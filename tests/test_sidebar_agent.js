const assert = require('node:assert/strict');
const { endpoint, run, listModels, readCompletion, executeCalls, tools, parseRetryAfter, isIdempotent } = require('../extensions/chrome/sidebar-agent.js');
const settings = { baseUrl: 'https://provider.example/v1', model: 'test-model', apiKey: 'test-secret', browserTools: true };
const response = message => ({ ok: true, json: async () => ({ choices: [{ message }] }) });
(async () => {
  let failedRequests = 0;
  await assert.rejects(run({ settings, history: [], prompt: 'Find sources', onEvent() {},
    executeTool: async () => { throw new Error('Provide a search query of 1 to 500 characters'); },
    fetchImpl: async () => {
      failedRequests++;
      return response({ content: null, tool_calls: [{ id: `bad${failedRequests}`, type: 'function',
        function: { name: 'search_web', arguments: JSON.stringify({ query: `different ${failedRequests}` }) } }] });
    }
  }), /failed three times.*Provide a search query/);
  assert.equal(failedRequests, 3, 'Changing failed arguments must not bypass the progress limit');
  let locatorRounds = 0, locatorWrites = 0;
  await assert.rejects(run({ settings, history: [], prompt: 'Fill the contact form', onEvent() {},
    executeTool: async name => {
      if (name === 'form_inspect') return { elements: [{ ref: '@e1', selector: 'input[name="your-full-name"]', frameId: 0 }] };
      locatorWrites++;
      return { completed: false, failed_index: 0, results: [], error: 'Action timeout after 5000ms: element not found' };
    },
    fetchImpl: async () => {
      const round = ++locatorRounds;
      const name = round % 2 ? 'form_inspect' : round === 2 ? 'batch_actions' : round === 4 ? 'browser_step' : 'fill';
      const field = { action: 'fill', selector: 'input[name=\\"your-full-name\\"]', value: 'Example Person' };
      const args = name === 'form_inspect' ? { tabId: 7 } : name === 'fill' ? { tabId: 7, ...field } : { tabId: 7, actions: [field] };
      return response({ content: null, tool_calls: [{ id: `locator${round}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    }
  }), /Field lookup failed three times/);
  assert.equal(locatorRounds, 6, 'Interleaved form inspections cannot hide repeated lookup failures');
  assert.equal(locatorWrites, 3, 'Changing between fill, batch and browser_step cannot hide failed lookups');
  let timeoutRequests = 0;
  await assert.rejects(run({ settings, history: [], prompt: 'Find sources', onEvent() {},
    executeTool: async () => { throw new Error('Background research timed out after 30 seconds.'); },
    fetchImpl: async () => {
      timeoutRequests++;
      return response({ content: null, tool_calls: [{ id: 'timeout-search', type: 'function',
        function: { name: 'search_web', arguments: '{"query":"valid search"}' } }] });
    }
  }), /Background research timed out/);
  assert.equal(timeoutRequests, 1, 'Research timeout must end the task without another model wait');
  assert.equal(endpoint('https://provider.example/v1/'), 'https://provider.example/v1/chat/completions');
  assert.equal(endpoint('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1/chat/completions');
  assert.throws(() => endpoint('http://provider.example/v1'), /HTTPS/);
  assert.throws(() => endpoint('https://user:secret@provider.example/v1'), /credentials/);
  const models = await listModels(settings, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://provider.example/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }, null, { name: 'invalid' }] }) };
  } });
  assert.deepEqual(models, ['a-model', 'z-model']);
  await listModels({ baseUrl: 'http://localhost:1234/v1/chat/completions', apiKey: '' }, { fetchImpl: async (url, options) => {
    assert.equal(url, 'http://localhost:1234/v1/models');
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, json: async () => ({ data: [{ id: 'local-model' }] }) };
  } });
  await assert.rejects(listModels(settings, { fetchImpl: async () => ({ ok: false, status: 401 }) }), /API key/);
  await assert.rejects(listModels(settings, { fetchImpl: async () => ({ ok: false, status: 404 }) }), /model discovery/);
  const requests = [], events = [], actions = [];
  const history = await run({ settings, history: [], prompt: 'Read my page', onEvent: event => events.push(event),
    executeTool: async (name, args) => { actions.push({ name, args }); return { text: 'Real page content' }; },
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.equal(options.redirect, 'error');
      if (requests.length === 1) return response({ content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_page', arguments: '{"tabId":7}' } }] });
      assert.equal(requests[1].messages.at(-1).tool_call_id, 'call1');
      assert.match(requests[1].messages.at(-1).content, /Real page content/);
      return response({ content: 'Summary of the page.' });
    }
  });
  assert.deepEqual(actions, [{ name: 'read_page', args: { tabId: 7 } }]);
  assert.equal(history.at(-1).content, 'Summary of the page.');
  assert.equal(events.at(-1).type, 'assistant');
  await run({ settings: { ...settings, browserTools: false, apiKey: '' }, history: [], prompt: 'Hello', onEvent() {},
    executeTool: async () => { throw new Error('Must not run'); },
    fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      assert.ok(body.tools.some(tool => tool.function.name === 'request_user_input'));
      assert.ok(!body.tools.some(tool => tool.function.name === 'click'));
      assert.equal(options.headers.Authorization, undefined);
      return response({ content: 'Hello!' });
    }
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run({ settings, history: [], prompt: 'Stop', signal: controller.signal, onEvent() {}, fetchImpl() { throw new Error('Must not call'); } }), /abort/i);
  await assert.rejects(run({ settings, history: [], prompt: 'Hi', onEvent() {}, fetchImpl: async () => ({ ok: false, status: 401 }) }), /API key/);
  let unknownCalls = 0, rounds = 0;
  await run({ settings, history: [], prompt: 'Hi', onEvent() {}, executeTool: async () => { unknownCalls++; },
    fetchImpl: async (_, options) => {
      if (++rounds === 1) return response({ content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'executeScript', arguments: '{}' } }] });
      assert.match(JSON.parse(options.body).messages.at(-1).content, /Unsupported/);
      return response({ content: 'Unsupported action.' });
    }
  });
  assert.equal(unknownCalls, 0);
  const streamEvents = [];
  const chunks = [
    { choices: [{ delta: { content: 'Hello **' } }] },
    { choices: [{ delta: { content: 'world** 🦊' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'stream1', type: 'function', function: { name: 'read_page', arguments: '{"tab' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":7}' } }] }, finish_reason: 'tool_calls' }] }
  ];
  const wire = chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(wire);
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } });
  const completed = await readCompletion(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), event => streamEvents.push(event), 3);
  assert.equal(completed.data.choices[0].message.content, 'Hello **world** 🦊');
  assert.equal(completed.data.choices[0].message.tool_calls[0].function.arguments, '{"tabId":7}');
  assert.equal(streamEvents.length, 2);
  const early = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(readCompletion(early, () => {}, 0), /ended early/);
  let active = 0, peak = 0;
  const fileCalls = Array.from({ length: 8 }, (_, index) => ({ id: 'file' + index, function: { name: 'files_extract', arguments: JSON.stringify({ path: 'doc' + index }) } }));
  const parallelResults = await executeCalls(fileCalls, { parallel: true, allowedTools: tools, onEvent() {},
    executeTool: async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return { content: 'Document' }; }
  });
  assert.equal(peak, 8);
  assert.deepEqual(parallelResults.map(result => result.tool_call_id), fileCalls.map(call => call.id));
  const order = [];
  const fills = [1, 2].map(index => ({ id: 'fill' + index, function: { name: 'fill', arguments: JSON.stringify({ tabId: 7, selector: '#field' + index, value: 'x' }) } }));
  await executeCalls(fills, { parallel: true, allowedTools: tools.filter(tool => tool.function.name !== "batch_actions"), onEvent() {}, executeTool: async (_, args) => { order.push('start' + args.selector); await new Promise(resolve => setImmediate(resolve)); order.push('end' + args.selector); return {}; } });
  assert.deepEqual(order, ['start#field1', 'end#field1', 'start#field2', 'end#field2']);
  const manyCalls = Array.from({ length: 24 }, (_, index) => ({ id: 'many' + index, type: 'function', function: { name: 'files_extract', arguments: '{"path":"document"}' } }));
  let manyRound = 0, manyActive = 0, manyPeak = 0;
  await run({ settings: { ...settings, fileTools: true }, history: [], prompt: 'Read documents', onEvent() {},
    executeTool: async () => { manyPeak = Math.max(manyPeak, ++manyActive); await new Promise(resolve => setImmediate(resolve)); manyActive--; return { content: 'Document' }; },
    fetchImpl: async (_, options) => {
      if (!manyRound++) return response({ content: null, tool_calls: manyCalls });
      assert.equal(JSON.parse(options.body).messages.filter(message => message.role === 'tool').length, 24);
      return response({ content: 'Done' });
    }
  });
  assert.equal(manyPeak, 12);
  let retried = 0;
  await assert.rejects(run({ settings, history: [], prompt: 'Continue', onEvent() {}, executeTool() {},
    fetchImpl: async () => { retried++; return { ok: false, status: 400, text: async () => 'context length exceeded' }; }
  }), /could not be reduced safely/);
  assert.equal(retried, 1); // Never loop when no history can actually be reduced.
  let configuredActive = 0, configuredPeak = 0;
  await executeCalls(fileCalls, { parallel: true, parallelLimit: 4, allowedTools: tools, onEvent() {},
    executeTool: async () => { configuredPeak = Math.max(configuredPeak, ++configuredActive); await new Promise(resolve => setImmediate(resolve)); configuredActive--; return {}; }
  });
  assert.equal(configuredPeak, 4);
  let configuredRounds = 0;
  const boundedHistory = await run({ settings: { ...settings, maxRounds: 1 }, history: [], prompt: 'Read', onEvent() {}, executeTool: async () => ({}),
    fetchImpl: async () => { configuredRounds++; return response({ content: null, tool_calls: [{ id: 'bounded', type: 'function', function: { name: 'current_tab', arguments: '{}' } }] }); }
  });
  assert.equal(configuredRounds, 1);
  assert.match(boundedHistory.at(-1).content, /Completed 1 tool rounds/);
  const sentFrom = { id: 42, title: 'Contact Sales', url: 'https://example.com/contact', windowId: 3 };
  const focusedHistory = await run({ settings, history: [], prompt: 'Fill this form', originTab: sentFrom, onEvent() {}, executeTool() {},
    fetchImpl: async (_, options) => {
      const messages = JSON.parse(options.body).messages;
      assert.match(messages[0].content, /active when the prompt was sent/);
      assert.match(messages.at(-1).content, /"tabId":42/);
      assert.match(messages.at(-1).content, /Contact Sales/);
      return response({ content: 'Using the form in tab 42.' });
    }
  });
  const newToolNames = ['hover', 'press_key', 'type_text', 'wait_for', 'handle_dialog', 'screenshot', 'upload_files', 'captcha_status', 'captcha_handoff'];
  for (const name of newToolNames) {
    const found = tools.find(t => t.function.name === name);
    assert.ok(found, `Tool schema for ${name} should be present in tools`);
    assert.equal(found.type, 'function');
    assert.ok(found.function.description);
    assert.equal(found.function.parameters.type, 'object');
  }
  const hoverTool = tools.find(t => t.function.name === 'hover');
  assert.deepEqual(hoverTool.function.parameters.required, ['tabId', 'selector']);
  const pressKeyTool = tools.find(t => t.function.name === 'press_key');
  assert.deepEqual(pressKeyTool.function.parameters.required, ['tabId', 'key']);
  assert.ok(pressKeyTool.function.parameters.properties.key.enum.includes('Enter'));
  const typeTextTool = tools.find(t => t.function.name === 'type_text');
  assert.deepEqual(typeTextTool.function.parameters.required, ['tabId', 'text']);
  const waitForTool = tools.find(t => t.function.name === 'wait_for');
  assert.deepEqual(waitForTool.function.parameters.required, ['tabId', 'selector']);
  assert.deepEqual(waitForTool.function.parameters.properties.state.enum, ['attached', 'visible', 'hidden']);
  const handleDialogTool = tools.find(t => t.function.name === 'handle_dialog');
  assert.deepEqual(handleDialogTool.function.parameters.required, ['tabId']);
  const screenshotTool = tools.find(t => t.function.name === 'screenshot');
  assert.deepEqual(screenshotTool.function.parameters.required, ['tabId']);
  const uploadFilesTool = tools.find(t => t.function.name === 'upload_files');
  assert.deepEqual(uploadFilesTool.function.parameters.required, ['tabId', 'selector', 'paths']);
  const captchaStatusTool = tools.find(t => t.function.name === 'captcha_status');
  assert.deepEqual(captchaStatusTool.function.parameters.required, ['tabId']);
  const captchaHandoffTool = tools.find(t => t.function.name === 'captcha_handoff');
  assert.deepEqual(captchaHandoffTool.function.parameters.required, ['tabId']);

  const newActions = [];
  const toolRunHistory = await run({
    settings, history: [], prompt: 'Hover and take screenshot', onEvent() {},
    executeTool: async (name, args) => { newActions.push({ name, args }); return { ok: true }; },
    fetchImpl: async (url, options) => {
      const parsed = JSON.parse(options.body);
      if (!parsed.messages.some(m => m.role === 'tool')) {
        return response({
          content: null,
          tool_calls: [
            { id: 'h1', type: 'function', function: { name: 'hover', arguments: '{"tabId":42,"selector":"#menu"}' } },
            { id: 's1', type: 'function', function: { name: 'screenshot', arguments: '{"tabId":42}' } }
          ]
        });
      }
      return response({ content: 'Hovered and captured screenshot.' });
    }
  });
  assert.equal(newActions.length, 2);
  assert.deepEqual(newActions[0], { name: 'hover', args: { tabId: 42, selector: '#menu' } });
  assert.deepEqual(newActions[1], { name: 'screenshot', args: { tabId: 42 } });
  assert.equal(toolRunHistory.at(-1).content, 'Hovered and captured screenshot.');

  // Item 24: Parse Retry-After headers (integer seconds and RFC 7231 HTTP-dates)
  assert.equal(parseRetryAfter('120'), 120000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('  5  '), 5000);
  const fixedNow = Date.parse('Wed, 21 Oct 2015 07:27:50 GMT');
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', fixedNow), 10000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:27:00 GMT', fixedNow), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('invalid-date'), null);
  assert.equal(parseRetryAfter('-5'), null);

  // Item 24: Isolate retries - idempotent vs non-idempotent
  assert.equal(isIdempotent('read_page'), true);
  assert.equal(isIdempotent('files_extract'), true);
  assert.equal(isIdempotent('browser_context'), true);
  assert.equal(isIdempotent('custom_read', { readOnly: true }), true);
  assert.equal(isIdempotent('click'), false);
  assert.equal(isIdempotent('fill'), false);
  assert.equal(isIdempotent('navigate'), false);
  assert.equal(isIdempotent('browser_step'), false);
  assert.equal(isIdempotent('batch_actions'), false);
  assert.equal(isIdempotent('custom_write', { readOnly: false }), false);

  // Non-idempotent uncertain writes are NEVER automatically retried
  let writeCallCount = 0;
  const writeCalls = [{ id: 'w1', function: { name: 'click', arguments: '{"tabId":1,"selector":"#btn"}' } }];
  const writeRes = await executeCalls(writeCalls, {
    parallel: true, allowedTools: tools, onEvent() {},
    executeTool: async () => {
      writeCallCount++;
      return { status: 429, error: 'HTTP 429 Too Many Requests' };
    }
  });
  assert.equal(writeCallCount, 1);
  assert.match(writeRes[0].content, /429/);

  // Idempotent calls CAN retry upon 429
  let idempotentCallCount = 0;
  const idempotentCalls = [{ id: 'r1', function: { name: 'read_page', arguments: '{"tabId":1}' } }];
  const idempRes = await executeCalls(idempotentCalls, {
    parallel: true, allowedTools: tools, onEvent() {},
    executeTool: async () => {
      idempotentCallCount++;
      if (idempotentCallCount === 1) return { status: 429, error: 'HTTP 429 Rate Limit' };
      return { text: 'Success Page' };
    }
  });
  assert.equal(idempotentCallCount, 2);
  assert.match(idempRes[0].content, /Success Page/);

  // Item 21: AIMD Concurrency scaling in executeCalls
  // 1. Halve concurrency upon receiving HTTP 429
  const aimd = { limit: 8, stableRounds: 0 };
  const callsForAimd = [
    { id: 'a1', function: { name: 'files_extract', arguments: '{"path":"file1"}' } }
  ];
  await executeCalls(callsForAimd, {
    parallel: true, parallelLimit: 8, allowedTools: tools, aimdState: aimd, onEvent() {},
    executeTool: async () => ({ status: 429, error: 'Too Many Requests' })
  });
  assert.equal(aimd.limit, 4); // 8 halved to 4
  assert.equal(aimd.stableRounds, 0);

  // 2. Additively recover (+1) after stable rounds
  const callsOk = [
    { id: 'ok1', function: { name: 'files_extract', arguments: '{"path":"file1"}' } }
  ];
  await executeCalls(callsOk, {
    parallel: true, parallelLimit: 8, allowedTools: tools, aimdState: aimd, onEvent() {},
    executeTool: async () => ({ content: 'OK' })
  });
  assert.equal(aimd.limit, 5); // Additively recovered: 4 -> 5
  assert.equal(aimd.stableRounds, 1);

  await executeCalls(callsOk, {
    parallel: true, parallelLimit: 8, allowedTools: tools, aimdState: aimd, onEvent() {},
    executeTool: async () => ({ content: 'OK' })
  });
  assert.equal(aimd.limit, 6); // Additively recovered: 5 -> 6
  assert.equal(aimd.stableRounds, 2);

  // 3. Halve concurrency upon latency spike > 3000ms
  const origNow = Date.now;
  let simulatedTime = 100000;
  Date.now = () => simulatedTime;
  try {
    await executeCalls(callsOk, {
      parallel: true, parallelLimit: 8, allowedTools: tools, aimdState: aimd, onEvent() {},
      executeTool: async () => {
        simulatedTime += 3500; // latency spike >3000ms
        return { content: 'OK' };
      }
    });
  } finally {
    Date.now = origNow;
  }
  assert.equal(aimd.limit, 3); // 6 halved to 3
  assert.equal(aimd.stableRounds, 0);

  // In request(): Full Jitter backoff and Retry-After parsing
  let reqAttempts = 0;
  const backoffEvents = [];
  await run({
    settings: { ...settings, retryBaseMs: 1, retryMaxMs: 5 },
    history: [], prompt: 'Retry test',
    onEvent: e => backoffEvents.push(e),
    executeTool: async () => ({}),
    fetchImpl: async (url, options) => {
      reqAttempts++;
      if (reqAttempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: h => h.toLowerCase() === 'retry-after' ? '0' : null }
        };
      }
      return response({ content: 'Recovered successfully.' });
    }
  });
  assert.equal(reqAttempts, 2);
  assert.ok(backoffEvents.some(e => e.type === 'progress' && /retrying/i.test(e.text)));

  // Item 2 & 21: Progressive Settlement & Batch Action Updates
  // 1. Emits action_settled immediately when individual tools finish, even before parallel jobs complete
  const progressiveEvents = [];
  let prog1SettledEarly = false;
  let unblockProg2;
  const prog2Gate = new Promise(resolve => { unblockProg2 = resolve; });
  const progressiveCalls = [
    { id: 'prog1', function: { name: 'files_extract', arguments: '{"path":"file1"}' } },
    { id: 'prog2', function: { name: 'files_extract', arguments: '{"path":"file2"}' } }
  ];
  const progExecution = executeCalls(progressiveCalls, {
    parallel: true, allowedTools: tools,
    onEvent(e) {
      progressiveEvents.push(e);
      if (e.type === 'action_settled' && e.id === 'prog1') {
        prog1SettledEarly = true;
        unblockProg2();
      }
    },
    executeTool: async (name, args) => {
      if (args.path === 'file1') {
        return { content: 'File 1 content' };
      }
      if (args.path === 'file2') {
        await prog2Gate;
        assert.ok(prog1SettledEarly, 'prog1 must have emitted action_settled before prog2 completes');
        return { content: 'File 2 content' };
      }
      return {};
    }
  });
  await progExecution;
  assert.ok(progressiveEvents.some(e => e.type === 'action_settled' && e.id === 'prog1' && e.completed === true));
  assert.ok(progressiveEvents.some(e => e.type === 'action_settled' && e.id === 'prog2' && e.completed === true));

  // 2. Partial outcomes in compound tools (batch_actions) are preserved in ledger and context
  const { ActionLedger } = require('../extensions/chrome/sidebar-ledger.js');
  const testLedger = new ActionLedger({ storageKey: 'test-progressive-ledger' });
  const batchCalls = [
    { id: 'batch_c1', type: 'function', function: { name: 'fill', arguments: '{"tabId":1,"selector":"#a","value":"valA"}' } },
    { id: 'batch_c2', type: 'function', function: { name: 'fill', arguments: '{"tabId":1,"selector":"#b","value":"valB"}' } },
    { id: 'batch_c3', type: 'function', function: { name: 'fill', arguments: '{"tabId":1,"selector":"#c","value":"valC"}' } }
  ];
  const batchSettledEvents = [];
  await executeCalls(batchCalls, {
    parallel: true, allowedTools: tools, ledger: testLedger,
    onEvent(e) { batchSettledEvents.push(e); },
    executeTool: async (name, args) => {
      assert.equal(name, 'batch_actions');
      // Subaction 0 succeeds, subaction 1 fails, subaction 2 skipped
      return {
        completed: false,
        failed_index: 1,
        error: 'Control #b not visible',
        results: [{ completed: true }]
      };
    }
  });
  const act0 = testLedger.get('batch_c1_action_0');
  const act1 = testLedger.get('batch_c1_action_1');
  const act2 = testLedger.get('batch_c1_action_2');
  assert.equal(act0?.status, 'completed', 'Completed subaction must be completed in ledger');
  assert.equal(act1?.status, 'failed', 'Failing subaction must be marked failed in ledger');
  assert.equal(act2?.status, 'skipped', 'Subsequent subaction must be marked skipped in ledger');

  // Item 1: Aborted batch plan transitions proposed sub-actions to SKIPPED in actionLedger
  const abortLedger = new ActionLedger({ storageKey: 'test-abort-ledger' });
  const abortController = new AbortController();
  abortController.abort();
  const abortedBatchCalls = [
    { id: 'aborted_step', type: 'function', function: { name: 'browser_step', arguments: JSON.stringify({
      tabId: 1,
      actions: [{ action: 'fill', selector: '#email', value: 'test@example.com' }, { action: 'fill', selector: '#pass', value: 'secret' }],
      clickSelector: '#login'
    }) } }
  ];
  await executeCalls(abortedBatchCalls, {
    parallel: true, allowedTools: tools, ledger: abortLedger, signal: abortController.signal,
    onEvent() {},
    executeTool: async () => { throw new Error('Should not run'); }
  });
  const abAct0 = abortLedger.get('aborted_step_action_0');
  const abAct1 = abortLedger.get('aborted_step_action_1');
  const abClick = abortLedger.get('aborted_step_click');
  assert.equal(abAct0?.status, 'skipped', 'Aborted batch subaction 0 must be skipped');
  assert.equal(abAct1?.status, 'skipped', 'Aborted batch subaction 1 must be skipped');
  assert.equal(abClick?.status, 'skipped', 'Aborted batch click must be skipped');
  assert.notEqual(abAct0?.status, 'approved', 'Subaction 0 must not be left orphaned in approved');
  assert.notEqual(abClick?.status, 'approved', 'Click must not be left orphaned in approved');

  // Item 1b: Batch plan failing before execution transitions proposed sub-actions to SKIPPED
  const failBeforeExecLedger = new ActionLedger({ storageKey: 'test-fail-before-exec-ledger' });
  const failBeforeBatchCalls = [
    { id: 'pre_fail_step', type: 'function', function: { name: 'browser_step', arguments: JSON.stringify({
      tabId: 1,
      actions: [{ action: 'fill', selector: '#f1', value: 'v1' }, { action: 'fill', selector: '#f2', value: 'v2' }],
      clickSelector: '#sub'
    }) } }
  ];
  await executeCalls(failBeforeBatchCalls, {
    parallel: true, allowedTools: tools, ledger: failBeforeExecLedger,
    onEvent() {},
    executeTool: async () => ({ error: 'Tab 1 not found', completed: false })
  });
  const pfAct0 = failBeforeExecLedger.get('pre_fail_step_action_0');
  const pfAct1 = failBeforeExecLedger.get('pre_fail_step_action_1');
  const pfClick = failBeforeExecLedger.get('pre_fail_step_click');
  assert.equal(pfAct0?.status, 'skipped', 'Pre-execution failure subaction 0 must be skipped');
  assert.equal(pfAct1?.status, 'skipped', 'Pre-execution failure subaction 1 must be skipped');
  assert.equal(pfClick?.status, 'skipped', 'Pre-execution failure click must be skipped');
  assert.notEqual(pfAct0?.status, 'approved', 'Subaction must not be orphaned in approved');
  assert.notEqual(pfClick?.status, 'approved', 'Click must not be orphaned in approved');

  // Item 2: browser_step wait timeout does NOT mark clickId as FAILED; records click as COMPLETED and notes wait timeout
  const waitTimeoutLedger = new ActionLedger({ storageKey: 'test-wait-timeout-ledger' });
  const waitTimeoutCalls = [
    { id: 'wait_timeout_step', type: 'function', function: { name: 'browser_step', arguments: JSON.stringify({
      tabId: 1,
      actions: [{ action: 'fill', selector: '#f1', value: 'v1' }],
      clickSelector: '#btnSubmit',
      waitForSelector: '#successMessage'
    }) } }
  ];
  await executeCalls(waitTimeoutCalls, {
    parallel: true, allowedTools: tools, ledger: waitTimeoutLedger,
    onEvent() {},
    executeTool: async () => ({
      completed: false,
      waitFailed: true,
      error: 'waitForSelector timed out waiting for #successMessage',
      results: [{ completed: true }],
      click: { completed: true, action: 'click', selector: '#btnSubmit' }
    })
  });
  const wtAction = waitTimeoutLedger.get('wait_timeout_step_action_0');
  const wtClick = waitTimeoutLedger.get('wait_timeout_step_click');
  const wtStep = waitTimeoutLedger.get('wait_timeout_step');
  assert.equal(wtAction?.status, 'completed', 'Field action must be completed');
  assert.equal(wtClick?.status, 'completed', 'Click must be COMPLETED even if wait timed out, NOT failed');
  assert.equal(wtClick?.result?.waitTimeout, true, 'Click result should note the wait timeout');
  assert.match(wtClick?.result?.waitError || wtClick?.result?.note, /timed out/, 'Click result should note the wait timeout message');
  assert.equal(wtStep?.status, 'failed', 'Compound tool step as a whole reflects the timeout failure');

  // Item 3: browser_step supports clickRef alongside clickSelector when proposing and settling clickId in actionLedger
  const clickRefLedger = new ActionLedger({ storageKey: 'test-click-ref-ledger' });
  const clickRefCalls = [
    { id: 'ref_step', type: 'function', function: { name: 'browser_step', arguments: JSON.stringify({
      tabId: 1,
      actions: [{ action: 'fill', selector: '#user', value: 'alice' }],
      clickRef: '@e42'
    }) } }
  ];
  await executeCalls(clickRefCalls, {
    parallel: true, allowedTools: tools, ledger: clickRefLedger,
    onEvent() {},
    executeTool: async (name, args) => {
      assert.equal(args.clickRef, '@e42');
      return {
        completed: true,
        results: [{ completed: true }],
        click: { completed: true, action: 'click', ref: '@e42' }
      };
    }
  });
  const refAction = clickRefLedger.get('ref_step_action_0');
  const refClick = clickRefLedger.get('ref_step_click');
  assert.equal(refAction?.status, 'completed', 'Field action must be completed');
  assert.ok(refClick, 'Click action entry must exist in ledger when using clickRef');
  assert.equal(refClick?.status, 'completed', 'Click action using clickRef must be settled as completed');
  assert.equal(refClick?.params?.clickRef, '@e42', 'Click action params must preserve clickRef');
  assert.equal(refClick?.metadata?.isFinalClick, true, 'Click action metadata must indicate final click');

  console.log('Sidebar provider, discovery, streaming, bounded parallel tools, ordering and authentication checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
