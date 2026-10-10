const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sidepanel = require.resolve('../extensions/chrome/sidepanel.js');
const source = fs.readFileSync(sidepanel, 'utf8');

function fixture() {
  const state = { url: 'https://example.com/form', calls: 0, approve: async () => 'once' };
  const context = vm.createContext({ console, structuredClone, crypto, URL, performance, setTimeout, clearTimeout,
    module: { exports: {} }, require: createRequire(sidepanel),
    OmniTaskSession: require('../extensions/chrome/task-session.js'),
    chrome: { tabs: { get: async () => ({ id: 7, url: state.url }) } }, state });
  vm.runInContext(source, context);
  vm.runInContext("accessMode = 'full'; requestApproval = async () => state.approve(); rawBrowserTool = async () => { state.calls++; return {}; };", context);
  return { context, state, panel: context.module.exports };
}

(async () => {
  const spoofed = fixture();
  spoofed.panel.policyEngine.rules.push({ decision: 'deny', tool: 'fill', domain: 'https://example.com' });
  await assert.rejects(spoofed.panel.browserTool('fill', { tabId: 7, url: 'https://allowed.example', selector: '#name', value: 'Bad' }), /denied/i);
  assert.equal(spoofed.state.calls, 0, 'A supplied URL cannot override the actual tab destination');

  const revoked = fixture();
  vm.runInContext("accessMode = 'ask';", revoked.context);
  revoked.state.approve = async () => {
    revoked.panel.policyEngine.rules.push({ decision: 'deny', tool: 'fill', domain: 'https://example.com' });
    return 'once';
  };
  await assert.rejects(revoked.panel.browserTool('fill', { tabId: 7, selector: '#name', value: 'Bad' }), /denied/i);
  assert.equal(revoked.state.calls, 0, 'A denial added during approval takes effect before dispatch');

  const moved = fixture();
  vm.runInContext("accessMode = 'ask';", moved.context);
  moved.state.approve = async () => { moved.state.url = 'https://other.example/form'; return 'once'; };
  await assert.rejects(moved.panel.browserTool('fill', { tabId: 7, url: 'https://example.com/form', selector: '#name', value: 'Bad' }), /destination changed/i);
  assert.equal(moved.state.calls, 0, 'Navigation during approval invalidates a write even with a supplied URL');

  const removed = fixture();
  vm.runInContext("accessMode = 'ask';", removed.context);
  removed.panel.policyEngine.grantSite('https://example.com', 'time');
  removed.context.OmniTaskClient = { session: { unreviewedWrites: [] },
    publish: async () => removed.panel.policyEngine.revokeSite('https://example.com') };
  await assert.rejects(removed.panel.browserTool('fill', { tabId: 7, selector: '#name', value: 'Bad' }), /permissions changed/i);
  assert.equal(removed.state.calls, 0, 'Revoking a grant during checkpointing prevents the queued write');

  const allowed = fixture();
  vm.runInContext("accessMode = 'ask';", allowed.context);
  await allowed.panel.browserTool('fill', { tabId: 7, selector: '#name', value: 'Allowed' });
  assert.equal(allowed.state.calls, 1, 'An unchanged once-approved destination remains usable');
  console.log('Dispatch checks live destinations, late denials and navigation during approval.');
})().catch(error => { console.error(error); process.exitCode = 1; });
