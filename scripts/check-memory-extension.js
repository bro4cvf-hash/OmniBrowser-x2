/* Optional live acceptance: loaded extension + real Hindsight, in a disposable profile. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
require('../extensions/chrome/vendor/hindsight/hindsight-client.js');
(async () => {
  const endpoint = process.argv[2] || 'http://127.0.0.1:8888';
  const client = new OmniHindsightSDK.HindsightClient({ baseUrl: endpoint });
  const version = await client.getVersion({ signal: AbortSignal.timeout(10000) });
  assert.equal(version.features.observations, false, 'Run this check in local-search mode to avoid paid calls');
  let bank;
  const root = path.resolve('.omnibrowser'); fs.mkdirSync(root, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(root, 'memory-acceptance-'));
  const extension = path.join(temporary, 'extension'); fs.cpSync(path.resolve('extensions/chrome'), extension, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
  manifest.permissions = manifest.permissions.filter(permission => permission !== 'nativeMessaging');
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<title>Solar research</title><article>Solar panels turn sunlight into electricity stored in batteries. Battery storage provides electrical power after sunset and during cloudy weather.</article><input value="excluded private field">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      headless: true, executablePath: process.env.OMNI_EXTENSION_CHROME_PATH || chromium.executablePath(),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const panel = await context.newPage(); await panel.goto(worker.url().replace(/background\.js$/, 'sidepanel.html'));
    const site = await context.newPage(); await site.goto(`http://127.0.0.1:${server.address().port}/`);
    const send = message => panel.evaluate(message => chrome.runtime.sendMessage(message), message);
    const initial = await send({ type: 'sidebarMemorySettings', action: 'status' });
    assert.equal(initial.success, true); bank = initial.result.bank;
    if (endpoint !== 'http://127.0.0.1:8888') {
      const configured = await send({ type: 'sidebarMemorySettings', action: 'configure', args: { endpoint, bank, apiKey: '' } });
      assert.equal(configured.success, true);
    }
    // Controls in the actual sidebar persist independently of chat settings.
    if (await panel.locator('#settingsDialog').evaluate(dialog => dialog.open)) await panel.locator('[data-close="settingsDialog"]').click();
    await panel.locator('#memoryButton').click();
    await panel.locator('#automaticMemoryEnabled').uncheck();
    await panel.waitForFunction(() => document.getElementById('automaticMemoryFeedback').textContent === 'Automatic saving paused.');
    assert.equal((await send({ type: 'sidebarMemorySettings', action: 'automaticStatus' })).result.enabled, false);
    await panel.locator('#automaticMemoryEnabled').check();
    await panel.waitForFunction(() => document.getElementById('automaticMemoryFeedback').textContent.startsWith('Automatic saving is on.'));
    const tool = async (name, args) => {
      const reply = await send({ type: 'sidebarTool', name, args });
      assert.equal(reply.success, true, reply.error); return reply.result;
    };
    await site.bringToFront();
    let saved;
    for (let attempt = 0; attempt < 45; attempt++) {
      const archive = await tool('memory_search', { archive: true });
      const memory = archive.memories.find(item => item.automatic && item.url === site.url());
      const status = await send({ type: 'sidebarMemorySettings', action: 'status' });
      if (memory && status.result.indexed === 1) { saved = { memory }; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!saved) console.error(await worker.evaluate(async () => ({
      status: await automaticMemory.status(), active: await automaticMemory.active(),
      windows: await chrome.windows.getAll(), pending: await chrome.storage.session.get('automatic-memory-pending'),
      alarms: await chrome.alarms.getAll()
    })));
    assert.ok(saved, 'The active website should save and index automatically without a capture command');
    const original = await tool('memory_read', { id: saved.memory.id });
    assert.match(original.content, /sunlight/); assert.doesNotMatch(original.content, /private field/);
    const recalled = await tool('memory_search', { query: 'harvest electrical power from sunshine', recall: true, limit: 5 });
    assert.ok(recalled.memories.some(item => item.id === saved.memory.id));
    await site.reload(); await site.bringToFront();
    await new Promise(resolve => setTimeout(resolve, 12000));
    const revisited = await tool('memory_search', { archive: true });
    assert.equal(revisited.total, 1); assert.equal(revisited.memories[0].id, saved.memory.id);
    assert.equal((await tool('memory_delete', { id: saved.memory.id })).deleted, true);
    await site.reload(); await site.bringToFront();
    await new Promise(resolve => setTimeout(resolve, 12000));
    assert.equal((await tool('memory_search', { archive: true })).total, 0, 'A deleted automatic page stays forgotten');
    const after = await tool('memory_search', { query: 'sunlight' }); assert.equal(after.total, 0);
    console.log('Loaded Chrome extension + actual Hindsight: automatic connection and saving, pause UI, repeat-visit deduplication, official SDK indexing, semantic recall, original text and persistent deletion passed.');
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (bank) await client.deleteBank(bank, { signal: AbortSignal.timeout(30000) });
    // Only the freshly created test directory under the workspace runtime root is removed.
    assert.equal(path.dirname(temporary), root); fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
