/* Persistent task checkpoints and write-ahead action records. No provider secrets. */
(function (root) {
  'use strict';
  const ACTIVE = new Set(['starting', 'running', 'waiting']);
  const READ_ONLY = new Set(['browser_context', 'current_tab', 'list_tabs', 'read_page', 'read_pages', 'verify_task', 'diagnostics_start', 'diagnostics_read', 'diagnostics_stop', 'downloads_status', 'recipe_list',
    'form_inspect', 'form_verify', 'search_web', 'fetch_web', 'files_roots', 'files_locations',
    'files_find_folder', 'files_list', 'files_search', 'files_extract', 'files_read_many',
    'memory_search', 'memory_read', 'memory_inspect', 'context_read', 'mcp_search', 'wait_for', 'captcha_status']);
  function isWrite(name, descriptor) {
    if (name.startsWith('mcp__')) return descriptor?.readOnly !== true && descriptor?.annotations?.readOnlyHint !== true;
    return !READ_ONLY.has(name) && !['update_plan', 'record_result', 'request_user_input'].includes(name);
  }
  function recoveryPrompt(record, accessMode) {
    const uncertain = (record.journal || []).filter(item => item.status === 'unknown' || item.status === 'dispatching');
    return `Recover the interrupted task: ${record.goal || record.prompt}\nInspect the original tab and relevant destinations first. ` +
      'Completed actions remain in place. Do not repeat submissions or other uncertain writes. ' +
      (uncertain.length ? (accessMode === 'full'
        ? 'The following actions have uncertain outcomes. Inspect their live destinations automatically, do not replay them, and continue other remaining work under the existing user instructions: '
        : 'The following actions have uncertain outcomes. Read the live destination, report what is observed and wait for the user to review before making further changes: ') +
        JSON.stringify(uncertain.map(item => ({ name: item.name, tabId: item.tabId, at: item.at }))) :
        'Check saved evidence and current state before continuing remaining work.');
  }
  function interrupted(record) {
    return { ...record, status: 'unknown', activity: 'Task interrupted. Reopen the sidebar and use Resume to inspect the destination before continuing.',
      updatedAt: Date.now(), journal: (record.journal || []).map(item =>
        item.status === 'dispatching' ? { ...item, status: 'unknown' } : item) };
  }
  class TaskSession {
    constructor(storage, record) {
      this.storage = storage; this.record = structuredClone(record); this.queue = Promise.resolve();
      // Older versions recorded even a missing target as an unknown write.
      // Repair only the exact pre-activation error for the journaled target.
      for (const item of this.record.journal || []) {
        const prefix = /^Action timeout after \d+ms waiting for '/.exec(item.error || '');
        if (item.status === 'unknown' && ['click', 'fill', 'select_option', 'set_checked'].includes(item.name) &&
            item.target && prefix && item.error.slice(prefix[0].length) === `${item.target}': element not found`) {
          item.status = 'failed';
        }
      }
    }
    save(patch = {}) {
      Object.assign(this.record, structuredClone(patch), { updatedAt: Date.now() });
      const snapshot = structuredClone(this.record);
      const next = this.queue.then(() => this.storage.set({ ['omniTask:' + snapshot.id]: snapshot }));
      this.queue = next; // A failed checkpoint must stop writes until recovery.
      return next;
    }
    async begin(name, args, descriptor) {
      const item = { id: crypto.randomUUID(), name, tabId: args?.tabId, at: Date.now(),
        target: String(args?.selector || args?.ref || args?.clickSelector || '').slice(0, 2000),
        destination: typeof args?.url === 'string' ? args.url.slice(0, 2000) : null,
        write: isWrite(name, descriptor), status: 'dispatching' };
      this.record.journal ||= [];
      this.record.journal.push(item);
      await this.save();
      return item.id;
    }
    async settle(id, result, error) {
      const item = this.record.journal.find(entry => entry.id === id);
      if (!item) throw new Error('Action record missing');
      // A transport exception cannot establish whether a write reached the site.
      item.status = error && item.write && error.notDispatched !== true ? 'unknown' : error || result?.error || result?.completed === false || result?.failed_index != null ? 'failed' : 'complete';
      if (!error && result?.results?.some(entry => entry.error || entry.skipped)) item.status = 'partial';
      if (error) item.error = String(error.message || error).slice(0, 1000);
      await this.save();
    }
    get uncertainWrites() { return (this.record.journal || []).filter(item => item.write && ['dispatching', 'unknown'].includes(item.status)); }
    get unreviewedWrites() { return this.uncertainWrites.filter(item => !item.reviewedAt); }
    async acknowledgeReview({ source = 'user', ids } = {}) {
      for (const item of this.unreviewedWrites) {
        if (ids && !ids.includes(item.id)) continue;
        item.reviewedAt = Date.now();
        item.reviewSource = source;
      }
      // Review records permission to continue; it is not evidence of server acceptance.
      await this.save();
    }
  }
  const api = { TaskSession, ACTIVE, interrupted, recoveryPrompt, isWrite };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmniTaskSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
