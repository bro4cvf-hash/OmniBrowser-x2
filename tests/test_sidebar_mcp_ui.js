/* Settings and persistence checks in real Chrome; external responses are fixtures. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 900 }, colorScheme: 'dark' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const local = { aiSettings: { baseUrl: 'https://provider.example/v1', model: 'fixture', provider: 'custom' }, aiAccessMode: 'full' };
      const session = {};
      window.testLocal = local; window.testSession = session;
      window.chrome = {
        storage: { local: { get: async () => local, set: async values => Object.assign(local, values), remove: async key => { delete local[key]; } },
          session: { get: async () => session, set: async values => Object.assign(session, values), remove: async key => { delete session[key]; } } },
        tabs: { query: async () => [{ id: 7, url: 'https://example.com' }] },
        runtime: { sendMessage(message, callback) {
          let result = { roots: [] };
          if (message.type === 'sidebarMcp') result = { tools: [], servers: message.action === 'disconnect' ? [] : [{ name: 'Parallel Search', connected: true, toolCount: 2 }] };
          callback({ success: true, result });
        } }
      };
    });
    await page.route('https://provider.example/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(route.request().url().endsWith('/models') ?
      { data: [{ id: 'fixture', context_length: 200000 }] } : { usage: { prompt_tokens: 2100 }, choices: [{ message: { content: 'Fixture response.' } }] }) }));
    await page.goto(pathToFileURL(path.resolve('extensions/chrome/sidepanel.html')).href);
    await page.waitForFunction(() => document.querySelector('#modelName').textContent === 'fixture');
    await page.waitForFunction(() => modelMetadata.fixture?.contextWindow === 200000);
    await page.locator('#settingsButton').click();
    await page.getByText('Advanced settings', { exact: true }).click();
    await page.locator('.mcpSettings > summary').click();
    await page.locator('#mcpParallelPreset').click();
    assert.equal(JSON.parse(await page.locator('#mcpConfig').inputValue()).mcpServers['Parallel Search'].url, 'https://search.parallel.ai/mcp');
    await page.locator('#mcpScraplingPreset').click();
    assert.equal(JSON.parse(await page.locator('#mcpConfig').inputValue()).mcpServers.Scrapling.command, 'scrapling');
    await page.locator('#mcpConfig').fill('{broken JSON');
    await page.locator('#connectMcp').click();
    assert.match(await page.locator('#mcpFeedback').textContent(), /JSON syntax/);
    assert.equal(await page.locator('#mcpFeedback').evaluate(node => node === document.activeElement), true);
    await page.locator('#mcpConfig').fill(JSON.stringify({ mcpServers: { 'Parallel Search': { url: 'https://search.parallel.ai/mcp', headers: { Authorization: 'Bearer fixture-only-secret' } } } }, null, 2));
    await page.locator('#connectMcp').click();
    await page.waitForFunction(() => document.querySelector('#mcpFeedback').textContent.includes('2 tools ready'));
    assert.equal(await page.evaluate(() => window.testSession.aiMcpConfig.mcpServers['Parallel Search'].headers.Authorization), 'Bearer fixture-only-secret');
    assert.ok(!(await page.evaluate(() => JSON.stringify(window.testLocal))).includes('fixture-only-secret'));
    for (const width of [280, 375, 420]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.querySelector('#settingsDialog').scrollWidth <= document.querySelector('#settingsDialog').clientWidth), true);
    }
    await page.setViewportSize({ width: 420, height: 1000 });
    await page.locator('#contextWindowTokens').fill('250000');
    fs.mkdirSync('.omnibrowser', { recursive: true });
    await page.screenshot({ path: '.omnibrowser/ui-context-mcp-settings.png' });
    await page.locator('#settingsForm button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#settingsDialog').open);
    await page.locator('#prompt').fill('Check context settings');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#activity').textContent.startsWith('Finished'));
    assert.match(await page.locator('#contextUsage').textContent(), /2k \/ 250k/);
    const stored = await page.evaluate(() => window.testLocal.aiChats[0]);
    assert.equal(stored.history[0].role, 'user');
    assert.equal(stored.history.at(-1).content, 'Fixture response.');
    assert.ok(stored.contextState);
    assert.ok(!JSON.stringify(stored).includes('fixture-only-secret'));
    await page.locator('#settingsButton').click();
    await page.locator('#disconnectMcp').click();
    await page.waitForFunction(() => document.querySelector('#mcpFeedback').textContent === 'No servers connected.');
    assert.equal(await page.evaluate(() => window.testSession.aiMcpConfig), undefined);
    assert.deepEqual(errors, []);
    console.log('MCP settings, JSON errors, presets, narrow layouts, session-only credentials, context display and chat checkpoints passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
