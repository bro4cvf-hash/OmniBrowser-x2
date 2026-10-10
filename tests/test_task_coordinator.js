const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sessionApi = require('../extensions/chrome/task-session.js');

(async () => {
  const local = {}, temporary = {};
  const area = data => ({
    get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values)),
    remove: async key => { delete data[key]; }
  });
  let listener, liveClient = null;
  const context = vm.createContext({ crypto, Date, OmniTaskSession: sessionApi,
    chrome: { runtime: { id: 'extension', getURL: path => 'chrome-extension://extension/' + path,
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async message => message.clientId === liveClient ? { alive: true, status: 'running' } : undefined },
      storage: { local: area(local), session: area(temporary) },
      tabs: { create() { throw new Error('Unexpected workspace tab'); }, update() { throw new Error('Unexpected workspace navigation'); } }
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../extensions/chrome/task-coordinator.js'), 'utf8'), context);
  const sender = { id: 'extension', url: 'chrome-extension://extension/sidepanel.html' };
  const send = (message, from = sender) => new Promise(resolve => listener(message, from, resolve));
  const first = await send({ type: 'taskStart', clientId: 'sidebar-one', payload: { prompt: 'Prepare form', remember: true } });
  assert.equal(first.success, true);
  assert.equal(first.result.owner.clientId, 'sidebar-one');
  assert.equal(first.result.owner.tabId, undefined);
  liveClient = 'sidebar-one';
  local['omniTask:' + first.result.owner.id].status = 'running';
  const second = await send({ type: 'taskStart', clientId: 'sidebar-two', payload: { prompt: 'Duplicate' } });
  assert.equal(second.success, false, 'Two sidebars cannot run tasks simultaneously');
  liveClient = null;
  const closed = await send({ type: 'taskCurrent' });
  assert.equal(closed.result.record.status, 'unknown');
  const resumed = await send({ type: 'taskStart', clientId: 'sidebar-two',
    payload: { prompt: 'Recover', remember: false, recovery: closed.result.record } });
  assert.equal(resumed.success, true);
  assert.equal(resumed.result.record.taskId, first.result.record.taskId);
  assert.equal(local.omniTaskOwner, undefined);
  assert.equal(local['omniTask:' + first.result.owner.id], undefined);
  const denied = await send({ type: 'taskStart', clientId: 'intruder', payload: { prompt: 'Run' } },
    { id: 'other', url: 'https://example.com' });
  assert.equal(denied.success, false);
  temporary.omniTaskOwner = { id: 'legacy-task', tabId: 7, persistent: false };
  temporary['omniTask:legacy-task'] = { id: 'legacy-task', status: 'running',
    journal: [{ name: 'click', write: true, status: 'dispatching' }] };
  const legacy = await send({ type: 'taskCurrent' });
  assert.equal(legacy.result.record.status, 'unknown', 'Legacy workspaces restore for sidebar recovery');
  assert.equal(legacy.result.record.journal[0].status, 'unknown');
  console.log('Sidebar task coordination, duplicate prevention, closure and legacy recovery passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
