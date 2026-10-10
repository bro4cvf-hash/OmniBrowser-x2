// Exercise the real service worker with Chrome API stubs.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const event = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f),
    emit: (...args) => [...listeners].forEach(f => f(...args)), listeners };
};
const updated = event(), removed = event();
let lastCommand;
let lastPort;
const sentCommands = [];
const onConnect = event();
const chrome = {
  runtime: { id: "a".repeat(32), onMessage: event(), onConnect, getURL: path => 'chrome-extension://' + 'a'.repeat(32) + '/' + path,
    connectNative: () => {
      lastPort = { onMessage: event(), onDisconnect: event(), postMessage() {},
        disconnect() { this.onDisconnect.emit(); } };
      return lastPort;
    } },
  tabs: { onUpdated: updated, onRemoved: removed,
    update: async (id, options) => {
      updated.emit(id, { status: "complete" }, { url: options.url });
      return { status: "loading" };
    },
    get: async (id) => ({ id, url: "https://example.com", windowId: 1 }),
  },
  scripting: {
    executeScript: async ({ target, func, args = [] }) => {
      const res = await func(...args);
      return [{ frameId: target.frameIds?.[0] || 0, result: res }];
    },
  },
  debugger: { onEvent: event(), onDetach: event(), attach: async () => {}, detach: async () => {},
    sendCommand: (target, method, params, callback) => {
      lastCommand = { method, params };
      sentCommands.push({ target, method, params });
      callback({ result: { value: 42 } });
    } },
};
const context = vm.createContext({ chrome, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController });
vm.runInContext(fs.readFileSync("extensions/chrome/background.js", "utf8"), context);
(async () => {
  const result = await vm.runInContext('navigate(7, "https://example.com")', context);
  assert.equal(result.navigated, true);
  assert.equal(updated.listeners.size, 0);
  assert.equal(removed.listeners.size, 1); // global tab cleanup only
  assert.equal(await vm.runInContext('executeScript(7, "Promise.resolve(42)")', context), 42);
  assert.equal(lastCommand.method, "Runtime.evaluate");
  assert.equal(lastCommand.params.awaitPromise, true);
  chrome.tabs.update = async () => { throw new Error("Missing tab"); };
  await assert.rejects(vm.runInContext('navigate(7, "https://example.com")', context), /Missing tab/);
  assert.equal(updated.listeners.size, 0);
  const config = { mcpServers: { omnibrowser: { command: 'test.exe', args: ['--mcp', '--extension'] } } };
  lastPort.onMessage.emit({ type: 'handshake_ack', relayAvailable: true, mcpConfig: config });
  const popupMessage = message => new Promise(resolve => chrome.runtime.onMessage.emit(message, {}, resolve));
  assert.equal((await popupMessage({ type: 'getStatus' })).connected, true);
  assert.deepEqual((await popupMessage({ type: 'getStatus' })).mcpConfig, config);
  await popupMessage({ type: 'disconnect' });
  const status = await popupMessage({ type: 'getStatus' });
  assert.equal(status.connected, false);
  assert.equal(status.mcpConfig, null);
  assert.equal(vm.runInContext('debuggerAttached.size', context), 0);
  const previousPort = lastPort;
  await popupMessage({ type: 'connect' });
  assert.notEqual(lastPort, previousPort);
  const denied = await new Promise(resolve => chrome.runtime.onMessage.emit({ type: 'sidebarTool', name: 'list_tabs', args: {} }, { id: chrome.runtime.id, url: 'https://malicious.example' }, resolve));
  assert.equal(denied.success, false);
  chrome.tabs.query = async () => [{ id: 7, url: 'https://example.com', title: 'My profile tab' }];
  const sidebarTabs = await new Promise(resolve => chrome.runtime.onMessage.emit({ type: 'sidebarTool', name: 'list_tabs', args: {} }, { id: chrome.runtime.id, url: chrome.runtime.getURL('sidepanel.html') }, resolve));
  assert.equal(sidebarTabs.result[0].id, 7);
  lastPort.onMessage.emit({ type: 'handshake_ack', relayAvailable: true, mcpConfig: config });
  let filePacket;
  lastPort.postMessage = message => { filePacket = message; };
  const filePromise = new Promise(resolve => chrome.runtime.onMessage.emit({ type: 'sidebarTool', name: 'files_roots', args: {} }, { id: chrome.runtime.id, url: chrome.runtime.getURL('sidepanel.html') }, resolve));
  assert.equal(filePacket.action, 'files_roots');
  lastPort.onMessage.emit({ type: 'sidebar_files_result', requestId: filePacket.requestId, success: true, result: { roots: ['C:\\Example'] } });
  assert.deepEqual((await filePromise).result.roots, ['C:\\Example']);
  // -------------------------------------------------------------
  // Test Item 1: Durable Background Execution in Service Worker
  // -------------------------------------------------------------
  const createPort = (name, sender = { id: chrome.runtime.id }) => {
    const p = {
      name,
      sender,
      onMessage: event(),
      onDisconnect: event(),
      postMessage(msg) { this.messages.push(msg); },
      disconnect() { this.onDisconnect.emit(); },
      messages: []
    };
    onConnect.emit(p);
    return p;
  };

  // 1. Create a background run with long-running executor
  let executorResolved = false;
  let runApprovalPromise;
  let runActionId;
  const runResponse = await new Promise(resolve => {
    chrome.runtime.onMessage.emit({
      type: 'startRun',
      runConfig: {
        chatId: 'chat-42',
        executor: async ({ appendAction, updateAction, requestApproval, signal }) => {
          const act = appendAction({ name: 'read_page', status: 'running' });
          runActionId = act.id;
          // Wait for approval
          await requestApproval({ action: 'click', args: { selector: '#submit' }, text: 'Allow click?' });
          updateAction(runActionId, { status: 'complete' });
          executorResolved = true;
          return { summary: 'finished successfully' };
        }
      }
    }, { id: chrome.runtime.id }, resolve);
  });

  assert.equal(runResponse.success, true);
  const runId = runResponse.run.runId;
  assert.equal(runResponse.run.chatId, 'chat-42');
  assert.equal(runResponse.run.status, 'running');

  // 2. Connect sidebar port and subscribe
  const sidebarPort1 = createPort('sidebar-run-stream');
  sidebarPort1.onMessage.emit({ type: 'subscribe', runId });
  assert.equal(sidebarPort1.messages[0].type, 'subscribed');
  assert.equal(sidebarPort1.messages[0].runId, runId);

  // Allow loop to tick so executor creates action and asks for approval
  await new Promise(r => setTimeout(r, 20));

  const checkStatus = await new Promise(resolve => {
    chrome.runtime.onMessage.emit({ type: 'getRun', runId }, { id: chrome.runtime.id }, resolve);
  });
  assert.equal(checkStatus.run.status, 'waiting_approval');
  assert.equal(checkStatus.run.actionLedger.length, 1);
  assert.equal(checkStatus.run.pendingApprovals.length, 1);
  const approvalId = checkStatus.run.pendingApprovals[0].approvalId;

  // 3. Simulate sidebar closing/disconnecting
  sidebarPort1.disconnect();

  // 4. Reconnect with a new port (e.g. sidebar reopened)
  const sidebarPort2 = createPort('sidebar-run-stream');
  sidebarPort2.onMessage.emit({ type: 'subscribe', runId });
  assert.equal(sidebarPort2.messages[0].type, 'subscribed');
  assert.equal(sidebarPort2.messages[0].run.status, 'waiting_approval');

  // 5. Resolve approval via reconnectable port
  sidebarPort2.onMessage.emit({ type: 'resolveApproval', runId, approvalId, approved: true });
  await new Promise(r => setTimeout(r, 20));

  assert.equal(executorResolved, true);
  const finalRunStatus = await new Promise(resolve => {
    chrome.runtime.onMessage.emit({ type: 'getRun', runId }, { id: chrome.runtime.id }, resolve);
  });
  assert.equal(finalRunStatus.run.status, 'completed');
  assert.equal(finalRunStatus.run.result.summary, 'finished successfully');
  assert.equal(finalRunStatus.run.actionLedger[0].status, 'complete');

  // 6. Test cancel message on port
  let cancelSeen = false;
  const runToCancel = await new Promise(resolve => {
    chrome.runtime.onMessage.emit({
      type: 'startRun',
      runConfig: {
        chatId: 'chat-cancel',
        executor: async ({ signal }) => {
          await new Promise((_, reject) => {
            signal.addEventListener('abort', () => { cancelSeen = true; reject(new Error('Aborted')); });
          });
        }
      }
    }, { id: chrome.runtime.id }, resolve);
  });
  const portCancel = createPort('sidebar-run-stream');
  portCancel.onMessage.emit({ type: 'subscribe', runId: runToCancel.run.runId });
  portCancel.onMessage.emit({ type: 'cancel', runId: runToCancel.run.runId });
  await new Promise(r => setTimeout(r, 20));

  assert.equal(cancelSeen, true);
  const cancelledRun = await new Promise(resolve => {
    chrome.runtime.onMessage.emit({ type: 'getRun', runId: runToCancel.run.runId }, { id: chrome.runtime.id }, resolve);
  });
  assert.equal(cancelledRun.run.status, 'stopped');

  // -------------------------------------------------------------
  // Test Items 9 & 10: Short Element References & Stale Ref Rejection
  // -------------------------------------------------------------
  const win = context;
  const createMockElement = (tag, id, type = 'text', initialVal = '') => {
    let _value = initialVal;
    let _checked = false;
    const el = {
      tagName: tag.toUpperCase(),
      id,
      type,
      get value() { return _value; },
      set value(v) { _value = v; },
      get checked() { return _checked; },
      set checked(v) { _checked = v; },
      clicked: false,
      isConnected: true,
      disabled: false,
      readOnly: false,
      getAttribute: (attr) => attr === 'id' ? id : (attr === 'type' ? type : null),
      matches: (sel) => sel.includes(tag.toLowerCase()) || (id && sel.includes('#' + id)),
      getRootNode: () => mockDoc,
      getClientRects: () => [{ width: 100, height: 30 }],
      getBoundingClientRect: () => ({ width: 100, height: 30, x: 0, y: 0 }),
      scrollIntoView: () => {},
      click: () => { el.clicked = true; },
      dispatchEvent: () => {},
      closest: () => null,
      contains: (other) => other === el,
    };
    return el;
  };

  const btn1 = createMockElement('button', 'btn1', 'button', 'Submit');
  btn1.getBoundingClientRect = () => ({ width: 100, height: 30, x: 0, y: 0 });
  const input1 = createMockElement('input', 'input1', 'text', 'Initial Value');
  input1.getBoundingClientRect = () => ({ width: 100, height: 30, x: 0, y: 40 });
  const allElements = [btn1, input1];

  const mockDoc = {
    title: 'Test Page',
    readyState: 'complete',
    body: { innerText: 'Test Page Content' },
    documentElement: { tagName: 'HTML' },
    querySelectorAll: (sel) => {
      if (sel === '*') return allElements;
      if (sel.includes('button') || sel.includes('input')) return allElements;
      if (sel.includes('#btn1')) return [btn1];
      if (sel.includes('#input1')) return [input1];
      return [];
    },
    elementFromPoint: (x, y) => (y >= 35 ? input1 : btn1),
  };

  win.window = win;
  win.document = mockDoc;
  win.location = { href: 'https://example.com/test' };
  win.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  win.CSS = { escape: (s) => s };

  // 1. inspectSidebarPage tracks generation and assigns @e1, @e2
  const pageResult = await vm.runInContext('inspectSidebarPage()', context);
  assert.equal(win.__omnibrowser_generation, 1, 'Generation should be 1 after first read');
  assert.ok(vm.runInContext('window.__omnibrowser_refs instanceof Map', context), 'Refs should be a Map');
  assert.equal(pageResult.elements.length, 2);
  assert.match(pageResult.elements[0].ref, /^@e\d{28}$/);
  assert.notEqual(pageResult.elements[0].ref, pageResult.elements[1].ref);
  assert.equal(win.__omnibrowser_refs.get(pageResult.elements[0].ref).generation, 1);
  assert.equal(win.__omnibrowser_refs.get(pageResult.elements[1].ref).generation, 1);

  // 2. applySidebarAction with valid @eN reference and CSS selector
  const btnRef = pageResult.elements.find(e => e.tag === 'button').ref;
  const inputRef = pageResult.elements.find(e => e.tag === 'input').ref;

  const clickResult = await vm.runInContext(`applySidebarAction('click', { selector: '${btnRef}' })`, context);
  assert.equal(clickResult.completed, true);
  assert.equal(btn1.clicked, true);

  const fillResult = await vm.runInContext(`applySidebarAction('fill', { ref: '${inputRef}', value: 'Updated Value' })`, context);
  assert.equal(fillResult.completed, true);
  assert.equal(input1.value, 'Updated Value');

  btn1.clicked = false;
  const clickCss = await vm.runInContext(`applySidebarAction('click', { selector: '#btn1' })`, context);
  assert.equal(clickCss.completed, true);
  assert.equal(btn1.clicked, true);

  // 3. Stale ref rejection on generation mismatch
  const repeated = await vm.runInContext('inspectSidebarPage()', context);
  assert.equal(win.__omnibrowser_generation, 1, 'The document generation remains stable across inspections');
  assert.equal(repeated.elements.find(element => element.tag === 'button').ref, btnRef, 'The same attached node keeps its identity');

  win.__omnibrowser_refs.set('@e99', { el: btn1, generation: 0 });
  await assert.rejects(
    async () => vm.runInContext(`applySidebarAction('click', { selector: '@e99' })`, context),
    (err) => err.name === 'StaleElementReference' || /StaleElementReference/.test(err.message),
    'Should throw explicit StaleElementReference error when generation is mismatched'
  );

  // 4. Stale ref rejection on detached element
  const freshBtnRef = (await vm.runInContext('inspectSidebarPage()', context)).elements.find(e => e.tag === 'button').ref;
  btn1.isConnected = false;
  await assert.rejects(
    async () => vm.runInContext(`applySidebarAction('click', { selector: '${freshBtnRef}' })`, context),
    (err) => err.name === 'StaleElementReference' || /StaleElementReference/.test(err.message),
    'Should throw explicit StaleElementReference error when element is detached'
  );
  btn1.isConnected = true;

  // 5. Stale ref rejection for missing reference
  await assert.rejects(
    async () => vm.runInContext(`applySidebarAction('click', { selector: '@e999' })`, context),
    (err) => err.name === 'StaleElementReference' || /StaleElementReference/.test(err.message),
    'Should throw explicit StaleElementReference error for non-existent ref'
  );

  // 6. verifySidebarFields with refs, CSS selectors, and stale ref rejection
  const freshInputRef = [...win.__omnibrowser_refs.entries()].find(([, entry]) => entry.el === input1)[0];
  const verifyValid = await vm.runInContext(`verifySidebarFields([{ ref: '${freshInputRef}', value: 'Updated Value' }, { selector: '#btn1' }])`, context);
  assert.equal(verifyValid[0].matches, true);
  assert.equal(verifyValid[0].ref, freshInputRef);
  assert.equal(verifyValid[1].matches, true);

  const verifyStale = await vm.runInContext(`verifySidebarFields([{ selector: '@e99', value: 'Updated Value' }])`, context);
  assert.equal(verifyStale[0].matches, false);
  assert.match(verifyStale[0].error, /StaleElementReference/);

  input1.isConnected = false;
  const verifyDetached = await vm.runInContext(`verifySidebarFields([{ ref: '${freshInputRef}', value: 'Updated Value' }])`, context);
  assert.equal(verifyDetached[0].matches, false);
  assert.match(verifyDetached[0].error, /StaleElementReference/);
  input1.isConnected = true;

  // -------------------------------------------------------------
  // Test Item 13 & 41: Native CDP Mouse & Keyboard Input in Extension
  // -------------------------------------------------------------
  // 1. Native CDP mouse lifecycle (nativeClick: mouseMoved -> mousePressed -> mouseReleased)
  sentCommands.length = 0;
  const nativeClickResult = await vm.runInContext('nativeClick(7, 120, 240)', context);
  assert.equal(nativeClickResult.clicked, true);
  assert.equal(nativeClickResult.native, true);
  assert.equal(nativeClickResult.x, 120);
  assert.equal(nativeClickResult.y, 240);
  assert.equal(sentCommands.length, 3);
  assert.equal(sentCommands[0].method, 'Input.dispatchMouseEvent');
  assert.equal(sentCommands[0].params.type, 'mouseMoved');
  assert.equal(sentCommands[0].params.x, 120);
  assert.equal(sentCommands[0].params.y, 240);
  assert.equal(sentCommands[1].method, 'Input.dispatchMouseEvent');
  assert.equal(sentCommands[1].params.type, 'mousePressed');
  assert.equal(sentCommands[1].params.button, 'left');
  assert.equal(sentCommands[1].params.clickCount, 1);
  assert.equal(sentCommands[2].method, 'Input.dispatchMouseEvent');
  assert.equal(sentCommands[2].params.type, 'mouseReleased');
  assert.equal(sentCommands[2].params.button, 'left');

  // 2. Hover (Input.dispatchMouseEvent mouseMoved)
  sentCommands.length = 0;
  const hoverResult = await vm.runInContext('hover(7, 300, 450)', context);
  assert.equal(hoverResult.hovered, true);
  assert.equal(hoverResult.x, 300);
  assert.equal(hoverResult.y, 450);
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].method, 'Input.dispatchMouseEvent');
  assert.equal(sentCommands[0].params.type, 'mouseMoved');
  assert.equal(sentCommands[0].params.x, 300);
  assert.equal(sentCommands[0].params.y, 450);

  // 3. Keyboard pressKey via Input.dispatchKeyEvent
  sentCommands.length = 0;
  const pressResult = await vm.runInContext('pressKey(7, "Enter")', context);
  assert.equal(pressResult.pressed, true);
  assert.equal(pressResult.key, 'Enter');
  assert.equal(sentCommands.length, 2);
  assert.equal(sentCommands[0].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCommands[0].params.type, 'keyDown');
  assert.equal(sentCommands[0].params.key, 'Enter');
  assert.equal(sentCommands[0].params.windowsVirtualKeyCode, 13);
  assert.equal(sentCommands[1].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCommands[1].params.type, 'keyUp');
  assert.equal(sentCommands[1].params.key, 'Enter');

  // 4. Keyboard typeText via Input.dispatchKeyEvent (sequence of rawKeyDown -> char -> keyUp)
  sentCommands.length = 0;
  const typeResult = await vm.runInContext('typeText(7, "Hi")', context);
  assert.equal(typeResult.typed, true);
  assert.equal(typeResult.length, 2);
  assert.equal(sentCommands.length, 6); // 2 chars * 3 events (rawKeyDown, char, keyUp)
  assert.equal(sentCommands[0].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCommands[0].params.type, 'rawKeyDown');
  assert.equal(sentCommands[0].params.key, 'H');
  assert.equal(sentCommands[0].params.code, 'KeyH');
  assert.equal(sentCommands[0].params.windowsVirtualKeyCode, 72);
  assert.equal(sentCommands[0].params.modifiers, 8);
  assert.equal(sentCommands[1].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCommands[1].params.type, 'char');
  assert.equal(sentCommands[1].params.text, 'H');
  assert.equal(sentCommands[2].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCommands[2].params.type, 'keyUp');
  assert.equal(sentCommands[2].params.key, 'H');
  assert.equal(sentCommands[3].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCommands[3].params.type, 'rawKeyDown');
  assert.equal(sentCommands[3].params.key, 'i');
  assert.equal(sentCommands[3].params.code, 'KeyI');
  assert.equal(sentCommands[3].params.windowsVirtualKeyCode, 73);
  assert.equal(sentCommands[4].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCommands[4].params.type, 'char');
  assert.equal(sentCommands[4].params.text, 'i');
  assert.equal(sentCommands[5].method, 'Input.dispatchKeyEvent');
  assert.equal(sentCommands[5].params.type, 'keyUp');
  assert.equal(sentCommands[5].params.key, 'i');

  // 5. Expose hover, press_key, type_text in runSidebarTool
  sentCommands.length = 0;
  const toolHover = await vm.runInContext('runSidebarTool("hover", { tabId: 7, x: 50, y: 75 })', context);
  assert.equal(toolHover.action, 'hover');
  assert.equal(toolHover.x, 50);
  assert.equal(toolHover.y, 75);
  assert.equal(sentCommands.length, 1);
  assert.equal(sentCommands[0].params.type, 'mouseMoved');

  sentCommands.length = 0;
  const toolKey = await vm.runInContext('runSidebarTool("press_key", { tabId: 7, key: "Escape" })', context);
  assert.equal(toolKey.action, 'press_key');
  assert.equal(toolKey.key, 'Escape');
  assert.equal(sentCommands.length, 2);
  assert.equal(sentCommands[0].params.key, 'Escape');

  sentCommands.length = 0;
  const toolType = await vm.runInContext('runSidebarTool("type_text", { tabId: 7, text: "Go" })', context);
  assert.equal(toolType.action, 'type_text');
  assert.equal(toolType.length, 2);
  assert.equal(sentCommands.length, 6);

  // Covered targets must not dispatch native clicks onto the overlay.
  const overlay = { tagName: 'DIV', getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 200 }) };
  mockDoc.elementFromPoint = () => overlay;
  sentCommands.length = 0;
  await assert.rejects(vm.runInContext('applySidebarAction("click", { selector: "#btn1", timeoutMs: 50 })', context), /covered/);
  await assert.rejects(vm.runInContext('runSidebarTool("click", { tabId: 7, selector: "#btn1", timeoutMs: 50 })', context), /covered/);
  assert.equal(sentCommands.length, 0);

  // 7. Automatic Fallback on Custom Event Listeners
  mockDoc.elementFromPoint = () => btn1; // Uncover element
  btn1.onpointerdown = () => {}; // Custom pointer listener attached
  sentCommands.length = 0;
  const customApply = await vm.runInContext('applySidebarAction("click", { selector: "#btn1" })', context);
  assert.equal(customApply.fallback, true);
  assert.equal(customApply.reason, 'custom_event_listeners');

  const customSidebar = await vm.runInContext('runSidebarTool("click", { tabId: 7, selector: "#btn1" })', context);
  assert.equal(customSidebar.fallback, true);
  assert.equal(customSidebar.native, true);
  assert.equal(customSidebar.fallbackReason, 'custom_event_listeners');
  assert.equal(sentCommands.length, 3); // nativeClick lifecycle was triggered
  // -------------------------------------------------------------
  // Test Item 12: Automatic Actionability Waiting & Explanations
  // -------------------------------------------------------------
  // 1. Attached & Unique
  // 1a. Missing element
  await assert.rejects(
    vm.runInContext('waitForActionable("#non-existent", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#non-existent': element not found/
  );

  // 1b. Duplicate / not unique
  const dup1 = createMockElement('button', 'dup1');
  const dup2 = createMockElement('button', 'dup2');
  mockDoc.querySelectorAll = (sel) => {
    if (sel.includes('.duplicate-btn')) return [dup1, dup2];
    if (sel.includes('#btn1')) return [btn1];
    if (sel.includes('#input1')) return [input1];
    return [];
  };
  await assert.rejects(
    vm.runInContext('waitForActionable(".duplicate-btn", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '\.duplicate-btn': matches 2 elements \(not unique\)/
  );

  // 2. Visible (width > 0, height > 0, not hidden/display none)
  // 2a. display: none
  const hiddenDispEl = createMockElement('button', 'hidden-disp');
  win.getComputedStyle = (el) => {
    if (el === hiddenDispEl) return { visibility: 'visible', display: 'none' };
    return { visibility: 'visible', display: 'block' };
  };
  mockDoc.querySelectorAll = (sel) => sel.includes('#hidden-disp') ? [hiddenDispEl] : [];
  await assert.rejects(
    vm.runInContext('waitForActionable("#hidden-disp", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#hidden-disp': hidden \(display: none\)/
  );

  // 2b. visibility: hidden
  const hiddenVisEl = createMockElement('button', 'hidden-vis');
  win.getComputedStyle = (el) => {
    if (el === hiddenVisEl) return { visibility: 'hidden', display: 'block' };
    return { visibility: 'visible', display: 'block' };
  };
  mockDoc.querySelectorAll = (sel) => sel.includes('#hidden-vis') ? [hiddenVisEl] : [];
  await assert.rejects(
    vm.runInContext('waitForActionable("#hidden-vis", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#hidden-vis': hidden \(visibility: hidden\)/
  );

  // 2c. zero size (0x0)
  const zeroSizeEl = createMockElement('button', 'zero-size');
  zeroSizeEl.getBoundingClientRect = () => ({ width: 0, height: 0, x: 0, y: 0 });
  win.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
  mockDoc.querySelectorAll = (sel) => sel.includes('#zero-size') ? [zeroSizeEl] : [];
  await assert.rejects(
    vm.runInContext('waitForActionable("#zero-size", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#zero-size': hidden \(zero size: 0x0\)/
  );

  // 3. Stable (bounding rect coordinates unchanged across animation frames)
  let moveTick = 0;
  const movingEl = createMockElement('button', 'moving');
  movingEl.getBoundingClientRect = () => {
    moveTick += 10;
    return { width: 100, height: 30, x: moveTick, y: 0 };
  };
  mockDoc.querySelectorAll = (sel) => sel.includes('#moving') ? [movingEl] : [];
  await assert.rejects(
    vm.runInContext('waitForActionable("#moving", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#moving': element is moving or animating/
  );

  // 4. Enabled (!disabled, !inert, !readOnly for fill)
  // 4a. disabled
  const disabledEl = createMockElement('button', 'disabled-btn');
  disabledEl.disabled = true;
  mockDoc.querySelectorAll = (sel) => sel.includes('#disabled-btn') ? [disabledEl] : [];
  await assert.rejects(
    vm.runInContext('waitForActionable("#disabled-btn", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#disabled-btn': element is disabled/
  );

  // 4b. inert
  const inertEl = createMockElement('button', 'inert-btn');
  inertEl.inert = true;
  mockDoc.querySelectorAll = (sel) => sel.includes('#inert-btn') ? [inertEl] : [];
  await assert.rejects(
    vm.runInContext('waitForActionable("#inert-btn", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#inert-btn': element is inert/
  );

  // 4c. readOnly for fill
  const readonlyEl = createMockElement('input', 'readonly-input', 'text');
  readonlyEl.readOnly = true;
  mockDoc.querySelectorAll = (sel) => sel.includes('#readonly-input') ? [readonlyEl] : [];
  await assert.rejects(
    vm.runInContext('waitForActionable("#readonly-input", { timeoutMs: 50, action: "fill" })', context),
    /Action timeout after 50ms waiting for '#readonly-input': element is read-only/
  );
  // readOnly is allowed for click
  mockDoc.elementFromPoint = () => readonlyEl;
  const readonlyClick = await vm.runInContext('waitForActionable("#readonly-input", { timeoutMs: 50, action: "click" })', context);
  assert.equal(readonlyClick, readonlyEl);

  // 5. Unobstructed (elementFromPoint hits element or descendant)
  // Covered by <div class="modal-backdrop">
  const submitBtn = createMockElement('button', 'submit');
  const modalBackdrop = {
    tagName: 'DIV',
    className: 'modal-backdrop',
    getBoundingClientRect: () => ({ width: 500, height: 500, x: 0, y: 0 }),
    contains: () => false,
  };
  mockDoc.querySelectorAll = (sel) => sel.includes('#submit') ? [submitBtn] : [];
  mockDoc.elementFromPoint = () => modalBackdrop;
  await assert.rejects(
    vm.runInContext('waitForActionable("#submit", { timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#submit': covered by <div\.modal-backdrop>/
  );

  // 6. Dynamic resolution: element becomes unobstructed during wait
  let backdropRemoved = false;
  mockDoc.elementFromPoint = () => backdropRemoved ? submitBtn : modalBackdrop;
  setTimeout(() => { backdropRemoved = true; }, 30);
  const resolvedEl = await vm.runInContext('waitForActionable("#submit", { timeoutMs: 200 })', context);
  assert.equal(resolvedEl, submitBtn);

  // 7. applySidebarAction integration with actionability explanations
  // 7a. Fill on readonly element throws precise actionability error
  mockDoc.querySelectorAll = (sel) => sel.includes('#readonly-input') ? [readonlyEl] : [];
  mockDoc.elementFromPoint = () => readonlyEl;
  await assert.rejects(
    vm.runInContext('applySidebarAction("fill", { selector: "#readonly-input", value: "hello", timeoutMs: 50 })', context),
    /Action timeout after 50ms waiting for '#readonly-input': element is read-only/
  );

  // 7b. batch_actions catches actionability failure with diagnostic explanation
  const batchRes = await vm.runInContext('applySidebarAction("batch_actions", { actions: [{ action: "fill", selector: "#readonly-input", value: "test", timeoutMs: 50 }] })', context);
  assert.equal(batchRes.completed, false);
  assert.equal(batchRes.failed_index, 0);
  assert.match(batchRes.error, /Action timeout after 50ms waiting for '#readonly-input': element is read-only/);

  // -------------------------------------------------------------
  // Test Items: Native CDP Input Enhancements (Requirements 1 - 5)
  // -------------------------------------------------------------
  // 1. Punctuation & Digit Virtual Key Codes
  const periodDef = vm.runInContext('resolveKeyDef(".")', context);
  assert.equal(periodDef.windowsVirtualKeyCode, 190, 'Period must be VK_OEM_PERIOD (190)');
  assert.notEqual(periodDef.windowsVirtualKeyCode, 46, 'Period must NOT be VK_DELETE (46)');
  assert.equal(periodDef.code, 'Period');

  const exclDef = vm.runInContext('resolveKeyDef("!")', context);
  assert.equal(exclDef.windowsVirtualKeyCode, 49, '! must be VK_1 (49)');
  assert.equal(exclDef.code, 'Digit1');

  for (let digit = 0; digit <= 9; digit++) {
    const digitDef = vm.runInContext(`resolveKeyDef("${digit}")`, context);
    assert.equal(digitDef.windowsVirtualKeyCode, 48 + digit, `Digit ${digit} must have VK_${digit} (${48 + digit})`);
    assert.equal(digitDef.code, `Digit${digit}`);
  }

  // 2. Modifier Keys in KEY_DEFINITIONS and bitmask conversion
  const shiftKey = vm.runInContext('KEY_DEFINITIONS["Shift"]', context);
  assert.equal(shiftKey.windowsVirtualKeyCode, 16);
  assert.equal(shiftKey.code, 'ShiftLeft');

  const ctrlKey = vm.runInContext('KEY_DEFINITIONS["Control"]', context);
  assert.equal(ctrlKey.windowsVirtualKeyCode, 17);
  assert.equal(ctrlKey.code, 'ControlLeft');

  const altKey = vm.runInContext('KEY_DEFINITIONS["Alt"]', context);
  assert.equal(altKey.windowsVirtualKeyCode, 18);
  assert.equal(altKey.code, 'AltLeft');

  const metaKey = vm.runInContext('KEY_DEFINITIONS["Meta"]', context);
  assert.equal(metaKey.windowsVirtualKeyCode, 91);
  assert.equal(metaKey.code, 'MetaLeft');

  assert.equal(vm.runInContext('parseModifiers("Control")', context), 2);
  assert.equal(vm.runInContext('parseModifiers(["Shift"])', context), 8);
  assert.equal(vm.runInContext('parseModifiers(["Control", "Shift"])', context), 10);
  assert.equal(vm.runInContext('parseModifiers("Alt+Meta")', context), 5);

  // 3. typeText with char events alongside rawKeyDown/keyUp
  sentCommands.length = 0;
  await vm.runInContext('typeText(7, ".1!")', context);
  assert.equal(sentCommands.length, 9); // 3 chars * 3 events
  // Period: rawKeyDown -> char -> keyUp
  assert.equal(sentCommands[0].params.type, 'rawKeyDown');
  assert.equal(sentCommands[0].params.key, '.');
  assert.equal(sentCommands[0].params.code, 'Period');
  assert.equal(sentCommands[0].params.windowsVirtualKeyCode, 190);
  assert.equal(sentCommands[1].params.type, 'char');
  assert.equal(sentCommands[1].params.text, '.');
  assert.equal(sentCommands[2].params.type, 'keyUp');
  assert.equal(sentCommands[2].params.windowsVirtualKeyCode, 190);
  // Digit 1: rawKeyDown -> char -> keyUp
  assert.equal(sentCommands[3].params.type, 'rawKeyDown');
  assert.equal(sentCommands[3].params.code, 'Digit1');
  assert.equal(sentCommands[3].params.windowsVirtualKeyCode, 49);
  assert.equal(sentCommands[4].params.type, 'char');
  assert.equal(sentCommands[4].params.text, '1');
  assert.equal(sentCommands[5].params.type, 'keyUp');
  assert.equal(sentCommands[5].params.windowsVirtualKeyCode, 49);
  // Exclamation: rawKeyDown -> char -> keyUp
  assert.equal(sentCommands[6].params.type, 'rawKeyDown');
  assert.equal(sentCommands[6].params.code, 'Digit1');
  assert.equal(sentCommands[6].params.windowsVirtualKeyCode, 49);
  assert.equal(sentCommands[6].params.modifiers, 8); // Shift active
  assert.equal(sentCommands[7].params.type, 'char');
  assert.equal(sentCommands[7].params.text, '!');
  assert.equal(sentCommands[8].params.type, 'keyUp');
  assert.equal(sentCommands[8].params.windowsVirtualKeyCode, 49);

  // 4. Pass options in fallback click paths
  // 4a. applySidebarAction fallback path preserves button, clickCount, modifiers
  mockDoc.querySelectorAll = (sel) => sel.includes('#btn1') ? [btn1] : [];
  mockDoc.elementFromPoint = () => btn1; // Uncovered custom widget
  btn1.onpointerdown = () => {};
  sentCommands.length = 0;
  const occludedWithOptions = await vm.runInContext('runSidebarTool("click", { tabId: 7, selector: "#btn1", timeoutMs: 50, button: "right", clickCount: 2, modifiers: ["Control"] })', context);
  assert.equal(occludedWithOptions.fallback, true);
  assert.equal(sentCommands.length, 3);
  assert.equal(sentCommands[1].params.type, 'mousePressed');
  assert.equal(sentCommands[1].params.button, 'right');
  assert.equal(sentCommands[1].params.clickCount, 2);
  assert.equal(sentCommands[1].params.modifiers, 2); // "Control" mask
  assert.equal(sentCommands[2].params.type, 'mouseReleased');
  assert.equal(sentCommands[2].params.button, 'right');
  assert.equal(sentCommands[2].params.modifiers, 2);

  // 4b. browser_step click fallback preserves options
  sentCommands.length = 0;
  const stepRes = await vm.runInContext('runSidebarTool("browser_step", { tabId: 7, actions: [], clickSelector: "#btn1", button: "middle", clickCount: 1, modifiers: "Shift" })', context);
  assert.equal(stepRes.click.fallback, true);
  assert.equal(sentCommands.length, 3);
  assert.equal(sentCommands[1].params.button, 'middle');
  assert.equal(sentCommands[1].params.clickCount, 1);
  assert.equal(sentCommands[1].params.modifiers, 8); // "Shift" mask

  // 5. Catch fallback element resolution with @eN references and >>> selectors
  mockDoc.elementFromPoint = () => overlay;
  sentCommands.length = 0;
  const catchBtn = createMockElement('button', 'catch-btn');
  catchBtn.getBoundingClientRect = () => ({ width: 100, height: 30, x: 25, y: 35 });
  win.__omnibrowser_refs.set('@e10', { el: catchBtn, generation: win.__omnibrowser_generation });
  const origApply = win.applySidebarAction;
  win.applySidebarAction = async (name, args) => {
    if (args.selector === '@e10') throw new Error('custom listener requires native input');
    return origApply(name, args);
  };
  const catchRes = await vm.runInContext('runSidebarTool("click", { tabId: 7, selector: "@e10", button: "left" })', context);
  assert.equal(catchRes.fallback, true);
  assert.equal(catchRes.x, 75); // 25 + 50
  assert.equal(catchRes.y, 50); // 35 + 15
  assert.equal(sentCommands.length, 3);
  win.applySidebarAction = origApply;

  // 5b. Catch fallback with >>> piercing selector
  const shadowHost = createMockElement('div', 'host-el');
  const innerBtn = createMockElement('button', 'inner-btn');
  innerBtn.getBoundingClientRect = () => ({ width: 80, height: 40, x: 10, y: 20 });
  shadowHost.shadowRoot = {
    querySelectorAll: (s) => s.includes('inner-btn') ? [innerBtn] : []
  };
  mockDoc.querySelectorAll = (s) => s.includes('#host-el') ? [shadowHost] : (s.includes('#btn1') ? [btn1] : []);
  win.applySidebarAction = async (name, args) => {
    if (args.selector === '#host-el >>> #inner-btn') throw new Error('custom listener requires native input');
    return origApply(name, args);
  };
  sentCommands.length = 0;
  const shadowCatchRes = await vm.runInContext('runSidebarTool("click", { tabId: 7, selector: "#host-el >>> #inner-btn", button: "left" })', context);
  assert.equal(shadowCatchRes.fallback, true);
  assert.equal(shadowCatchRes.x, 50); // 10 + 40
  assert.equal(shadowCatchRes.y, 40); // 20 + 20
  assert.equal(sentCommands.length, 3);
  // -------------------------------------------------------------
  // Test Items: Service Worker Lifecycle and IPC Fixes
  // -------------------------------------------------------------
  // 1. broadcastRunEvent dead port removal
  const deadPortRunId = 'run-dead-port-test';
  const deadPort1 = createPort('sidebar-run-stream');
  deadPort1.postMessage = () => { throw new Error('Port closed'); };
  deadPort1.onMessage.emit({ type: 'subscribe', runId: deadPortRunId });
  assert.equal(vm.runInContext(`runPorts.get("${deadPortRunId}").size`, context), 1);
  vm.runInContext(`broadcastRunEvent("${deadPortRunId}", { type: "test" })`, context);
  assert.equal(vm.runInContext(`runPorts.has("${deadPortRunId}")`, context), false);

  // 2. port.onMessage handlers wrap port.postMessage in try/catch
  const throwingPort = createPort('sidebar-run-stream');
  throwingPort.postMessage = () => { throw new Error('Disconnected'); };
  // None of these should throw unhandled errors
  throwingPort.onMessage.emit({ type: 'subscribe', runId: 'run-subscribe-err' });
  throwingPort.onMessage.emit({ type: 'cancel', runId: 'run-cancel-err' });
  throwingPort.onMessage.emit({ type: 'resolveApproval', runId: 'run-approval-err', approvalId: 'app-1' });

  // 3. chrome.runtime.onConnect validates port.sender
  const unauthorizedPort = createPort('sidebar-run-stream', { id: 'unauthorized-id' });
  unauthorizedPort.onMessage.emit({ type: 'subscribe', runId: 'run-unauthorized' });
  assert.equal(vm.runInContext('runPorts.has("run-unauthorized")', context), false);
  const noSenderPort = createPort('sidebar-run-stream', null);
  noSenderPort.onMessage.emit({ type: 'subscribe', runId: 'run-no-sender' });
  assert.equal(vm.runInContext('runPorts.has("run-no-sender")', context), false);

  // 4. requestRunApproval timeout and port disconnection handling
  const timeoutRun = vm.runInContext(`createRun({ runId: "run-timeout-test" })`, context);
  await assert.rejects(
    vm.runInContext(`requestRunApproval(backgroundRuns.get("${timeoutRun.runId}"), { action: "click", args: {}, text: "approve?", timeoutMs: 30 })`, context),
    /Approval request timed out/
  );
  assert.equal(timeoutRun.status, 'failed');

  const disconnectRun = vm.runInContext(`createRun({ runId: "run-disconnect-test" })`, context);
  const disconnectPort = createPort('sidebar-run-stream');
  disconnectPort.onMessage.emit({ type: 'subscribe', runId: disconnectRun.runId });
  const approvalPromise = vm.runInContext(`requestRunApproval(backgroundRuns.get("${disconnectRun.runId}"), { action: "click", args: {}, text: "approve?", timeoutMs: 5000, disconnectTimeoutMs: 30 })`, context);
  disconnectPort.disconnect();
  await assert.rejects(approvalPromise, /All approval ports disconnected/);

  // 5. backgroundRuns pruning: older than 1h and max 50 runs
  const pruneRunOld = vm.runInContext(`createRun({ runId: "run-old-completed" })`, context);
  pruneRunOld.status = 'completed';
  pruneRunOld.updatedAt = Date.now() - (65 * 60 * 1000); // 65 min ago
  vm.runInContext('pruneBackgroundRuns()', context);
  assert.equal(vm.runInContext('backgroundRuns.has("run-old-completed")', context), false);

  // Cap at 50 runs:
  for (let i = 0; i < 60; i++) {
    const r = vm.runInContext(`createRun({ runId: "run-cap-" + ${i} })`, context);
    r.status = 'completed';
    r.updatedAt = Date.now() - i * 1000;
  }
  vm.runInContext('pruneBackgroundRuns()', context);
  assert.ok(vm.runInContext('backgroundRuns.size', context) <= 50);

  // 6. chrome.runtime.onMessage invalid message guard
  const onMsgListener = Array.from(chrome.runtime.onMessage.listeners)[0];
  assert.equal(onMsgListener(null, {}, () => {}), false);
  assert.equal(onMsgListener("string-msg", {}, () => {}), false);
  assert.equal(onMsgListener(12345, {}, () => {}), false);
  assert.equal(onMsgListener(undefined, {}, () => {}), false);

  // 7. handleNativeMessage invalid message guard
  await vm.runInContext('handleNativeMessage(null)', context);
  await vm.runInContext('handleNativeMessage(undefined)', context);
  await vm.runInContext('handleNativeMessage("not-an-object")', context);
  await vm.runInContext('handleNativeMessage(42)', context);

  // 8. runSidebarTool invalid tool name validation
  await assert.rejects(vm.runInContext('runSidebarTool("")', context), /Invalid tool name/);
  await assert.rejects(vm.runInContext('runSidebarTool("   ")', context), /Invalid tool name/);
  await assert.rejects(vm.runInContext('runSidebarTool(null)', context), /Invalid tool name/);
  await assert.rejects(vm.runInContext('runSidebarTool(123)', context), /Invalid tool name/);

  console.log("Extension regression checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });

