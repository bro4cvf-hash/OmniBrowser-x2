/* Loaded-extension acceptance: no paid model or external website is used. */
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-reuse-live-'));
  const extension = path.join(temporary, 'extension');
  fs.cpSync(path.resolve('extensions/chrome'), extension, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
  manifest.permissions = manifest.permissions.filter(permission => permission !== 'nativeMessaging');
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/failed')) { res.writeHead(503); res.end('fixture failure'); return; }
    if (req.url === '/file') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="fixture.txt"' }); res.end('download fixture'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<main id="main"><h1 id="status">Initial page</h1><input id="name" aria-labelledby="label"><label id="label">Full name</label><input id="agree" type="checkbox"><button id="run" onclick="document.querySelector(\'#status\').textContent=\'Verified receipt\'">Run</button><a id="download" href="/file">Download fixture</a><div id="extra">Extra text</div></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { headless: true,
      executablePath: process.env.OMNI_EXTENSION_CHROME_PATH || chromium.executablePath(),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => chrome.storage.local.set({ aiAccessMode: 'full' }));
    const panel = await context.newPage(); await panel.goto(worker.url().replace('background.js', 'sidepanel.html'));
    const site = await context.newPage(); await site.goto(base + '/form');
    const tabId = await panel.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, base + '/form');
    const call = (name, args = {}) => panel.evaluate(async ({ name, args }) => {
      const response = await chrome.runtime.sendMessage({ type: 'sidebarTool', name, args });
      if (!response.success) throw new Error(response.error); return response.result;
    }, { name, args: { tabId, ...args } });

    const first = await call('read_page');
    assert.equal(first.elements.find(element => element.selector === '#name').label, 'Full name');
    const ref = first.elements.find(element => element.selector === '#name').ref;
    const second = await call('read_page', { sinceSnapshotId: first.snapshotId });
    assert.equal(second.mode, 'delta'); assert.equal(second.changed, false);
    assert.equal(second.elements.find(element => element.selector === '#name').ref, ref);
    assert.ok(JSON.stringify(second).length < JSON.stringify(first).length);
    await call('fill', { selector: ref, value: 'Alex' });
    assert.equal(await site.locator('#name').inputValue(), 'Alex');
    const controls = await call('read_page', { interactiveOnly: true, maxElements: 2 });
    assert.equal(controls.text, ''); assert.equal(controls.elements.length, 2); assert.ok(controls.nextElementOffset);
    const next = await call('read_page', { interactiveOnly: true, maxElements: 2, offset: controls.nextElementOffset });
    assert.notEqual(next.elements[0].ref, controls.elements[0].ref);
    const scope = await call('read_page', { selector: '#extra' }); assert.equal(scope.text, 'Extra text'); assert.equal(scope.elements.length, 0);
    await site.locator('#name').evaluate(element => element.outerHTML = '<input id="name" aria-label="Replacement">');
    await assert.rejects(call('fill', { selector: ref, value: 'Wrong node' }), /stale|not found|expired/i);
    await call('recipe_save', { name: 'name-form', actions: [{ action: 'fill', selector: '#name', value: '{{name}}' }] });
    const stored = await panel.evaluate(() => chrome.storage.local.get('omniActionRecipes'));
    assert.ok(!JSON.stringify(stored).includes('Alex'));
    // Exercise policy dispatch, not only the service-worker helper.
    await panel.evaluate(async tabId => browserTool('recipe_run', { tabId, name: 'name-form', values: { name: 'Recipe user' } }), tabId);
    assert.equal(await site.locator('#name').inputValue(), 'Recipe user');
    await call('verify_task', { criteria: [{ kind: 'field', selector: '#name', value: 'Recipe user' }] }).then(result => assert.equal(result.verified, true));

    await call('diagnostics_start');
    await site.evaluate(() => { console.error('fixture diagnostic'); return fetch('/failed?private=secret').catch(() => {}); });
    let diagnosis;
    for (let attempt = 0; attempt < 40; attempt++) {
      diagnosis = await call('diagnostics_read', { failuresOnly: true });
      if (diagnosis.network.some(item => item.status === 503) && diagnosis.console.some(item => item.text.includes('fixture diagnostic'))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(diagnosis.network.some(item => item.status === 503));
    assert.ok(diagnosis.console.some(item => item.text.includes('fixture diagnostic')));
    assert.ok(!JSON.stringify(diagnosis.network).includes('secret'));
    await site.evaluate(() => history.pushState({}, '', '#spa'));
    assert.ok((await call('diagnostics_read')).network.some(item => item.status === 503));

    const download = await call('download_file', { url: base + '/file', filename: 'fixture.txt' });
    let completed;
    for (let attempt = 0; attempt < 80; attempt++) {
      completed = await call('downloads_status', { id: download.id });
      if (completed.state !== 'in_progress') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(completed.state, 'complete'); assert.equal(completed.verified, true);
    await assert.rejects(call('downloads_status', { id: download.id + 100 }), /download ID/);
    await call('diagnostics_stop'); assert.equal((await call('diagnostics_read')).capturing, false);
    await site.goto(base + '/replacement');
    const fresh = await call('read_page', { sinceSnapshotId: first.snapshotId }); assert.equal(fresh.mode, 'full'); assert.equal(fresh.baselineMissing, true);
    await assert.rejects(call('fill', { selector: ref, value: 'Must reject after navigation' }), /stale|not found|expired/i);
    console.log('Loaded Chrome extension reuse acceptance passed: observations, stable targets, recipes/policy, diagnostics and download completion.');
  } finally {
    await context?.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
