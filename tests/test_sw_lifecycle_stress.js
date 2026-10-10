// Test suite for Service Worker Lifecycle Stress & IPC Resilience
// 1. Port maintenance & disconnect recovery in background.js
// 2. Dead port eviction from runPorts during broadcast errors
// 3. port.onMessage handling disconnected ports safely
// 4. Approval promise timeout / disconnect cleanup
// 5. IPC message resilience on null/undefined inputs

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const event = () => {
  const listeners = new Set();
  return {
    addListener: f => listeners.add(f),
    removeListener: f => listeners.delete(f),
    emit: (...args) => [...listeners].forEach(f => f(...args)),
    listeners
  };
};

function createBackgroundHarness() {
  const updated = event();
  const removed = event();
  const onConnect = event();
  const runtimeOnMessage = event();
  let nativePortInstance;

  const chrome = {
    runtime: {
      id: 'a'.repeat(32),
      onMessage: runtimeOnMessage,
      onConnect,
      getURL: path => 'chrome-extension://' + 'a'.repeat(32) + '/' + path,
      connectNative: () => {
        nativePortInstance = {
          onMessage: event(),
          onDisconnect: event(),
          postMessage() {},
          disconnect() { this.onDisconnect.emit(); }
        };
        return nativePortInstance;
      }
    },
    tabs: {
      onUpdated: updated,
      onRemoved: removed,
      query: async () => [{ id: 7, url: 'https://example.com', active: true }],
      update: async (id, opt) => ({ id, ...opt }),
      get: async (id) => ({ id, url: 'https://example.com', windowId: 1 })
    },
    scripting: {
      executeScript: async () => [{ result: { completed: true } }]
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => {},
      detach: async () => {},
      sendCommand: (target, method, params, cb) => {
        if (cb) cb({ result: { value: 42 } });
      }
    }
  };

  const context = vm.createContext({
    chrome,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController
  });

  const bgCode = fs.readFileSync('extensions/chrome/background.js', 'utf8');
  vm.runInContext(bgCode, context);

  const createPort = (name = 'sidebar-run-stream', overrides = {}) => {
    const p = {
      name,
      sender: { id: chrome.runtime.id },
      onMessage: event(),
      onDisconnect: event(),
      postMessage(msg) { this.messages.push(msg); },
      disconnect() {
        this.disconnected = true;
        this.onDisconnect.emit();
      },
      messages: [],
      disconnected: false,
      ...overrides
    };
    onConnect.emit(p);
    return p;
  };

  return { chrome, context, createPort, getNativePort: () => nativePortInstance, onConnect, runtimeOnMessage };
}

async function runTests() {
  console.log('--- Starting Service Worker Lifecycle Stress Tests ---');

  // =========================================================================
  // Test 1: Port maintenance & disconnect recovery in background.js
  // =========================================================================
  console.log('Testing 1: Port maintenance & disconnect recovery...');
  {
    const { context, createPort } = createBackgroundHarness();

    // 1a. Create a background run
    const run = vm.runInContext('createRun({ chatId: "chat-port-test" })', context);
    const runId = run.runId;

    // Connect 5 ports and subscribe all of them
    const ports = [];
    for (let i = 0; i < 5; i++) {
      const p = createPort('sidebar-run-stream');
      p.onMessage.emit({ type: 'subscribe', runId });
      assert.equal(p.messages.length, 1);
      assert.equal(p.messages[0].type, 'subscribed');
      assert.equal(p.messages[0].runId, runId);
      assert.equal(p.messages[0].run.chatId, 'chat-port-test');
      ports.push(p);
    }

    const initialPortsCount = vm.runInContext(`runPorts.get("${runId}").size`, context);
    assert.equal(initialPortsCount, 5, 'All 5 ports should be tracked in runPorts');

    // Broadcast an event and ensure all 5 received it
    vm.runInContext(`broadcastRunEvent("${runId}", { type: "test_event", step: 1 })`, context);
    for (const p of ports) {
      assert.equal(p.messages.length, 2);
      assert.equal(p.messages[1].type, 'test_event');
      assert.equal(p.messages[1].step, 1);
    }

    // Disconnect 2 ports
    ports[0].disconnect();
    ports[1].disconnect();
    const remainingPortsCount = vm.runInContext(`runPorts.get("${runId}").size`, context);
    assert.equal(remainingPortsCount, 3, 'Disconnected ports should be cleanly removed');

    // Broadcast again: only active 3 ports should receive it
    vm.runInContext(`broadcastRunEvent("${runId}", { type: "test_event", step: 2 })`, context);
    assert.equal(ports[0].messages.length, 2, 'Disconnected port 0 should receive no new events');
    assert.equal(ports[1].messages.length, 2, 'Disconnected port 1 should receive no new events');
    assert.equal(ports[2].messages.length, 3);
    assert.equal(ports[3].messages.length, 3);
    assert.equal(ports[4].messages.length, 3);

    // Disconnect remaining ports
    ports[2].disconnect();
    ports[3].disconnect();
    ports[4].disconnect();
    const mapHasRun = vm.runInContext(`runPorts.has("${runId}")`, context);
    assert.equal(mapHasRun, false, 'runPorts entry should be deleted when all ports disconnect');

    // Reconnection recovery: connect a new port and verify full catch-up state
    vm.runInContext(`appendRunAction(backgroundRuns.get("${runId}"), { action: "read_page", status: "complete" })`, context);
    vm.runInContext(`setRunStatus(backgroundRuns.get("${runId}"), "running")`, context);

    const reconnectedPort = createPort('sidebar-run-stream');
    reconnectedPort.onMessage.emit({ type: 'subscribe', runId });
    assert.equal(reconnectedPort.messages.length, 1);
    const subMsg = reconnectedPort.messages[0];
    assert.equal(subMsg.type, 'subscribed');
    assert.equal(subMsg.run.status, 'running');
    assert.equal(subMsg.run.actionLedger.length, 1);
    assert.equal(subMsg.run.actionLedger[0].action, 'read_page');
    assert.equal(vm.runInContext(`runPorts.get("${runId}").size`, context), 1);

    // Stress: 50 rapid connect/subscribe/disconnect cycles
    for (let i = 0; i < 50; i++) {
      const stressPort = createPort('sidebar-run-stream');
      stressPort.onMessage.emit({ type: 'subscribe', runId });
      assert.equal(stressPort.messages[0].type, 'subscribed');
      stressPort.disconnect();
    }
    // After all 50 disconnected, only reconnectedPort should remain
    assert.equal(vm.runInContext(`runPorts.get("${runId}").size`, context), 1);
    reconnectedPort.disconnect();
    assert.equal(vm.runInContext(`runPorts.has("${runId}")`, context), false);

    console.log('✓ Test 1 passed: Port maintenance & disconnect recovery verified');
  }

  // =========================================================================
  // Test 2: Dead port eviction from runPorts during broadcast errors
  // =========================================================================
  console.log('Testing 2: Dead port eviction from runPorts during broadcast errors...');
  {
    const { context, createPort } = createBackgroundHarness();

    const run = vm.runInContext('createRun({ chatId: "chat-dead-ports" })', context);
    const runId = run.runId;

    // Connect 4 healthy ports and 4 dead ports (whose postMessage throws)
    const healthyPorts = [];
    const deadPorts = [];

    for (let i = 0; i < 4; i++) {
      const hp = createPort('sidebar-run-stream');
      hp.onMessage.emit({ type: 'subscribe', runId });
      healthyPorts.push(hp);

      const dp = createPort('sidebar-run-stream', {
        postMessage(msg) {
          if (msg.type === 'subscribed') {
            this.messages.push(msg);
            return;
          }
          throw new Error('Attempting to use a disconnected port');
        }
      });
      dp.onMessage.emit({ type: 'subscribe', runId });
      deadPorts.push(dp);
    }

    assert.equal(vm.runInContext(`runPorts.get("${runId}").size`, context), 8);

    // Trigger broadcast: dead ports will throw inside postMessage
    vm.runInContext(`broadcastRunEvent("${runId}", { type: "heartbeat", ts: 100 })`, context);

    // Verify all 4 healthy ports received heartbeat
    for (const hp of healthyPorts) {
      assert.equal(hp.messages.length, 2);
      assert.equal(hp.messages[1].type, 'heartbeat');
    }

    // Verify dead ports were evicted from runPorts
    const portsRemaining = vm.runInContext(`runPorts.get("${runId}").size`, context);
    assert.equal(portsRemaining, 4, 'All 4 dead ports should be evicted from runPorts Set');

    // Make 2 of the remaining healthy ports become dead
    healthyPorts[0].postMessage = () => { throw new Error('Simulated socket broken'); };
    healthyPorts[1].postMessage = () => { throw new Error('Simulated socket broken'); };

    vm.runInContext(`broadcastRunEvent("${runId}", { type: "heartbeat", ts: 200 })`, context);
    assert.equal(vm.runInContext(`runPorts.get("${runId}").size`, context), 2);
    assert.equal(healthyPorts[2].messages.length, 3);
    assert.equal(healthyPorts[3].messages.length, 3);

    // Make the last 2 throw as well
    healthyPorts[2].postMessage = () => { throw new Error('Closed'); };
    healthyPorts[3].postMessage = () => { throw new Error('Closed'); };

    vm.runInContext(`broadcastRunEvent("${runId}", { type: "heartbeat", ts: 300 })`, context);
    assert.equal(vm.runInContext(`runPorts.has("${runId}")`, context), false, 'Empty set should be removed completely');

    // Concurrency stress: 30 mixed ports simultaneously
    const mixedHealthy = [];
    for (let i = 0; i < 30; i++) {
      const isDead = (i % 2 === 0);
      const p = createPort('sidebar-run-stream', {
        postMessage(msg) {
          if (msg.type === 'subscribed') return;
          if (isDead) throw new Error('Port dead');
          this.messages.push(msg);
        }
      });
      p.onMessage.emit({ type: 'subscribe', runId });
      if (!isDead) mixedHealthy.push(p);
    }
    assert.equal(vm.runInContext(`runPorts.get("${runId}").size`, context), 30);

    vm.runInContext(`broadcastRunEvent("${runId}", { type: "stress_blast" })`, context);
    assert.equal(vm.runInContext(`runPorts.get("${runId}").size`, context), 15);
    for (const hp of mixedHealthy) {
      assert.equal(hp.messages.length, 1);
      assert.equal(hp.messages[0].type, 'stress_blast');
      hp.disconnect();
    }
    assert.equal(vm.runInContext(`runPorts.has("${runId}")`, context), false);

    console.log('✓ Test 2 passed: Dead port eviction on broadcast error verified');
  }

  // =========================================================================
  // Test 3: port.onMessage handling disconnected ports safely
  // =========================================================================
  console.log('Testing 3: port.onMessage handling disconnected ports safely...');
  {
    const { context, createPort } = createBackgroundHarness();

    const run = vm.runInContext('createRun({ chatId: "chat-msg-safety" })', context);
    const runId = run.runId;

    // 3a. Port throws when responding to subscribe
    const brokenSubscribePort = createPort('sidebar-run-stream', {
      postMessage() { throw new Error('Disconnected during subscribe ack'); }
    });
    // Emitting subscribe should not throw or crash
    assert.doesNotThrow(() => {
      brokenSubscribePort.onMessage.emit({ type: 'subscribe', runId });
    });
    // Broadcast triggers eviction of the dead port
    vm.runInContext(`broadcastRunEvent("${runId}", { type: "test" })`, context);
    const portsForRun = vm.runInContext(`runPorts.get("${runId}")`, context);
    const hasBrokenPort = portsForRun && portsForRun.has(brokenSubscribePort);
    assert.equal(!!hasBrokenPort, false, 'Broken port should be evicted by broadcastRunEvent');

    // 3b. Port throws when responding to cancel
    const cancelRunTarget = vm.runInContext('createRun({ chatId: "chat-cancel-test" })', context);
    const brokenCancelPort = createPort('sidebar-run-stream', {
      postMessage(msg) {
        if (msg.type === 'subscribed') return;
        throw new Error('Disconnected during cancel result');
      }
    });
    brokenCancelPort.onMessage.emit({ type: 'subscribe', runId: cancelRunTarget.runId });
    assert.doesNotThrow(() => {
      brokenCancelPort.onMessage.emit({ type: 'cancel', runId: cancelRunTarget.runId });
    });
    assert.equal(cancelRunTarget.status, 'stopped');

    // 3c. Port throws when responding to resolveApproval
    let approvalReceived = false;
    const approvalRun = vm.runInContext(`
      createRun({
        chatId: "chat-app-test",
        executor: async ({ requestApproval }) => {
          await requestApproval({ action: "test_action", text: "Approve?" });
        }
      })
    `, context);

    await new Promise(r => setTimeout(r, 25));
    const appRecord = Array.from(approvalRun.pendingApprovals.entries())[0];
    assert.ok(appRecord, 'Approval should be pending');
    const [approvalId] = appRecord;

    const brokenApprovalPort = createPort('sidebar-run-stream', {
      postMessage(msg) {
        if (msg.type === 'subscribed') return;
        throw new Error('Disconnected during approval resolution');
      }
    });
    brokenApprovalPort.onMessage.emit({ type: 'subscribe', runId: approvalRun.runId });

    assert.doesNotThrow(() => {
      brokenApprovalPort.onMessage.emit({
        type: 'resolveApproval',
        runId: approvalRun.runId,
        approvalId,
        approved: true
      });
    });

    // 3d. Malformed & unexpected messages on port.onMessage
    const normalPort = createPort('sidebar-run-stream');
    const malformedInputs = [
      null,
      undefined,
      12345,
      'just a string',
      true,
      [],
      {},
      { type: null },
      { type: undefined },
      { type: 42 },
      { type: 'unknown_type' },
      { type: 'subscribe' }, // Missing runId
      { type: 'cancel' },    // Missing runId
      { type: 'resolveApproval' }, // Missing approvalId
      { type: 'resolveApproval', runId: 'fake-id' }, // Non-existent run
      { type: 'resolveApproval', runId: approvalRun.runId, approvalId: 'non-existent' }
    ];

    for (const input of malformedInputs) {
      assert.doesNotThrow(() => {
        normalPort.onMessage.emit(input);
      }, `Port onMessage should handle malformed input gracefully: ${JSON.stringify(input)}`);
    }

    normalPort.disconnect();
    console.log('✓ Test 3 passed: port.onMessage safely handled disconnected and malformed ports');
  }

  // =========================================================================
  // Test 4: Approval promise timeout / disconnect cleanup
  // =========================================================================
  console.log('Testing 4: Approval promise timeout / disconnect cleanup...');
  {
    const { context, createPort } = createBackgroundHarness();

    // 4a. Approval promise timeout (timeoutMs)
    let timeoutPromiseRejected = false;
    let timeoutErrorMessage = '';
    const runTimeout = vm.runInContext(`
      createRun({
        chatId: "chat-timeout",
        executor: async ({ requestApproval }) => {
          try {
            await requestApproval({ action: "sensitive_op", timeoutMs: 40 });
          } catch (err) {
            timeoutPromiseRejected = true;
            timeoutErrorMessage = err.message;
            throw err;
          }
        }
      })
    `, context);
    context.timeoutPromiseRejected = false;
    context.timeoutErrorMessage = '';

    // Wait 60ms for timeout to trigger
    await new Promise(r => setTimeout(r, 60));

    assert.equal(context.timeoutPromiseRejected, true, 'Approval promise should reject on timeout');
    assert.match(context.timeoutErrorMessage, /Approval request timed out/i);
    assert.equal(runTimeout.status, 'failed');
    assert.equal(runTimeout.pendingApprovals.size, 0);

    // 4b. Approval resolution BEFORE timeout clears the timer cleanly
    let approvalResolved = false;
    const runSuccess = vm.runInContext(`
      createRun({
        chatId: "chat-success-approval",
        executor: async ({ requestApproval }) => {
          await requestApproval({ action: "fast_op", timeoutMs: 5000 });
          approvalResolved = true;
        }
      })
    `, context);
    context.approvalResolved = false;

    await new Promise(r => setTimeout(r, 20));
    assert.equal(runSuccess.status, 'waiting_approval');
    const [fastAppId] = Array.from(runSuccess.pendingApprovals.keys());

    const portSuccess = createPort('sidebar-run-stream');
    portSuccess.onMessage.emit({ type: 'subscribe', runId: runSuccess.runId });
    portSuccess.onMessage.emit({
      type: 'resolveApproval',
      runId: runSuccess.runId,
      approvalId: fastAppId,
      approved: true
    });

    await new Promise(r => setTimeout(r, 25));
    assert.equal(context.approvalResolved, true);
    assert.equal(runSuccess.status, 'completed');
    portSuccess.disconnect();

    // 4c. Approval disconnect timeout cleanup: all ports disconnect
    let disconnectRejected = false;
    let disconnectErrorMsg = '';
    const runDisconnect = vm.runInContext(`
      createRun({
        chatId: "chat-disconnect-cleanup",
        executor: async ({ requestApproval }) => {
          try {
            await requestApproval({ action: "needs_port", disconnectTimeoutMs: 40 });
          } catch (err) {
            disconnectRejected = true;
            disconnectErrorMsg = err.message;
            throw err;
          }
        }
      })
    `, context);
    context.disconnectRejected = false;
    context.disconnectErrorMsg = '';

    const dcPort = createPort('sidebar-run-stream');
    dcPort.onMessage.emit({ type: 'subscribe', runId: runDisconnect.runId });

    await new Promise(r => setTimeout(r, 20));
    assert.equal(runDisconnect.status, 'waiting_approval');

    // Port disconnects
    dcPort.disconnect();

    // Wait 60ms (longer than 40ms disconnectTimeoutMs)
    await new Promise(r => setTimeout(r, 60));

    assert.equal(context.disconnectRejected, true, 'Approval should reject after disconnectTimeoutMs');
    assert.match(context.disconnectErrorMsg, /All approval ports disconnected/i);
    assert.equal(runDisconnect.status, 'failed');
    assert.equal(runDisconnect.pendingApprovals.size, 0);

    // 4d. Reconnect cancels disconnect timeout
    let recoveredApprovalResolved = false;
    const runRecover = vm.runInContext(`
      createRun({
        chatId: "chat-reconnect-recovery",
        executor: async ({ requestApproval }) => {
          await requestApproval({ action: "will_recover", disconnectTimeoutMs: 80 });
          recoveredApprovalResolved = true;
        }
      })
    `, context);
    context.recoveredApprovalResolved = false;

    const firstPort = createPort('sidebar-run-stream');
    firstPort.onMessage.emit({ type: 'subscribe', runId: runRecover.runId });

    await new Promise(r => setTimeout(r, 20));
    const [recAppId] = Array.from(runRecover.pendingApprovals.keys());

    // First port disconnects, starting the 80ms timer
    firstPort.disconnect();

    // Within 25ms, second port reconnects and subscribes
    await new Promise(r => setTimeout(r, 25));
    const secondPort = createPort('sidebar-run-stream');
    secondPort.onMessage.emit({ type: 'subscribe', runId: runRecover.runId });

    // Wait another 70ms (total 95ms > 80ms)
    await new Promise(r => setTimeout(r, 70));

    // Run must NOT have timed out because secondPort is connected!
    assert.equal(runRecover.status, 'waiting_approval');
    assert.equal(runRecover.pendingApprovals.has(recAppId), true);

    // Resolve via second port
    secondPort.onMessage.emit({
      type: 'resolveApproval',
      runId: runRecover.runId,
      approvalId: recAppId,
      approved: true
    });

    await new Promise(r => setTimeout(r, 25));
    assert.equal(context.recoveredApprovalResolved, true);
    assert.equal(runRecover.status, 'completed');
    secondPort.disconnect();

    // 4e. cancelRun rejects pending approvals and cleans up timers
    let cancelAppRejected = false;
    let cancelAppReason = '';
    const runCancel = vm.runInContext(`
      createRun({
        chatId: "chat-cancel-cleanup",
        executor: async ({ requestApproval }) => {
          try {
            await requestApproval({ action: "stop_me", timeoutMs: 10000 });
          } catch (err) {
            cancelAppRejected = true;
            cancelAppReason = err.message;
            throw err;
          }
        }
      })
    `, context);
    context.cancelAppRejected = false;
    context.cancelAppReason = '';

    await new Promise(r => setTimeout(r, 20));
    assert.equal(runCancel.pendingApprovals.size, 1);

    vm.runInContext(`cancelRun("${runCancel.runId}", "Custom cancel reason")`, context);
    await new Promise(r => setTimeout(r, 20));

    assert.equal(context.cancelAppRejected, true);
    assert.equal(context.cancelAppReason, 'Custom cancel reason');
    assert.equal(runCancel.status, 'stopped');
    assert.equal(runCancel.pendingApprovals.size, 0);

    console.log('✓ Test 4 passed: Approval timeout, reconnect recovery, and cancel cleanup verified');
  }

  // =========================================================================
  // Test 5: IPC message resilience on null/undefined inputs
  // =========================================================================
  console.log('Testing 5: IPC message resilience on null/undefined inputs...');
  {
    const { chrome, getNativePort, onConnect } = createBackgroundHarness();

    // 5a. chrome.runtime.onMessage with null, undefined, primitives, malformed
    const fuzzMessages = [
      null,
      undefined,
      0,
      1,
      -1,
      NaN,
      '',
      'getStatus',
      false,
      true,
      [],
      [1, 2, 3],
      {},
      { type: null },
      { type: undefined },
      { type: 123 },
      { type: '' },
      { type: 'completely_unknown_type' },
      { type: 'sidebarFolder' }, // Missing sender validation
      { type: 'sidebarMcp' },
      { type: 'sidebarTool' },
      { type: 'startRun' },
      { type: 'getRun' },
      { type: 'listRuns' }
    ];

    for (const msg of fuzzMessages) {
      assert.doesNotThrow(() => {
        let responseReceived = false;
        chrome.runtime.onMessage.emit(msg, null, (res) => {
          responseReceived = true;
        });
      }, `chrome.runtime.onMessage must not throw on: ${JSON.stringify(msg)}`);

      // Sender as undefined, null, or empty object
      assert.doesNotThrow(() => {
        chrome.runtime.onMessage.emit(msg, undefined, () => {});
        chrome.runtime.onMessage.emit(msg, {}, () => {});
      });

      // sendResponse as null or undefined
      assert.doesNotThrow(() => {
        chrome.runtime.onMessage.emit(msg, null, null);
        chrome.runtime.onMessage.emit(msg, undefined, undefined);
      });
    }

    // Verify valid messages continue to work properly with null/empty sender
    const statusPromise = new Promise(resolve => {
      chrome.runtime.onMessage.emit({ type: 'getStatus' }, null, resolve);
    });
    const statusResult = await statusPromise;
    assert.ok(statusResult);
    assert.equal(typeof statusResult.connected, 'boolean');

    // 5b. nativePort.onMessage resilience
    const nativePort = getNativePort();
    assert.ok(nativePort, 'Native port should be created');

    const fuzzNativeMessages = [
      null,
      undefined,
      0,
      42,
      'handshake_ack',
      '',
      false,
      [],
      {},
      { type: null },
      { type: undefined },
      { type: 'sidebar_files_result' }, // Missing requestId
      { type: 'sidebar_mcp_result' },
      { action: null },
      { action: undefined },
      { action: 'non_existent_action' }
    ];

    for (const nativeMsg of fuzzNativeMessages) {
      assert.doesNotThrow(() => {
        nativePort.onMessage.emit(nativeMsg);
      }, `nativePort.onMessage must not throw on: ${JSON.stringify(nativeMsg)}`);
    }

    // 5c. chrome.runtime.onConnect with invalid/unauthorized ports
    const badPorts = [
      { name: 'wrong-name', sender: { id: chrome.runtime.id } },
      { name: 'sidebar-run-stream', sender: { id: 'unauthorized-id' } },
      { name: 'sidebar-run-stream', sender: null },
      { name: 'sidebar-run-stream', sender: undefined }
    ];

    for (const badPort of badPorts) {
      assert.doesNotThrow(() => {
        onConnect.emit(badPort);
      }, 'onConnect must ignore or handle bad ports without throwing');
    }

    console.log('✓ Test 5 passed: IPC message resilience on null/undefined inputs verified');
  }

  console.log('\n======================================================');
  console.log('ALL SERVICE WORKER LIFECYCLE STRESS TESTS PASSED!');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ Lifecycle Stress Test Failed:');
  console.error(err);
  process.exit(1);
});
