/* Loaded-extension acceptance with a local deterministic provider and real Chrome tools. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { unwrapObservation } = require('../extensions/chrome/sidebar-context.js');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-task-acceptance-'));
  const extension = path.join(temporary, 'extension');
  fs.cpSync(path.resolve('extensions/chrome'), extension, { recursive: true });
  // Do not connect the user's registered native host from a disposable test profile.
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
  manifest.permissions = manifest.permissions.filter(permission => permission !== 'nativeMessaging');
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  let mode = 'prepare', round = 0, tabId, release, held = false, context;
  const measurements = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.end(); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'acceptance-model' }] })); return; }
    if (req.url === '/form') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<main><h1>Local acceptance form</h1><a id="start-registration" href="#application">Get started</a><input id="company" aria-label="Company" required><button id="submit" onclick="document.body.dataset.submissions=String(Number(document.body.dataset.submissions||0)+1)">Submit application</button></main>');
      return;
    }
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; res.end('{}'); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const current = ++round;
    if (current === 1 && ['prepare', 'uncertain', 'cancel'].includes(mode)) {
      held = true; await new Promise(resolve => { release = resolve; });
    }
    let message;
    if (mode === 'prepare') {
      if (current === 1) message = { content: null, tool_calls: [call('inspect', 'form_inspect', { tabId })] };
      else if (current === 2) {
        const source = body.messages.filter(item => item.role === 'tool').at(-1);
        const page = JSON.parse(unwrapObservation(source.content));
        const field = page.elements.find(item => item.selector === '#company');
        message = { content: null, tool_calls: [call('fill', 'batch_actions', { tabId, actions: [{ action: 'fill', selector: field.ref, value: 'Example LLC' }] })] };
      } else if (current === 3) message = { content: null, tool_calls: [call('verify', 'form_verify', { tabId, fields: [{ selector: '#company', value: 'Example LLC' }] })] };
      else message = { content: 'The company field is verified and ready for review.' };
    } else if (mode === 'uncertain') {
      message = current === 1 ? { content: null, tool_calls: [call('submit', 'click', { tabId, selector: '#submit' })] } : { content: 'The submission needs verification.' };
    } else if (mode === 'recover') {
      if (current === 1) message = { content: null, tool_calls: [call('replay', 'click', { tabId, selector: 'role=button[name="Submit application"]' })] };
      else if (current === 2) message = { content: null, tool_calls: [call('change', 'fill', { tabId, selector: '#company', value: 'Remaining work after inspection' })] };
      else message = { content: 'Remaining fields updated; the original submission is still unconfirmed.' };
    } else if (mode === 'locator') {
      if (current === 1) message = { content: null, tool_calls: [call('missing', 'click', { tabId, selector: 'a[href="#get-started"]' })] };
      else if (current === 2) message = { content: null, tool_calls: [call('guessed', 'click', { tabId, selector: 'a[href="https://example.com/signup"]' })] };
      else if (current === 3) {
        const observed = JSON.parse(unwrapObservation(body.messages.filter(item => item.role === 'tool').at(-1).content)).page;
        const link = observed.elements.find(item => item.selector === '#start-registration');
        message = { content: null, tool_calls: [call('actual', 'click', { tabId, selector: link.ref })] };
      } else if (current === 4) message = { content: null, tool_calls: [call('company', 'fill', { tabId, selector: '#company', value: 'Example LLC' })] };
      else if (current === 5) message = { content: null, tool_calls: [call('verified', 'form_verify', { tabId, fields: [{ selector: '#company', value: 'Example LLC' }] })] };
      else message = { content: 'Registration opened and the company field verified for review.' };
    } else message = { content: 'This canceled reply should not be displayed.' };
    measurements.push({ scenario: mode, round: current, inputCharacters: text.length });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 400, completion_tokens: 100 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      headless: true, executablePath: process.env.OMNI_EXTENSION_CHROME_PATH || chromium.executablePath(),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionRoot = worker.url().replace(/background\.js$/, '');
    await worker.evaluate(async base => {
      await chrome.storage.local.set({ aiSettings: { provider: 'local', baseUrl: base + '/v1', model: 'acceptance-model',
        browserTools: true, fileTools: false, mcpTools: false, memoryTools: false, streaming: false,
        rememberChats: true, subagents: false, taskMinutes: 2, taskTokenLimit: 1 }, aiAccessMode: 'full' });
      await chrome.storage.session.set({ aiApiKey: 'fixture-only-secret' });
    }, base);
    const panel = await context.newPage();
    await panel.goto(extensionRoot + 'sidepanel.html');
    await panel.waitForFunction(() => document.querySelector('#model').value === 'acceptance-model');
    assert.equal(await panel.locator('#taskTokenLimit').count(), 0, 'The removed task token cap is absent from settings');
    assert.equal(await panel.evaluate(() => 'taskTokenLimit' in settings()), false, 'Legacy saved caps are not loaded into task settings');
    mode = 'connect'; round = 0;
    await panel.locator('#settingsButton').click();
    await panel.locator('#testConnection').click();
    await panel.waitForFunction(() => document.querySelector('#connectionFeedback').textContent.startsWith('Connected.'));
    assert.equal(await panel.locator('#advancedSettings').evaluate(node => node.open), false);
    await panel.locator('[data-close=settingsDialog]').click();
    mode = 'prepare'; round = 0;
    const site = await context.newPage(); await site.goto(base + '/form');
    tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, base + '/form');
    await site.bringToFront();
    const started = Date.now();
    await panel.evaluate(() => { void runTask('Fill Company with Example LLC and verify it. Leave the form for review.'); });
    for (let tries = 0; !held && tries < 100; tries++) await wait(50);
    assert.ok(held, 'Provider request reached the execution document');
    const runner = panel;
    assert.equal(context.pages().some(page => page.url().includes('?task=')), false, 'No task workspace is created');
    assert.equal(await runner.locator('#taskWorkspace').count(), 0, 'Workspace controls are removed');
    const observer = await context.newPage(); await observer.goto(extensionRoot + 'sidepanel.html');
    await observer.waitForFunction(() => document.body.dataset.runState === 'running');
    // Stop only the service worker while the provider request remains in its execution document.
    const cdp = await context.newCDPSession(runner);
    const versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', event => event.versions.forEach(version => versions.set(version.versionId, version)));
    await cdp.send('ServiceWorker.enable');
    for (let tries = 0; ![...versions.values()].some(version => version.scriptURL === worker.url() && version.runningStatus === 'running') && tries < 100; tries++) await wait(50);
    const version = [...versions.values()].find(item => item.scriptURL === worker.url() && item.runningStatus === 'running');
    assert.ok(version, 'The active service worker version is present');
    await worker.evaluate(() => { globalThis.__acceptanceWorkerMarker = 'original worker'; });
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    release();
    await runner.waitForFunction(() => document.body.dataset.runState === 'completed', { timeout: 20000 });
    await observer.waitForFunction(() => document.body.dataset.runState === 'completed');
    const restarted = context.serviceWorkers().find(candidate => candidate.url() === worker.url());
    assert.ok(restarted, 'The service worker restarted for the remaining tools');
    assert.equal(await restarted.evaluate(() => globalThis.__acceptanceWorkerMarker), undefined, 'The original worker globals were lost');
    assert.equal(await site.locator('#company').inputValue(), 'Example LLC');
    assert.equal(await site.evaluate(() => document.body.dataset.submissions || '0'), '0');
    assert.equal(await observer.locator('.message.assistant').last().textContent(), 'OmniBrowser x2The company field is verified and ready for review.');
    fs.mkdirSync('.omnibrowser', { recursive: true });
    await observer.setViewportSize({ width: 375, height: 850 });
    await observer.screenshot({ path: '.omnibrowser/task-observer.png' });
    // Old references cannot address a new observation or a new document.
    const stale = await runner.evaluate(async tabId => {
      const first = await rawBrowserTool('read_page', { tabId });
      const old = first.elements.find(item => item.selector === '#company').ref;
      const second = await rawBrowserTool('read_page', { tabId });
      return { old, fresh: second.elements.find(item => item.selector === '#company').ref };
    }, tabId);
    assert.equal(stale.old, stale.fresh, 'The same attached control keeps its stable identity');
    await site.evaluate(() => { const input = document.querySelector('#company'); input.replaceWith(input.cloneNode(true)); });
    const replacement = await runner.evaluate(async tabId => {
      const page = await rawBrowserTool('read_page', { tabId });
      return page.elements.find(item => item.selector === '#company').ref;
    }, tabId);
    assert.notEqual(stale.old, replacement, 'A replacement control cannot inherit an old reference');
    await assert.rejects(runner.evaluate(({ tabId, old }) => rawBrowserTool('fill', { tabId, selector: old, value: 'Wrong' }), { tabId, old: stale.old }), /StaleElementReference/);
    await site.reload();
    await assert.rejects(runner.evaluate(({ tabId, old }) => rawBrowserTool('fill', { tabId, selector: old, value: 'Wrong' }), { tabId, old: replacement }), /StaleElementReference/);
    await site.locator('#company').fill('Example LLC');
    const stored = await runner.evaluate(async () => {
      const owner = (await chrome.storage.session.get('omniTaskOwner')).omniTaskOwner;
      return (await chrome.storage.local.get('omniTask:' + owner.id))['omniTask:' + owner.id];
    });
    assert.ok(stored.journal.some(item => item.name === 'batch_actions' && item.status === 'complete'));
    assert.equal(JSON.stringify(stored).includes('fixture-only-secret'), false);
    const requestsBeforeReload = measurements.length;
    await runner.reload();
    await runner.waitForFunction(() => document.body.dataset.runState === 'completed');
    assert.equal(await runner.evaluate(() => OmniTaskClient.session.record.status), 'completed', 'Reopening the sidebar keeps the completed outcome');
    assert.equal(measurements.length, requestsBeforeReload, 'Reload does not repeat provider requests');
    assert.equal(await site.locator('#company').inputValue(), 'Example LLC');
    await runner.evaluate(async tabId => {
      const destination = (await chrome.tabs.get(tabId)).url;
      policyEngine.rules.push({ decision: 'deny', tool: 'fill', domain: destination });
      let browserDenied = false;
      try { await browserTool('fill', { tabId, selector: '#company', value: 'Denied change' }); } catch (error) { browserDenied = /denied/i.test(error.message); }
      if (!browserDenied) throw new Error('Browser dispatch did not enforce its denial rule');
      policyEngine.rules.push({ decision: 'deny', category: 'file_read', path: 'C:/Private' });
      let fileDenied = false;
      try { await browserTool('files_extract', { path: 'C:/Private/file.txt' }); } catch (error) { fileDenied = /denied/i.test(error.message); }
      if (!fileDenied) throw new Error('File dispatch did not enforce its denial rule');
      mcpCatalogue.push({ mcpServer: 'test', function: { name: 'mcp__test__erase' } });
      policyEngine.rules.push({ decision: 'deny', mcpServer: 'test' });
      let mcpDenied = false;
      try { await browserTool('mcp__test__erase', {}); } catch (error) { mcpDenied = /denied/i.test(error.message); }
      if (!mcpDenied) throw new Error('MCP dispatch did not enforce its denial rule');
      policyEngine.rules = [];
    }, tabId);
    assert.equal(await site.locator('#company').inputValue(), 'Example LLC');

    assert.equal(await runner.evaluate(() => {
      renderSubmissionOutcome('unknown', { message: 'The click completed without server confirmation.' });
      return hasUnknownOutcome(history, document.querySelector('.workBody'));
    }), true, 'A completed click alone cannot finish a task with an unknown submission outcome');

    mode = 'locator'; round = 0;
    await site.locator('#company').fill('');
    await site.bringToFront();
    await runner.evaluate(() => { void runTask('My company is Example LLC. Open registration and fill it. Do not submit.'); });
    await runner.waitForFunction(() => ['completed', 'failed'].includes(document.body.dataset.runState), { timeout: 25000 });
    assert.equal(await runner.evaluate(() => currentRunState), 'completed');
    assert.equal(await runner.locator('#approval').isVisible(), false, 'Full access locator recovery never requests approval');
    const locatorJournal = await runner.evaluate(() => OmniTaskClient.session.record.journal);
    assert.equal(locatorJournal.filter(item => item.name === 'click' && item.status === 'failed').length, 1, 'Only the first missing selector reaches the browser');
    assert.equal(locatorJournal.filter(item => item.name === 'click' && item.status === 'complete').length, 1);
    assert.equal(locatorJournal.some(item => item.status === 'unknown'), false, 'A missing element cannot create an uncertain write');
    assert.equal(await site.locator('#company').inputValue(), 'Example LLC');
    assert.equal(await site.evaluate(() => document.body.dataset.submissions || '0'), '0');

    // Inject a lost response after a real browser write; it must not be replayed automatically.
    mode = 'uncertain'; round = 0; held = false;
    // The same sidebar owns the next task; inject a fault while the provider is held.
    await site.bringToFront();
    await runner.evaluate(() => { void runTask('Submit this local test application.'); });
    for (let tries = 0; !held && tries < 100; tries++) await wait(50);
    assert.ok(held);
    await runner.evaluate(() => {
      const original = rawBrowserTool;
      rawBrowserTool = async (name, args) => { const result = await original(name, args); if (name === 'click') throw new Error('Connection lost after dispatch'); return result; };
    });
    release();
    await runner.waitForFunction(() => ['completed', 'unknown'].includes(document.body.dataset.runState), { timeout: 20000 });
    // Fault injection may race a very fast provider; assert the journal fault actually occurred.
    const journal = await runner.evaluate(() => OmniTaskClient.session.record.journal);
    assert.ok(journal.some(item => item.name === 'click' && item.status === 'unknown'), 'Lost-response fault reached the real journal');
    assert.equal(await site.evaluate(() => document.body.dataset.submissions), '1');
    assert.equal(await runner.evaluate(() => currentRunState), 'unknown');
    await runner.close();
    await observer.reload();
    await observer.waitForFunction(() => document.body.dataset.runState === 'unknown');
    mode = 'recover'; round = 0;
    await observer.evaluate(() => { void OmniTaskClient.recover(); });
    const recovering = observer;
    await recovering.waitForFunction(() => document.body.dataset.runState === 'unknown' && document.querySelector('#stop').disabled, { timeout: 20000 });
    assert.equal(await site.locator('#company').inputValue(), 'Remaining work after inspection');
    assert.equal(await site.evaluate(() => document.body.dataset.submissions), '1');
    assert.equal(await recovering.locator('#approvalActions').isVisible(), false, 'Full access inspects unknown outcomes without asking permission');

    mode = 'cancel'; round = 0; held = false;
    await site.bringToFront();
    await observer.evaluate(() => { void runTask('Read this page for a cancellation check.'); });
    for (let tries = 0; !held && tries < 100; tries++) await wait(50);
    assert.ok(held);
    await observer.locator('#stop').click();
    const canceling = observer;
    await canceling.waitForFunction(() => document.body.dataset.runState === 'stopped');
    release();
    await observer.evaluate(async () => {
      await OmniTaskClient.disablePersistence();
      const local = await chrome.storage.local.get(null);
      if (Object.keys(local).some(key => key.startsWith('omniTask:') || key === 'omniTaskOwner'))
        throw new Error('Disabling history left persistent task data');
      const owner = (await chrome.storage.session.get('omniTaskOwner')).omniTaskOwner;
      if (owner.persistent) throw new Error('The active task owner still uses persistent storage');
    });
    // Closing a sidebar during a held request interrupts work and restores recovery.
    await observer.reload();
    await observer.waitForFunction(() => document.body.dataset.runState === 'stopped');
    mode = 'cancel'; round = 0; held = false;
    await site.bringToFront();
    await observer.evaluate(() => { void runTask('Read this page to check sidebar closure.'); });
    for (let tries = 0; !held && tries < 100; tries++) await wait(50);
    assert.ok(held);
    await observer.close();
    const reopened = await context.newPage(); await reopened.goto(extensionRoot + 'sidepanel.html');
    await reopened.waitForFunction(() => document.body.dataset.runState === 'unknown');
    const requestsBeforeRelease = measurements.length;
    release();
    await wait(300);
    assert.equal(measurements.length, requestsBeforeRelease + 1, 'Only the already pending request completes');
    assert.equal(await site.evaluate(() => document.body.dataset.submissions), '1', 'Closure does not replay completed writes');
    assert.equal(context.pages().some(page => page.url().includes('?task=')), false);
    assert.equal(await reopened.locator('#resumeTask').isVisible(), true);
    fs.mkdirSync('.omnibrowser', { recursive: true });
    fs.writeFileSync('.omnibrowser/task-acceptance.json', JSON.stringify({
      environment: 'Loaded extension, disposable Chrome profile, local deterministic provider',
      elapsedMs: Date.now() - started, measurements, checks: ['sidebar closure', 'worker restart', 'verified form values',
        'connection test', 'stale observations', 'navigation', 'secret exclusion', 'completed sidebar reload', 'dispatch policy', 'uncertain writes', 'recovery hold', 'cancellation']
    }, null, 2));
    console.log('Loaded extension: sidebar closure, worker restart, verified form fill, stale references, recovery hold and Stop passed.');
  } catch (error) {
    const pages = [];
    for (const page of context?.pages() || []) {
      if (!page.url().startsWith('chrome-extension:')) continue;
      try { pages.push(await page.evaluate(() => ({ url: location.href, state: document.body.dataset.runState,
        activity: document.querySelector('#activity')?.textContent, feedback: document.querySelector('#settingsFeedback')?.textContent,
        approval: document.querySelector('#approvalText')?.textContent,
        access: typeof accessMode !== 'undefined' ? accessMode : null,
        journal: typeof OmniTaskClient !== 'undefined' ? OmniTaskClient.session?.record.journal : null,
        session: typeof OmniTaskClient !== 'undefined' ? { id: OmniTaskClient.session?.record.id, status: OmniTaskClient.session?.record.status } : null }))); } catch {}
    }
    console.error(JSON.stringify({ mode, round, held, pages }, null, 2));
    throw error;
  } finally {
    if (release) release();
    if (context) await context.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('omni-task-acceptance-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
