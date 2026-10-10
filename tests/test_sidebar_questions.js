const assert = require('node:assert/strict');
const Questions = require('../extensions/chrome/sidebar-questions.js');
const { run } = require('../extensions/chrome/sidebar-agent.js');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = message => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message }] }) });
const settings = { baseUrl: 'https://provider.example/v1', model: 'test', browserTools: true, streaming: false, maxRounds: 10 };
const question = { questions: [{ id: 'email', question: 'Which email should I use?', reason: 'Your documents have no verified application contact.' }] };
(async () => {
  assert.throws(() => Questions.validate({ questions: [] }), /1 to 3/);
  assert.throws(() => Questions.validate({ questions: [question.questions[0], question.questions[0]] }), /unique/);
  assert.throws(() => Questions.validate({ questions: [{ id: 'a', question: 'Choose', options: [{ label: 'Yes' }, { label: 'Yes' }] }] }), /unique/);
  assert.throws(() => Questions.validateAnswers(question, { status: 'answered', answers: {} }), /explicit/);
  assert.throws(() => Questions.validateAnswers(question, { status: 'cancelled' }), /not answered/);
  let round = 0;
  const actions = [];
  const history = await run({ settings, history: [], prompt: 'Prepare my application.', onEvent() {},
    executeTool: async (name, args) => {
      actions.push(name);
      if (name === 'request_user_input') return { status: 'answered', answers: { email: 'owner@example.org' } };
      assert.equal(args.value, 'owner@example.org'); return { completed: true };
    },
    fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      if (++round === 1) return response({ content: null, tool_calls: [call('ask', 'request_user_input', question), call('stale', 'fill', { tabId: 7, selector: '#email', value: 'guessed@example.org' })] });
      assert.ok(body.messages.some(m => m.role === 'user' && m.content.includes('My answer: owner@example.org')));
      if (round === 2) return response({ content: null, tool_calls: [call('correct', 'fill', { tabId: 7, selector: '#email', value: 'owner@example.org' })] });
      return response({ content: 'Email entered.' });
    }
  });
  assert.deepEqual(actions, ['request_user_input', 'fill']);
  assert.ok(history.some(m => m.role === 'tool' && m.tool_call_id === 'stale' && /New user input/.test(m.content)));
  // Answers remain original user evidence after resuming a chat.
  const { contactGuard } = require('../extensions/chrome/sidebar-agent.js');
  contactGuard(history, '').check('fill', { tabId: 7, selector: '#email', value: 'owner@example.org' });
  // Steering invalidates queued actions and is included in the next model request.
  let queued = [], steeringRound = 0, dispatched = 0;
  await run({ settings, history: [], prompt: 'Fill company.', onEvent() {}, drainUserMessages: () => queued.splice(0), executeTool: async () => { dispatched++; },
    fetchImpl: async (_, options) => {
      if (++steeringRound === 1) {
        queued.push('Stop filling and only inspect.');
        return response({ content: null, tool_calls: [call('old', 'fill', { tabId: 7, selector: '#company', value: 'Old company' })] });
      }
      assert.ok(JSON.parse(options.body).messages.some(m => m.role === 'user' && m.content === 'Stop filling and only inspect.'));
      return response({ content: 'I will inspect.' });
    }
  });
  assert.equal(dispatched, 0);
  // Stop identical failures before burning all available rounds.
  let failures = 0;
  await assert.rejects(run({ settings, history: [], prompt: 'Read page.', onEvent() {}, executeTool: async () => { failures++; return { error: 'Missing tab' }; },
    fetchImpl: async () => response({ content: null, tool_calls: [call(`fail-${failures}`, 'read_page', { tabId: 7 })] })
  }), /three times/);
  assert.equal(failures, 3);
  console.log('Structured questions, explicit answers, trusted user facts, stale-action blocking, steering and repeated-failure limits passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
