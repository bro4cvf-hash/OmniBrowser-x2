const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { TaskSession } = require('../extensions/chrome/task-session.js');
const { run } = require('../extensions/chrome/sidebar-agent.js');
const sidepanel = require.resolve('../extensions/chrome/sidepanel.js');
const page = { url: 'https://example.com', elements: [{ ref: '@e11', selector: '#register', frameId: 0, tag: 'a', text: 'Get started', href: 'https://example.com/register' }] };

function fixture(mode = 'full') {
  const state = { calls: [], approvals: 0, missing: true, lost: false };
  const session = new TaskSession({ set: async () => {} }, { id: 'test-task', journal: [] });
  const context = vm.createContext({ console, structuredClone, crypto, URL, performance, setTimeout, clearTimeout,
    module: { exports: {} }, require: createRequire(sidepanel), state,
    OmniTaskSession: require('../extensions/chrome/task-session.js'),
    OmniTaskClient: { session, publish: async () => {} },
    chrome: { tabs: { get: async () => ({ id: 7, url: page.url }) }, runtime: {
      sendMessage: (message, reply) => {
        state.calls.push(message.name);
        if (message.name === 'click' && state.lost) reply({ success: false, error: 'Connection lost after dispatch' });
        else if (message.name === 'click' && state.missing) reply({ success: false,
          error: "Action timeout after 5000ms waiting for 'a[href=\"#get-started\"]': element not found", notDispatched: true, page });
        else reply({ success: true, result: message.name === 'read_page' ? page : { completed: true } });
      }
    } } });
  vm.runInContext(fs.readFileSync(sidepanel, 'utf8'), context);
  vm.runInContext(`accessMode = '${mode}'; requestApproval = async () => { state.approvals++; return 'once'; }; renderSubmissionOutcome = () => {};`, context);
  return { context, session, state, panel: context.module.exports };
}

(async () => {
  const failed = fixture();
  await assert.rejects(failed.panel.browserTool('click', { tabId: 7, selector: 'a[href="#get-started"]' }), error => {
    assert.equal(error.notDispatched, true);
    assert.equal(error.page.elements[0].ref, '@e11');
    return /element not found/.test(error.message);
  });
  assert.equal(failed.session.record.journal[0].status, 'failed');
  failed.state.missing = false;
  await failed.panel.browserTool('click', { tabId: 7, selector: '@e11' });
  assert.equal(failed.state.approvals, 0, 'Known failed clicks must never request review in Full access');

  const lost = fixture();
  lost.state.lost = true;
  await assert.rejects(lost.panel.browserTool('click', { tabId: 7, selector: '#submit' }), /Connection lost/);
  assert.equal(lost.session.uncertainWrites.length, 1);
  lost.state.lost = false;
  lost.state.missing = false;
  const repeated = await lost.panel.browserTool('click', { tabId: 7, selector: 'role=button[name="Submit"]' });
  assert.equal(repeated.unknownOutcome, true, 'An alternate selector must not replay an uncertain click');
  assert.deepEqual(lost.state.calls, ['click', 'read_page']);
  assert.equal(lost.state.approvals, 0);
  await lost.panel.browserTool('fill', { tabId: 7, selector: '#company', value: 'Example LLC' });
  assert.equal(lost.state.calls.at(-1), 'fill', 'Independent field edits continue after automatic inspection');
  assert.equal(lost.session.uncertainWrites.length, 1, 'Inspection is not evidence of confirmed submission');
  assert.equal(lost.session.uncertainWrites[0].reviewSource, 'automatic');

  const ask = fixture('ask');
  const id = await ask.session.begin('click', { tabId: 7, selector: '#submit' });
  await ask.session.settle(id, null, new Error('Connection lost after dispatch'));
  await ask.panel.browserTool('fill', { tabId: 7, selector: '#company', value: 'Example LLC' });
  assert.ok(ask.state.approvals > 0, 'Ask mode retains explicit recovery review');

  const actions = [];
  let round = 0;
  await run({ settings: { baseUrl: 'https://provider.example/v1', model: 'fixture', browserTools: true, streaming: false },
    history: [], prompt: 'Open the registration form and fill it. Do not submit.', onEvent() {},
    executeTool: async (name, args) => {
      actions.push({ name, args });
      if (actions.length === 1) throw Object.assign(new Error('Action timeout after 5000ms: element not found'), { notDispatched: true, page });
      return { completed: true, page };
    },
    fetchImpl: async (_, options) => {
      round++;
      if (round === 2) assert.match(JSON.parse(options.body).messages.at(-1).content, /@e11/);
      const selector = ['a[href="#get-started"]', 'a[href="https://example.com/signup"]', '@e11'][round - 1];
      const message = selector ? { content: null, tool_calls: [{ id: `click-${round}`, type: 'function',
        function: { name: 'click', arguments: JSON.stringify({ tabId: 7, selector }) } }] } : { content: 'Registration opened for review.' };
      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    }
  });
  assert.equal(actions.length, 2, 'A second invented link is rejected before browser dispatch');
  assert.equal(actions[1].args.selector, '@e11', 'The actual observed control succeeds');
  assert.equal(actions[1].args.__submissionHold, true, 'Do not submit remains active during recovery');
  console.log('Full access recovery, known negative outcomes, no duplicate clicks and fresh locator recovery passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
