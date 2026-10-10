const assert = require('node:assert/strict');
const {
  resolveLocator,
  resolveAllLocators,
  computeAccessibleName,
  computeAccessibleRole,
  parseLocator,
  describeElement,
  getElementCoordinates,
  AmbiguousLocatorError
} = require('../extensions/chrome/semantic-locators.js');

// Lightweight DOM Mock for standalone Node testing
class MockNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.childNodes = [];
    this.parentNode = null;
    this.parentElement = null;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (this.nodeType === 1 || this.nodeType === 9 || this.nodeType === 11) {
      child.parentElement = this.nodeType === 1 ? this : null;
    }
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  contains(other) {
    let curr = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }
}

class MockTextNode extends MockNode {
  constructor(text) {
    super(3, '#text');
    this.nodeValue = String(text);
  }

  get textContent() { return this.nodeValue; }
  set textContent(val) { this.nodeValue = String(val); }
}

class MockElement extends MockNode {
  constructor(tagName, ownerDocument) {
    super(1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.style = { display: '', visibility: '' };
    this.shadowRoot = null;
    this._rect = { x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, bottom: 30, right: 100 };
  }

  get children() {
    return this.childNodes.filter(node => node.nodeType === 1);
  }

  getAttribute(name) {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name.toLowerCase(), String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name.toLowerCase());
  }

  removeAttribute(name) {
    this.attributes.delete(name.toLowerCase());
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(val) { this.setAttribute('id', val); }

  get className() { return this.getAttribute('class') || ''; }
  set className(val) { this.setAttribute('class', val); }

  get type() { return this.getAttribute('type') || ''; }
  set type(val) { this.setAttribute('type', val); }

  get placeholder() { return this.getAttribute('placeholder') || ''; }
  set placeholder(val) { this.setAttribute('placeholder', val); }

  get value() { return this.getAttribute('value') || ''; }
  set value(val) { this.setAttribute('value', val); }

  get alt() { return this.getAttribute('alt') || ''; }
  set alt(val) { this.setAttribute('alt', val); }

  get role() { return this.getAttribute('role') || ''; }
  set role(val) { this.setAttribute('role', val); }

  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(val) { if (val) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }

  get labels() {
    const list = [];
    const doc = this.ownerDocument;
    if (this.id && doc) {
      const matching = doc.querySelectorAll(`label[for="${this.id}"]`);
      list.push(...matching);
    }
    let parent = this.parentElement;
    while (parent) {
      if (parent.tagName === 'LABEL') {
        if (!list.includes(parent)) list.push(parent);
      }
      parent = parent.parentElement;
    }
    return list;
  }

  setRect(x, y, width, height) {
    this._rect = {
      x, y, width, height,
      top: y, left: x,
      bottom: y + height,
      right: x + width
    };
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  attachShadow({ mode = 'open' } = {}) {
    this.shadowRoot = new MockDocumentFragment(this.ownerDocument, this);
    return this.shadowRoot;
  }

  get textContent() {
    let text = '';
    for (const child of this.childNodes) {
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1) text += child.textContent;
    }
    return text;
  }

  set textContent(val) {
    this.childNodes = [];
    if (val !== '') {
      this.appendChild(new MockTextNode(val));
    }
  }

  get innerText() {
    return this.textContent;
  }

  set innerText(val) {
    this.textContent = val;
  }

  closest(selector) {
    let curr = this;
    while (curr && curr.nodeType === 1) {
      if (matchSelector(curr, selector)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(selector) {
    const results = [];
    const commaParts = selector.split(',').map(s => s.trim());

    const testNode = (node) => {
      for (const sel of commaParts) {
        if (matchSelector(node, sel)) {
          return true;
        }
      }
      return false;
    };

    const traverse = (current) => {
      for (const child of current.children) {
        if (testNode(child)) results.push(child);
        traverse(child);
      }
    };

    traverse(this);
    return results;
  }
}

class MockDocumentFragment extends MockNode {
  constructor(ownerDocument, host) {
    super(11, '#document-fragment');
    this.ownerDocument = ownerDocument;
    this.host = host;
  }

  get children() {
    return this.childNodes.filter(node => node.nodeType === 1);
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(selector) {
    const results = [];
    const commaParts = selector.split(',').map(s => s.trim());

    const testNode = (node) => {
      for (const sel of commaParts) {
        if (matchSelector(node, sel)) {
          return true;
        }
      }
      return false;
    };

    const traverse = (current) => {
      for (const child of current.children) {
        if (testNode(child)) results.push(child);
        traverse(child);
      }
    };

    traverse(this);
    return results;
  }
}

class MockDocument extends MockNode {
  constructor() {
    super(9, '#document');
    this.documentElement = new MockElement('html', this);
    this.body = new MockElement('body', this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new MockElement(tagName, this);
  }

  createTextNode(text) {
    return new MockTextNode(text);
  }

  getElementById(id) {
    let found = null;
    const traverse = (node) => {
      if (found) return;
      if (node.nodeType === 1 && node.getAttribute('id') === id) {
        found = node;
        return;
      }
      for (const child of node.childNodes) {
        traverse(child);
      }
      if (node.shadowRoot) {
        traverse(node.shadowRoot);
      }
    };
    traverse(this);
    return found;
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

function matchSelector(element, selector) {
  if (!element || element.nodeType !== 1) return false;
  selector = selector.trim();
  if (selector === '*') return true;

  // Attribute selector [attr=val] or [attr]
  const attrMatch = selector.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/);
  if (attrMatch) {
    const tag = attrMatch[1];
    const attr = attrMatch[2].toLowerCase();
    const val = attrMatch[3] !== undefined ? attrMatch[3] : (attrMatch[4] !== undefined ? attrMatch[4] : attrMatch[5]);
    if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    if (!element.hasAttribute(attr)) return false;
    if (val !== undefined && element.getAttribute(attr) !== val) return false;
    return true;
  }

  // ID selector #id or tag#id
  const idMatch = selector.match(/^([a-zA-Z0-9_-]*)#([a-zA-Z0-9_-]+)$/);
  if (idMatch) {
    const tag = idMatch[1];
    const id = idMatch[2];
    if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    return element.getAttribute('id') === id;
  }

  // Class selector .class or tag.class or .class1.class2
  if (selector.startsWith('.') || (selector.includes('.') && !selector.includes('['))) {
    const parts = selector.split('.');
    const tag = parts[0];
    const classes = parts.slice(1);
    if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    const elClasses = (element.getAttribute('class') || '').trim().split(/\s+/);
    return classes.every(c => elClasses.includes(c));
  }

  // Tag name
  if (/^[a-zA-Z0-9_-]+$/.test(selector)) {
    return element.tagName.toLowerCase() === selector.toLowerCase();
  }

  return false;
}

// Minimal HTML builder helper for concise test fixtures
function el(doc, tag, attrs = {}, children = []) {
  const element = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'rect') {
      element.setRect(value.x, value.y, value.width, value.height);
    } else if (key === 'style') {
      Object.assign(element.style, value);
    } else {
      element.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') {
      element.appendChild(doc.createTextNode(child));
    } else if (child) {
      element.appendChild(child);
    }
  }
  return element;
}

console.log('--- Starting Semantic Locator Test Suite ---');

// 1. DSL Parsing Tests
{
  console.log('Testing parseLocator...');
  assert.deepEqual(parseLocator('role=button[name="Submit"]'), {
    type: 'role', role: 'button', name: 'Submit', raw: 'role=button[name="Submit"]'
  });
  assert.deepEqual(parseLocator("role=button[name='Save Draft']"), {
    type: 'role', role: 'button', name: 'Save Draft', raw: "role=button[name='Save Draft']"
  });
  assert.deepEqual(parseLocator('role=checkbox'), {
    type: 'role', role: 'checkbox', name: undefined, raw: 'role=checkbox'
  });
  assert.deepEqual(parseLocator('label="Username"'), {
    type: 'label', label: 'Username', raw: 'label="Username"'
  });
  assert.deepEqual(parseLocator("label='Password'"), {
    type: 'label', label: 'Password', raw: "label='Password'"
  });
  assert.deepEqual(parseLocator('placeholder="Search articles..."'), {
    type: 'placeholder', placeholder: 'Search articles...', raw: 'placeholder="Search articles..."'
  });
  assert.deepEqual(parseLocator('text="Welcome"'), {
    type: 'text', text: 'Welcome', raw: 'text="Welcome"'
  });
  assert.deepEqual(parseLocator('#submit-btn'), {
    type: 'css', selector: '#submit-btn', raw: '#submit-btn'
  });
  assert.deepEqual(parseLocator('.btn-primary'), {
    type: 'css', selector: '.btn-primary', raw: '.btn-primary'
  });

  // Object forms
  assert.deepEqual(parseLocator({ role: 'button', name: 'Submit' }), {
    type: 'role', role: 'button', name: 'Submit', raw: JSON.stringify({ role: 'button', name: 'Submit' })
  });
  assert.deepEqual(parseLocator({ label: 'Full Name' }), {
    type: 'label', label: 'Full Name', raw: JSON.stringify({ label: 'Full Name' })
  });
  assert.deepEqual(parseLocator({ placeholder: 'Email' }), {
    type: 'placeholder', placeholder: 'Email', raw: JSON.stringify({ placeholder: 'Email' })
  });
  assert.deepEqual(parseLocator({ text: 'Log Out' }), {
    type: 'text', text: 'Log Out', raw: JSON.stringify({ text: 'Log Out' })
  });
  assert.deepEqual(parseLocator({ css: '#my-id' }), {
    type: 'css', selector: '#my-id', raw: JSON.stringify({ css: '#my-id' })
  });
}

// 2. W3C AccName & Role Calculation Tests
{
  console.log('Testing computeAccessibleRole and computeAccessibleName...');
  const doc = new MockDocument();

  // Explicit ARIA role
  const divBtn = el(doc, 'div', { role: 'button' }, ['Custom Click']);
  assert.equal(computeAccessibleRole(divBtn), 'button');
  assert.equal(computeAccessibleName(divBtn), 'Custom Click');

  // Implicit HTML roles
  const nativeBtn = el(doc, 'button', {}, ['Click Me']);
  assert.equal(computeAccessibleRole(nativeBtn), 'button');
  assert.equal(computeAccessibleName(nativeBtn), 'Click Me');

  const link = el(doc, 'a', { href: 'https://example.com' }, ['Docs']);
  assert.equal(computeAccessibleRole(link), 'link');
  assert.equal(computeAccessibleName(link), 'Docs');

  const checkbox = el(doc, 'input', { type: 'checkbox' });
  assert.equal(computeAccessibleRole(checkbox), 'checkbox');

  const textbox = el(doc, 'input', { type: 'text', placeholder: 'Enter name' });
  assert.equal(computeAccessibleRole(textbox), 'textbox');
  assert.equal(computeAccessibleName(textbox), 'Enter name');

  const heading = el(doc, 'h2', {}, ['Overview']);
  assert.equal(computeAccessibleRole(heading), 'heading');
  assert.equal(computeAccessibleName(heading), 'Overview');

  const img = el(doc, 'img', { alt: 'Logo' });
  assert.equal(computeAccessibleRole(img), 'img');
  assert.equal(computeAccessibleName(img), 'Logo');

  // aria-label takes precedence over content
  const ariaLabelBtn = el(doc, 'button', { 'aria-label': 'Close Window' }, ['X']);
  assert.equal(computeAccessibleName(ariaLabelBtn), 'Close Window');

  // aria-labelledby takes precedence over aria-label
  const labelSpan = el(doc, 'span', { id: 'lbl-title' }, ['Dialog Title']);
  doc.body.appendChild(labelSpan);
  const dialogBtn = el(doc, 'button', { 'aria-labelledby': 'lbl-title', 'aria-label': 'Ignored' }, ['Ignored']);
  doc.body.appendChild(dialogBtn);
  assert.equal(computeAccessibleName(dialogBtn), 'Dialog Title');

  // native <label for="id">
  const forInput = el(doc, 'input', { id: 'user-input', type: 'text' });
  const forLabel = el(doc, 'label', { for: 'user-input' }, ['Username']);
  doc.body.appendChild(forLabel);
  doc.body.appendChild(forInput);
  assert.equal(computeAccessibleName(forInput), 'Username');

  // wrapping <label>
  const wrapInput = el(doc, 'input', { type: 'password' });
  const wrapLabel = el(doc, 'label', {}, ['Password: ', wrapInput]);
  doc.body.appendChild(wrapLabel);
  assert.equal(computeAccessibleName(wrapInput), 'Password:');

  // submit input button value
  const submitInput = el(doc, 'input', { type: 'submit', value: 'Send Form' });
  assert.equal(computeAccessibleRole(submitInput), 'button');
  assert.equal(computeAccessibleName(submitInput), 'Send Form');
}

// 3. Resolving Semantic Locators: role=<role>[name="<accessibleName>"]
{
  console.log('Testing role=<role>[name="..."] resolution...');
  const doc = new MockDocument();
  const btnSubmit = el(doc, 'button', { id: 'btn-submit', rect: { x: 10, y: 10, width: 80, height: 30 } }, ['Submit']);
  const btnCancel = el(doc, 'button', { id: 'btn-cancel', rect: { x: 100, y: 10, width: 80, height: 30 } }, ['Cancel']);
  const linkHome = el(doc, 'a', { href: '/', rect: { x: 200, y: 10, width: 50, height: 20 } }, ['Home']);
  doc.body.appendChild(btnSubmit);
  doc.body.appendChild(btnCancel);
  doc.body.appendChild(linkHome);

  assert.equal(resolveLocator('role=button[name="Submit"]', doc), btnSubmit);
  assert.equal(resolveLocator('role=button[name="Cancel"]', doc), btnCancel);
  assert.equal(resolveLocator('role=link[name="Home"]', doc), linkHome);
  assert.equal(resolveLocator({ role: 'button', name: 'Submit' }, doc), btnSubmit);

  // Non-existent role or name returns null
  assert.equal(resolveLocator('role=button[name="NonExistent"]', doc), null);
}

// 4. Resolving Semantic Locators: label="<labelText>"
{
  console.log('Testing label="..." resolution...');
  const doc = new MockDocument();
  const emailInput = el(doc, 'input', { id: 'email-field', type: 'email' });
  const emailLabel = el(doc, 'label', { for: 'email-field' }, ['Email Address']);
  doc.body.appendChild(emailLabel);
  doc.body.appendChild(emailInput);

  const phoneInput = el(doc, 'input', { type: 'tel' });
  const phoneLabel = el(doc, 'label', {}, ['Phone Number', phoneInput]);
  doc.body.appendChild(phoneLabel);

  const searchBtn = el(doc, 'button', { 'aria-label': 'Search Catalogue' }, ['🔍']);
  doc.body.appendChild(searchBtn);

  assert.equal(resolveLocator('label="Email Address"', doc), emailInput);
  assert.equal(resolveLocator('label="Phone Number"', doc), phoneInput);
  assert.equal(resolveLocator('label="Search Catalogue"', doc), searchBtn);
  assert.equal(resolveLocator({ label: 'Email Address' }, doc), emailInput);
}

// 5. Resolving Semantic Locators: placeholder="<text>"
{
  console.log('Testing placeholder="..." resolution...');
  const doc = new MockDocument();
  const searchInput = el(doc, 'input', { placeholder: 'Search products...' });
  const messageArea = el(doc, 'textarea', { placeholder: 'Type your message here' });
  doc.body.appendChild(searchInput);
  doc.body.appendChild(messageArea);

  assert.equal(resolveLocator('placeholder="Search products..."', doc), searchInput);
  assert.equal(resolveLocator('placeholder="Type your message here"', doc), messageArea);
  assert.equal(resolveLocator({ placeholder: 'Search products...' }, doc), searchInput);
}

// 6. Resolving Semantic Locators: text="<visibleText>" (Deepest element rule)
{
  console.log('Testing text="..." resolution with deepest element priority...');
  const doc = new MockDocument();
  const btn = el(doc, 'button', { id: 'save-btn' }, ['Save Changes']);
  const container = el(doc, 'div', { class: 'action-bar' }, [btn]);
  doc.body.appendChild(container);

  // Both container and btn have text "Save Changes", but button is the deepest element
  const matched = resolveLocator('text="Save Changes"', doc);
  assert.equal(matched, btn);
  assert.equal(resolveLocator({ text: 'Save Changes' }, doc), btn);
}

// 7. CSS Selector Fallback and Shadow DOM Traversal
{
  console.log('Testing CSS selector fallback and shadow DOM >>>...');
  const doc = new MockDocument();
  const uniqueDiv = el(doc, 'div', { id: 'unique-box', class: 'panel active' }, ['Box']);
  doc.body.appendChild(uniqueDiv);

  assert.equal(resolveLocator('#unique-box', doc), uniqueDiv);
  assert.equal(resolveLocator('.panel.active', doc), uniqueDiv);

  // Web component with Shadow Root
  const customElement = el(doc, 'custom-card');
  doc.body.appendChild(customElement);
  const shadow = customElement.attachShadow({ mode: 'open' });
  const shadowButton = el(doc, 'button', { id: 'shadow-btn' }, ['Inside Shadow']);
  shadow.appendChild(shadowButton);

  const foundInShadow = resolveLocator('custom-card >>> #shadow-btn', doc);
  assert.equal(foundInShadow, shadowButton);

  // Semantic locator should also find elements inside open shadow root!
  const semanticInShadow = resolveLocator('role=button[name="Inside Shadow"]', doc);
  assert.equal(semanticInShadow, shadowButton);
}

// 8. Strict Ambiguity Enforcement (>1 match)
{
  console.log('Testing strict ambiguity enforcement with candidate descriptions & coordinates...');
  const doc = new MockDocument();

  const btn1 = el(doc, 'button', { id: 'btn-1', class: 'btn primary', rect: { x: 20, y: 50, width: 80, height: 32 } }, ['Duplicate Action']);
  const btn2 = el(doc, 'button', { id: 'btn-2', class: 'btn secondary', rect: { x: 120, y: 50, width: 80, height: 32 } }, ['Duplicate Action']);
  doc.body.appendChild(btn1);
  doc.body.appendChild(btn2);

  // Test role locator ambiguity
  let caughtError = null;
  try {
    resolveLocator('role=button[name="Duplicate Action"]', doc);
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, 'Should throw error when multiple candidates match');
  assert.ok(caughtError instanceof AmbiguousLocatorError);
  assert.equal(caughtError.name, 'AmbiguousLocatorError');
  assert.equal(caughtError.candidates.length, 2);

  // Verify candidate descriptions and coordinates are listed
  assert.match(caughtError.message, /Strict ambiguity error/);
  assert.match(caughtError.message, /matched 2 elements/);
  assert.match(caughtError.message, /Candidate #1: <button#btn-1\.btn\.primary> role="button" name="Duplicate Action" at \{x: 20, y: 50, width: 80, height: 32\}/);
  assert.match(caughtError.message, /Candidate #2: <button#btn-2\.btn\.secondary> role="button" name="Duplicate Action" at \{x: 120, y: 50, width: 80, height: 32\}/);

  // Verify programmatic candidate information on error object
  assert.equal(caughtError.candidates[0].element, btn1);
  assert.deepEqual(caughtError.candidates[0].coordinates, { x: 20, y: 50, width: 80, height: 32, top: 50, left: 20, bottom: 82, right: 100 });
  assert.equal(caughtError.candidates[1].element, btn2);
  assert.deepEqual(caughtError.candidates[1].coordinates, { x: 120, y: 50, width: 80, height: 32, top: 50, left: 120, bottom: 82, right: 200 });

  // Test text locator ambiguity
  assert.throws(
    () => resolveLocator('text="Duplicate Action"', doc),
    err => err instanceof AmbiguousLocatorError && err.candidates.length === 2
  );

  // Test CSS locator ambiguity
  assert.throws(
    () => resolveLocator('.btn', doc),
    err => err instanceof AmbiguousLocatorError && err.candidates.length === 2
  );

  // Test placeholder locator ambiguity
  const ph1 = el(doc, 'input', { placeholder: 'Enter code', rect: { x: 10, y: 100, width: 120, height: 28 } });
  const ph2 = el(doc, 'input', { placeholder: 'Enter code', rect: { x: 10, y: 150, width: 120, height: 28 } });
  doc.body.appendChild(ph1);
  doc.body.appendChild(ph2);

  assert.throws(
    () => resolveLocator('placeholder="Enter code"', doc),
    err => err instanceof AmbiguousLocatorError && err.candidates.length === 2
  );

  // Test label locator ambiguity
  const l1 = el(doc, 'input', { id: 'f1', rect: { x: 10, y: 200, width: 100, height: 25 } });
  const l2 = el(doc, 'input', { id: 'f2', rect: { x: 10, y: 240, width: 100, height: 25 } });
  const lbl1 = el(doc, 'label', { for: 'f1' }, ['Amount']);
  const lbl2 = el(doc, 'label', { for: 'f2' }, ['Amount']);
  doc.body.appendChild(lbl1);
  doc.body.appendChild(l1);
  doc.body.appendChild(lbl2);
  doc.body.appendChild(l2);

  assert.throws(
    () => resolveLocator('label="Amount"', doc),
    err => err instanceof AmbiguousLocatorError && err.candidates.length === 2
  );
}

// 9. Required option check
{
  console.log('Testing options.required...');
  const doc = new MockDocument();
  assert.equal(resolveLocator('role=button[name="Missing"]', doc), null);
  assert.throws(
    () => resolveLocator('role=button[name="Missing"]', doc, { required: true }),
    /No element matching locator/
  );
}

// 10. Additional W3C AccName & Advanced Edge Cases
{
  console.log('Testing advanced W3C AccName edge cases...');
  const doc = new MockDocument();

  // Multi-ID aria-labelledby
  const spanFirst = el(doc, 'span', { id: 'first-name' }, ['John']);
  const spanLast = el(doc, 'span', { id: 'last-name' }, ['Doe']);
  const greetingBtn = el(doc, 'button', { 'aria-labelledby': 'first-name last-name' }, ['Fallback']);
  doc.body.appendChild(spanFirst);
  doc.body.appendChild(spanLast);
  doc.body.appendChild(greetingBtn);
  assert.equal(computeAccessibleName(greetingBtn), 'John Doe');
  assert.equal(resolveLocator('role=button[name="John Doe"]', doc), greetingBtn);

  // Subtree containing image with alt text
  const iconImg = el(doc, 'img', { alt: 'Delete Entry' });
  const iconBtn = el(doc, 'button', {}, [iconImg]);
  doc.body.appendChild(iconBtn);
  assert.equal(computeAccessibleName(iconBtn), 'Delete Entry');
  assert.equal(resolveLocator('role=button[name="Delete Entry"]', doc), iconBtn);

  // aria-hidden element: ignored unless referenced
  const hiddenSpan = el(doc, 'span', { 'aria-hidden': 'true' }, ['Hidden Content']);
  doc.body.appendChild(hiddenSpan);
  assert.equal(computeAccessibleName(hiddenSpan), '');

  const referencedHidden = el(doc, 'span', { id: 'secret-label', 'aria-hidden': 'true' }, ['Secret Field']);
  const secretInput = el(doc, 'input', { 'aria-labelledby': 'secret-label' });
  doc.body.appendChild(referencedHidden);
  doc.body.appendChild(secretInput);
  assert.equal(computeAccessibleName(secretInput), 'Secret Field');

  // Subtree hidden children filtering (display: none, visibility: hidden, aria-hidden="true")
  const hiddenChildBtn1 = el(doc, 'button', {}, [
    'Save',
    el(doc, 'span', { style: { display: 'none' } }, [' Draft Hidden'])
  ]);
  assert.equal(computeAccessibleName(hiddenChildBtn1), 'Save');

  const hiddenChildBtn2 = el(doc, 'button', {}, [
    'Delete',
    el(doc, 'span', { style: { visibility: 'hidden' } }, [' Now'])
  ]);
  assert.equal(computeAccessibleName(hiddenChildBtn2), 'Delete');

  const hiddenChildBtn3 = el(doc, 'button', {}, [
    'Submit',
    el(doc, 'span', { 'aria-hidden': 'true' }, [' Secret'])
  ]);
  assert.equal(computeAccessibleName(hiddenChildBtn3), 'Submit');

  // Child aria-label prioritization over raw child text content in subtree
  const childAriaLabelBtn = el(doc, 'button', {}, [
    el(doc, 'span', { 'aria-label': 'Close Window' }, ['X'])
  ]);
  doc.body.appendChild(childAriaLabelBtn);
  assert.equal(computeAccessibleName(childAriaLabelBtn), 'Close Window');
  assert.equal(resolveLocator('role=button[name="Close Window"]', doc), childAriaLabelBtn);

  const mixedChildBtn = el(doc, 'button', {}, [
    'Action: ',
    el(doc, 'span', { 'aria-label': 'Print Document' }, ['[print-icon]'])
  ]);
  assert.equal(computeAccessibleName(mixedChildBtn), 'Action: Print Document');

  // Hidden child with aria-label must be filtered
  const hiddenChildWithLabelBtn = el(doc, 'button', {}, [
    'Confirm',
    el(doc, 'span', { 'aria-label': 'Ignored Label', 'aria-hidden': 'true' }, ['raw'])
  ]);
  assert.equal(computeAccessibleName(hiddenChildWithLabelBtn), 'Confirm');

  // Case-insensitive fallback
  const caseBtn = el(doc, 'button', {}, ['Continue']);
  doc.body.appendChild(caseBtn);
  assert.equal(resolveLocator('role=button[name="continue"]', doc), caseBtn);
  assert.equal(resolveLocator('text="continue"', doc), caseBtn);

  // Single quotes in DSL
  assert.equal(resolveLocator("role=button[name='continue']", doc), caseBtn);

  // resolveAllLocators returns all matches without throwing
  const allButtons = resolveAllLocators('role=button', doc);
  assert.ok(Array.isArray(allButtons));
  assert.ok(allButtons.length >= 3);
}

console.log(' All Semantic Locator resolution tests passed successfully!');

