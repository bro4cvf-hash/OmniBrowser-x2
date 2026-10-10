const assert = require('node:assert/strict');
const { run, executeCalls, tools } = require('../extensions/chrome/sidebar-agent.js');
const { Subagents } = require('../extensions/chrome/sidebar-subagents.js');
const settings = { baseUrl: 'https://provider.example/v1', model: 'test', browserTools: true, fileTools: true, streaming: false };
const response = message => ({ ok: true, json: async () => ({ choices: [{ message }] }) });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
(async () => {
  let parentRounds = 0, childRounds = 0, checkpoint, observed = [], childRequests = [];
  const fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body);
    const child = /You are an isolated/.test(body.messages[0].content);
    if (child) {
      childRequests.push(body);
      assert.ok(!JSON.stringify(body.messages).includes('PARENT_PRIVATE_DETAIL'));
      assert.ok(!body.tools.some(t => ['click', 'navigate', 'delegate_task', 'request_user_input'].includes(t.function.name)));
      if (++childRounds === 1) return response({ tool_calls: [call('r', 'read_page', { tabId: 7 }), call('w', 'click', { tabId: 7, selector: '#submit' })] });
      assert.match(body.messages.at(-1).content, /Unsupported/);
      return response({ content: 'Verified source https://example.com; CHILD_ONLY_FINDING' });
    }
    if (++parentRounds === 1) return response({ tool_calls: [call('d', 'delegate_task', { task: 'Inspect tab 7 for evidence' })] });
    assert.match(body.messages.at(-1).content, /CHILD_ONLY_FINDING/);
    assert.ok(!JSON.stringify(body.messages).includes('RAW_CHILD_DOCUMENT'));
    return response({ content: 'Done' });
  };
  const history = await run({ settings, history: [], prompt: 'PARENT_PRIVATE_DETAIL research', fetchImpl,
    executeTool: async name => { observed.push(name); return { text: 'RAW_CHILD_DOCUMENT' }; },
    onEvent: event => { if (event.type === 'checkpoint') checkpoint = structuredClone(event); } });
  assert.deepEqual(observed, ['read_page'], 'Invented child writes never reach executor');
  assert.equal(history.at(-1).content, 'Done');
  const session = checkpoint.contextState.subagents[0];
  assert.equal(session.status, 'complete');
  assert.ok(JSON.stringify(session.history).includes('RAW_CHILD_DOCUMENT'));
  const restored = new Subagents({ state: checkpoint.contextState.subagents, run: async ({ session }) => {
    assert.ok(session.history.length > 0); return [...session.history, { role: 'assistant', content: 'Resumed' }];
  } });
  const index = session.history.findIndex(m => m.role === 'tool' && m.content.includes('RAW_CHILD_DOCUMENT'));
  assert.match(restored.read({ taskId: session.id, index }).content, /RAW_CHILD_DOCUMENT/);
  assert.equal((await restored.delegate({ taskId: session.id, task: 'Check again' })).report, 'Resumed');
  await assert.rejects(restored.delegate({ taskId: 'missing', task: 'Check' }), /Unknown/);
  await assert.rejects(restored.delegate({ taskId: session.id, task: 'Check', role: 'verify' }), /original/);
  const releases = [];
  const concurrent = new Subagents({ run: () => new Promise(resolve => releases.push(() => resolve([{ role: 'assistant', content: 'ok' }]))) });
  const jobs = [1, 2, 3].map(i => concurrent.delegate({ task: 'Read ' + i }));
  assert.equal(concurrent.active.size, 3);
  await assert.rejects(concurrent.delegate({ task: 'Fourth' }), /Three/);
  await assert.rejects(concurrent.delegate({ taskId: concurrent.state()[0].id, task: 'Duplicate' }), /Three|already running/);
  releases.forEach(release => release()); await Promise.all(jobs);
  assert.equal(concurrent.active.size, 0);
  const controller = new AbortController();
  const stopped = new Subagents({ signal: controller.signal, run: ({ signal, onCheckpoint }) => {
    onCheckpoint({ history: [{ role: 'user', content: 'retained' }], contextState: {} });
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
  } });
  const pending = stopped.delegate({ task: 'Read' }); controller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(stopped.state()[0].status, 'interrupted');
  assert.equal(stopped.state()[0].history[0].content, 'retained');
  let rounds = 0, limitedState;
  await run({ settings: { ...settings, maxRounds: 1 }, history: [], prompt: 'Delegate',
    onEvent: event => { if (event.type === 'checkpoint') limitedState = event.contextState; },
    executeTool: async () => ({ text: 'evidence' }), fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body); rounds++;
      return response({ tool_calls: [body.messages[0].content.includes('You are an isolated') ? call('read', 'read_page', { tabId: 7 }) : call('delegate', 'delegate_task', { task: 'Read' })] });
    } });
  assert.equal(rounds, 2); assert.equal(limitedState.subagents[0].status, 'failed');
  assert.match(limitedState.subagents[0].error, /without a final report/);
  const failedResume = new Subagents({ state: restored.state(), run: async () => { throw new Error('Provider offline'); } });
  const failure = await failedResume.delegate({ taskId: session.id, task: 'Retry' });
  assert.equal(failure.status, 'failed'); assert.equal(failure.report, '');
  const ordered = [];
  await executeCalls([call('before', 'click', { tabId: 1, selector: '#before' }),
    call('child1', 'delegate_task', { task: 'First' }), call('child2', 'delegate_task', { task: 'Second' }),
    call('after', 'click', { tabId: 2, selector: '#after' })], {
    parallel: true, allowedTools: [...tools, { type: 'function', function: { name: 'delegate_task' } }], ledger: [], onEvent() {},
    executeTool: async (name, args) => {
      ordered.push(args.selector || args.task);
      if (name === 'delegate_task') {
        await new Promise(resolve => setTimeout(resolve, 10)); ordered.push(args.task + ' done');
      }
      return { completed: true };
    }
  });
  assert.equal(ordered[0], '#before'); assert.equal(ordered.at(-1), '#after');
  assert.ok(ordered.indexOf('Second') < ordered.indexOf('First done'), 'Independent children execute concurrently');
  // Deferred MCP discovery cannot expose writes to children.
  let childStep = 0;
  await run({ settings, history: [], prompt: 'Research',
    mcpTools: ['safe', 'unsafe'].map(name => ({ mcpServer: 'fixture', readOnly: name === 'safe', type: 'function', function: { name: 'mcp__' + name, description: name, parameters: { type: 'object' } } })),
    onEvent() {}, executeTool: async () => { throw new Error('Unexpected executor'); },
    fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      if (body.messages[0].content.includes('You are an isolated')) {
        if (++childStep === 1) return response({ tool_calls: [call('discover', 'mcp_search', { query: '' })] });
        assert.ok(body.tools.some(t => t.function.name === 'mcp__safe'));
        assert.ok(!body.tools.some(t => t.function.name === 'mcp__unsafe'));
        return response({ content: 'Safe tools discovered' });
      }
      return body.messages.some(m => m.role === 'tool') ? response({ content: 'Done' }) : response({ tool_calls: [call('delegate', 'delegate_task', { task: 'Discover' })] });
    } });
  console.log('Sub-agent isolation, source recovery, resume, concurrency, cancellation, budgets and MCP restrictions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
