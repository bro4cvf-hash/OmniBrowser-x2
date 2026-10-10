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

    assert.equal(await page.locator('#accessLabel').textContent(), 'Full access');
    assert.equal(await page.locator('.activeGrantsSection').evaluate(el => el.hidden), true);
    for (const [mode, label] of [['ask', 'Ask for approval'], ['auto', 'Approve for me'], ['full', 'Full access']]) {
      await page.locator('#accessLabel').click();
      await page.locator(`[data-access="${mode}"]`).click();
      await page.waitForFunction(mode => window.testStorage.aiAccessMode === mode, mode);
      assert.equal(await page.locator('#accessLabel').textContent(), label);
      assert.equal(await page.locator(`[data-access="${mode}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#accessMenu').evaluate(el => el.open), false);
    }
    await page.evaluate(async () => {
      await setAccess('auto');
      await browserTool('click', {tabId: 7, selector: '#details'});
    });
    await page.evaluate(() => { window.pendingApproval = browserTool('click', {tabId: 7, selector: '#submit'}); });
    await page.waitForFunction(() => !document.querySelector('#approval').hidden);
    await page.locator('#allowOnce').click();
    await page.evaluate(() => window.pendingApproval);
    // A task grant must actually suppress the next approval on the same site.
    await page.evaluate(() => setAccess('ask'));
    await page.evaluate(() => { window.pendingApproval = browserTool('click', {tabId: 7, url: 'https://example.com/apply', selector: '#details'}); });
    await page.waitForFunction(() => !document.querySelector('#approvalActions').hidden);
    await page.locator('#allowTask').click();
    await page.evaluate(() => window.pendingApproval);
    await page.evaluate(() => browserTool('click', {tabId: 7, url: 'https://example.com/apply', selector: '#next'}));
    assert.equal(await page.locator('.activeGrantsSection').evaluate(el => el.hidden), false);
    assert.equal(await page.locator('#siteGrantsHeading').evaluate(el => el.hidden), false);
    assert.equal(await page.locator('#folderGrantsHeading').evaluate(el => el.hidden), await page.evaluate(() => policyEngine.getActiveFolderGrants().length === 0));
    assert.equal(await page.locator('#approval').evaluate(el => el.hidden), true);
    await page.evaluate(() => { policyEngine.clearTaskGrants(); });
    await page.evaluate(async () => {
      await setAccess('full');
      await browserTool('click', {tabId: 7, selector: '#submit'});
    });
    await page.evaluate(async () => {
      await setAccess('ask');
      window.pendingApproval = browserTool('fetch_web', {url: 'https://example.com'});
    });
    await page.waitForFunction(() => !document.querySelector('#approvalActions').hidden);
    await page.locator('#allowOnce').click();
    await page.evaluate(() => window.pendingApproval);
    await page.evaluate(() => setAccess('full'));
    await page.locator('#accessLabel').click();
    await page.screenshot({path: '.omnibrowser/permissions-preview.png'});
    for (const width of [280, 320, 420]) {
      await page.setViewportSize({width, height:900});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    console.log('Permission choices, saved mode, selected state, menu dismissal and responsive layout passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
