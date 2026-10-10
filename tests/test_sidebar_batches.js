const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const event = () => ({ addListener() {}, removeListener() {} });
const chrome = {
  runtime: { connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }), onMessage: event() },
  debugger: { onEvent: event(), onDetach: event() },
  tabs: { onRemoved: event(), onUpdated: event(), get: async id => ({ id, url: id === 99 ? 'chrome://settings' : 'https://example.com' }) }
};
const context = vm.createContext({ chrome, console, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync('extensions/chrome/background.js', 'utf8'), context);
const run = (name, args) => vm.runInContext(`runSidebarTool(${JSON.stringify(name)}, ${JSON.stringify(args)})`, context);
const fields = Array.from({ length: 40 }, (_, index) => ({ action: 'fill', selector: '#field' + index, value: 'value', frameId: index < 20 ? 0 : 2 }));

(async () => {
  const injections = [];
  chrome.scripting = { executeScript: async spec => {
    injections.push(spec);
    if (spec.func.name === 'inspectSidebarPage') return [0, 2].map(frameId => ({ frameId, result: { title: 'Form', text: 'Form', elements: [{ selector: '#field', value: 'value' }] } }));
    return [{ result: { completed: true, results: spec.args[1].actions.map(() => ({ completed: true })) } }];
  } };
  const result = await run('batch_actions', { tabId: 7, actions: fields });
  assert.equal(result.completed, true);
  assert.equal(result.results.length, 40);
  assert.equal(injections.length, 3, 'Forty fields across two frames should use two action injections and one inspection');
  assert.deepEqual(Array.from(injections[0].target.frameIds), [0]);
  assert.deepEqual(Array.from(injections[1].target.frameIds), [2]);
  assert.equal(injections[0].args[1].actions.length, 20);
  assert.equal(result.page.elements.length, 2);
  assert.equal(result.page.elements[1].frameId, 2);
  assert.equal(result.page.frames[0].elements, undefined, 'Do not repeat every selector twice in model context');

  injections.length = 0;
  chrome.scripting.executeScript = async spec => {
    injections.push(spec);
    if (spec.func.name === 'inspectSidebarPage') return [{ frameId: 0, result: { elements: [] } }];
    return [{ result: { completed: false, failed_index: 1, error: 'Hidden control', results: [{ completed: true }] } }];
  };
  const partial = await run('browser_step', { tabId: 7, actions: fields, clickSelector: '#submit' });
  assert.equal(partial.completed, false);
  assert.equal(partial.failed_index, 1);
  assert.equal(injections.length, 2, 'After failure, inspect once; skip later frames and the final click');

  chrome.scripting.executeScript = async spec => {
    if (spec.func.name === 'inspectSidebarPage') return [{ frameId: 0, result: { elements: [] } }];
    assert.equal(spec.args[1].__serializeErrors, true);
    return [{ result: { completed: false, actionError: 'Target is covered by an overlay' } }];
  };
  await assert.rejects(run('click', { tabId: 7, selector: '#submit' }), /covered by an overlay/);
  await assert.rejects(run('fill', { tabId: 7, selector: '#name', value: 'Example' }), /covered by an overlay/);
  const finalFailure = await run('browser_step', { tabId: 7, actions: [], clickSelector: '#submit' });
  assert.equal(finalFailure.completed, false);
  assert.match(finalFailure.error, /covered by an overlay/);

  injections.length = 0;
  await assert.rejects(run('batch_actions', { tabId: 7, actions: [...fields, { ...fields[0], frameId: -1 }] }), /frame ID/);
  assert.equal(injections.length, 0, 'Validate the entire batch before changing any field');
  await assert.rejects(run('browser_step', { tabId: 7, actions: fields, timeoutMs: 20000 }), /timeout/);

  let running = 0, peak = 0;
  chrome.scripting.executeScript = async () => {
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setImmediate(resolve)); running--;
    return [{ frameId: 0, result: { elements: [] } }];
  };
  const pages = await run('read_pages', { tabIds: [1, 2, 3, 4, 5, 99] });
  assert.equal(peak, 4);
  assert.deepEqual(Array.from(pages.results, item => item.tabId), [1, 2, 3, 4, 5, 99]);
  assert.match(pages.results.at(-1).error, /protected/);
  assert.ok(pages.results[0].page);

  // Semantic locator integration in background.js
  const mockElements = [
    { tagName: 'BUTTON', type: 'submit', innerText: 'Submit', disabled: false, isConnected: true, getAttribute: k => k === 'role' ? 'button' : null, getClientRects: () => [{}] },
    { tagName: 'INPUT', type: 'email', name: 'email', id: 'email-id', placeholder: 'user@example.com', disabled: false, isConnected: true, getAttribute: k => k === 'placeholder' ? 'user@example.com' : (k === 'id' ? 'email-id' : null), getClientRects: () => [{}] },
    { tagName: 'LABEL', htmlFor: 'email-id', innerText: 'Email', disabled: false, isConnected: true, getAttribute: k => k === 'for' ? 'email-id' : null, getClientRects: () => [{}] },
    { tagName: 'A', href: '/login', innerText: 'Sign In', disabled: false, isConnected: true, getAttribute: k => k === 'href' ? '/login' : null, getClientRects: () => [{}] },
    { tagName: 'BUTTON', innerText: 'Duplicate', disabled: false, isConnected: true, getAttribute: () => null, getClientRects: () => [{}] },
    { tagName: 'BUTTON', innerText: 'Duplicate', disabled: false, isConnected: true, getAttribute: () => null, getClientRects: () => [{}] },
  ];
  const mockDoc = {
    querySelectorAll: sel => mockElements,
    getElementById: id => mockElements.find(e => e.id === id) || null
  };

  // 1. resolveLocator matches role
  const roleMatches = context.resolveLocator('role=button[name="Submit"]', mockDoc);
  assert.equal(roleMatches.length, 1);
  assert.equal(roleMatches[0].innerText, 'Submit');

  // 2. resolveLocator matches label
  const labelMatches = context.resolveLocator('label="Email"', mockDoc);
  assert.equal(labelMatches.length, 1);
  assert.equal(labelMatches[0].type, 'email');

  // 3. resolveLocator matches text
  const textMatches = context.resolveLocator('text="Sign In"', mockDoc);
  assert.equal(textMatches.length, 1);
  assert.equal(textMatches[0].innerText, 'Sign In');

  // 4. resolveLocator matches placeholder
  const placeholderMatches = context.resolveLocator('placeholder="user@example.com"', mockDoc);
  assert.equal(placeholderMatches.length, 1);
  assert.equal(placeholderMatches[0].name, 'email');

  // 5. Strict ambiguity: multiple elements match
  const dupMatches = context.resolveLocator('role=button[name="Duplicate"]', mockDoc);
  assert.equal(dupMatches.length, 2, 'Ambiguous selector should return all matches for strict ambiguity handling');

  // 6. Shadow DOM traversal: host >>> text="Inside Shadow"
  const shadowChild = { tagName: 'BUTTON', innerText: 'Inside Shadow', disabled: false, isConnected: true, getAttribute: () => null, getClientRects: () => [{}] };
  const shadowRoot = { querySelectorAll: () => [shadowChild] };
  const shadowHost = { tagName: 'DIV', shadowRoot, getAttribute: () => null };
  const hostDoc = { querySelectorAll: () => [shadowHost] };
  const shadowMatches = context.resolveLocator('div >>> text="Inside Shadow"', hostDoc);
  assert.equal(shadowMatches.length, 1);
  assert.equal(shadowMatches[0], shadowChild);

  console.log('Sidebar batches: frame grouping, bounded page reads, snapshots, partial failures and semantic locators passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

