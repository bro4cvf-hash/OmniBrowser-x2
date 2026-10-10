const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Test suite for Item 55: Accurate Lifecycle State Machine & Recovery Controls

function createMockElement(tagName, id = '', className = '') {
  const listeners = new Map();
  const children = [];
  const classListSet = new Set(className ? className.split(' ') : []);
  const attributes = new Map();
  const dataset = {};

  const el = {
    tagName: tagName.toUpperCase(),
    id,
    dataset,
    children,
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    open: false,
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    style: { setProperty(prop, val) { this[prop] = val; } },
    get options() { return children.filter(c => c.tagName === 'OPTION'); },
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeEventListener(event, handler) {
      if (!listeners.has(event)) return;
      const arr = listeners.get(event).filter(h => h !== handler);
      listeners.set(event, arr);
    },
    dispatchEvent(event) {
      const arr = listeners.get(event.type) || [];
      for (const h of arr) h(event);
    },
    click() {
      const arr = listeners.get('click') || [];
      for (const h of arr) h({ type: 'click', preventDefault() {} });
    },
    focus() {},
    showModal() { el.open = true; },
    close() { el.open = false; },
    setAttribute(key, val) { attributes.set(key, String(val)); },
    getAttribute(key) { return attributes.get(key) ?? null; },
    removeAttribute(key) { attributes.delete(key); },
    append(...nodes) {
      for (const node of nodes) {
        if (typeof node === 'string') {
          children.push(createMockElement('span'));
          children[children.length - 1].textContent = node;
        } else {
          node.parentElement = el;
          children.push(node);
        }
      }
    },
    prepend(...nodes) {
      for (const node of nodes.reverse()) {
        if (typeof node === 'string') {
          const s = createMockElement('span');
          s.textContent = node;
          children.unshift(s);
        } else {
          node.parentElement = el;
          children.unshift(node);
        }
      }
    },
    replaceChildren(...nodes) {
      children.length = 0;
      for (const node of nodes) {
        if (typeof node === 'string') {
          const s = createMockElement('span');
          s.textContent = node;
          children.push(s);
        } else {
          node.parentElement = el;
          children.push(node);
        }
      }
    },
    remove() {
      if (el.parentElement) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx !== -1) el.parentElement.children.splice(idx, 1);
      }
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const parts = sel.trim().split(/\s+/);
      let current = [el];
      for (const part of parts) {
        const next = [];
        for (const parent of current) {
          function walk(node) {
            for (const child of node.children) {
              if (matchesSelector(child, part)) next.push(child);
              walk(child);
            }
          }
          walk(parent);
        }
        current = next;
      }
      return current;
    },
    matches(sel) {
      return matchesSelector(el, sel);
    },
    classList: {
      add(...cls) { cls.forEach(c => classListSet.add(c)); },
      remove(...cls) { cls.forEach(c => classListSet.delete(c)); },
      toggle(cls, force) {
        if (force === true) classListSet.add(cls);
        else if (force === false) classListSet.delete(cls);
        else if (classListSet.has(cls)) classListSet.delete(cls);
        else classListSet.add(cls);
      },
      contains(cls) { return classListSet.has(cls); }
    },
    get className() { return [...classListSet].join(' '); },
    set className(val) {
      classListSet.clear();
      (val || '').split(/\s+/).filter(Boolean).forEach(c => classListSet.add(c));
    },
    get textContent() {
      if (el._textContent !== undefined) return el._textContent;
      return children.map(c => c.textContent).join('');
    },
    set textContent(val) {
      el._textContent = String(val);
      children.length = 0;
    }
  };

  return el;
}

function matchesSelector(el, sel) {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.includes('[data-status=')) {
    const m = sel.match(/\[data-status=([^\]]+)\]/);
    return m && el.dataset.status === m[1];
  }
  if (sel.includes('[data-access=')) {
    const m = sel.match(/\[data-access=([^\]]+)\]/);
    return m && el.dataset.access === m[1];
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function createDOMEnvironment() {
  const elements = new Map();

  function getOrCreate(id, tag = 'div', cls = '') {
    if (!elements.has(id)) {
      const el = createMockElement(tag, id, cls);
      elements.set(id, el);
    }
    return elements.get(id);
  }

  // Pre-populate elements present in sidepanel.html
  const requiredIds = [
    'historyButton', 'settingsButton', 'newChat', 'historyDialog', 'settingsDialog',
    'settingsPanel', 'settingsForm', 'provider', 'baseUrl', 'apiKey', 'refreshModels',
    'modelsFeedback', 'model', 'streaming', 'parallelTools', 'parallelLimit', 'maxRounds',
    'timeoutSeconds', 'contextWindowTokens', 'contextHelp', 'autoCompact', 'mcpTools',
    'mcpParallelPreset', 'mcpScraplingPreset', 'mcpConfig', 'mcpFeedback', 'connectMcp',
    'disconnectMcp', 'browserTools', 'fileTools', 'theme', 'textSize', 'shine', 'enterSend',
    'rememberChats', 'settingsFeedback', 'filesPanel', 'fileBadge', 'folderForm',
    'folderPath', 'addFolder', 'folderList', 'refreshFolders', 'folderFeedback', 'messages',
    'welcome', 'toolActivity', 'recoveryControls', 'recoveryStateBadge', 'resumeTask',
    'retryStep', 'takeOverTab', 'approval', 'approvalText', 'denyAction', 'allowAction',
    'composer', 'prompt', 'activity', 'stop', 'send', 'contextUsage', 'accessMenu',
    'accessLabel', 'modelPicker', 'modelButton', 'modelName', 'modelMenu', 'modelSearch',
    'modelOptions', 'chatList', 'historySearch', 'modelBadge'
  ];

  for (const id of requiredIds) {
    getOrCreate(id);
  }

  // settingsPanel and filesPanel have summary children
  getOrCreate('settingsPanel').append(createMockElement('summary'));
  getOrCreate('filesPanel').append(createMockElement('summary'));
  getOrCreate('model').value = 'test-model';
  getOrCreate('baseUrl').value = 'https://api.example.com/v1';

  const documentElement = createMockElement('html');
  const body = createMockElement('body');
  documentElement.append(body);

  // Add recoveryControls and children inside body
  const recovery = getOrCreate('recoveryControls', 'section');
  const badge = getOrCreate('recoveryStateBadge', 'span');
  const resumeBtn = getOrCreate('resumeTask', 'button');
  const retryBtn = getOrCreate('retryStep', 'button');
  const takeOverBtn = getOrCreate('takeOverTab', 'button');
  recovery.append(badge, resumeBtn, retryBtn, takeOverBtn);
  body.append(recovery);

  const doc = {
    documentElement,
    body,
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tag) {
      return createMockElement(tag);
    },
    querySelector(sel) {
      if (sel.startsWith('#')) return doc.getElementById(sel.slice(1));
      return body.querySelector(sel);
    },
    querySelectorAll(sel) {
      if (sel.startsWith('#')) {
        const el = doc.getElementById(sel.slice(1));
        return el ? [el] : [];
      }
      return body.querySelectorAll(sel);
    },
    addEventListener() {},
    removeEventListener() {}
  };

  return { doc, elements };
}

(async () => {
  console.log('Running Lifecycle State Machine and Recovery Controls tests...');

  const { doc, elements } = createDOMEnvironment();
  const activatedTabs = [];
  const focusedWindows = [];

  const store = {
    aiSettings: {
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model'
    },
    aiAccessMode: 'full'
  };

  const chromeMock = {
    storage: {
      local: {
        get: async () => store,
        set: async (val) => Object.assign(store, val),
        remove: async (k) => { delete store[k]; }
      },
      session: {
        get: async () => ({}),
        set: async () => {}
      }
    },
    tabs: {
      query: async () => [{ id: 42, title: 'Test Tab', url: 'https://example.com', windowId: 101 }],
      update: async (tabId, props) => {
        activatedTabs.push({ tabId, props });
        return { id: tabId, ...props };
      }
    },
    windows: {
      update: async (winId, props) => {
        focusedWindows.push({ winId, props });
        return { id: winId, ...props };
      }
    },
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (cb) cb({ success: true, result: {} });
      }
    }
  };

  const agentMock = {
    endpoint(url) { return url; },
    listModels: async () => ['test-model'],
    userPrompt: (p) => p,
    validateWorkflow: (name, arg) => arg,
    run: async () => []
  };

  const rendererMock = {
    render: (text, container) => { container.textContent = text; }
  };

  const sandbox = {
    OmniSidebarPolicy: require('../extensions/chrome/sidebar-policy.js'),
    OmniTaskSession: require('../extensions/chrome/task-session.js'),
    document: doc,
    window: {
      addEventListener() {},
      document: doc
    },
    globalThis: {},
    chrome: chromeMock,
    OmniSidebarAgent: agentMock,
    OmniChatRenderer: rendererMock,
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) },
    performance: { now: () => Date.now() },
    AbortController,
    structuredClone: (obj) => JSON.parse(JSON.stringify(obj)),
    getComputedStyle: () => ({ minHeight: '36px', maxHeight: '112px' }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    console,
    URL
  };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;

  const scriptCode = fs.readFileSync('extensions/chrome/sidepanel.js', 'utf8');
  vm.runInNewContext(scriptCode, sandbox);

  // Allow startup async IIFE to run
  await new Promise(r => setTimeout(r, 50));

  // 1. Check explicit RunState enum
  const RunState = sandbox.RunState || sandbox.window.RunState;
  assert.ok(RunState, 'RunState must be defined');
  assert.equal(RunState.IDLE, 'idle');
  assert.equal(RunState.RUNNING, 'running');
  assert.equal(RunState.WAITING, 'waiting');
  assert.equal(RunState.STOPPED, 'stopped');
  assert.equal(RunState.FAILED, 'failed');
  assert.equal(RunState.COMPLETED, 'completed');
  assert.equal(RunState.UNKNOWN, 'unknown');

  // 2. Initial state: idle
  assert.equal(doc.body.dataset.runState, 'idle');
  assert.equal(doc.getElementById('recoveryControls').hidden, true);

  // 3. Test setRunState
  sandbox.setRunState(RunState.STOPPED);
  assert.equal(doc.body.dataset.runState, 'stopped');
  assert.equal(doc.getElementById('recoveryControls').hidden, false);
  assert.equal(doc.getElementById('recoveryStateBadge').textContent, 'Stopped');

  sandbox.setRunState(RunState.FAILED);
  assert.equal(doc.body.dataset.runState, 'failed');
  assert.equal(doc.getElementById('recoveryControls').hidden, false);
  assert.equal(doc.getElementById('recoveryStateBadge').textContent, 'Failed');

  sandbox.setRunState(RunState.UNKNOWN);
  assert.equal(doc.body.dataset.runState, 'unknown');
  assert.equal(doc.getElementById('recoveryControls').hidden, false);
  assert.equal(doc.getElementById('recoveryStateBadge').textContent, 'Uncertain');

  sandbox.setRunState(RunState.WAITING);
  assert.equal(doc.body.dataset.runState, 'waiting');
  assert.equal(doc.getElementById('recoveryControls').hidden, true);

  sandbox.setRunState(RunState.COMPLETED);
  assert.equal(doc.body.dataset.runState, 'completed');
  assert.equal(doc.getElementById('recoveryControls').hidden, true);

  sandbox.setRunState(RunState.RUNNING);
  assert.equal(doc.body.dataset.runState, 'running');
  assert.equal(doc.getElementById('recoveryControls').hidden, true);

  sandbox.setRunState(RunState.IDLE);
  assert.equal(doc.body.dataset.runState, 'idle');
  assert.equal(doc.getElementById('recoveryControls').hidden, true);

  // 4. Test runTask success -> completed, activity starts with Finished
  let runCalledWithPrompt = null;
  agentMock.run = async (opts) => {
    runCalledWithPrompt = opts.prompt;
    return [{ role: 'assistant', content: 'Success response.' }];
  };

  await sandbox.runTask('Hello world');
  assert.equal(doc.body.dataset.runState, 'completed');
  assert.match(doc.getElementById('activity').textContent, /^Finished ·/);
  assert.equal(doc.getElementById('recoveryControls').hidden, true);

  // 5. Test runTask stopped (aborted) -> stopped, activity NEVER starts with Finished
  agentMock.run = async (opts) => {
    const err = new Error('Stopped');
    err.name = 'AbortError';
    throw err;
  };
  await sandbox.runTask('Cancel me');
  assert.equal(doc.body.dataset.runState, 'stopped');
  assert.match(doc.getElementById('activity').textContent, /^Stopped ·/);
  assert.ok(!doc.getElementById('activity').textContent.startsWith('Finished'), 'Stopped must never display Finished');
  assert.equal(doc.getElementById('recoveryControls').hidden, false);

  // 6. Test runTask failed (error) -> failed, activity NEVER starts with Finished
  agentMock.run = async (opts) => {
    throw new Error('API Rate Limit Exceeded');
  };
  await sandbox.runTask('Fail me');
  assert.equal(doc.body.dataset.runState, 'failed');
  assert.match(doc.getElementById('activity').textContent, /^Failed ·/);
  assert.ok(!doc.getElementById('activity').textContent.startsWith('Finished'), 'Failed must never display Finished');
  assert.equal(doc.getElementById('recoveryControls').hidden, false);

  // 7. Test runTask unknown outcome -> unknown, activity NEVER starts with Finished
  agentMock.run = async (opts) => {
    return [{ role: 'assistant', content: 'Completed 64 tool rounds. Send a follow-up to continue from this point.' }];
  };
  await sandbox.runTask('Reach max rounds');
  assert.equal(doc.body.dataset.runState, 'unknown');
  assert.match(doc.getElementById('activity').textContent, /^Outcome uncertain ·/);
  assert.ok(!doc.getElementById('activity').textContent.startsWith('Finished'), 'Unknown outcome must never display Finished');
  assert.equal(doc.getElementById('recoveryControls').hidden, false);

  // 8. Test Recovery Controls: Take Over
  activatedTabs.length = 0;
  focusedWindows.length = 0;
  const takeOverBtnEl = doc.getElementById('takeOverTab');
  assert.ok(takeOverBtnEl, '#takeOverTab button must exist');
  takeOverBtnEl.click();
  // Allow async takeOver handler to complete
  await new Promise(r => setTimeout(r, 20));
  assert.equal(activatedTabs.length, 1);
  assert.equal(activatedTabs[0].tabId, 42);
  assert.equal(activatedTabs[0].props.active, true);
  assert.equal(focusedWindows.length, 1);
  assert.equal(focusedWindows[0].winId, 101);
  assert.equal(focusedWindows[0].props.focused, true);

  // 9. Test Recovery Controls: Resume
  let resumePromptReceived = null;
  agentMock.run = async (opts) => {
    resumePromptReceived = opts.prompt;
    return [{ role: 'assistant', content: 'Resumed successfully.' }];
  };
  const resumeBtnEl = doc.getElementById('resumeTask');
  assert.ok(resumeBtnEl, '#resumeTask button must exist');
  resumeBtnEl.click();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(resumePromptReceived.includes('current page state'), 'Resume prompt should continue from current page state');
  assert.equal(doc.body.dataset.runState, 'completed');

  // 10. Test Recovery Controls: Retry Step
  sandbox.setRunState(RunState.FAILED);
  let retryPromptReceived = null;
  agentMock.run = async (opts) => {
    retryPromptReceived = opts.prompt;
    return [{ role: 'assistant', content: 'Retried step successfully.' }];
  };
  const retryBtnEl = doc.getElementById('retryStep');
  assert.ok(retryBtnEl, '#retryStep button must exist');
  retryBtnEl.click();
  await new Promise(r => setTimeout(r, 20));
  assert.ok(retryPromptReceived.includes('idempotently'), 'Retry prompt should retry idempotently');
  assert.equal(doc.body.dataset.runState, 'completed');

  // 11. Test plan with blocked step -> unknown outcome
  agentMock.run = async (opts) => {
    opts.onEvent({
      type: 'plan',
      steps: [
        { title: 'Step 1', status: 'complete' },
        { title: 'Step 2', status: 'blocked' }
      ]
    });
    return [{ role: 'assistant', content: 'Step 2 could not be completed.' }];
  };
  await sandbox.runTask('Run blocked plan');
  assert.equal(doc.body.dataset.runState, 'unknown');
  assert.match(doc.getElementById('activity').textContent, /^Outcome uncertain ·/);
  assert.ok(!doc.getElementById('activity').textContent.startsWith('Finished'));
  assert.equal(doc.getElementById('recoveryControls').hidden, false);

  // 12. Test newChat resets to idle and hides recovery controls
  const newChatBtn = doc.getElementById('newChat');
  newChatBtn.click();
  assert.equal(doc.body.dataset.runState, 'idle');
  assert.equal(doc.getElementById('recoveryControls').hidden, true);
  assert.equal(doc.getElementById('activity').textContent, '');

  console.log('✓ All Lifecycle State Machine & Recovery Controls tests passed successfully!');
})().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
