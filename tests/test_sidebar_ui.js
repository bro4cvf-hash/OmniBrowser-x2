/* Optional browser checks: requires Playwright and a locally installed Chrome. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 900 }, colorScheme: 'dark' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const store = { aiSettings: { provider: 'custom', baseUrl: 'https://provider.example/v1', model: 'test-model', theme: 'dark', fileTools: true, browserTools: true }, aiAccessMode: 'full' };
      window.testStorage = store;
      window.chrome = {
        storage: { local: { get: async () => store, set: async values => Object.assign(store, values), remove: async key => { delete store[key]; } }, session: { get: async () => ({}), set: async () => {} } },
        tabs: { query: async () => [{ id: 7, title: 'Fixture form', url: 'https://example.com/apply' }] },
        runtime: { sendMessage(message, callback) {
          const result = message.type === 'sidebarFolder' ? { roots: [], mode: message.args?.mode } : { completed: true, verified: true, page: { title: 'Fixture', url: 'https://example.com/apply', elements: [], text: 'Fields filled' } };
          callback({ success: true, result });
        } }
      };
    });
    await page.route('https://provider.example/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'test-model' }] }) }));
    await page.goto(pathToFileURL(path.resolve('extensions/chrome/sidepanel.html')).href);
    await page.waitForFunction(() => document.querySelector('#modelName').textContent === 'test-model');
    await page.locator('.suggestions button').first().click();
    assert.match(await page.locator('#prompt').inputValue(), /suitable providers/);
    await page.locator('#prompt').fill('');
    fs.mkdirSync('.omnibrowser', { recursive: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: '.omnibrowser/ui-preview-dark.png' });
    const layout = () => page.evaluate(() => ({ width: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, main: document.querySelector('main').clientWidth, mainScroll: document.querySelector('main').scrollWidth }));
    for (const width of [280, 320, 375, 420, 640]) {
      await page.setViewportSize({ width, height: 800 });
      const sizes = await layout();
      assert.ok(sizes.document <= width && sizes.body <= width && sizes.mainScroll <= sizes.main, JSON.stringify(sizes));
    }
    await page.setViewportSize({ width: 420, height: 900 });
    await page.evaluate(() => { document.querySelector('#theme').value = 'light'; applyAppearance(); });
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(light, 'rgb(247, 246, 251)');
    await page.screenshot({ path: '.omnibrowser/ui-preview-light.png' });
    await page.evaluate(() => { document.querySelector('#theme').value = 'dark'; applyAppearance(); });
    await page.locator('#settingsButton').click();
    assert.equal(await page.locator('#settingsDialog').evaluate(dialog => dialog.open), true);
    await page.locator('[data-close=settingsDialog]').click();
    await page.locator('#modelButton').click();
    assert.equal(await page.locator('#modelButton').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#modelButton').getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => {
      let round = 0;
      const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      window.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: ++round === 1 ? { content: null, tool_calls: [
        call('plan', 'update_plan', { steps: [{ title: 'Read business documents', status: 'complete' }, { title: 'Prepare application', status: 'running' }] }),
        call('ready', 'record_result', { title: 'Example provider', url: 'https://example.com/apply', status: 'researched', note: 'Test fixture.' })
      ] } : round === 2 ? { content: null, tool_calls: [
        call('verified', 'form_verify', { tabId: 7, fields: [{ selector: '#company', value: 'Example LLC' }] }),
        call('result', 'record_result', { title: 'Example provider', url: 'https://example.com/apply', status: 'ready', note: 'Fields verified. Ready for review.' }),
        call('finish', 'update_plan', { steps: [{ title: 'Read business documents', status: 'complete' }, { title: 'Prepare application', status: 'complete' }] })
      ] } : { content: 'The example application is ready for review.' } }] }) });
    });
    await page.locator('#prompt').fill('Prepare an example application from my files.');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#activity').textContent.startsWith('Finished'));
    assert.equal(await page.locator('.resultCard').count(), 1);
    assert.equal(await page.locator('.resultStatus').textContent(), 'Ready for review');
    assert.equal(await page.locator('.taskPlan li[data-status=complete]').count(), 2);
    assert.equal(await page.locator('.workLog').evaluate(node => node.open), true);
    assert.equal(await page.locator('.message').first().evaluate(node => getComputedStyle(node).animationName), 'none');
    const saved = await page.evaluate(() => window.testStorage.aiChats[0].transcript.find(entry => entry.work));
    assert.equal(saved.entries.find(entry => entry.plan).plan.length, 2);
    assert.equal(saved.entries.find(entry => entry.results).results[0].status, 'ready');
    await page.locator('#newChat').click();
    await page.evaluate(() => openChat(chats[0].id));
    await page.locator('.workLog summary').click();
    assert.equal(await page.locator('.resultCard').count(), 1);
    assert.equal(await page.locator('.taskPlan li').count(), 2);
    await page.screenshot({ path: '.omnibrowser/ui-preview-workflow.png' });
    // Exercise the actual verifier against browser DOM controls, not API stubs.
    const background = fs.readFileSync('extensions/chrome/background.js', 'utf8');
    const verifier = background.slice(background.indexOf('function verifySidebarFields(fields)'), background.indexOf('async function inspectSidebarPage'));
    await page.addScriptTag({ content: verifier });
    const checks = await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.innerHTML = '<input id="testCompany" required value="Example LLC"><input id="testEmail" type="email" required value="invalid"><input id="testTerms" type="checkbox"><input id="testSecret" type="password" value="private"><div id="testHost"></div>';
      document.body.append(fixture);
      fixture.querySelector('#testHost').attachShadow({ mode: 'open' }).innerHTML = '<input id="testShadow" value="Inside shadow">';
      const result = verifySidebarFields([
        { selector: '#testCompany', value: 'Example LLC' },
        { selector: '#testCompany', value: 'Different LLC' },
        { selector: '#testEmail', value: 'invalid' },
        { selector: '#testTerms', checked: false },
        { selector: '#testSecret', value: 'private' },
        { selector: '#missingField', value: '' },
        { selector: '#testHost >>> #testShadow', value: 'Inside shadow' }
      ]);
      fixture.remove(); return result;
    });
    assert.equal(checks[0].matches, true);
    assert.equal(checks[1].matches, false);
    assert.equal(checks[2].valid, false);
    assert.equal(checks[3].matches, true);
    assert.match(checks[4].error, /Sensitive/);
    assert.match(checks[5].error, /exactly one/);
    assert.equal(checks[6].matches, true);
    // Real question controls: no default answers, multiple fields, keyboard use,
    // custom answers, malicious text rendered literally, and cancellation.
    await page.evaluate(() => {
      window.questionResult = null;
      window.questionController = new AbortController();
      window.questionPromise = OmniQuestions.request({ questions: [
        { id: 'retry', question: 'Try again?', reason: 'The previous fill failed.', options: [{ label: 'Yes', description: 'Inspect and retry.' }, { label: 'No', description: 'Leave this form.' }] },
        { id: 'contact', question: '<script>unsafe</script> Your contact email?' }
      ] }, { container: document.querySelector('#messages'), signal: questionController.signal }).then(value => { window.questionResult = value; });
    });
    const card = page.locator('.questionCard').last();
    for (const width of [280, 320, 420]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth));
      assert.ok(await card.locator('input').first().evaluate(el => el.getBoundingClientRect().width <= 20));
    }
    assert.equal(await card.locator('input:checked').count(), 0);
    assert.equal(await card.locator('button').isDisabled(), true);
    await card.locator('input[type=radio]').first().focus();
    await page.keyboard.press('Space');
    assert.equal(await card.locator('button').isDisabled(), true);
    await card.locator('textarea').nth(1).fill('owner@example.org');
    await card.locator('button').click();
    assert.deepEqual(await page.evaluate(() => questionResult), { status: 'answered', answers: { retry: 'Yes', contact: 'owner@example.org' } });
    assert.equal(await card.locator('script').count(), 0);
    assert.equal(await card.locator('button').isDisabled(), true);
    await page.evaluate(() => {
      window.questionAbort = null;
      window.questionController = new AbortController();
      OmniQuestions.request({ questions: [{ id: 'choose', question: 'Choose an option', options: [{ label: 'Yes' }, { label: 'No' }] }] }, { container: document.querySelector('#messages'), signal: questionController.signal }).catch(error => { window.questionAbort = error.name; });
    });
    await page.locator('.questionCard').last().locator('textarea').fill('A different answer');
    await page.evaluate(() => questionController.abort());
    assert.equal(await page.evaluate(() => questionAbort), 'AbortError');
    assert.match(await page.locator('.questionCard').last().textContent(), /No answer was sent/);
    // Exercise the real sidebar -> agent -> question -> resume path.
    await page.evaluate(() => {
      let round = 0;
      window.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: ++round === 1 ? {
        content: null, tool_calls: [{ id: 'ask-live', type: 'function', function: { name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'review', question: 'Prepare the form for review?', options: [{ label: 'Yes' }, { label: 'No' }] }] }) } }]
      } : { content: 'I will prepare it for review.' } }] }) });
    });
    await page.locator('#prompt').fill('Help prepare this form.');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('.questionCard:last-child button:not(:disabled)') === null && document.querySelector('#activity').textContent.includes('Waiting for your answers'));
    assert.equal(await page.locator('#send').isDisabled(), false);
    await page.locator('.questionCard').last().getByText('Yes', { exact: true }).click();
    await page.locator('.questionCard').last().getByRole('button', { name: 'Send answers' }).click();
    await page.waitForFunction(() => document.querySelector('#stop').hidden);
    assert.ok(await page.evaluate(() => testStorage.aiChats[0].history.some(m => m.role === 'user' && m.content.includes('My answer: Yes'))));
    await page.screenshot({ path: '.omnibrowser/ui-questions.png' });
    assert.deepEqual(errors, []);
    console.log('Sidebar layouts, themes, reduced motion, menus, workflow events, result updates and chat restoration passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
