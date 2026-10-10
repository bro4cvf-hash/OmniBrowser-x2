/* Real sidebar settings, discovery races and reopen recovery; provider responses are fixtures. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const local = JSON.parse(localStorage.getItem('fixture-settings') || 'null') || {
        aiSettings: { provider: 'custom', baseUrl: 'https://provider.example/v1', model: 'gemini-3.8-flash-low', memoryTools: false }, aiAccessMode: 'full'
      };
      window.testLocal = local;
      const persist = () => localStorage.setItem('fixture-settings', JSON.stringify(local));
      window.chrome = {
        storage: {
          local: { get: async () => local, set: async values => { Object.assign(local, values); persist(); }, remove: async key => { delete local[key]; persist(); } },
          session: { get: async () => ({}), set: async () => {}, remove: async () => {} }
        },
        tabs: { query: async () => [{ id: 7, url: 'https://example.com' }] },
        runtime: { sendMessage(message, callback) { callback({ success: true, result: { roots: [] } }); } }
      };
    });
    let discoveryUnavailable = false;
    await page.route('https://provider.example/**', route => {
      const models = route.request().url().endsWith('/models');
      return route.fulfill({ status: models && discoveryUnavailable ? 401 : 200, contentType: 'application/json', body: JSON.stringify(models ?
        { data: [{ id: 'gemini-3.8-flash-low', owned_by: 'antigravity' }] } :
        { usage: { prompt_tokens: 93000 }, choices: [{ message: { content: 'Fixture response.' } }] }) });
    });
    await page.goto(pathToFileURL(path.resolve('extensions/chrome/sidepanel.html')).href);
    await page.waitForFunction(() => modelMetadata['gemini-3.8-flash-low']?.contextWindow === 1048576);
    await page.evaluate(() => saveSettings());
    assert.equal(await page.evaluate(() => testLocal.aiSettings.modelContextWindow), 1048576);
    await page.locator('#prompt').fill('Check the model context');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#activity').textContent.startsWith('Finished'));
    assert.match(await page.locator('#contextUsage').textContent(), /93k \/ 1049k context/);
    assert.match(await page.locator('#contextUsage').getAttribute('title'), /Published model limit: 1,048,576 tokens/);
    const fill = await page.locator('#contextFill').evaluate(node => parseFloat(node.style.width));
    assert.ok(fill > 8 && fill < 10, `93k should use about 9% of Gemini's window, got ${fill}%`);

    discoveryUnavailable = true;
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#modelsFeedback').textContent.includes('rejected'));
    assert.equal(await page.evaluate(() => settings().modelContextWindow), 1048576);
    // An uncatalogued provider model also keeps its last discovered limit on reopen.
    await page.evaluate(async () => {
      await chrome.storage.local.set({ aiSettings: { ...testLocal.aiSettings, model: 'fixture', modelContextWindow: 262144, modelContextSource: 'provider' } });
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#modelsFeedback').textContent.includes('rejected'));
    assert.equal(await page.evaluate(() => OmniSidebarContext.contextWindow(settings())), 262144);
    await page.evaluate(() => {
      document.querySelector('#apiKey').value = 'replacement-fixture-key';
      document.querySelector('#apiKey').dispatchEvent(new Event('input'));
      clearTimeout(modelTimer);
      document.querySelector('#model').value = 'fixture';
    });
    assert.equal(await page.evaluate(() => OmniSidebarContext.contextWindow(settings())), 128000);

    // A cancelled older model fetch cannot overwrite metadata from a newer one.
    await page.evaluate(async () => {
      const pending = [];
      OmniSidebarAgent.listModels = (_, options) => new Promise(resolve => pending.push({ options, resolve }));
      const older = fetchModels(), newer = fetchModels();
      pending[1].options.onMetadata({ fixture: { contextWindow: 300000, contextSource: 'provider' } });
      pending[1].resolve(['fixture']);
      await newer;
      pending[0].options.onMetadata({ fixture: { contextWindow: 16000, contextSource: 'provider' } });
      pending[0].resolve(['fixture']);
      await older;
      await saveSettings();
    });
    assert.equal(await page.evaluate(() => testLocal.aiSettings.modelContextWindow), 300000);
    await page.evaluate(() => { document.querySelector('#contextWindowTokens').value = '2000000'; });
    assert.equal(await page.evaluate(() => OmniSidebarContext.contextWindow(settings())), 2000000);
    assert.deepEqual(errors, []);
    console.log('Gemini proxy context, exact limit tooltip, usage proportion, reopen recovery, key changes and discovery races passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
