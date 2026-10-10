// Check popup connection states and clipboard feedback without Chrome.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
async function check(response, error, copyFails = false) {
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { addEventListener(_, callback) { this.click = callback; } });
    return elements.get(id);
  } };
  const chrome = { runtime: { id: 'a'.repeat(32), lastError: error,
    sendMessage(_, callback) { callback(response); } } };
  let copied;
  const navigator = { clipboard: { async writeText(text) {
    copied = text;
    if (copyFails) throw new Error('Clipboard unavailable');
  } } };
  vm.runInNewContext(fs.readFileSync('extensions/chrome/popup.js', 'utf8'), { document, chrome, navigator, setInterval() {} });
  const connected = !error && response?.connected && response?.relayAvailable;
  assert.equal(elements.get('status').className, `status ${connected ? 'connected' : 'disconnected'}`);
  await elements.get('copyCommand').click();
  assert.equal(elements.get('copyCommand').disabled, false);
  assert.match(elements.get('copyFeedback').textContent, copyFails ? /manually/ : /Copied/);
  assert.equal(copied, 'omnibrowser install-host --extension-id ' + 'a'.repeat(32));
  if (connected && response.mcpConfig) {
    await elements.get('copyConfig').click();
    assert.deepEqual(JSON.parse(copied), response.mcpConfig);
  }
}
(async () => {
  await check({ connected: true, relayAvailable: false });
  await check({ connected: true, relayAvailable: true, mcpConfig: { mcpServers: { omnibrowser: { command: 'test.exe', args: ['--mcp', '--extension'] } } } });
  await check({ connected: false });
  await check(undefined, { message: 'Unavailable' }, true);
  console.log('Popup connection and copy checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
