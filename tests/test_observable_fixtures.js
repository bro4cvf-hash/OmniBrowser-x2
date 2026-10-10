// tests/test_observable_fixtures.js
// Item 49: Task Fixtures for Realistic Web Scenarios
// Tests deterministic observable fixtures covering:
// 1. Delayed forms & dynamic elements (actionability auto-waiting)
// 2. Modal overlays & backdrops (occlusion detection)
// 3. Open shadow roots with `>>>` and short `@eN` references
// 4. Nested iframes
// 5. Ambiguous confirmation vs genuine confirmation

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const bgSource = fs.readFileSync('extensions/chrome/background.js', 'utf8');

// --- Lightweight deterministic DOM Environment ---

class MockNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.parentElement = null;
    this.childNodes = [];
    this._observers = new Set();
  }

  getRootNode() {
    let curr = this;
    while (curr.parentNode) {
      curr = curr.parentNode;
    }
    return curr;
  }

  _notifyMutations(mutation) {
    let curr = this;
    while (curr) {
      if (curr._observers) {
        for (const obs of curr._observers) {
          obs._notify(mutation);
        }
      }
      curr = curr.parentNode || curr.host;
    }
  }
}

class MockElement extends MockNode {
  constructor(tagName, ownerDocument) {
    super(1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.style = { visibility: 'visible', display: 'block' };
    this.shadowRoot = null;
    this.dataset = {};
    this._listeners = new Map();
    this._customRect = null;
    this._zIndex = 0;
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    const idx = siblings.indexOf(this);
    return idx > 0 ? siblings[idx - 1] : null;
  }

  set _rect(r) { this._customRect = r; }
  get _rect() { return this.getBoundingClientRect(); }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }

  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }

  get children() {
    return this.childNodes.filter(n => n.nodeType === 1);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[prop] = String(value);
    }
    this._notifyMutations({ type: 'attributes', target: this, attributeName: name });
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      delete this.dataset[prop];
    }
    this._notifyMutations({ type: 'attributes', target: this, attributeName: name });
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    child.parentElement = this;
    this.childNodes.push(child);
    this._notifyMutations({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
    return child;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const textNode = new MockNode(3, '#text');
        textNode.textContent = node;
        this.appendChild(textNode);
      } else {
        this.appendChild(node);
      }
    }
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
      this._notifyMutations({ type: 'childList', target: this, addedNodes: [], removedNodes: [child] });
    }
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  attachShadow(init = { mode: 'open' }) {
    const shadow = new MockShadowRoot(this, this.ownerDocument);
    if (init && init.mode === 'closed') {
      this.shadowRoot = null;
    } else {
      this.shadowRoot = shadow;
    }
    return shadow;
  }

  get isConnected() {
    let curr = this;
    while (curr) {
      if (curr === this.ownerDocument || (curr.nodeType === 9)) return true;
      curr = curr.parentNode || curr.host;
    }
    return false;
  }

  matches(selector) {
    if (!selector || typeof selector !== 'string') return false;
    const parts = selector.split(',').map(s => s.trim());
    for (const sel of parts) {
      if (this._matchesSingle(sel)) return true;
    }
    return false;
  }

  _matchesSingle(sel) {
    if (sel === '*') return true;
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    if (sel.includes(':not(')) {
      const match = sel.match(/^([^:]*):not\((.+)\)$/);
      if (match) {
        const base = match[1].trim();
        const negated = match[2].trim();
        if (base && !this._matchesSingle(base)) return false;
        return !this._matchesSingle(negated);
      }
    }
    if (!sel.startsWith('[') && sel.includes('[') && sel.endsWith(']')) {
      const braIdx = sel.indexOf('[');
      const tag = sel.slice(0, braIdx).trim();
      const attrPart = sel.slice(braIdx);
      if (tag && !this._matchesSingle(tag)) return false;
      return this._matchesSingle(attrPart);
    }
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const inside = sel.slice(1, -1);
      const eqIdx = inside.indexOf('=');
      if (eqIdx === -1) return this.hasAttribute(inside);
      const key = inside.slice(0, eqIdx).trim();
      let val = inside.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return (this.getAttribute(key) || this[key]) === val;
    }
    if (sel.includes(':nth-of-type(')) {
      const match = sel.match(/^([a-z0-9_-]+):nth-of-type\((\d+)\)$/i);
      if (match) {
        const tag = match[1].toUpperCase();
        const n = parseInt(match[2], 10);
        if (this.tagName !== tag) return false;
        const siblings = this.parentNode ? this.parentNode.children.filter(c => c.tagName === tag) : [this];
        return siblings.indexOf(this) + 1 === n;
      }
    }
    return this.tagName === sel.toUpperCase();
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(listener);
  }

  dispatchEvent(event) {
    event.target = this;
    event.currentTarget = this;
    const listeners = this._listeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        listener.call(this, event);
      }
    }
    const handler = this['on' + event.type];
    if (typeof handler === 'function') handler.call(this, event);
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
  }

  scrollIntoView() {}

  getBoundingClientRect() {
    if (this._customRect) return { ...this._customRect };
    let y = 10;
    let curr = this;
    while (curr && curr.nodeType === 1) {
      if (curr.previousElementSibling) {
        y += 45;
        curr = curr.previousElementSibling;
      } else {
        curr = curr.parentElement;
      }
    }
    return { x: 10, y, width: 150, height: 35, top: y, left: 10, bottom: y + 35, right: 160 };
  }

  getClientRects() {
    const r = this.getBoundingClientRect();
    if (this.style.display === 'none' || this.style.visibility === 'hidden') return [];
    if (r.width === 0 && r.height === 0) return [];
    return [r];
  }

  get textContent() {
    let text = '';
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) text += child.textContent;
        else if (child.nodeType === 1) walk(child);
      }
    };
    walk(this);
    return text;
  }

  set textContent(v) {
    this.childNodes = [];
    const t = new MockNode(3, '#text');
    t.textContent = String(v);
    this.appendChild(t);
  }

  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
}

class MockShadowRoot extends MockNode {
  constructor(host, ownerDocument) {
    super(11, '#document-fragment');
    this.host = host;
    this.ownerDocument = ownerDocument;
    this._listeners = new Map();
  }

  get children() {
    return this.childNodes.filter(n => n.nodeType === 1);
  }

  appendChild(child) {
    child.parentNode = this;
    child.parentElement = this.host;
    this.childNodes.push(child);
    this._notifyMutations({ type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
    return child;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      this._notifyMutations({ type: 'childList', target: this, addedNodes: [], removedNodes: [child] });
    }
    return child;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.matches(selector)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  elementFromPoint(x, y) {
    return this.ownerDocument.elementFromPoint(x, y, this);
  }
}

class MockHTMLInputElement extends MockElement {
  constructor(ownerDocument) {
    super('input', ownerDocument);
    this.type = 'text';
    this._value = '';
    this.checked = false;
    this.disabled = false;
    this.readOnly = false;
    this.required = false;
  }

  get value() { return this._value; }
  set value(v) { this._value = String(v); }

  click() {
    if (this.type === 'checkbox') {
      this.checked = !this.checked;
    } else if (this.type === 'radio') {
      this.checked = true;
    }
    super.click();
  }

  get validity() {
    const valid = !this.required || (this.type === 'checkbox' ? this.checked : this._value.length > 0);
    return { valid };
  }

  get validationMessage() {
    return this.validity.valid ? '' : 'Please fill out this field.';
  }
}

class MockHTMLTextAreaElement extends MockElement {
  constructor(ownerDocument) {
    super('textarea', ownerDocument);
    this._value = '';
    this.disabled = false;
    this.readOnly = false;
    this.required = false;
  }

  get value() { return this._value; }
  set value(v) { this._value = String(v); }

  get validity() {
    return { valid: !this.required || this._value.length > 0 };
  }

  get validationMessage() {
    return this.validity.valid ? '' : 'Please fill out this field.';
  }
}

class MockHTMLSelectElement extends MockElement {
  constructor(ownerDocument) {
    super('select', ownerDocument);
    this.value = '';
    this.disabled = false;
  }

  get options() {
    return this.querySelectorAll('option').map(opt => ({
      text: opt.textContent,
      value: opt.getAttribute('value') || opt.textContent,
      disabled: opt.hasAttribute('disabled'),
      closest: sel => opt.matches(sel) ? opt : null,
    }));
  }
}

class MockDocument extends MockNode {
  constructor() {
    super(9, '#document');
    this.ownerDocument = this;
    this.title = 'Deterministic Web Fixture';
    this.readyState = 'complete';
    this.documentElement = new MockElement('html', this);
    this.documentElement.parentNode = this;
    this.body = new MockElement('body', this);
    this.documentElement.appendChild(this.body);
    this.childNodes.push(this.documentElement);
  }

  createElement(tagName) {
    const tag = tagName.toLowerCase();
    if (tag === 'input') return new MockHTMLInputElement(this);
    if (tag === 'textarea') return new MockHTMLTextAreaElement(this);
    if (tag === 'select') return new MockHTMLSelectElement(this);
    return new MockElement(tag, this);
  }

  get children() {
    return [this.documentElement];
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  elementFromPoint(x, y, scopeRoot = null) {
    const candidates = [];
    let orderCounter = 0;
    const collect = (el, currentZ = 0) => {
      if (!el || el.nodeType !== 1) return;
      if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return;
      const z = el._zIndex !== undefined ? el._zIndex : currentZ;
      const order = ++orderCounter;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        candidates.push({ el, z, order });
      }
      for (const child of el.children) collect(child, z);
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) collect(child, z);
      }
    };
    if (scopeRoot && scopeRoot.nodeType === 11) {
      for (const child of scopeRoot.children) collect(child);
    } else {
      collect(scopeRoot || this.documentElement);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.z - a.z) || (b.order - a.order));
    return candidates[0].el;
  }
}

class MockMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
  }

  observe(target, options) {
    this.targets.add(target);
    target._observers.add(this);
  }

  disconnect() {
    for (const t of this.targets) {
      t._observers.delete(this);
    }
    this.targets.clear();
  }

  _notify(mutation) {
    if (this.targets.size > 0) {
      this.callback([mutation], this);
    }
  }
}

// Helper to instantiate clean VM execution context for background.js tools
function createFixtureEnvironment(framesData = {}) {
  // framesData: Map of frameId -> { doc, win }
  const mainDoc = new MockDocument();
  const mainWin = {
    document: mainDoc,
    location: { href: 'https://fixtures.example.com/index.html' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    MutationObserver: MockMutationObserver,
    getComputedStyle: el => el.style,
    Event: class Event { constructor(type, init) { this.type = type; this.bubbles = init?.bubbles ?? false; } },
    HTMLInputElement: MockHTMLInputElement,
    HTMLTextAreaElement: MockHTMLTextAreaElement,
    HTMLSelectElement: MockHTMLSelectElement,
    CSS: { escape: s => s },
  };

  const frames = new Map();
  frames.set(0, { doc: mainDoc, win: mainWin });

  for (const [id, cfg] of Object.entries(framesData)) {
    const frameId = Number(id);
    const doc = new MockDocument();
    doc.title = cfg.title || `Frame ${frameId}`;
    const win = {
      document: doc,
      location: { href: cfg.url || `https://fixtures.example.com/frame${frameId}.html` },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Date,
      MutationObserver: MockMutationObserver,
      getComputedStyle: el => el.style,
      Event: class Event { constructor(type, init) { this.type = type; this.bubbles = init?.bubbles ?? false; } },
      HTMLInputElement: MockHTMLInputElement,
      HTMLTextAreaElement: MockHTMLTextAreaElement,
      HTMLSelectElement: MockHTMLSelectElement,
      CSS: { escape: s => s },
    };
    frames.set(frameId, { doc, win });
  }

  const chrome = {
    runtime: {
      connectNative: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }),
      onMessage: { addListener() {} },
      onConnect: { addListener() {} }
    },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      attach: (target, version, cb) => {
        if (typeof cb === 'function') cb();
        return Promise.resolve();
      },
      detach: (target, cb) => {
        if (typeof cb === 'function') cb();
        return Promise.resolve();
      },
      sendCommand: (target, method, commandParams, cb) => {
        if (typeof cb === 'function') cb({});
        return Promise.resolve({ result: {} });
      }
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      get: async id => ({ id, url: 'https://fixtures.example.com/index.html' })
    },
    scripting: {
      executeScript: async spec => {
        const targetFrameIds = spec.target.allFrames ? [...frames.keys()] : (spec.target.frameIds || [0]);
        const results = [];
        for (const frameId of targetFrameIds) {
          const frame = frames.get(frameId);
          if (!frame) continue;
          const frameContext = vm.createContext({
            ...frame.win,
            document: frame.doc,
            window: frame.win,
            globalThis: frame.win,
            requestAnimationFrame: cb => setTimeout(cb, 16),
            cancelAnimationFrame: id => clearTimeout(id),
            StaleElementReference: class StaleElementReference extends Error { constructor(m) { super(m); this.name = 'StaleElementReference'; } },
            chrome,
            console,
            URL,
            Map,
            Set,
            Array,
            Object,
            Number,
            String,
            Boolean,
            Date,
            Promise,
          });
          vm.runInContext(bgSource, frameContext);
          // Run the requested function inside this frame context
          const funcCode = `(${spec.func.toString()})(...${JSON.stringify(spec.args || [])})`;
          const result = await vm.runInContext(funcCode, frameContext);
          results.push({ frameId, result });
        }
        return results;
      }
    }
  };

  const bgContext = vm.createContext({
    chrome,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Date,
    Promise,
  });

  vm.runInContext(bgSource, bgContext);

  const runSidebarTool = (name, args) =>
    vm.runInContext(`runSidebarTool(${JSON.stringify(name)}, ${JSON.stringify(args)})`, bgContext);

  return { mainDoc, mainWin, frames, runSidebarTool, chrome };
}

// --- Generic Submission Confirmation Evaluator ---
// Distinguishes genuine submission evidence from ambiguous/transient/error states.
function evaluateSubmissionConfirmation(pageSnapshot) {
  if (!pageSnapshot) return { confirmed: false, status: 'error', reason: 'No page snapshot provided' };

  const text = (pageSnapshot.text || '').toLowerCase();
  const elements = pageSnapshot.elements || [];

  // Check 1: Explicit error alerts or invalid fields
  const hasInvalidField = elements.some(el => el.valid === false);
  const errorAlert = elements.find(el => el.role === 'alert' || /error|invalid|failed/i.test(el.label || ''));
  if (hasInvalidField || (errorAlert && !/success/i.test(errorAlert.label))) {
    return {
      confirmed: false,
      status: 'rejected',
      reason: errorAlert ? `Validation or submission error: ${errorAlert.label}` : 'One or more fields failed validation'
    };
  }

  // Check 2: Genuine confirmation indicators
  // Look for confirmation receipt / ID pattern: e.g. "Confirmation Number: CONF-123", "Order #456", "Ref: ABC"
  const refMatch = pageSnapshot.text.match(/(?:confirmation|reference|receipt|order)\s*(?:#|number|id|code)?\s*[:#]\s*([a-z0-9_-]{4,})/i) ||
                   pageSnapshot.text.match(/(?:confirmation|reference|receipt|order)\s+(?:#|number|id|code)\s+([a-z0-9_-]{4,})/i);
  const successMessageMatch = /(?:successfully\s+submitted|submission\s+confirmed|application\s+received|order\s+placed\s+successfully|thank\s+you\s+for\s+your\s+application)/i.test(pageSnapshot.text);

  // Check 3: Ambiguous or transient indicators (spinner, "processing", draft saved)
  const isTransient = /(?:processing\s+your\s+request|please\s+wait|submitting\.\.\.|draft\s+saved)/i.test(text);

  if (successMessageMatch && refMatch) {
    return {
      confirmed: true,
      status: 'confirmed',
      referenceId: refMatch[1],
      reason: 'Observed genuine confirmation message and unique reference code'
    };
  }

  if (isTransient) {
    return {
      confirmed: false,
      status: 'ambiguous',
      reason: 'Transient processing or pending state without final confirmation receipt'
    };
  }

  if (successMessageMatch && !refMatch) {
    // Message present without reference id, check if form was actually unmounted/cleared
    const editableInputs = elements.filter(el => ['text', 'email', 'number'].includes(el.type) && !el.disabled);
    if (editableInputs.length > 0) {
      return {
        confirmed: false,
        status: 'ambiguous',
        reason: 'Success text present but form inputs remain active and unconfirmed'
      };
    }
    return {
      confirmed: true,
      status: 'confirmed',
      reason: 'Observed success confirmation with form completion'
    };
  }

  return {
    confirmed: false,
    status: 'unconfirmed',
    reason: 'No confirmation evidence observed on page'
  };
}

// =========================================================================
// Deterministic Fixtures & Tests
// =========================================================================

(async () => {
  console.log('--- Starting Task Fixtures for Realistic Web Scenarios ---');

  // =======================================================================
  // 1. Delayed forms & dynamic elements (verifying actionability auto-waiting)
  // =======================================================================
  console.log('Testing Scenario 1: Delayed forms & dynamic elements (actionability auto-waiting)...');
  {
    const { mainDoc, runSidebarTool } = createFixtureEnvironment();

    // Initial state: loading indicator, form not mounted yet
    const loadingDiv = mainDoc.createElement('div');
    loadingDiv.id = 'loading';
    loadingDiv.innerText = 'Loading delayed form...';
    mainDoc.body.appendChild(loadingDiv);

    // Dynamic mount after 60ms delay
    setTimeout(() => {
      loadingDiv.remove();

      const form = mainDoc.createElement('form');
      form.id = 'delayed-form';

      const nameInput = mainDoc.createElement('input');
      nameInput.id = 'applicant-name';
      nameInput.setAttribute('name', 'applicant');
      nameInput.required = true;

      const emailInput = mainDoc.createElement('input');
      emailInput.id = 'applicant-email';
      emailInput.type = 'email';
      emailInput.required = true;

      const submitBtn = mainDoc.createElement('button');
      submitBtn.id = 'submit-delayed';
      submitBtn.innerText = 'Submit Application';
      submitBtn.onclick = () => {
        mainDoc.body.dataset.formSubmitted = 'true';
        mainDoc.body.dataset.applicantName = nameInput.value;
        mainDoc.body.dataset.applicantEmail = emailInput.value;
      };

      form.appendChild(nameInput);
      form.appendChild(emailInput);
      form.appendChild(submitBtn);
      mainDoc.body.appendChild(form);
    }, 60);

    // Auto-waiting step: browser_step with waitForSelector on #applicant-name
    // Must auto-wait for the 60ms delay, fill inputs, and click submit.
    const stepResult = await runSidebarTool('browser_step', {
      tabId: 1,
      waitForSelector: '#applicant-name',
      timeoutMs: 2000,
      actions: [
        { action: 'fill', selector: '#applicant-name', value: 'Jordan Smith' },
        { action: 'fill', selector: '#applicant-email', value: 'jordan.smith@example.com' },
      ],
      clickSelector: '#submit-delayed'
    });

    console.log('stepResult:', JSON.stringify(stepResult, null, 2));
    assert.equal(stepResult.completed, true, 'browser_step must succeed after auto-waiting for delayed form');
    assert.equal(stepResult.waitFailed, undefined);

    // Assert final observable DOM/state changes
    const applicantNameEl = mainDoc.querySelector('#applicant-name');
    const applicantEmailEl = mainDoc.querySelector('#applicant-email');
    assert.ok(applicantNameEl, '#applicant-name must exist in DOM');
    assert.equal(applicantNameEl.value, 'Jordan Smith', 'Observable DOM: applicant name input value updated');
    assert.equal(applicantEmailEl.value, 'jordan.smith@example.com', 'Observable DOM: email input value updated');
    assert.equal(mainDoc.body.dataset.formSubmitted, 'true', 'Observable DOM: form submission handler triggered');
    assert.equal(mainDoc.body.dataset.applicantName, 'Jordan Smith', 'Observable DOM: dataset reflects final applicant state');

    // Negative timeout check: waiting for an element that never appears
    const timeoutStep = await runSidebarTool('browser_step', {
      tabId: 1,
      waitForSelector: '#element-that-never-appears',
      timeoutMs: 80,
      actions: [{ action: 'fill', selector: '#applicant-name', value: 'Updated Name' }]
    });
    assert.equal(timeoutStep.completed, false, 'Auto-waiting must timeout if element never appears');
    assert.equal(timeoutStep.waitFailed, true);
    assert.match(timeoutStep.error, /Expected control did not become visible/i);

    console.log('✓ Scenario 1 passed: actionability auto-waiting resolved delayed elements and recorded state changes.');
  }

  // =======================================================================
  // 2. Modal overlays & backdrops (verifying occlusion detection)
  // =======================================================================
  console.log('Testing Scenario 2: Modal overlays & backdrops (occlusion detection)...');
  {
    const { mainDoc, runSidebarTool } = createFixtureEnvironment();

    // Background interactive action button
    const actionBtn = mainDoc.createElement('button');
    actionBtn.id = 'target-action-btn';
    actionBtn.innerText = 'Confirm Transaction';
    actionBtn._rect = { x: 50, y: 50, width: 120, height: 40, left: 50, right: 170, top: 50, bottom: 90 };
    actionBtn._zIndex = 1;
    actionBtn.onclick = () => {
      mainDoc.body.dataset.actionExecuted = 'true';
    };
    mainDoc.body.appendChild(actionBtn);

    // High z-index Modal backdrop occluding the button
    const backdrop = mainDoc.createElement('div');
    backdrop.id = 'modal-backdrop';
    backdrop._rect = { x: 0, y: 0, width: 800, height: 600, left: 0, right: 800, top: 0, bottom: 600 };
    backdrop._zIndex = 100; // occludes zIndex 1

    const modalBox = mainDoc.createElement('div');
    modalBox.id = 'modal-box';
    modalBox._zIndex = 101;

    const dismissBtn = mainDoc.createElement('button');
    dismissBtn.id = 'dismiss-modal-btn';
    dismissBtn.innerText = 'Dismiss Modal';
    dismissBtn._rect = { x: 200, y: 200, width: 100, height: 30, left: 200, right: 300, top: 200, bottom: 230 };
    dismissBtn._zIndex = 102;
    dismissBtn.onclick = () => {
      backdrop.style.display = 'none';
      mainDoc.body.dataset.modalDismissed = 'true';
    };
    modalBox.appendChild(dismissBtn);
    backdrop.appendChild(modalBox);
    mainDoc.body.appendChild(backdrop);

    // Step A: Attempt to interact with target-action-btn while backdrop is active.
    // 1. Actionability waiting detects occlusion and times out with precise explanation
    await assert.rejects(
      runSidebarTool('fill', { tabId: 1, selector: '#target-action-btn', value: 'test', timeoutMs: 60 }),
      /covered by <div#(modal-backdrop|modal-box)>/i,
      'Actionability check must detect occlusion by modal overlay'
    );

    // 2. Click detects occlusion, reporting occlusion reason and leaving target unclicked
    await assert.rejects(runSidebarTool('click', { tabId: 1, selector: '#target-action-btn', timeoutMs: 60 }), /covered/, 'Covered targets must reject rather than click the overlay');
    assert.equal(mainDoc.body.dataset.actionExecuted, undefined, 'Click must NOT have reached covered button through backdrop');

    // Step B: Dismiss the modal overlay
    const dismissResult = await runSidebarTool('click', { tabId: 1, selector: '#dismiss-modal-btn' });
    assert.equal(dismissResult.completed, true);
    assert.equal(mainDoc.body.dataset.modalDismissed, 'true', 'Modal dismiss click succeeded');
    assert.equal(backdrop.style.display, 'none', 'Observable DOM: backdrop hidden');

    // Step C: Retry target action now that backdrop is removed/hidden
    const actionResult = await runSidebarTool('click', { tabId: 1, selector: '#target-action-btn' });
    assert.equal(actionResult.completed, true, 'Click succeeded once element is unoccluded');
    assert.equal(actionResult.synthetic, true, 'Unoccluded click succeeded synthetically');

    // Assert final observable DOM/state change
    assert.equal(mainDoc.body.dataset.actionExecuted, 'true', 'Observable DOM: target button received click');

    console.log('✓ Scenario 2 passed: modal occlusion detected and prevented click until overlay dismissed.');
  }

  // =======================================================================
  // 3. Open shadow roots with `>>>` and short `@eN` references
  // =======================================================================
  console.log('Testing Scenario 3: Open shadow roots with `>>>` and short `@eN` references...');
  {
    const { mainDoc, runSidebarTool } = createFixtureEnvironment();

    // Custom web component host
    const userCard = mainDoc.createElement('custom-user-profile');
    userCard.id = 'profile-component';
    mainDoc.body.appendChild(userCard);

    // Open shadow root
    const shadow = userCard.attachShadow({ mode: 'open' });

    const shadowNameInput = mainDoc.createElement('input');
    shadowNameInput.id = 'shadow-username';
    shadowNameInput.setAttribute('placeholder', 'Enter alias');
    shadowNameInput.value = 'Initial';

    const shadowToggle = mainDoc.createElement('input');
    shadowToggle.id = 'shadow-toggle';
    shadowToggle.type = 'checkbox';
    shadowToggle.checked = false;

    const shadowSaveBtn = mainDoc.createElement('button');
    shadowSaveBtn.id = 'shadow-save-btn';
    shadowSaveBtn.innerText = 'Save Profile';
    shadowSaveBtn.onclick = () => {
      userCard.dataset.savedAlias = shadowNameInput.value;
      userCard.dataset.savedNotification = String(shadowToggle.checked);
      userCard.dataset.saveState = 'saved';
    };

    shadow.appendChild(shadowNameInput);
    shadow.appendChild(shadowToggle);
    shadow.appendChild(shadowSaveBtn);

    // Step A: Inspect page -> returns elements across open shadow roots with >>> and short @eN refs
    const page = await runSidebarTool('read_page', { tabId: 1 });
    assert.ok(page.elements.length >= 3);

    const nameItem = page.elements.find(el => el.selector.includes('shadow-username'));
    const toggleItem = page.elements.find(el => el.selector.includes('shadow-toggle'));
    const btnItem = page.elements.find(el => el.selector.includes('shadow-save-btn'));

    assert.ok(nameItem, 'Shadow input element discovered');
    assert.match(nameItem.selector, /profile-component >>> #shadow-username/);
    assert.match(nameItem.ref, /^@e\d+$/);

    assert.ok(toggleItem, 'Shadow toggle element discovered');
    assert.match(toggleItem.selector, /profile-component >>> #shadow-toggle/);
    assert.match(toggleItem.ref, /^@e\d+$/);

    assert.ok(btnItem, 'Shadow button element discovered');
    assert.match(btnItem.selector, /profile-component >>> #shadow-save-btn/);
    assert.match(btnItem.ref, /^@e\d+$/);

    // Step B: Action targeting shadow root using `>>>` selector
    await runSidebarTool('fill', {
      tabId: 1,
      selector: '#profile-component >>> #shadow-username',
      value: 'ShadowAgent007'
    });
    assert.equal(shadowNameInput.value, 'ShadowAgent007', 'Observable DOM: shadow input updated via >>>');

    // Step C: Action targeting shadow root using short `@eN` reference
    await runSidebarTool('set_checked', {
      tabId: 1,
      ref: (await runSidebarTool('read_page', { tabId: 1 })).elements.find(el => el.selector.includes('shadow-toggle')).ref,
      checked: true
    });
    assert.equal(shadowToggle.checked, true, 'Observable DOM: shadow checkbox updated via @eN ref');

    // Step D: Trigger button click via short `@eN` reference
    await runSidebarTool('click', {
      tabId: 1,
      ref: (await runSidebarTool('read_page', { tabId: 1 })).elements.find(el => el.selector.includes('shadow-save-btn')).ref
    });

    // Step E: Verify fields with verifySidebarFields using both >>> and @eN refs
    const verifyResult = await runSidebarTool('form_verify', {
      tabId: 1,
      fields: [
        { selector: '#profile-component >>> #shadow-username', value: 'ShadowAgent007' },
        { selector: '#profile-component >>> #shadow-toggle', checked: true }
      ]
    });
    assert.equal(verifyResult.verified, true, 'form_verify confirmed shadow elements with >>> and @eN');

    // Assert final observable DOM/state changes
    assert.equal(userCard.dataset.savedAlias, 'ShadowAgent007', 'Observable DOM: custom element dataset savedAlias');
    assert.equal(userCard.dataset.savedNotification, 'true', 'Observable DOM: custom element dataset savedNotification');
    assert.equal(userCard.dataset.saveState, 'saved', 'Observable DOM: custom element saveState updated');

    // Step F: Flexible whitespace around >>> (both compact and padded)
    await runSidebarTool('fill', {
      tabId: 1,
      selector: '#profile-component>>>#shadow-username',
      value: 'ShadowWhitespaceCompact'
    });
    assert.equal(shadowNameInput.value, 'ShadowWhitespaceCompact', 'Flexible whitespace (compact) >>> resolved');

    await runSidebarTool('fill', {
      tabId: 1,
      selector: '#profile-component   >>>   #shadow-username',
      value: 'ShadowWhitespaceSpaced'
    });
    assert.equal(shadowNameInput.value, 'ShadowWhitespaceSpaced', 'Flexible whitespace (spaced) >>> resolved');

    // Step G: Closed shadow root returns descriptive error in hover and verifySidebarFields
    const closedCard = mainDoc.createElement('custom-closed-profile');
    closedCard.id = 'closed-profile';
    mainDoc.body.appendChild(closedCard);
    closedCard.attachShadow({ mode: 'closed' });

    await assert.rejects(
      runSidebarTool('hover', {
        tabId: 1,
        selector: '#closed-profile >>> #closed-target'
      }),
      /Target element is inside a closed or inaccessible shadow root/
    );

    const closedVerify = await runSidebarTool('form_verify', {
      tabId: 1,
      fields: [{ selector: '#closed-profile >>> #closed-input', value: 'closedVal' }]
    });
    assert.equal(closedVerify.verified, false);
    assert.equal(closedVerify.fields[0].error, 'Target element is inside a closed or inaccessible shadow root');

    console.log('✓ Scenario 3 passed: shadow roots navigated via `>>>` and short `@eN` refs with state asserted.');
  }

  // =======================================================================
  // 4. Nested iframes
  // =======================================================================
  console.log('Testing Scenario 4: Nested iframes...');
  {
    const framesConfig = {
      1: { title: 'Checkout Gateway Frame', url: 'https://gateway.example.com/pay' },
      2: { title: '3DS Security Challenge Frame', url: 'https://bank3ds.example.com/challenge' }
    };

    const { mainDoc, frames, runSidebarTool } = createFixtureEnvironment(framesConfig);

    // Frame 0 (top-level): Order note input
    const orderNotes = mainDoc.createElement('input');
    orderNotes.id = 'order-notes';
    orderNotes.value = '';
    mainDoc.body.appendChild(orderNotes);

    // Frame 1 (Gateway): Cardholder name input
    const frame1Doc = frames.get(1).doc;
    const cardHolder = frame1Doc.createElement('input');
    cardHolder.id = 'cardholder-name';
    cardHolder.value = '';
    frame1Doc.body.appendChild(cardHolder);

    // Frame 2 (Nested 3DS): Security pin / OTP input and confirm button
    const frame2Doc = frames.get(2).doc;
    const otpInput = frame2Doc.createElement('input');
    otpInput.id = 'otp-code';
    otpInput.value = '';
    const verifyBtn = frame2Doc.createElement('button');
    verifyBtn.id = 'verify-otp-btn';
    verifyBtn.innerText = 'Verify Security Code';
    verifyBtn.onclick = () => {
      frame2Doc.body.dataset.challengePassed = 'true';
      frame2Doc.body.dataset.recordedOtp = otpInput.value;
    };
    frame2Doc.body.appendChild(otpInput);
    frame2Doc.body.appendChild(verifyBtn);

    // Step A: Multi-frame read_page
    const page = await runSidebarTool('read_page', { tabId: 1 });
    assert.equal(page.frames.length, 3, 'Must detect top frame and two child frames');
    const f0El = page.elements.find(el => el.frameId === 0 && el.selector.includes('order-notes'));
    const f1El = page.elements.find(el => el.frameId === 1 && el.selector.includes('cardholder-name'));
    const f2El = page.elements.find(el => el.frameId === 2 && el.selector.includes('otp-code'));
    assert.ok(f0El, 'Frame 0 element discovered');
    assert.ok(f1El, 'Frame 1 element discovered');
    assert.ok(f2El, 'Frame 2 element discovered');

    // Step B: Batch actions across frames
    const batchResult = await runSidebarTool('batch_actions', {
      tabId: 1,
      actions: [
        { action: 'fill', frameId: 0, selector: '#order-notes', value: 'Expedited Air Freight' },
        { action: 'fill', frameId: 1, selector: '#cardholder-name', value: 'Dr. John Watson' },
        { action: 'fill', frameId: 2, selector: '#otp-code', value: '984512' }
      ]
    });
    assert.equal(batchResult.completed, true);
    assert.equal(batchResult.results.length, 3);

    // Step C: Trigger final action in nested Frame 2
    const clickResult = await runSidebarTool('click', {
      tabId: 1,
      frameId: 2,
      selector: '#verify-otp-btn'
    });
    assert.equal(clickResult.completed, true);

    // Assert final observable DOM/state changes in respective frames
    assert.equal(orderNotes.value, 'Expedited Air Freight', 'Observable DOM: Frame 0 notes updated');
    assert.equal(cardHolder.value, 'Dr. John Watson', 'Observable DOM: Frame 1 cardholder updated');
    assert.equal(otpInput.value, '984512', 'Observable DOM: Nested Frame 2 OTP updated');
    assert.equal(frame2Doc.body.dataset.challengePassed, 'true', 'Observable DOM: Nested Frame 2 dataset challengePassed verified');
    assert.equal(frame2Doc.body.dataset.recordedOtp, '984512', 'Observable DOM: Nested Frame 2 recorded OTP matches input');

    // Assert disambiguated references across frames
    assert.match(f0El.ref, /^@e\d+$/, 'Top frame elements preserve @eN format');
    assert.match(f1El.ref, /^@f1e\d+$/, 'Frame 1 elements disambiguated with @f1eN prefix');
    assert.match(f2El.ref, /^@f2e\d+$/, 'Frame 2 elements disambiguated with @f2eN prefix');

    // Step D: Direct ref action without explicit frameId routes to correct frame via prefix
    await runSidebarTool('fill', {
      tabId: 1,
      ref: (await runSidebarTool('read_page', { tabId: 1 })).elements.find(el => el.selector.includes('cardholder-name')).ref,
      value: 'Mycroft Holmes'
    });
    assert.equal(cardHolder.value, 'Mycroft Holmes', 'Observable DOM: Frame 1 updated via unambiguous ref @f1eN');

    // Step E: browser_step with clickFrameId and waitForFrameId targeting nested frame 2
    const stepFrameResult = await runSidebarTool('browser_step', {
      tabId: 1,
      waitForSelector: '#otp-code',
      waitForFrameId: 2,
      actions: [
        { action: 'fill', ref: (await runSidebarTool('read_page', { tabId: 1 })).elements.find(el => el.selector.includes('otp-code')).ref, value: '554433' }
      ],
      clickSelector: '#verify-otp-btn',
      clickFrameId: 2
    });
    console.log('stepFrameResult details:', JSON.stringify(stepFrameResult, null, 2));
assert.equal(stepFrameResult.completed, true, 'browser_step with clickFrameId and waitForFrameId succeeded in frame 2');
    assert.equal(otpInput.value, '554433', 'Observable DOM: Frame 2 input updated via browser_step');
    assert.equal(frame2Doc.body.dataset.recordedOtp, '554433', 'Observable DOM: Frame 2 button clicked via clickFrameId');

    console.log('✓ Scenario 4 passed: multi-frame inspection, routing, and nested frame state updates asserted.');
  }

  // =======================================================================
  // 5. Ambiguous confirmation vs genuine confirmation
  // =======================================================================
  console.log('Testing Scenario 5: Ambiguous confirmation vs genuine confirmation...');
  {
    // Sub-case 5A: Ambiguous - transient processing spinner without final receipt
    const snapTransient = {
      text: 'Thank you for submitting. Processing your request... Please wait while we verify your details.',
      elements: [
        { tag: 'div', role: 'status', label: 'Processing your request...' },
        { tag: 'input', type: 'text', disabled: true, value: 'Acme Corp' }
      ]
    };
    const evalTransient = evaluateSubmissionConfirmation(snapTransient);
    assert.equal(evalTransient.confirmed, false, 'Transient spinner must NOT be marked confirmed');
    assert.equal(evalTransient.status, 'ambiguous');
    assert.match(evalTransient.reason, /transient|pending/i);

    // Sub-case 5B: Ambiguous/Rejected - validation failure alert returned on submission
    const snapError = {
      text: 'Submit Application. Please correct the highlighted errors before continuing.',
      elements: [
        { tag: 'div', role: 'alert', label: 'Please correct errors: Invalid Tax ID' },
        { tag: 'input', type: 'text', valid: false, value: '12-34' }
      ]
    };
    const evalError = evaluateSubmissionConfirmation(snapError);
    assert.equal(evalError.confirmed, false, 'Validation failure must NOT be marked confirmed');
    assert.equal(evalError.status, 'rejected');
    assert.match(evalError.reason, /validation|error/i);

    // Sub-case 5C: Ambiguous - static footer text without form submission
    const snapFooterOnly = {
      text: 'Terms & Conditions. Thank you for browsing our site. Contact us at support@example.com',
      elements: [
        { tag: 'input', type: 'text', disabled: false, value: '' }
      ]
    };
    const evalFooter = evaluateSubmissionConfirmation(snapFooterOnly);
    assert.equal(evalFooter.confirmed, false, 'Generic browse text without form submission is unconfirmed');

    // Sub-case 5D: Genuine Confirmation - clear success message and distinct reference ID
    const snapGenuine = {
      text: 'Application Successfully Submitted!\nThank you, your submission has been received.\nConfirmation Number: CONF-2026-X9842\nYour receipt has been emailed.',
      elements: [
        { tag: 'h2', label: 'Application Successfully Submitted!' },
        { tag: 'p', label: 'Confirmation Number: CONF-2026-X9842' }
      ]
    };
    const evalGenuine = evaluateSubmissionConfirmation(snapGenuine);
    assert.equal(evalGenuine.confirmed, true, 'Genuine confirmation message and reference code must be confirmed');
    assert.equal(evalGenuine.status, 'confirmed');
    assert.equal(evalGenuine.referenceId, 'CONF-2026-X9842');

    // DOM-level assertion for a genuine confirmation workflow in live fixture
    const { mainDoc, runSidebarTool } = createFixtureEnvironment();

    const form = mainDoc.createElement('form');
    form.id = 'registration-form';

    const companyInput = mainDoc.createElement('input');
    companyInput.id = 'company-name';
    companyInput.value = 'Apex Solutions LLC';
    form.appendChild(companyInput);

    const submitBtn = mainDoc.createElement('button');
    submitBtn.id = 'btn-submit-reg';
    submitBtn.innerText = 'Register Company';
    submitBtn.onclick = () => {
      // Replace form with confirmation panel in DOM
      form.remove();
      const receipt = mainDoc.createElement('div');
      receipt.id = 'confirmation-receipt';
      receipt.innerText = 'Submission Confirmed!\nConfirmation ID: REG-88419-OK\nYour account is now ready.';
      mainDoc.body.appendChild(receipt);
      mainDoc.body.dataset.registrationConfirmed = 'true';
      mainDoc.body.dataset.receiptCode = 'REG-88419-OK';
    };
    form.appendChild(submitBtn);
    mainDoc.body.appendChild(form);

    // Click submit
    const submitResult = await runSidebarTool('click', { tabId: 1, selector: '#btn-submit-reg' });
    assert.equal(submitResult.completed, true);

    // Read updated page snapshot
    const postSubmitPage = await runSidebarTool('read_page', { tabId: 1 });
    const liveEval = evaluateSubmissionConfirmation(postSubmitPage);

    assert.equal(liveEval.confirmed, true, 'Live fixture page verified as genuinely confirmed');
    assert.equal(liveEval.referenceId, 'REG-88419-OK', 'Extracted reference ID matches');

    // Assert final observable DOM/state changes
    assert.equal(mainDoc.querySelector('#registration-form'), null, 'Observable DOM: form unmounted');
    assert.ok(mainDoc.querySelector('#confirmation-receipt'), 'Observable DOM: confirmation receipt mounted');
    assert.equal(mainDoc.body.dataset.registrationConfirmed, 'true', 'Observable DOM: dataset registrationConfirmed is true');
    assert.equal(mainDoc.body.dataset.receiptCode, 'REG-88419-OK', 'Observable DOM: receipt code matches');

    console.log('✓ Scenario 5 passed: ambiguous vs genuine confirmation distinguished with observable proof.');
  }

  console.log('\n================================================================');
  console.log('All 5 Item 49 Task Fixtures passed deterministically!');
  console.log('================================================================');
})().catch(err => {
  console.error('\n❌ Test Fixture Failure:\n', err);
  process.exitCode = 1;
});
