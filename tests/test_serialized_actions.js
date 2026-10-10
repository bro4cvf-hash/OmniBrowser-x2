const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('extensions/chrome/background.js', 'utf8');
const event = () => ({ addListener() {}, removeListener() {} });
const chrome = {
  runtime: { onMessage: event(), connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }) },
  tabs: { onRemoved: event(), onUpdated: event() },
  debugger: { onEvent: event(), onDetach: event() }
};
const worker = vm.createContext({ chrome, console, setTimeout, clearTimeout });
vm.runInContext(source, worker);
const field = {
  nodeType: 1, tagName: 'INPUT', type: 'text', isConnected: true, value: '',
  getAttribute() { return null; }, hasAttribute() { return false; }, closest() { return null; },
  scrollIntoView() {}, getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 20 }; },
  dispatchEvent() {}, click() { this.clicked = true; }
};
const page = vm.createContext({
  document: { querySelectorAll: () => [field], elementFromPoint: () => field },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Event: class Event {},
});
// Chrome transports only the function source, never its worker closure.
const inject = (name, args) => {
  page.args = name === 'applySidebarAction' ? [args[0], { ...args[1], __serializeErrors: true }] : args;
  const func = vm.runInContext(name, worker);
  return vm.runInContext(`(${func.toString()})(...args)`, page);
};
(async () => {
  const fill = await inject('applySidebarAction', ['fill', { selector: '#name', value: 'Example' }]);
  assert.equal(fill.completed, true);
  assert.equal(field.value, 'Example');
  const batch = await inject('applySidebarAction', ['batch_actions', { actions: [
    { action: 'fill', selector: '#name', value: 'Updated' },
    { action: 'click', selector: '#name' }
  ] }]);
  assert.equal(batch.completed, true);
  assert.equal(batch.results.length, 2);
  assert.equal(field.value, 'Updated');
  assert.equal(field.clicked, true);
  page.__omnibrowser_generation = 3;
  page.__omnibrowser_refs = new Map([['@e1', { el: field, generation: 3 }]]);
  const verified = await inject('verifySidebarFields', [[{ ref: '@f2e1', value: 'Updated' }]]);
  assert.equal(verified[0].matches, true, 'Frame-qualified refs must resolve in the injected frame');
  page.__omnibrowser_generation = 4;
  const stale = await inject('verifySidebarFields', [[{ ref: '@f2e1', value: 'Updated' }]]);
  assert.match(stale[0].error, /StaleElementReference/);
  assert.equal(await inject('waitForActionable', ['#name', { timeoutMs: 200 }]), field);
  page.document.elementFromPoint = () => ({ tagName: 'DIV' });
  const covered = await inject('applySidebarAction', ['click', { selector: '#name', timeoutMs: 100 }]);
  assert.equal(covered.completed, false);
  assert.match(covered.actionError, /covered/);
  assert.equal(covered.notDispatched, true, 'Actionability failures precede activation');
  let attempts = 0;
  page.document.querySelectorAll = () => ++attempts <= 2 ? [field] : [];
  const vanished = await inject('applySidebarAction', ['click', { selector: '#name', timeoutMs: 100 }]);
  assert.equal(vanished.completed, false);
  assert.match(vanished.actionError, /covered|element not found/);
  assert.equal(vanished.notDispatched, true);

  // A styled input uses its associated label, preserving normal browser activation.
  field.type = 'checkbox';
  field.checked = false;
  field.style = { opacity: '0', pointerEvents: 'none' };
  field.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
  const label = {
    ...field, tagName: 'LABEL', style: {},
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20 }),
    click() { field.checked = !field.checked; this.clicks = (this.clicks || 0) + 1; }
  };
  field.labels = [label];
  page.document.querySelectorAll = () => [field];
  page.document.elementFromPoint = () => label;
  const checked = await inject('applySidebarAction', ['set_checked', { selector: '#name', checked: true, timeoutMs: 100 }]);
  assert.equal(checked.completed, true);
  assert.equal(field.checked, true);
  assert.equal(label.clicks, 1);
  await inject('applySidebarAction', ['set_checked', { selector: '#name', checked: true, timeoutMs: 100 }]);
  assert.equal(label.clicks, 1, 'Already checked inputs must not toggle again');
  const clicked = await inject('applySidebarAction', ['click', { selector: '#name', timeoutMs: 100 }]);
  assert.equal(clicked.completed, true);
  assert.equal(field.checked, false);
  field.disabled = true;
  const disabled = await inject('applySidebarAction', ['set_checked', { selector: '#name', checked: true, timeoutMs: 100 }]);
  assert.match(disabled.actionError, /disabled/);
  field.disabled = false;
  page.document.elementFromPoint = () => ({ tagName: 'DIV' });
  const overlay = await inject('applySidebarAction', ['set_checked', { selector: '#name', checked: true, timeoutMs: 100 }]);
  assert.match(overlay.actionError, /covered/);
  assert.equal(field.checked, false);
  page.document.elementFromPoint = () => label;
  label.click = () => {};
  const unchanged = await inject('applySidebarAction', ['set_checked', { selector: '#name', checked: true, timeoutMs: 100 }]);
  assert.match(unchanged.actionError, /requested state/);
  // Tom Select replaces a select with a .ts-control pointer target.
  const select = {
    ...field, tagName: 'SELECT', type: 'select-one', disabled: false,
    value: '', style: { display: 'none' }, labels: [],
    options: [{ value: 'NA', disabled: false }]
  };
  let opened = false;
  const widget = {
    ...label, style: {}, closest: () => null,
    click() { opened = true; }
  };
  const option = {
    ...widget, getAttribute: key => key === 'data-value' ? 'NA' : null,
    click() { select.value = 'NA'; }
  };
  const wrapper = {
    querySelector: () => widget,
    querySelectorAll: () => opened ? [option] : []
  };
  select.closest = selector => selector === '.ts-wrapper' ? wrapper : null;
  page.document.querySelectorAll = () => [select];
  page.document.elementFromPoint = () => opened ? option : widget;
  const selected = await inject('applySidebarAction', ['select_option', { selector: '#country', value: 'NA', timeoutMs: 100 }]);
  assert.equal(selected.completed, true);
  assert.equal(select.value, 'NA');
  assert.equal(opened, true);
  opened = false;
  select.disabled = true;
  const disabledSelect = await inject('applySidebarAction', ['select_option', { selector: '#country', value: 'NA', timeoutMs: 100 }]);
  assert.match(disabledSelect.actionError, /disabled/);
  assert.equal(opened, false);
  select.disabled = false;
  const invalidOption = await inject('applySidebarAction', ['select_option', { selector: '#country', value: 'invalid', timeoutMs: 100 }]);
  assert.match(invalidOption.actionError, /Enabled option not found/);
  opened = false;
  select.value = '';
  option.click = () => {};
  const unsynced = await inject('applySidebarAction', ['select_option', { selector: '#country', value: 'NA', timeoutMs: 100 }]);
  assert.match(unsynced.actionError, /requested value/);
  // Native selects need no pointer click, even when validation text covers them.
  select.closest = () => null;
  select.style = { pointerEvents: 'none' };
  select.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20 });
  select.options = [{ value: 'WY', text: 'Wyoming', disabled: false }, { value: 'XX', text: 'Unavailable', disabled: true }];
  select.value = '';
  page.document.elementFromPoint = () => ({ tagName: 'SPAN', className: 'help-block' });
  const nativeSelected = await inject('applySidebarAction', ['select_option', { selector: '#state', value: ' wyoming ', timeoutMs: 100 }]);
  assert.equal(nativeSelected.completed, true);
  assert.equal(nativeSelected.value, 'WY');
  assert.equal(select.value, 'WY');
  select.disabled = true;
  const blockedNative = await inject('applySidebarAction', ['select_option', { selector: '#state', value: 'WY', timeoutMs: 100 }]);
  assert.match(blockedNative.actionError, /disabled/);
  select.disabled = false;
  const unavailable = await inject('applySidebarAction', ['select_option', { selector: '#state', value: 'Unavailable', timeoutMs: 100 }]);
  assert.match(unavailable.actionError, /Enabled option not found/);
  select.options.push({ value: 'W2', text: 'Wyoming', disabled: false });
  const ambiguousOption = await inject('applySidebarAction', ['select_option', { selector: '#state', value: 'Wyoming', timeoutMs: 100 }]);
  assert.match(ambiguousOption.actionError, /Ambiguous option label/);
  console.log('Serialized page action tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
