const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sessionApi = require('../extensions/chrome/task-session.js');

async function fixture(status = 'completed', live = false) {
  const record = { id: 'task', chatId: 'chat', prompt: 'Prepare form', status,
    history: [], transcript: [], activity: 'Saved activity', usage: '500 tokens', journal: [] };
  const owner = { id: 'task', clientId: 'previous-sidebar', persistent: true };
  const data = { 'omniTask:task': record, omniTaskOwner: owner };
  const elements = new Map();
  const area = { get: async key => key === null ? structuredClone(data) : ({ [key]: structuredClone(data[key]) }),
    set: async patch => Object.assign(data, structuredClone(patch)),
    remove: async keys => { for (const key of [keys].flat()) delete data[key]; } };
  let runs = 0, listener, ownedStart;
  const messages = [];
  const context = vm.createContext({ structuredClone, crypto, setTimeout, clearTimeout,
    OmniTaskSession: sessionApi, location: { protocol: 'chrome-extension:', search: '' },
    chrome: { runtime: { id: 'extension', getURL: path => 'chrome-extension://extension/' + path,
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async message => {
        messages.push(message);
        if (message.type === 'taskCurrent') {
          const restored = !live && sessionApi.ACTIVE.has(record.status) ? sessionApi.interrupted(record) : record;
          return { success: true, result: { owner, record: restored, live } };
        }
        if (message.type === 'taskStart') return { success: true, result: {
          owner: { id: 'next-task', clientId: message.clientId, persistent: message.payload.remember },
          record: { ...message.payload, id: 'next-task', taskId: 'next-task', status: 'starting', journal: message.payload.recovery?.journal || [] }
        } };
        return { success: true };
      } }, storage: { local: area, session: area, onChanged: { addListener() {} } },
      tabs: { query: async () => [{ id: 7, url: 'https://example.com/form' }],
        create() { throw new Error('Tasks must never create a workspace tab'); } } },
    document: {}, chats: [], chatId: 'chat', currentRunState: 'idle', controller: null, submissionPending: false,
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    nearBottom: () => true, openChat() {}, setRunState(state) { context.currentRunState = state; },
    runTask: async (prompt, owned) => {
      runs++; ownedStart = owned;
      context.currentRunState = 'completed';
      await context.OmniTaskClient.session.save({ status: 'completed' });
    },
    appendMessage() {}, saveSettings: async () => {}, settings: () => ({ rememberChats: true }),
    serializeTranscript: () => [], history: [], contextState: {}, currentOriginTab: null, lastActiveTabId: null });
  vm.runInContext(fs.readFileSync(require.resolve('../extensions/chrome/task-client.js'), 'utf8'), context);
  await context.OmniTaskClient.initialize();
  return { context, data, elements, messages, listener, get runs() { return runs; }, get ownedStart() { return ownedStart; } };
}

(async () => {
  for (const status of ['completed', 'failed', 'stopped', 'unknown']) {
    const restored = await fixture(status);
    assert.equal(restored.context.currentRunState, status);
    assert.equal(restored.context.OmniTaskClient.session.record.status, status);
    assert.equal(restored.runs, 0, 'Reopening the sidebar never replays settled tasks');
    assert.equal(restored.elements.get('taskUsage').textContent, '500 tokens');
  }
  for (const status of ['running', 'waiting']) {
    const restored = await fixture(status);
    assert.equal(restored.context.currentRunState, 'unknown', 'Closed sidebar work requires recovery');
    assert.equal(restored.runs, 0);
  }
  const panel = await fixture();
  await panel.context.OmniTaskClient.start('Prepare another form');
  assert.equal(panel.runs, 1, 'The submitting sidebar executes the task itself');
  assert.equal(panel.ownedStart, true);
  assert.equal(panel.context.OmniTaskClient.session.record.status, 'completed');
  const start = panel.messages.find(message => message.type === 'taskStart');
  assert.ok(start.clientId);
  let pong;
  panel.listener({ type: 'taskPing', id: 'next-task', clientId: start.clientId }, { id: 'extension' }, reply => { pong = reply; });
  assert.equal(pong.alive, true);
  await panel.context.OmniTaskClient.disablePersistence();
  assert.equal(panel.context.OmniTaskClient.session.storage, panel.context.chrome.storage.session);
  assert.equal(Object.keys(panel.data).some(key => key.startsWith('omniTask:') || key === 'omniTaskOwner' && panel.data[key].persistent), false);
  panel.context.OmniTaskClient.detach();
  assert.equal(panel.context.OmniTaskClient.session, null, 'New chat releases the previous checkpoint');
  const observer = await fixture('waiting', true);
  assert.equal(observer.context.OmniTaskClient.session, null, 'A second sidebar cannot adopt active execution');
  assert.equal(observer.context.OmniTaskClient.remoteActive, true);
  assert.match(observer.elements.get('activity').textContent, /sidebar where you started/);
  assert.equal(observer.runs, 0);
  console.log('Sidebar execution, checkpoint restoration, exclusive ownership and privacy passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
