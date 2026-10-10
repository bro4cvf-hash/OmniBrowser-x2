const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extensions/chrome/background.js', 'utf8');
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit: (...args) => [...listeners].forEach(fn => fn(...args)) };
};
function harness(connect) {
  const timers = new Map(), ports = [];
  let timerId = 0;
  const chrome = {
    runtime: { id: 'extension', onMessage: event(), onConnect: event(),
      connectNative() {
        if (connect) connect();
        const port = { onMessage: event(), onDisconnect: event(), messages: [],
          postMessage(message) { this.messages.push(message); },
          disconnect() { this.onDisconnect.emit(); } };
        ports.push(port);
        return port;
      } },
    tabs: { onUpdated: event(), onRemoved: event() },
    debugger: { onEvent: event(), onDetach: event(), attach: async () => {}, detach: async () => {},
      sendCommand(target, method, params, callback) { callback({}); } }
  };
  const context = vm.createContext({ chrome, console: { log() {}, error() {} },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, AbortController });
  vm.runInContext(source, context);
  return { chrome, ports, timers, run: code => vm.runInContext(code, context),
    fire(ms) {
      const entry = [...timers].find(([, value]) => value.ms === ms);
      assert.ok(entry, `Expected ${ms}ms timer`);
      timers.delete(entry[0]); entry[1].fn();
    } };
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
(async () => {
  // 1. Concurrent first commands share one debugger attachment.
  {
    const h = harness(); let attachments = 0, release;
    h.chrome.debugger.attach = () => { attachments++; return new Promise(resolve => { release = resolve; }); };
    const first = h.run('attachDebugger(7)'), second = h.run('attachDebugger(7)');
    await tick(); assert.equal(attachments, 1); release(); await Promise.all([first, second]);
  }
  // 2. A tab closing during attachment cannot leave a phantom attached tab.
  {
    const h = harness(); let release;
    h.chrome.debugger.attach = () => new Promise(resolve => { release = resolve; });
    const pending = h.run('attachDebugger(7)');
    const rejected = assert.rejects(pending, /closed during attachment/);
    await tick(); h.chrome.tabs.onRemoved.emit(7); release(); await rejected;
    assert.equal(h.run('debuggerAttached.size'), 0);
  }
  // 3. A missing Chrome callback has a deadline and releases bookkeeping.
  {
    const h = harness(); h.chrome.debugger.sendCommand = () => {};
    const pending = h.run('sendDebuggerCommand(7, "Runtime.evaluate")');
    const rejected = assert.rejects(pending, /timed out/);
    await tick(); h.fire(30000); await rejected;
    assert.equal(h.run('debuggerCommands.size'), 0);
  }
  // 4. Detach rejects in-flight work immediately, even if a callback never comes.
  {
    const h = harness(); let callback;
    h.chrome.debugger.sendCommand = (target, method, params, cb) => { callback = cb; };
    const pending = h.run('sendDebuggerCommand(7, "Runtime.evaluate")');
    const rejected = assert.rejects(pending, /connection closed/);
    await tick(); h.chrome.debugger.onDetach.emit({ tabId: 7 }, 'target_closed'); await rejected;
    callback({}); assert.equal(h.run('debuggerCommands.size'), 0);
    assert.equal([...h.timers.values()].filter(timer => timer.ms === 30000).length, 0);
  }
  // 5. A failed detach cannot poison the next attach or reuse old console state.
  {
    const h = harness(); await h.run('attachDebugger(7)');
    h.run('consoleEnabled.add(7); consoleMessages.set(7, [{old: true}])');
    h.chrome.debugger.detach = async () => { throw new Error('already detached'); };
    await assert.rejects(h.run('detachDebugger(7)'), /already detached/);
    assert.equal(h.run('debuggerAttached.size + consoleEnabled.size + consoleMessages.size'), 0);
    await h.run('attachDebugger(7)'); assert.equal(h.run('debuggerAttached.size'), 1);
  }
  // 6. Synchronous native startup and handshake-send failures both recover.
  {
    let fail = true;
    const h = harness(() => { if (fail) throw new Error('bridge unavailable'); });
    assert.equal(h.run('nativePort'), null); fail = false; h.fire(5000);
    assert.equal(h.ports.length, 1);
    h.ports[0].onDisconnect.emit();
    h.chrome.runtime.connectNative = () => {
      const port = { onMessage: event(), onDisconnect: event(), disconnect() {},
        postMessage() { throw new Error('port closed'); } };
      return port;
    };
    h.fire(5000); assert.equal(h.run('nativePort'), null);
    assert.equal([...h.timers.values()].filter(timer => timer.ms === 5000).length, 1);
  }
  // 7. A bridge that connects but never acknowledges gets replaced.
  {
    const h = harness(); h.fire(15000);
    assert.equal(h.run('nativePort'), null); h.fire(5000); assert.equal(h.ports.length, 2);
    h.ports[1].onMessage.emit({ type: 'handshake_ack' });
    assert.equal([...h.timers.values()].filter(timer => timer.ms === 15000).length, 0);
  }
  // 8. Old asynchronous replies must never leak into a replacement bridge.
  {
    const h = harness(); let release;
    h.chrome.tabs.query = () => new Promise(resolve => { release = resolve; });
    h.ports[0].onMessage.emit({ id: 1, action: 'getTabs' });
    h.ports[0].onDisconnect.emit(); h.fire(5000);
    release([]); await tick();
    assert.equal(h.ports[1].messages.some(message => message.id === 1), false);
  }
  // 9. Screenshots target the requested tab without racing visible-tab focus.
  {
    const h = harness(); const targets = [];
    h.chrome.debugger.sendCommand = (target, method, params, cb) => {
      assert.equal(method, 'Page.captureScreenshot'); targets.push(target.tabId);
      cb({ data: `image-${target.tabId}` });
    };
    const results = await Promise.all([h.run('screenshot(7)'), h.run('screenshot(8)')]);
    assert.deepEqual(targets.sort(), [7, 8]);
    assert.equal(results[0].screenshot, 'image-7'); assert.equal(results[1].screenshot, 'image-8');
  }
  // 10. Pasted Windows line endings produce exactly one Enter per line.
  {
    const h = harness(); const commands = [];
    h.chrome.debugger.sendCommand = (target, method, params, cb) => { commands.push(params); cb({}); };
    await h.run('typeText(7, "first\\r\\nsecond")');
    assert.equal(commands.filter(params => params.key === 'Enter' && ['keyDown', 'rawKeyDown'].includes(params.type)).length, 1);
    await assert.rejects(h.run('typeText(7, null)'), /must be a string/);
  }
  console.log('All 10 extension reliability regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
