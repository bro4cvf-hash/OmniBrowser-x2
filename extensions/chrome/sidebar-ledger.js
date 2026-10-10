(function (root) {
  'use strict';

  const ActionStatus = Object.freeze({
    PROPOSED: 'proposed',
    APPROVED: 'approved',
    STARTED: 'started',
    COMPLETED: 'completed',
    FAILED: 'failed',
    SKIPPED: 'skipped',
    UNKNOWN: 'unknown'
  });

  const VALID_TRANSITIONS = Object.freeze({
    [ActionStatus.PROPOSED]: Object.freeze([ActionStatus.APPROVED, ActionStatus.SKIPPED, ActionStatus.FAILED]),
    [ActionStatus.APPROVED]: Object.freeze([ActionStatus.STARTED, ActionStatus.SKIPPED, ActionStatus.FAILED, ActionStatus.UNKNOWN]),
    [ActionStatus.STARTED]: Object.freeze([ActionStatus.COMPLETED, ActionStatus.FAILED, ActionStatus.SKIPPED, ActionStatus.UNKNOWN]),
    [ActionStatus.UNKNOWN]: Object.freeze([ActionStatus.COMPLETED, ActionStatus.FAILED, ActionStatus.SKIPPED]),
    [ActionStatus.COMPLETED]: Object.freeze([]),
    [ActionStatus.FAILED]: Object.freeze([]),
    [ActionStatus.SKIPPED]: Object.freeze([])
  });

  const SETTLED_STATES = new Set([
    ActionStatus.COMPLETED,
    ActionStatus.FAILED,
    ActionStatus.SKIPPED,
    ActionStatus.UNKNOWN
  ]);

  const KNOWN_READONLY_PATTERNS = [
    /^(read|inspect|snapshot|get|query|search|check|list|status|eval)/i,
    /_(read|inspect|snapshot|get|query|search|check|list|status|eval)$/i
  ];

  const KNOWN_MUTATION_PATTERNS = [
    /^(click|fill|type|press|input|submit|navigate|upload|download|delete|remove|post|put|patch|execute|batch|step)/i,
    /_(click|fill|type|press|input|submit|navigate|upload|download|delete|remove|post|put|patch|execute|batch|step)$/i
  ];

  function isMutationAction(name, explicitIsMutation) {
    if (typeof explicitIsMutation === 'boolean') return explicitIsMutation;
    if (!name || typeof name !== 'string') return true;
    for (const pattern of KNOWN_READONLY_PATTERNS) {
      if (pattern.test(name)) return false;
    }
    for (const pattern of KNOWN_MUTATION_PATTERNS) {
      if (pattern.test(name)) return true;
    }
    return true;
  }

  function clone(val) {
    if (val === undefined || val === null) return val;
    return JSON.parse(JSON.stringify(val));
  }

  function generateId(prefix = 'act') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  async function storageGet(storage, key) {
    if (!storage || typeof storage.get !== 'function') return null;
    try {
      const res = storage.get(key);
      if (res && typeof res.then === 'function') {
        const data = await res;
        return data ? data[key] : null;
      }
      return await new Promise((resolve, reject) => {
        storage.get(key, items => {
          const err = (typeof chrome !== 'undefined' && chrome?.runtime?.lastError);
          if (err) reject(err);
          else resolve(items ? items[key] : null);
        });
      });
    } catch (e) {
      return null;
    }
  }

  async function storageSet(storage, key, value) {
    if (!storage || typeof storage.set !== 'function') return;
    const payload = { [key]: value };
    const res = storage.set(payload);
    if (res && typeof res.then === 'function') {
      await res;
      return;
    }
    await new Promise((resolve, reject) => {
      storage.set(payload, () => {
        const err = (typeof chrome !== 'undefined' && chrome?.runtime?.lastError);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  class ActionLedger {
    constructor(options = {}) {
      this.storageKey = options.storageKey || 'omni_action_ledger';
      this.debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 50;
      this.storage = options.storage !== undefined
        ? options.storage
        : (typeof chrome !== 'undefined' && chrome?.storage?.local ? chrome.storage.local : null);
      this.autoFlushOnUnload = options.autoFlushOnUnload !== false;

      this._entries = new Map();
      this._journal = [];
      this._pendingActions = new Set();
      this._pendingJournal = [];
      this._debounceTimer = null;
      this._flushPromise = null;

      this._settlementHooks = new Set();
      this._transitionHooks = new Set();

      if (typeof options.onSettled === 'function') {
        this._settlementHooks.add(options.onSettled);
      }
      if (typeof options.onTransition === 'function') {
        this._transitionHooks.add(options.onTransition);
      }

      if (typeof window !== 'undefined' && this.autoFlushOnUnload) {
        this._unloadHandler = () => {
          this.flush().catch(() => {});
        };
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('beforeunload', this._unloadHandler);
          window.addEventListener('pagehide', this._unloadHandler);
        }
      }
    }

    get size() {
      return this._entries.size;
    }

    onSettled(fn) {
      if (typeof fn !== 'function') throw new TypeError('Settlement hook must be a function');
      this._settlementHooks.add(fn);
      return () => this._settlementHooks.delete(fn);
    }

    addSettlementHook(fn) {
      return this.onSettled(fn);
    }

    removeSettlementHook(fn) {
      return this._settlementHooks.delete(fn);
    }

    onTransition(fn) {
      if (typeof fn !== 'function') throw new TypeError('Transition hook must be a function');
      this._transitionHooks.add(fn);
      return () => this._transitionHooks.delete(fn);
    }

    addTransitionHook(fn) {
      return this.onTransition(fn);
    }

    removeTransitionHook(fn) {
      return this._transitionHooks.delete(fn);
    }

    propose(data = {}) {
      const id = data.id || generateId('act');
      if (this._entries.has(id)) {
        throw new Error(`Action with id '${id}' already exists in ledger`);
      }

      const name = data.name || data.action || 'unknown_action';
      const isMutation = isMutationAction(name, data.isMutation);
      const now = Date.now();

      const entry = {
        id,
        name,
        params: clone(data.params || data.args || {}),
        status: ActionStatus.PROPOSED,
        isMutation,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        settledAt: null,
        result: null,
        error: null,
        metadata: clone(data.metadata || {}),
        history: [
          {
            from: null,
            to: ActionStatus.PROPOSED,
            timestamp: now,
            reason: data.reason || 'Proposed'
          }
        ]
      };

      this._entries.set(id, entry);

      const event = {
        eventId: generateId('evt'),
        actionId: id,
        name,
        from: null,
        to: ActionStatus.PROPOSED,
        timestamp: now,
        isSettled: false,
        reason: data.reason || 'Proposed'
      };
      this._journal.push(event);
      this._pendingJournal.push(event);

      for (const hook of this._transitionHooks) {
        try {
          hook(clone(entry), null, ActionStatus.PROPOSED, this);
        } catch (e) {
          console.error('ActionLedger transition hook error:', e);
        }
      }

      this._enqueuePersist(id);
      return clone(entry);
    }

    createAction(data) {
      return this.propose(data);
    }

    proposeBatch(items = []) {
      if (!Array.isArray(items)) throw new TypeError('proposeBatch requires an array of actions');
      return items.map(item => this.propose(item));
    }

    transition(id, nextState, payload = {}) {
      const entry = this._entries.get(id);
      if (!entry) {
        throw new Error(`Action not found: ${id}`);
      }

      const currentState = entry.status;
      const allowed = VALID_TRANSITIONS[currentState];
      if (!allowed || !allowed.includes(nextState)) {
        throw new Error(`Invalid state transition for action '${id}': cannot transition from '${currentState}' to '${nextState}'`);
      }

      const clonedResult = payload.result !== undefined ? clone(payload.result) : undefined;
      const clonedMetadata = payload.metadata ? clone(payload.metadata) : undefined;
      const clonedError = payload.error !== undefined
        ? (payload.error instanceof Error ? payload.error.message : clone(payload.error))
        : undefined;

      const now = Date.now();
      entry.status = nextState;
      entry.updatedAt = now;

      if (nextState === ActionStatus.STARTED && !entry.startedAt) {
        entry.startedAt = now;
      }

      if (clonedResult !== undefined) {
        entry.result = clonedResult;
      }
      if (clonedError !== undefined) {
        entry.error = clonedError;
      }
      if (clonedMetadata) {
        entry.metadata = Object.assign(entry.metadata || {}, clonedMetadata);
      }

      const isSettled = SETTLED_STATES.has(nextState);
      if (isSettled && !entry.settledAt) {
        entry.settledAt = now;
      }

      const transitionRecord = {
        from: currentState,
        to: nextState,
        timestamp: now,
        reason: payload.reason || null,
        result: clonedResult !== undefined ? clone(clonedResult) : undefined,
        error: clonedError !== undefined ? entry.error : undefined
      };
      entry.history.push(transitionRecord);

      const event = {
        eventId: generateId('evt'),
        actionId: id,
        name: entry.name,
        from: currentState,
        to: nextState,
        timestamp: now,
        isSettled,
        reason: payload.reason || null,
        metadata: clonedMetadata !== undefined ? clone(clonedMetadata) : undefined
      };
      this._journal.push(event);
      this._pendingJournal.push(event);

      const entrySnapshot = clone(entry);

      if (isSettled) {
        for (const hook of this._settlementHooks) {
          try {
            hook(entrySnapshot, this);
          } catch (e) {
            console.error('ActionLedger settlement hook error:', e);
          }
        }
      }

      for (const hook of this._transitionHooks) {
        try {
          hook(entrySnapshot, currentState, nextState, this);
        } catch (e) {
          console.error('ActionLedger transition hook error:', e);
        }
      }

      this._enqueuePersist(id);
      return entrySnapshot;
    }

    approve(id, payload = {}) {
      return this.transition(id, ActionStatus.APPROVED, payload);
    }

    start(id, payload = {}) {
      return this.transition(id, ActionStatus.STARTED, payload);
    }

    complete(id, result, payload = {}) {
      return this.transition(id, ActionStatus.COMPLETED, { result, ...payload });
    }

    fail(id, error, payload = {}) {
      return this.transition(id, ActionStatus.FAILED, { error, ...payload });
    }

    skip(id, reason, payload = {}) {
      return this.transition(id, ActionStatus.SKIPPED, { reason, ...payload });
    }

    markUnknown(id, reasonOrError, payload = {}) {
      return this.transition(id, ActionStatus.UNKNOWN, {
        reason: reasonOrError,
        error: reasonOrError,
        ...payload
      });
    }

    resolveUncertain(id, resolvedState, payload = {}) {
      const entry = this._entries.get(id);
      if (!entry) {
        throw new Error(`Action not found: ${id}`);
      }
      if (entry.status !== ActionStatus.UNKNOWN) {
        throw new Error(`Action '${id}' is not in unknown state (current: '${entry.status}')`);
      }
      const allowedResolutions = [ActionStatus.COMPLETED, ActionStatus.FAILED, ActionStatus.SKIPPED];
      if (!allowedResolutions.includes(resolvedState)) {
        throw new Error(`Cannot resolve uncertain mutation to '${resolvedState}', must be completed, failed, or skipped`);
      }
      return this.transition(id, resolvedState, {
        reason: payload.reason || 'Resolved from unknown',
        ...payload
      });
    }

    get(id) {
      const entry = this._entries.get(id);
      return entry ? clone(entry) : null;
    }

    has(id) {
      return this._entries.has(id);
    }

    getAll() {
      return Array.from(this._entries.values()).map(clone);
    }

    getByStatus(status) {
      return this.query({ status });
    }

    getJournal() {
      return this._journal.map(clone);
    }

    query(criteria = {}) {
      const results = [];
      const {
        status,
        isMutation,
        name,
        tool,
        sessionId,
        tabId,
        batchId,
        since,
        until
      } = criteria;

      const statuses = status ? (Array.isArray(status) ? status : [status]) : null;
      const targetName = name || tool;

      for (const entry of this._entries.values()) {
        if (!entry || typeof entry !== 'object') continue;
        if (statuses && !statuses.includes(entry.status)) continue;
        if (typeof isMutation === 'boolean' && entry.isMutation !== isMutation) continue;
        if (targetName && entry.name !== targetName) continue;
        if (sessionId && entry.metadata?.sessionId !== sessionId) continue;
        if (tabId !== undefined && entry.metadata?.tabId !== tabId && entry.params?.tabId !== tabId) continue;
        if (batchId && entry.metadata?.batchId !== batchId) continue;
        if (since !== undefined && entry.createdAt < since) continue;
        if (until !== undefined && entry.createdAt > until) continue;

        results.push(clone(entry));
      }

      return results;
    }

    queryUncertainMutations(criteria = {}) {
      const onlyMutations = criteria.onlyMutations !== false;
      return this.query({
        ...criteria,
        status: ActionStatus.UNKNOWN,
        ...(onlyMutations ? { isMutation: true } : {})
      });
    }

    getUncertainMutations(criteria = {}) {
      return this.queryUncertainMutations(criteria);
    }

    hasUncertainMutations(criteria = {}) {
      return this.queryUncertainMutations(criteria).length > 0;
    }

    _enqueuePersist(id) {
      this._pendingActions.add(id);

      if (this.debounceMs <= 0) {
        this.flush().catch(err => {
          console.error('ActionLedger sync flush failed:', err);
        });
        return;
      }

      if (!this._debounceTimer) {
        this._debounceTimer = setTimeout(() => {
          this._debounceTimer = null;
          this.flush().catch(err => {
            console.error('ActionLedger debounced flush failed:', err);
          });
        }, this.debounceMs);
      }
    }

    async flush() {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }

      let actionIdsToPersist = [];
      let journalToPersist = [];

      this._flushPromise = (this._flushPromise || Promise.resolve())
        .then(async () => {
          if (this._pendingActions.size === 0 && this._pendingJournal.length === 0) {
            return;
          }

          actionIdsToPersist = Array.from(this._pendingActions);
          journalToPersist = this._pendingJournal.slice();
          this._pendingActions.clear();
          this._pendingJournal = [];

          await this._persistToStorage(actionIdsToPersist, journalToPersist);
        })
        .catch(err => {
          this._flushPromise = null;
          for (const id of actionIdsToPersist) {
            this._pendingActions.add(id);
          }
          this._pendingJournal = journalToPersist.concat(this._pendingJournal);
          throw err;
        });

      return this._flushPromise;
    }

    async _persistToStorage(actionIds, journalEvents) {
      if (!this.storage) return;

      const existing = await storageGet(this.storage, this.storageKey);
      let record = {
        actions: {},
        journal: [],
        updatedAt: Date.now()
      };

      if (existing && typeof existing === 'object') {
        if (Array.isArray(existing)) {
          for (const item of existing) {
            if (item?.id) record.actions[item.id] = item;
          }
        } else {
          record.actions = (existing.actions && typeof existing.actions === 'object' && !Array.isArray(existing.actions)) ? { ...existing.actions } : {};
          record.journal = Array.isArray(existing.journal) ? existing.journal.slice() : [];
        }
      }

      // Append-only journal addition
      if (journalEvents.length > 0) {
        record.journal.push(...journalEvents);
      }

      // Update current state of persisted actions
      for (const id of actionIds) {
        const current = this._entries.get(id);
        if (current) {
          record.actions[id] = clone(current);
        }
      }

      record.updatedAt = Date.now();
      await storageSet(this.storage, this.storageKey, record);
    }

    async load() {
      if (!this.storage) return this;
      const data = await storageGet(this.storage, this.storageKey);
      if (!data) return this;

      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && typeof item === 'object' && Array.isArray(item.history) && item.id) {
            this._entries.set(item.id, clone(item));
          }
        }
      } else if (typeof data === 'object') {
        if (data.actions && typeof data.actions === 'object' && !Array.isArray(data.actions)) {
          for (const [id, item] of Object.entries(data.actions)) {
            if (item && typeof item === 'object' && Array.isArray(item.history)) {
              this._entries.set(item.id || id, clone(item));
            }
          }
        }
        if (Array.isArray(data.journal)) {
          this._journal = data.journal.filter(item => item && typeof item === 'object').map(clone);
        }
      }
      return this;
    }

    async clear() {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      this._entries.clear();
      this._journal = [];
      this._pendingActions.clear();
      this._pendingJournal = [];
      if (this.storage) {
        await storageSet(this.storage, this.storageKey, {
          actions: {},
          journal: [],
          updatedAt: Date.now()
        });
      }
    }

    dispose() {
      if (this._debounceTimer) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      if (typeof window !== 'undefined' && this._unloadHandler && typeof window.removeEventListener === 'function') {
        window.removeEventListener('beforeunload', this._unloadHandler);
        window.removeEventListener('pagehide', this._unloadHandler);
      }
      this._settlementHooks.clear();
      this._transitionHooks.clear();
      this._pendingActions.clear();
      this._pendingJournal = [];
    }
  }

  const api = {
    ActionLedger,
    ActionStatus,
    VALID_TRANSITIONS,
    SETTLED_STATES,
    isMutationAction
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OmniSidebarLedger = api;
    root.ActionLedger = ActionLedger;
    root.ActionStatus = ActionStatus;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this)));
