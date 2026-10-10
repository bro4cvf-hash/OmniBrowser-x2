const assert = require('node:assert/strict');
const {
  ActionLedger,
  ActionStatus,
  VALID_TRANSITIONS,
  SETTLED_STATES,
  isMutationAction
} = require('../extensions/chrome/sidebar-ledger.js');

function createMockStorage(initialData = {}) {
  const store = { ...initialData };
  let getCalls = 0;
  let setCalls = 0;

  return {
    async get(key) {
      getCalls++;
      return { [key]: store[key] ? JSON.parse(JSON.stringify(store[key])) : undefined };
    },
    async set(items) {
      setCalls++;
      for (const [k, v] of Object.entries(items)) {
        store[k] = JSON.parse(JSON.stringify(v));
      }
    },
    getStore() {
      return store;
    },
    getStats() {
      return { getCalls, setCalls };
    }
  };
}

(async () => {
  console.log('Running ActionLedger tests...');

  // --- Test 1: Full State Transitions Lifecycle ---
  {
    const ledger = new ActionLedger({ debounceMs: 0 });

    // Proposed -> Approved -> Started -> Completed
    const act1 = ledger.propose({ name: 'click_button', params: { selector: '#submit' } });
    assert.equal(act1.status, ActionStatus.PROPOSED);
    assert.equal(act1.isMutation, true);
    assert.equal(act1.history.length, 1);

    const approved1 = ledger.approve(act1.id, { reason: 'User confirmed dialog' });
    assert.equal(approved1.status, ActionStatus.APPROVED);

    const started1 = ledger.start(act1.id);
    assert.equal(started1.status, ActionStatus.STARTED);
    assert.ok(started1.startedAt);

    const completed1 = ledger.complete(act1.id, { submitted: true, code: 200 });
    assert.equal(completed1.status, ActionStatus.COMPLETED);
    assert.deepEqual(completed1.result, { submitted: true, code: 200 });
    assert.ok(completed1.settledAt);
    assert.equal(completed1.history.length, 4);

    // Proposed -> Approved -> Started -> Failed
    const act2 = ledger.propose({ name: 'fetch_data', isMutation: false });
    assert.equal(act2.isMutation, false);
    ledger.approve(act2.id);
    ledger.start(act2.id);
    const failed2 = ledger.fail(act2.id, new Error('Network timeout'));
    assert.equal(failed2.status, ActionStatus.FAILED);
    assert.equal(failed2.error, 'Network timeout');

    // Proposed -> Approved -> Started -> Skipped
    const act3 = ledger.propose({ name: 'type_text', params: { text: 'hello' } });
    ledger.approve(act3.id);
    ledger.start(act3.id);
    const skipped3 = ledger.skip(act3.id, 'Element became obsolete');
    assert.equal(skipped3.status, ActionStatus.SKIPPED);

    // Proposed -> Approved -> Started -> Unknown
    const act4 = ledger.propose({ name: 'submit_payment', params: { amount: 50 } });
    ledger.approve(act4.id);
    ledger.start(act4.id);
    const unknown4 = ledger.markUnknown(act4.id, 'Tab crashed during submit');
    assert.equal(unknown4.status, ActionStatus.UNKNOWN);
    assert.ok(unknown4.settledAt);

    // Direct pre-start cancellation: Proposed -> Skipped / Failed
    const act5 = ledger.propose({ name: 'click_link' });
    const skipped5 = ledger.skip(act5.id, 'User cancelled');
    assert.equal(skipped5.status, ActionStatus.SKIPPED);

    const act6 = ledger.propose({ name: 'delete_item' });
    const failed6 = ledger.fail(act6.id, 'Permission check failed');
    assert.equal(failed6.status, ActionStatus.FAILED);

    // Approved -> Skipped / Failed / Unknown
    const act7 = ledger.propose({ name: 'click_test' });
    ledger.approve(act7.id);
    const skipped7 = ledger.skip(act7.id, 'Precondition failed');
    assert.equal(skipped7.status, ActionStatus.SKIPPED);

    const act8 = ledger.propose({ name: 'click_interrupted' });
    ledger.approve(act8.id);
    const unknown8 = ledger.markUnknown(act8.id, 'Interrupted before started');
    assert.equal(unknown8.status, ActionStatus.UNKNOWN);

    console.log('✓ Valid state transitions passed');
  }

  // --- Test 2: Invalid State Transitions Enforced ---
  {
    const ledger = new ActionLedger({ debounceMs: 0 });
    const act = ledger.propose({ name: 'click_action' });

    // Cannot jump proposed -> completed directly
    assert.throws(
      () => ledger.complete(act.id, { ok: true }),
      /cannot transition from 'proposed' to 'completed'/
    );

    // Cannot jump proposed -> started directly without approval
    assert.throws(
      () => ledger.start(act.id),
      /cannot transition from 'proposed' to 'started'/
    );

    // Advance to completed
    ledger.approve(act.id);
    ledger.start(act.id);
    ledger.complete(act.id, { ok: true });

    // Terminal state cannot transition again
    assert.throws(
      () => ledger.start(act.id),
      /cannot transition from 'completed' to 'started'/
    );
    assert.throws(
      () => ledger.fail(act.id, 'Late error'),
      /cannot transition from 'completed' to 'failed'/
    );

    console.log('✓ Invalid state transitions enforcement passed');
  }

  // --- Test 3: Immediate Per-Action Settlement Hooks During Parallel Batch Execution ---
  {
    const settledLog = [];
    const ledger = new ActionLedger({
      debounceMs: 10,
      onSettled: (action) => {
        settledLog.push({ id: action.id, status: action.status, at: Date.now() });
      }
    });

    const batch = ledger.proposeBatch([
      { id: 'b_1', name: 'batch_click_1' },
      { id: 'b_2', name: 'batch_click_2' },
      { id: 'b_3', name: 'batch_click_3' },
      { id: 'b_4', name: 'batch_click_4' }
    ]);

    for (const b of batch) {
      ledger.approve(b.id);
      ledger.start(b.id);
    }

    // Simulate parallel execution with staggered finish times
    const startBatchTime = Date.now();
    let action1SettledTime = 0;
    let action4SettledTime = 0;

    const runAction = async (id, delayMs, outcome) => {
      await new Promise(r => setTimeout(r, delayMs));
      if (outcome.status === 'completed') {
        ledger.complete(id, outcome.result);
      } else if (outcome.status === 'failed') {
        ledger.fail(id, outcome.error);
      } else if (outcome.status === 'unknown') {
        ledger.markUnknown(id, outcome.reason);
      }
    };

    // Action 1 completes at 15ms, Action 2 fails at 30ms, Action 3 unknown at 45ms, Action 4 completes at 80ms
    const p1 = runAction('b_1', 15, { status: 'completed', result: 'fast_done' }).then(() => {
      action1SettledTime = Date.now();
      // At this point, Action 1 is already settled in the ledger!
      assert.equal(ledger.get('b_1').status, ActionStatus.COMPLETED);
      assert.equal(settledLog.some(e => e.id === 'b_1'), true);
      // But Action 4 is NOT settled yet!
      assert.equal(ledger.get('b_4').status, ActionStatus.STARTED);
    });

    const p2 = runAction('b_2', 30, { status: 'failed', error: 'element not visible' });
    const p3 = runAction('b_3', 45, { status: 'unknown', reason: 'timeout waiting for response' });
    const p4 = runAction('b_4', 80, { status: 'completed', result: 'slow_done' }).then(() => {
      action4SettledTime = Date.now();
    });

    await Promise.all([p1, p2, p3, p4]);

    assert.equal(settledLog.length, 4);
    assert.deepEqual(settledLog.map(e => e.id), ['b_1', 'b_2', 'b_3', 'b_4']);
    assert.equal(settledLog[0].status, ActionStatus.COMPLETED);
    assert.equal(settledLog[1].status, ActionStatus.FAILED);
    assert.equal(settledLog[2].status, ActionStatus.UNKNOWN);
    assert.equal(settledLog[3].status, ActionStatus.COMPLETED);

    console.log('✓ Immediate per-action settlement hooks during parallel execution passed');
  }

  // --- Test 4: Append-Only Persistence to chrome.storage.local with Queue Debouncing ---
  {
    const storage = createMockStorage();
    const ledger = new ActionLedger({
      storage,
      storageKey: 'test_ledger_key',
      debounceMs: 50 // 50ms debouncing window
    });

    // Propose 5 rapid actions
    for (let i = 0; i < 5; i++) {
      ledger.propose({ id: `q_${i}`, name: `action_${i}` });
    }

    // Immediately after synchronous proposes, debouncing should prevent 5 immediate storage.set calls
    const statsBeforeFlush = storage.getStats();
    assert.equal(statsBeforeFlush.setCalls, 0, 'Debounced queue should not write to storage synchronously');

    // Awaiting flush writes pending records
    await ledger.flush();
    const statsAfterFlush = storage.getStats();
    assert.equal(statsAfterFlush.setCalls, 1, 'Flush should commit batched queue in a single storage call');

    const storedData = storage.getStore()['test_ledger_key'];
    assert.ok(storedData);
    assert.equal(Object.keys(storedData.actions).length, 5);
    assert.equal(storedData.journal.length, 5);

    // Settle 3 of them progressively
    ledger.approve('q_0');
    ledger.start('q_0');
    ledger.complete('q_0', { res: 0 });

    ledger.approve('q_1');
    ledger.start('q_1');
    ledger.fail('q_1', 'err 1');

    ledger.approve('q_2');
    ledger.start('q_2');
    ledger.markUnknown('q_2', 'uncertain 2');

    // Wait for the debounce timer (60ms)
    await new Promise(r => setTimeout(r, 70));

    const finalStored = storage.getStore()['test_ledger_key'];
    // Journal must be append-only: previous 5 events plus the new transition events!
    assert.ok(finalStored.journal.length > 5, 'Journal entries must be appended');
    assert.equal(finalStored.actions['q_0'].status, ActionStatus.COMPLETED);
    assert.equal(finalStored.actions['q_1'].status, ActionStatus.FAILED);
    assert.equal(finalStored.actions['q_2'].status, ActionStatus.UNKNOWN);

    // Verify loading ledger into a new instance
    const restoredLedger = new ActionLedger({
      storage,
      storageKey: 'test_ledger_key'
    });
    await restoredLedger.load();
    assert.equal(restoredLedger.size, 5);
    assert.equal(restoredLedger.get('q_0').status, ActionStatus.COMPLETED);
    assert.equal(restoredLedger.get('q_2').status, ActionStatus.UNKNOWN);
    assert.equal(restoredLedger.getJournal().length, finalStored.journal.length);

    console.log('✓ Append-only persistence with queue debouncing passed');
  }

  // --- Test 5: Querying and Resolving Uncertain Mutations ---
  {
    const ledger = new ActionLedger({ debounceMs: 0 });

    // Mutating actions
    const m1 = ledger.propose({ name: 'click_submit', isMutation: true });
    ledger.approve(m1.id);
    ledger.start(m1.id);
    ledger.markUnknown(m1.id, 'Disconnected before acknowledgment');

    const m2 = ledger.propose({ name: 'fill_form', isMutation: true });
    ledger.approve(m2.id);
    ledger.start(m2.id);
    ledger.complete(m2.id, { filled: true });

    // Read-only action that went unknown (e.g. read_page timeout)
    const r1 = ledger.propose({ name: 'read_page', isMutation: false });
    ledger.approve(r1.id);
    ledger.start(r1.id);
    ledger.markUnknown(r1.id, 'Tab suspended');

    // Query uncertain mutations - should only return mutations in UNKNOWN state by default
    const uncertainMutations = ledger.queryUncertainMutations();
    assert.equal(uncertainMutations.length, 1);
    assert.equal(uncertainMutations[0].id, m1.id);
    assert.equal(uncertainMutations[0].isMutation, true);
    assert.equal(ledger.hasUncertainMutations(), true);

    // Query including non-mutations
    const allUnknown = ledger.queryUncertainMutations({ onlyMutations: false });
    assert.equal(allUnknown.length, 2);

    // Resolve uncertain mutation
    const resolved = ledger.resolveUncertain(m1.id, ActionStatus.COMPLETED, {
      result: { verified: 'Submission was recorded in DB' },
      notes: 'Audit log reconciled'
    });

    assert.equal(resolved.status, ActionStatus.COMPLETED);
    assert.deepEqual(resolved.result, { verified: 'Submission was recorded in DB' });
    assert.equal(ledger.get(m1.id).status, ActionStatus.COMPLETED);
    assert.equal(ledger.hasUncertainMutations(), false);

    console.log('✓ Querying and resolving uncertain mutations passed');
  }

  // --- Test 6: Environment Compatibility: Window vs Service Worker Contexts ---
  {
    // Context A: Service Worker environment (typeof window === 'undefined')
    assert.equal(typeof window, 'undefined');
    const swLedger = new ActionLedger();
    swLedger.propose({ name: 'sw_action' });
    assert.equal(swLedger.size, 1);

    // Context B: Window context simulation (mock window with unload event listeners)
    let unloadHandlerCalled = false;
    let addedListeners = {};
    const mockWindow = {
      addEventListener: (evt, fn) => {
        addedListeners[evt] = fn;
      },
      removeEventListener: (evt) => {
        delete addedListeners[evt];
      }
    };

    globalThis.window = mockWindow;
    try {
      assert.equal(typeof window !== 'undefined', true);
      const storage = createMockStorage();
      const winLedger = new ActionLedger({
        storage,
        debounceMs: 500,
        autoFlushOnUnload: true
      });

      winLedger.propose({ id: 'win_1', name: 'win_action' });
      assert.ok(addedListeners['beforeunload'], 'Window beforeunload listener should be registered');
      assert.ok(addedListeners['pagehide'], 'Window pagehide listener should be registered');

      // Trigger beforeunload simulation
      addedListeners['beforeunload']();
      await winLedger.flush();

      const stored = storage.getStore()['omni_action_ledger'];
      assert.ok(stored.actions['win_1'], 'Unload should trigger ledger flush to storage');

      winLedger.dispose();
      assert.ok(!addedListeners['beforeunload'], 'dispose should remove window event listeners');
    } finally {
      delete globalThis.window;
    }

    assert.equal(typeof window, 'undefined');
    console.log('✓ Window vs Service Worker context compatibility passed');
  }

  // --- Test 7: Payload Cloning Before State Mutation in transition() ---
  {
    const ledger = new ActionLedger({ debounceMs: 0 });
    const act = ledger.propose({ name: 'clone_test' });
    ledger.approve(act.id);
    ledger.start(act.id);

    // If cloning payload fails (e.g., circular structure in result), state must NOT be mutated to completed
    const circular = {};
    circular.self = circular;

    assert.throws(
      () => ledger.complete(act.id, circular),
      /circular|Converting circular structure to JSON/i
    );

    // Entry status must remain STARTED because cloning failed before state update
    assert.equal(ledger.get(act.id).status, ActionStatus.STARTED);

    // Normal completion works
    const normal = ledger.complete(act.id, { safe: true });
    assert.equal(normal.status, ActionStatus.COMPLETED);
    console.log('✓ Transition payload cloning before state mutation passed');
  }

  // --- Test 8: Flush Failure Recovery and Unpersisted State Restoration ---
  {
    let shouldFail = true;
    const store = {};
    const flakeyStorage = {
      async get(key) {
        return { [key]: store[key] };
      },
      async set(items) {
        if (shouldFail) {
          throw new Error('Temporary storage write failure');
        }
        for (const [k, v] of Object.entries(items)) {
          store[k] = JSON.parse(JSON.stringify(v));
        }
      }
    };

    const ledger = new ActionLedger({
      storage: flakeyStorage,
      storageKey: 'flakey_ledger',
      debounceMs: 0
    });

    ledger.propose({ id: 'f_1', name: 'flakey_action_1' });

    // First flush fails
    await assert.rejects(
      async () => ledger.flush(),
      /Temporary storage write failure/
    );

    // Unpersisted actions and journal should still be pending in the ledger
    assert.equal(ledger._pendingActions.has('f_1'), true, 'f_1 must be restored to _pendingActions');
    assert.ok(ledger._pendingJournal.length > 0, '_pendingJournal must have restored events');

    // Add another action while error happened
    ledger.propose({ id: 'f_2', name: 'flakey_action_2' });

    // Storage becomes healthy
    shouldFail = false;

    // Next flush must succeed without being broken by the previous rejection
    await ledger.flush();

    assert.equal(ledger._pendingActions.size, 0);
    assert.equal(ledger._pendingJournal.length, 0);
    assert.ok(store['flakey_ledger']);
    assert.ok(store['flakey_ledger'].actions['f_1']);
    assert.ok(store['flakey_ledger'].actions['f_2']);
    assert.equal(store['flakey_ledger'].journal.length, 2);

    console.log('✓ Flush failure recovery and pending state restoration passed');
  }

  // --- Test 9: Robustness Against Malformed existing.actions in Storage ---
  {
    const malformedStorage = createMockStorage({
      corrupt_ledger: {
        actions: ['invalid', 'array', 'of', 'actions'], // array instead of object
        journal: [],
        updatedAt: Date.now()
      }
    });

    const ledger = new ActionLedger({
      storage: malformedStorage,
      storageKey: 'corrupt_ledger',
      debounceMs: 0
    });

    // Proposing and persisting should not crash or produce numeric keys from array spreading
    ledger.propose({ id: 'c_1', name: 'action_c1' });
    await ledger.flush();

    const stored = malformedStorage.getStore()['corrupt_ledger'];
    assert.equal(Array.isArray(stored.actions), false);
    assert.equal(typeof stored.actions, 'object');
    assert.ok(stored.actions['c_1']);
    assert.equal(stored.actions['0'], undefined, 'Must not spread array into actions object');

    console.log('✓ Safe existing.actions object handling in storage passed');
  }

  // --- Test 10: load() Validation Guarding Against Null/Primitive Entries & Missing History ---
  {
    const storageWithCorruptEntries = createMockStorage({
      test_load_validate: {
        actions: {
          valid_1: {
            id: 'valid_1',
            name: 'valid_action',
            status: ActionStatus.PROPOSED,
            isMutation: true,
            history: [{ from: null, to: ActionStatus.PROPOSED, timestamp: Date.now() }]
          },
          null_entry: null,
          string_entry: 'primitive_string',
          number_entry: 42,
          no_history: {
            id: 'no_history',
            name: 'missing_history_action',
            status: ActionStatus.PROPOSED
          }
        },
        journal: [{ eventId: 'ev_1', actionId: 'valid_1' }, null, 'bad_event']
      }
    });

    const ledger = new ActionLedger({
      storage: storageWithCorruptEntries,
      storageKey: 'test_load_validate'
    });

    await ledger.load();

    // Only valid_1 should be loaded into _entries
    assert.equal(ledger.size, 1);
    assert.ok(ledger.has('valid_1'));
    assert.equal(ledger.has('no_history'), false);

    // Queries should not crash even if corrupt entries existed in storage
    const queried = ledger.query();
    assert.equal(queried.length, 1);
    assert.equal(queried[0].id, 'valid_1');

    console.log('✓ load() entry validation guarding against corrupt/primitive data passed');
  }

  console.log('All ActionLedger tests passed successfully!');
})();
