const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { tools, executeCalls, validateWorkflow, submissionGuard, run } = require('../extensions/chrome/sidebar-agent.js');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const event = () => ({ addListener() {}, removeListener() {} });

(async () => {
  const events = [], calls = [];
  await executeCalls([
    call('plan', 'update_plan', { steps: [{ title: 'Find business documents', status: 'running' }, { title: 'Verify applications', status: 'pending' }] }),
    call('result', 'record_result', { title: 'Example provider', url: 'https://example.com/apply', status: 'ready', note: 'Fields verified; awaiting review.' }),
    call('folder', 'files_find_folder', { name: 'LLC' })
  ], { allowedTools: tools, parallel: true, onEvent: event => events.push(event), executeTool: async (name, args) => { calls.push(name); return { matches: [{ path: 'C:\\actual\\Desktop\\LLC' }] }; } });
  assert.deepEqual(calls, ['files_find_folder']);
  assert.equal(events.find(event => event.type === 'plan').steps.length, 2);
  assert.equal(events.find(event => event.type === 'result').status, 'ready');
  assert.throws(() => validateWorkflow('update_plan', { steps: [{ title: 'x', status: 'fake' }] }), /valid task/);
  assert.throws(() => validateWorkflow('record_result', { title: 'x', url: 'javascript:alert(1)', status: 'ready', note: '' }), /HTTP/);
  assert.throws(() => validateWorkflow('record_result', { title: 'x', url: 'https://user:pass@example.com', status: 'ready', note: '' }), /credentials/);

  // Schema validation & status enforcement
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'submitted', note: 'Submitted without evidence' }), /observed confirmation/i);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'submitted', note: 'Submitted with empty evidence', evidence: {} }), /observed confirmation/i);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'submitted', note: 'Submitted with whitespace confirmation', evidence: { observedConfirmation: '   ' } }), /observed confirmation/i);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'submitted', note: 'Submitted with invalid confirmation type', evidence: { observedConfirmation: 12345 } }), /observed confirmation/i);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'invalid_status' }), /Invalid task result/);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'ready', evidence: { unsupportedField: true } }), /Invalid evidence property/);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'ready', evidence: { sourceUrl: 'javascript:void(0)' } }), /HTTP/);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'ready', evidence: { sourceUrl: 'https://user:pass@example.com' } }), /credentials/);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'ready', evidence: { unknownFields: 'not an array' } }), /unknown fields/i);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'ready', evidence: { validationErrors: [42] } }), /validation errors/i);

  // Item 39: Forbid describing draft resets as undoing submissions & outcome validation
  assert.throws(() => validateWorkflow('update_plan', { steps: [{ title: 'Reset draft to undo submission', status: 'pending' }] }), /Draft resets/);
  assert.throws(() => validateWorkflow('update_plan', { steps: [{ title: 'Draft reset undoing submission', status: 'pending' }] }), /Draft resets/);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'ready', note: 'Draft reset undid the submission' }), /Draft resets/);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'ready', note: 'Resetting draft to undo submission' }), /Draft resets/);
  assert.throws(() => validateWorkflow('record_result', { title: 'Provider', url: 'https://example.com/apply', status: 'ready', outcome: 'invalid_outcome' }), /Invalid submission outcome/);

  const unknownResult = validateWorkflow('record_result', { title: 'Unknown provider', url: 'https://example.com/check', status: 'unknown' });
  assert.equal(unknownResult.status, 'unknown');

  const validSubmitted = validateWorkflow('record_result', {
    title: 'Submitted provider',
    url: 'https://example.com/apply',
    status: 'submitted',
    note: 'Application verified and submitted.',
    evidence: {
      sourceUrl: 'https://example.com/confirm',
      sourcePath: 'C:\\Desktop\\LLC\\doc.pdf',
      observedConfirmation: 'Confirmation #ABC-999',
      unknownFields: ['optional_fax'],
      validationErrors: ['Minor formatting warning']
    }
  });
  assert.equal(validSubmitted.status, 'submitted');
  assert.equal(validSubmitted.evidence.observedConfirmation, 'Confirmation #ABC-999');
  assert.equal(validSubmitted.evidence.sourceUrl, 'https://example.com/confirm');
  assert.equal(validSubmitted.evidence.sourcePath, 'C:\\Desktop\\LLC\\doc.pdf');
  assert.deepEqual(validSubmitted.evidence.unknownFields, ['optional_fax']);
  assert.deepEqual(validSubmitted.evidence.validationErrors, ['Minor formatting warning']);

  // Verify sidepanel.js result card rendering of provenance and evidence tags
  class MockElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.className = '';
      this.children = [];
      this.dataset = {};
      this.attributes = new Map();
      this.textContent = '';
    }
    setAttribute(k, v) { this.attributes.set(k, v); }
    getAttribute(k) { return this.attributes.get(k); }
    append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
    prepend(...nodes) { for (const n of nodes.reverse()) { n.parentElement = this; this.children.unshift(n); } }
    replaceChildren(...nodes) { this.children = []; this.textContent = ''; if (nodes.length) this.append(...nodes); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
      const results = [];
      const match = (el) => {
        if (sel.startsWith('.')) {
          const parts = sel.slice(1).split('.');
          if (parts.every(c => el.className && el.className.split(' ').includes(c))) return true;
        }
        if (['a', 'p', 'code', 'article', 'section', 'div', 'span', 'h3'].includes(sel) && el.tagName === sel) return true;
        return false;
      };
      const walk = (p) => { for (const c of p.children) { if (match(c)) results.push(c); walk(c); } };
      walk(this);
      return results;
    }
  }
  const mockDoc = { createElement(tag) { return new MockElement(tag); } };
  const sidepanelCtx = vm.createContext({ document: mockDoc, OmniSidebarAgent: { validateWorkflow }, URL });
  const renderMatch = fs.readFileSync('extensions/chrome/sidepanel.js', 'utf8').match(/function renderResult\(container, result\) \{[\s\S]*?\n\}/);
  assert.ok(renderMatch);
  vm.runInContext(renderMatch[0], sidepanelCtx);

  const container = new MockElement('div');
  sidepanelCtx.renderResult(container, validSubmitted);
  const card = container.querySelector('.resultCard');
  assert.ok(card);
  assert.equal(card.dataset.url, 'https://example.com/apply');
  assert.equal(card.querySelector('.resultStatus').textContent, 'Submitted');
  assert.equal(card.querySelector('.resultStatus').dataset.status, 'submitted');

  const provenance = card.querySelector('.resultProvenance');
  assert.ok(provenance);
  const provLink = provenance.querySelector('a');
  assert.equal(provLink.href, 'https://example.com/confirm');
  assert.match(provLink.textContent, /https:\/\/example\.com\/confirm ↗/);
  const provCode = provenance.querySelector('.provenancePath');
  assert.equal(provCode.textContent, 'C:\\Desktop\\LLC\\doc.pdf');

  const tags = card.querySelector('.evidenceTags');
  assert.ok(tags);
  const confirmedTag = tags.querySelector('.evidenceTag.confirmed');
  assert.match(confirmedTag.textContent, /Confirmation #ABC-999/);
  const unknownTag = tags.querySelector('.evidenceTag.unknown');
  assert.match(unknownTag.textContent, /Unknown: optional_fax/);
  const errorTag = tags.querySelector('.evidenceTag.error');
  assert.match(errorTag.textContent, /Minor formatting warning/);

  let tabUrl = 'https://example.com/apply', createdTabs = 0;
  const chrome = {
    runtime: { onMessage: event(), connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }) },
    tabs: { onRemoved: event(), onUpdated: event(), create: async ({ url }) => { createdTabs++; tabUrl = url; return { id: 7, url }; }, get: async () => ({ url: tabUrl }) },
    debugger: { onEvent: event(), onDetach: event() },
    scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: func.name === 'verifySidebarFields' ? args[0].map(field => ({ selector: field.selector, value: 'Example LLC', matches: field.value === 'Example LLC', valid: true })) : { elements: [{ tag: 'input', selector: '#company' }, { tag: 'a', selector: '#link' }], frames: [], title: 'Search', url: tabUrl } }] }
  };
  const context = vm.createContext({ chrome, console, setTimeout, clearTimeout, URL });
  vm.runInContext(fs.readFileSync('extensions/chrome/background.js', 'utf8'), context);
  vm.runInContext("nativeMcpRequest = async (action, args) => ({ mode: 'headless', sources: ['https://example.com'], action, args })", context);
  const search = await vm.runInContext("runSidebarTool('search_web', {query:'high risk payments & applications'})", context);
  assert.equal(search.args.query, 'high risk payments & applications');
  assert.equal(search.mode, 'headless');
  assert.equal(search.action, 'research_search');
  assert.equal(createdTabs, 0);
  assert.equal(search.tabId, undefined);
  await assert.rejects(vm.runInContext("runSidebarTool('search_web', {query:''})", context), /search query/);
  const form = await vm.runInContext("runSidebarTool('form_inspect', {tabId:7})", context);
  assert.equal(form.elements.length, 1);
  const verified = await vm.runInContext("runSidebarTool('form_verify', {tabId:7,fields:[{selector:'#company',value:'Example LLC'}]})", context);
  assert.equal(verified.verified, true);
  const mismatch = await vm.runInContext("runSidebarTool('form_verify', {tabId:7,fields:[{selector:'#company',value:'Wrong'}]})", context);
  assert.equal(mismatch.verified, false);
  await assert.rejects(vm.runInContext("runSidebarTool('form_verify', {tabId:7,fields:[{selector:'#company'}]})", context), /expected values/);

  // Item 3 & 7: Duplicate Submission Barrier & Resume Integration
  const guard = submissionGuard([], 'Apply for payment provider');
  // First submission attempt is allowed
  const check1 = guard.check('click', { tabId: 7, selector: '#submit' });
  check1.commit();

  // Duplicate submission on same tab is blocked
  assert.throws(() => guard.check('click', { tabId: 7, selector: '#submit' }), /Duplicate submission blocked/);
  assert.throws(() => guard.check('browser_step', { tabId: 7, clickSelector: '#submit', actions: [{ action: 'fill', selector: '#company', value: 'LLC' }] }), /Duplicate submission blocked/);

  // Non-submit controls are not blocked
  const nonSubmit = guard.check('click', { tabId: 7, selector: '#next-section' });
  nonSubmit.commit();

  // Fresh form_verify confirming form was not submitted unblocks retry
  guard.observe('form_verify', { verified: false, fields: [{ selector: '#email', valid: false }] }, { tabId: 7 });
  const retryVerify = guard.check('click', { tabId: 7, selector: '#submit' });
  retryVerify.commit();

  // Duplicate is blocked again after commit
  assert.throws(() => guard.check('click', { tabId: 7, selector: '#submit' }), /Duplicate submission blocked/);

  // Fresh read_page confirming form was not submitted (error message) unblocks retry
  guard.observe('read_page', { text: 'Submission error: please fix highlighted fields' }, { tabId: 7 });
  const retryPage = guard.check('browser_step', { tabId: 7, clickSelector: 'button[type="submit"]', actions: [{ action: 'fill', selector: '#company', value: 'Real LLC' }] });
  retryPage.commit();

  // Fresh read_page confirming submission success keeps duplicate barrier active
  guard.observe('read_page', { text: 'Thank you! Your application has been submitted. Confirmation #12345' }, { tabId: 7 });
  assert.throws(() => guard.check('click', { tabId: 7, selector: '#submit' }), /Duplicate submission blocked/);

  // Resume with existing history containing completed submission
  const failedStepHistory = [
    { role: 'assistant', tool_calls: [call('failed_step', 'browser_step', { tabId: 7, clickSelector: '#submit' }), call('false_result', 'record_result', { tabId: 7, title: 'Application', url: 'https://example.com/apply', status: 'submitted' })], content: null },
    { role: 'tool', tool_call_id: 'failed_step', content: JSON.stringify({ completed: false, results: [{ error: 'Element not found' }] }) },
    { role: 'tool', tool_call_id: 'false_result', content: JSON.stringify({ status: 'needs_evidence' }) }
  ];
  const failedStepGuard = submissionGuard(failedStepHistory, 'Continue');
  assert.equal(failedStepGuard.directives, null);
  failedStepGuard.check('click', { tabId: 7, selector: '#submit' }).abort();

  const historyWithSubmission = [
    { role: 'assistant', tool_calls: [call('old_submit', 'click', { tabId: 7, selector: '#submit' })], content: null },
    { role: 'tool', tool_call_id: 'old_submit', content: JSON.stringify({ completed: true }) }
  ];
  const resumedGuard = submissionGuard(historyWithSubmission, 'Continue');
  assert.ok(resumedGuard.directives);
  assert.match(resumedGuard.directives.directive, /Do not repeat completed submissions/);
  assert.throws(() => resumedGuard.check('click', { tabId: 7, selector: '#submit' }), /Duplicate submission blocked/);

  // Reconciliation confirming failure unblocks the submission
  const failedReconciliationGuard = submissionGuard(historyWithSubmission, 'The previous submission failed, please retry');
  const failureRetry = failedReconciliationGuard.check('click', { tabId: 7, selector: '#submit' });
  assert.ok(failureRetry);
  failureRetry.commit();

  // Resume integration in run(): verify reference context receives reconciliation directives
  let observedPromptMessages;
  const mockSettings = { baseUrl: 'https://provider.example/v1', model: 'test-model', apiKey: 'test', browserTools: true };
  await run({
    settings: mockSettings,
    history: historyWithSubmission,
    prompt: 'Continue review',
    originTab: { id: 7, title: 'Apply Page', url: 'https://example.com/apply' },
    onEvent() {},
    executeTool: async () => ({}),
    fetchImpl: async (url, options) => {
      observedPromptMessages = JSON.parse(options.body).messages;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Reconciliation checked. No duplicate submission needed.' } }] }) };
    }
  });
  const userMsg = observedPromptMessages.find(m => m.role === 'user');
  assert.match(userMsg.content, /Browser context at send time/);
  assert.match(userMsg.content, /reconciliation/i);
  assert.match(userMsg.content, /completedSubmissions/);
  assert.match(userMsg.content, /#submit/);

  // Item 39: Consequential Action Previews & Tri-State Outcomes
  // 1. Verify sidepanel.html contains required structured preview and outcome containers
  const sidepanelHtml = fs.readFileSync('extensions/chrome/sidepanel.html', 'utf8');
  assert.ok(sidepanelHtml.includes('id="approval"'), 'sidepanel.html must include #approval');
  assert.ok(sidepanelHtml.includes('id="approvalDestination"'), 'sidepanel.html must include destination URL container');
  assert.ok(sidepanelHtml.includes('id="approvalRecord"'), 'sidepanel.html must include affected record container');
  assert.ok(sidepanelHtml.includes('id="approvalFields"'), 'sidepanel.html must include proposed fields table');
  assert.ok(sidepanelHtml.includes('id="approvalCitations"'), 'sidepanel.html must include citations container');
  assert.ok(sidepanelHtml.includes('id="approvalOutcome"'), 'sidepanel.html must include outcome container');
  assert.match(sidepanelHtml, /<div\s+id="approvalOutcome"[^>]*\brole="status"/, 'sidepanel.html must include role="status" on #approvalOutcome');
  assert.match(sidepanelHtml, /<div\s+id="approvalOutcome"[^>]*\baria-live="polite"/, 'sidepanel.html must include aria-live="polite" on #approvalOutcome');
  assert.ok(sidepanelHtml.includes('id="outcomeBadge"'), 'sidepanel.html must include outcome badge element');

  // 2. Load sidepanel.js Item 39 exports
  const sidepanel = require('../extensions/chrome/sidepanel.js');
  const {
    renderActionPreview,
    renderSubmissionOutcome,
    determineSubmissionOutcome,
    forbidDraftResetUndoingSubmission,
    isConsequentialAction
  } = sidepanel;

  // 3. Setup mock DOM for testing action previews & outcomes
  const elements = new Map();
  class ApprovalMockElement {
    constructor(tagName, id = '') {
      this.tagName = tagName.toLowerCase();
      this.id = id;
      this.className = '';
      this.children = [];
      this.dataset = {};
      this.attributes = new Map();
      this.textContent = '';
      this.hidden = false;
      this.href = '';
      this.parentElement = null;
    }
    setAttribute(k, v) { this.attributes.set(k, v); if (k === 'id') this.id = v; }
    getAttribute(k) { return this.attributes.get(k); }
    removeAttribute(k) { this.attributes.delete(k); if (k === 'id') this.id = ''; if (k === 'href') this.href = ''; }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel.startsWith('.') && cur.className && cur.className.split(' ').includes(sel.slice(1))) return cur;
        if (sel.startsWith('#') && cur.id === sel.slice(1)) return cur;
        if (cur.tagName === sel.toLowerCase()) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
    prepend(...nodes) { for (const n of nodes.reverse()) { n.parentElement = this; this.children.unshift(n); } }
    replaceChildren(...nodes) { this.children = []; this.textContent = ''; if (nodes.length) this.append(...nodes); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
      const results = [];
      const match = el => {
        if (sel.startsWith('#')) return el.id === sel.slice(1);
        if (sel.startsWith('.')) {
          const parts = sel.slice(1).split('.');
          if (parts.every(c => el.className && el.className.split(' ').includes(c))) return true;
        }
        if (el.tagName === sel.toLowerCase()) return true;
        return false;
      };
      const walk = p => { for (const c of p.children) { if (match(c)) results.push(c); walk(c); } };
      walk(this);
      return results;
    }
  }

  global.document = {
    getElementById: id => {
      if (!elements.has(id)) elements.set(id, new ApprovalMockElement('div', id));
      return elements.get(id);
    },
    createElement: tag => new ApprovalMockElement(tag),
    querySelector: sel => {
      for (const el of elements.values()) {
        const found = el.querySelector(sel);
        if (found) return found;
      }
      return null;
    }
  };

  // 4. Test renderActionPreview with structured preview
  const previewData = {
    destination: 'https://example.com/apply',
    record: 'Merchant Application for Acme LLC',
    fields: [
      { name: '#company', value: 'Acme LLC' },
      { name: '#ein', value: '12-3456789' }
    ],
    citations: [
      'C:\\Desktop\\LLC\\Articles.pdf (line 5)',
      'https://records.gov/registry/1234'
    ],
    isConsequential: true
  };
  renderActionPreview(previewData);

  assert.equal(document.getElementById('approvalDestination').textContent, 'https://example.com/apply');
  assert.equal(document.getElementById('approvalDestination').href, 'https://example.com/apply');
  assert.equal(document.getElementById('approvalRecord').textContent, 'Merchant Application for Acme LLC');
  const fieldsBody = document.getElementById('approvalFieldsBody');
  assert.equal(fieldsBody.children.length, 2);
  assert.equal(fieldsBody.children[0].children[0].textContent, '#company');
  assert.equal(fieldsBody.children[0].children[1].textContent, 'Acme LLC');
  assert.equal(fieldsBody.children[1].children[0].textContent, '#ein');
  assert.equal(fieldsBody.children[1].children[1].textContent, '12-3456789');
  const citationsList = document.getElementById('approvalCitations');
  assert.equal(citationsList.children.length, 2);
  assert.equal(citationsList.children[0].textContent, 'C:\\Desktop\\LLC\\Articles.pdf (line 5)');
  assert.equal(citationsList.children[1].textContent, 'https://records.gov/registry/1234');
  assert.equal(document.getElementById('approvalPreview').hidden, false);

  // 5. Test tri-state outcomes rendering
  // a) Confirmed (green badge)
  renderSubmissionOutcome('confirmed', {
    destination: 'https://example.com/apply',
    message: 'Application confirmed by server.'
  });
  const outcomeBadge = document.getElementById('outcomeBadge');
  assert.equal(outcomeBadge.dataset.outcome, 'confirmed');
  assert.equal(outcomeBadge.textContent, 'Confirmed');
  assert.ok(outcomeBadge.className.includes('confirmed'));
  assert.equal(document.getElementById('approvalOutcome').hidden, false);
  assert.equal(document.getElementById('approvalOutcome').getAttribute('role'), 'status');
  assert.equal(document.getElementById('approvalOutcome').getAttribute('aria-live'), 'polite');
  assert.equal(document.getElementById('outcomeMessage').textContent, 'Application confirmed by server.');

  // b) Failed (red badge)
  renderSubmissionOutcome('failed', {
    destination: 'https://example.com/apply',
    message: 'Submission failed due to invalid credentials.'
  });
  assert.equal(outcomeBadge.dataset.outcome, 'failed');
  assert.equal(outcomeBadge.textContent, 'Failed');
  assert.ok(outcomeBadge.className.includes('failed'));
  assert.equal(document.getElementById('outcomeMessage').textContent, 'Submission failed due to invalid credentials.');

  // c) Unknown (amber warning)
  renderSubmissionOutcome('unknown', {
    destination: 'https://example.com/apply',
    message: 'Submission outcome unknown. Check destination before retrying.'
  });
  assert.equal(outcomeBadge.dataset.outcome, 'unknown');
  assert.match(outcomeBadge.textContent, /Unknown/i);
  assert.ok(outcomeBadge.className.includes('unknown'));
  assert.equal(document.getElementById('outcomeMessage').textContent, 'Submission outcome unknown. Check destination before retrying.');

  // d) Invalid outcome rejected
  assert.throws(() => renderSubmissionOutcome('invalid_state'), /Invalid submission outcome/);

  // 6. Forbid describing draft resets as undoing submissions
  assert.throws(() => forbidDraftResetUndoingSubmission('Draft reset undid the submission'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Resetting draft to undo submission'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Undo submission by resetting draft'), /Draft resets/);
  assert.throws(() => renderActionPreview({ text: 'Draft reset undid the submission' }), /Draft resets/);
  assert.throws(() => renderSubmissionOutcome('confirmed', { message: 'Reset draft to undo submission' }), /Draft resets/);

  // Expanded checks:
  // a) "revert", "reverting", "reverted", "reverts"
  assert.throws(() => forbidDraftResetUndoingSubmission('Draft reset will revert the submission'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Reverting submission with draft reset'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Draft reset reverted the submission'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Draft reset reverts submission'), /Draft resets/);

  // b) "undo", "undoing", "undid", "undone"
  assert.throws(() => forbidDraftResetUndoingSubmission('Undo submission via draft reset'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Undoing submission using draft reset'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Undid submission after draft reset'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Submission undone by draft reset'), /Draft resets/);

  // c) "reset", "resetting" preceding submission
  assert.throws(() => forbidDraftResetUndoingSubmission('Reset submission'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Resetting submission'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Resetting the submission'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('Reset the submission'), /Draft resets/);

  // d) Passive voice:
  assert.throws(() => forbidDraftResetUndoingSubmission('submission was reverted by draft reset'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('submission was undone by draft reset'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('submission reverted after draft was reset'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('submission reset'), /Draft resets/);
  assert.throws(() => forbidDraftResetUndoingSubmission('submission was reset'), /Draft resets/);

  // e) Valid actions/draft descriptions must not throw
  assert.doesNotThrow(() => forbidDraftResetUndoingSubmission('Application submitted successfully'));
  assert.doesNotThrow(() => forbidDraftResetUndoingSubmission('Reset draft'));
  assert.doesNotThrow(() => forbidDraftResetUndoingSubmission('Resetting draft fields for new entry'));

  // 7. Test determineSubmissionOutcome helper
  assert.equal(determineSubmissionOutcome({ page: { text: 'Thank you! Your application has been confirmed.' } }), 'confirmed');
  assert.equal(determineSubmissionOutcome({ error: 'Network timeout' }), 'failed');
  assert.equal(determineSubmissionOutcome(null, new Error('Connection refused')), 'failed');
  assert.equal(determineSubmissionOutcome({ page: { text: 'Processing page without confirmation marker' } }), 'unknown');

  // 8. Test isConsequentialAction helper
  assert.equal(isConsequentialAction('browser_step', { clickSelector: '#submit' }), true);
  assert.equal(isConsequentialAction('click', { selector: 'button[type="submit"]' }), true);
  assert.equal(isConsequentialAction('click', { selector: '#delete-account' }), true);
  assert.equal(isConsequentialAction('read_page', {}), false);
  assert.equal(isConsequentialAction('form_inspect', {}), false);

  // Item 33 & 34: Policy Integration & Grant Management in UI
  const {
    PolicyEngine,
    formatRemainingTime,
    isSubpath,
    extractSite,
    normalizePath
  } = sidepanel;

  // 1. Verify sidepanel.html contains scoped permissions UI and 4 scoped approval buttons
  assert.ok(sidepanelHtml.includes('id="permissionsPanel"'), 'sidepanel.html must include #permissionsPanel');
  assert.ok(sidepanelHtml.includes('id="siteGrantsList"'), 'sidepanel.html must include #siteGrantsList');
  assert.ok(sidepanelHtml.includes('id="folderGrantsList"'), 'sidepanel.html must include #folderGrantsList');
  assert.ok(sidepanelHtml.includes('id="allowOnce"'), 'sidepanel.html must include #allowOnce button');
  assert.ok(sidepanelHtml.includes('id="allowTask"'), 'sidepanel.html must include #allowTask button');
  assert.ok(sidepanelHtml.includes('id="allowSite"'), 'sidepanel.html must include #allowSite button');
  assert.ok(sidepanelHtml.includes('id="denyAction"'), 'sidepanel.html must include #denyAction button');

  // 2. Safe tools allow execution without any grants
  const engine = new PolicyEngine({ taskId: 'task-1' });
  for (const safeTool of PolicyEngine.SAFE_TOOLS) {
    assert.equal(engine.isSafe(safeTool), true, `${safeTool} should be safe`);
    const perm = engine.checkPermission(safeTool, {});
    assert.equal(perm.allowed, true);
    assert.equal(perm.reason, 'safe_tool');
  }

  // 3. Mutating tools require permission when no grant exists
  const mutatingTools = ['click', 'fill', 'navigate', 'files_extract', 'browser_step'];
  for (const mutatingTool of mutatingTools) {
    assert.equal(engine.isSafe(mutatingTool), false, `${mutatingTool} should not be safe`);
    const perm = engine.checkPermission(mutatingTool, { url: 'https://example.com/apply' });
    assert.equal(perm.allowed, false);
  }

  // 4. Scoped grant behavior:
  // a) "Allow once": Does not persist grant
  const onceGrant = engine.grantSite('https://example.com', 'once');
  assert.ok(onceGrant);
  assert.equal(engine.hasSiteGrant('https://example.com'), false);
  assert.equal(engine.getActiveSiteGrants().length, 0);

  // b) "Allow for this task": Scoped to active taskId, cleared when task changes or new chat starts
  engine.grantSite('https://example.com', 'task');
  assert.equal(engine.hasSiteGrant('https://example.com'), true);
  assert.equal(engine.checkPermission('click', { url: 'https://example.com/action' }).allowed, true);

  // Switch task
  engine.setTaskId('task-2');
  assert.equal(engine.hasSiteGrant('https://example.com'), false);
  assert.equal(engine.checkPermission('click', { url: 'https://example.com/action' }).allowed, false);

  // Switch back to task-1 and clear task grants
  engine.setTaskId('task-1');
  assert.equal(engine.hasSiteGrant('https://example.com'), true);
  engine.clearTaskGrants('task-1');
  assert.equal(engine.hasSiteGrant('https://example.com'), false);

  // c) "Allow for this site (1 hr)": Timed grant with countdown formatting and manual revocation
  const oneHourMs = 3600000;
  const siteGrant = engine.grantSite('https://merchant.com', 'time', oneHourMs);
  assert.equal(engine.hasSiteGrant('https://merchant.com'), true);
  assert.equal(engine.checkPermission('click', { url: 'https://merchant.com/form' }).allowed, true);
  assert.match(formatRemainingTime(siteGrant.expiresAt), /h|m/);
  assert.equal(formatRemainingTime(null), 'This task');
  assert.equal(formatRemainingTime(Date.now() - 1000), 'Expired');

  // Manual revocation
  assert.equal(engine.revokeSite('https://merchant.com'), true);
  assert.equal(engine.hasSiteGrant('https://merchant.com'), false);
  assert.equal(engine.checkPermission('click', { url: 'https://merchant.com/form' }).allowed, false);

  // 5. Folder grants, subpath matching, and revocation
  assert.equal(isSubpath('C:/Users/Test/Documents/Invoice.pdf', 'C:/Users/Test/Documents'), true);
  assert.equal(isSubpath('C:\\Users\\Test\\Documents\\Subfolder\\file.txt', 'C:/Users/Test/Documents'), true);
  assert.equal(isSubpath('C:/Users/Test/Other/Invoice.pdf', 'C:/Users/Test/Documents'), false);
  assert.equal(normalizePath('C:\\Users\\Test\\Documents\\'), 'c:/users/test/documents');

  // Check files_extract before folder grant
  const fileCheck = engine.checkPermission('files_extract', { path: 'C:/docs/payroll/2026.pdf' });
  assert.equal(fileCheck.allowed, false);
  assert.equal(fileCheck.type, 'folder');

  // Grant parent folder
  engine.grantFolder('C:/docs/payroll', 'task');
  assert.equal(engine.hasFolderGrant('C:/docs/payroll/2026.pdf'), true);
  assert.equal(engine.hasFolderGrant('C:/docs/other/2026.pdf'), false);
  const fileCheckAfter = engine.checkPermission('files_extract', { path: 'C:/docs/payroll/2026.pdf' });
  assert.equal(fileCheckAfter.allowed, true);
  assert.equal(fileCheckAfter.reason, 'folder_grant');

  // Revoke folder grant
  assert.equal(engine.revokeFolder('C:/docs/payroll'), true);
  assert.equal(engine.hasFolderGrant('C:/docs/payroll/2026.pdf'), false);
  assert.equal(engine.checkPermission('files_extract', { path: 'C:/docs/payroll/2026.pdf' }).allowed, false);

  // 6. Expiration logic (cleanExpired)
  const expiredSite = 'https://expired-session.com';
  engine.siteGrants.set(expiredSite, {
    site: expiredSite,
    scope: 'time',
    expiresAt: Date.now() - 5000,
    taskId: null
  });
  assert.equal(engine.hasSiteGrant(expiredSite), false);
  assert.equal(engine.siteGrants.has(expiredSite), false);

  // 7. Serialization and state restoration (toJSON / fromJSON)
  const stateEngineA = new PolicyEngine({ taskId: 't-1' });
  stateEngineA.grantSite('https://site-a.com', 'time', 600000);
  stateEngineA.grantFolder('C:/approved/folder', 'time', 600000);
  const serialized = stateEngineA.toJSON();

  const stateEngineB = new PolicyEngine({ taskId: 't-1' });
  stateEngineB.fromJSON(serialized);
  assert.equal(stateEngineB.hasSiteGrant('https://site-a.com'), true);
  assert.equal(stateEngineB.hasFolderGrant('C:/approved/folder/subfile.txt'), true);

  // 8. Tab origin tracking
  engine.setTabSite(42, 'https://sub.portal.org/page');
  assert.equal(engine.getTabSite(42), 'https://sub.portal.org');
  assert.equal(extractSite('https://sub.portal.org:8080/path?q=1'), 'https://sub.portal.org:8080');

  console.log('Workflow plans, result validation, duplicate submission barrier, resume integration, action previews, tri-state outcomes, policy engine & grant management passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
