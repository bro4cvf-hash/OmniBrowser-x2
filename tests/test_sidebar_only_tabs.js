const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const event = () => ({ addListener() {}, removeListener() {} });
const ownId = 'a'.repeat(32);
let creates = 0, updates = 0, attachments = 0, commands = 0;
const chrome = {
  runtime: { id: ownId, onMessage: event(), onConnect: event(),
    connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }) },
  tabs: { onUpdated: event(), onRemoved: event(),
    create: async ({ url }) => { creates++; return { id: 7, url }; },
    update: async (id, { url }) => { updates++; return { id, url, status: 'complete' }; } },
  debugger: { onEvent: event(), onDetach: event(),
    attach: async () => { attachments++; },
    sendCommand(target, method, args, callback) { commands++; callback({}); } }
};
const context = vm.createContext({ chrome, console: { log() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
vm.runInContext(fs.readFileSync('extensions/chrome/background.js', 'utf8'), context);
(async () => {
  const blocked = [
    'chrome-extension://' + ownId + '/sidepanel.html',
    'chrome-extension://' + ownId + '/sidepanel.html?task=legacy',
    'chrome-extension://' + ownId + '/popup.html',
    'chrome-extension://' + ownId,
    'CHROME-EXTENSION://' + ownId.toUpperCase() + '/sidepanel.html',
    ' \nchrome-extension://' + ownId + '/sidepanel.html\t',
    'view-source:chrome-extension://' + ownId + '/sidepanel.html'
  ];
  for (const url of blocked) {
    context.targetUrl = url;
    await assert.rejects(vm.runInContext('createTab(targetUrl)', context), /only in the sidebar/);
    await assert.rejects(vm.runInContext('navigate(7, targetUrl)', context), /only in the sidebar/);
    for (const method of ['Page.navigate', 'Target.createTarget']) {
      context.method = method;
      await assert.rejects(vm.runInContext('sendDebuggerCommand(7, method, { url: targetUrl })', context), /only in the sidebar/);
    }
  }
  assert.deepEqual({ creates, updates, attachments, commands }, { creates: 0, updates: 0, attachments: 0, commands: 0 },
    'Blocked OmniBrowser URLs never reach Chrome tab or debugger APIs');
  const created = await vm.runInContext('createTab("https://example.com")', context);
  assert.equal(created.url, 'https://example.com');
  await vm.runInContext('createTab()', context);
  const navigated = await vm.runInContext('navigate(7, "https://example.com/form")', context);
  assert.equal(navigated.navigated, true);
  assert.equal(creates, 2);
  assert.equal(updates, 1);
  console.log('OmniBrowser tab creation and navigation blocked across tab and debugger controls; website tabs still work.');
})().catch(error => { console.error(error); process.exitCode = 1; });
