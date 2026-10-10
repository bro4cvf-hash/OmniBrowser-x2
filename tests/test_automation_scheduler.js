const assert = require('node:assert/strict');
const { executeCalls, tools, unwrapObservation } = require('../extensions/chrome/sidebar-agent.js');
const parseToolContent = content => JSON.parse(typeof unwrapObservation === 'function' ? unwrapObservation(content) : content);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const options = { parallel: true, allowedTools: tools, onEvent() {} };

(async () => {
  const researchGate = deferred(), researchStarted = [];
  const research = executeCalls([
    call('search1', 'search_web', { query: 'first', tabId: 7 }),
    call('search2', 'search_web', { query: 'second', tabId: 7 }),
    call('fetch', 'fetch_web', { urls: ['https://example.com'], tabId: 7 }),
    call('browser', 'read_page', { tabId: 7 })
  ], { ...options, parallelLimit: 4, executeTool: async name => {
    researchStarted.push(name); await researchGate.promise; return { mode: 'headless' };
  } });
  await tick();
  assert.equal(researchStarted.length, 4, 'Background research must not serialize behind browser or other searches');
  researchGate.resolve();
  await research;

  const navigation = deferred(), started = [];
  const scheduled = executeCalls([
    call('nav', 'navigate', { tabId: 7, url: 'https://example.com' }),
    call('same', 'read_page', { tabId: 7 }),
    call('other', 'read_page', { tabId: 8 }),
    call('file', 'files_extract', { path: 'profile.txt' })
  ], { ...options, executeTool: async (name, args) => {
    started.push(name + (args.tabId || ''));
    if (name === 'navigate') await navigation.promise;
    return {};
  } });
  await tick();
  assert.deepEqual([...started].sort(), ['files_extract', 'navigate7', 'read_page8']);
  navigation.resolve();
  assert.deepEqual((await scheduled).map(item => item.tool_call_id), ['nav', 'same', 'other', 'file']);
  assert.equal(started.at(-1), 'read_page7');

  const fieldCalls = [1, 2, 3].map(index => call('field' + index, 'fill', { tabId: 7, frameId: index === 3 ? 2 : 0, selector: '#field' + index, value: 'value' }));
  let batches = 0;
  const events = [];
  const batched = await executeCalls(fieldCalls, { ...options, onEvent: event => events.push(event), executeTool: async (name, args) => {
    assert.equal(name, 'batch_actions'); batches++;
    assert.equal(args.actions.length, 3);
    assert.deepEqual(args.actions.map(item => item.frameId), [0, 0, 2]);
    return { completed: false, failed_index: 1, error: 'Field hidden', results: [{ completed: true }], page: { text: 'Updated page' } };
  } });
  assert.equal(batches, 1);
  assert.deepEqual(batched.map(item => item.tool_call_id), fieldCalls.map(item => item.id));
  assert.equal(parseToolContent(batched[0].content).completed, true);
  assert.equal(parseToolContent(batched[1].content).skipped, false);
  assert.equal(parseToolContent(batched[2].content).skipped, true);
  assert.equal(parseToolContent(batched[2].content).page.text, 'Updated page');
  assert.equal(events[0].count, 3);

  const actions = [];
  await executeCalls([fieldCalls[0], call('inspect', 'read_page', { tabId: 7 }), fieldCalls[1]], {
    ...options, executeTool: async name => { actions.push(name); return {}; }
  });
  assert.deepEqual(actions, ['fill', 'read_page', 'fill']);
  let reads = 0;
  await executeCalls([call('read1', 'read_page', { tabId: 7 }), call('read2', 'read_page', { tabId: 7 })], {
    ...options, executeTool: async () => ({ version: ++reads })
  });
  assert.equal(reads, 2, 'Explicit reads must observe dynamic pages afresh');

  const serial = [];
  await executeCalls([call('tab', 'new_tab', { url: 'https://example.com' }), call('file', 'files_extract', { path: 'file' })], {
    ...options, parallel: false, executeTool: async name => { serial.push('start ' + name); await tick(); serial.push('end ' + name); return {}; }
  });
  assert.deepEqual(serial, ['start new_tab', 'end new_tab', 'start files_extract', 'end files_extract']);

  const readGroup = deferred(), groupOrder = [];
  const grouped = executeCalls([call('pages', 'read_pages', { tabIds: [7, 8] }), call('click', 'click', { tabId: 8, selector: '#next' }), call('free', 'read_page', { tabId: 9 })], {
    ...options, executeTool: async name => { groupOrder.push(name); if (name === 'read_pages') await readGroup.promise; return {}; }
  });
  await tick(); assert.deepEqual(groupOrder, ['read_pages', 'read_page']);
  readGroup.resolve(); await grouped; assert.equal(groupOrder.at(-1), 'click');

  const controller = new AbortController(), inFlight = deferred();
  let executions = 0, finished = false;
  const cancelled = executeCalls(Array.from({ length: 8 }, (_, index) => call('cancel' + index, 'files_extract', { path: 'file' + index })), {
    ...options, parallelLimit: 2, signal: controller.signal,
    executeTool: async () => { executions++; await inFlight.promise; return {}; }
  });
  const drained = cancelled.then(results => { finished = true; return results; });
  await tick(); assert.equal(executions, 2);
  controller.abort(); await tick(); assert.equal(finished, false, 'Wait for running actions before finishing cancellation');
  inFlight.resolve(); const stoppedResults = await drained;
  assert.equal(executions, 2, 'Queued actions must not execute after Stop');
  assert.equal(stoppedResults.length, 8, 'Keep a matching result for each tool call when stopped');
  assert.ok(stoppedResults.slice(2).every(result => parseToolContent(result.content).skipped));

  const invalid = await executeCalls([call('bad', 'read_page', null), call('unsupported', 'delete_everything')], {
    ...options, executeTool: async () => { throw new Error('Must not execute'); }
  });
  assert.match(invalid[0].content, /Invalid tool arguments/);
  assert.match(invalid[1].content, /Unsupported/);
  console.log('Automation scheduling: independent navigation, field batching, ordering, fresh reads and cancellation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
