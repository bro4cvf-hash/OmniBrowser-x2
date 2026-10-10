/* Isolated, bounded research sessions. No browser writes or recursive delegation. */
(function(root) {
  const READ_TOOLS = new Set(['browser_context', 'current_tab', 'list_tabs', 'read_page', 'read_pages',
    'form_inspect', 'form_verify', 'search_web', 'fetch_web', 'memory_search', 'memory_read', 'memory_inspect', 'files_roots', 'files_locations',
    'files_find_folder', 'files_list', 'files_search', 'files_extract', 'files_read_many', 'context_read', 'mcp_search']);
  const canRead = item => READ_TOOLS.has(item.function?.name) ||
    (!!item.mcpServer && item.readOnly === true);
  class Subagents {
    constructor({ state, run, signal, onEvent = () => {} }) {
      this.sessions = new Map();
      for (const item of (Array.isArray(state) ? state : []).slice(0, 8)) {
        if (typeof item?.id === 'string' && /^agent-[a-zA-Z0-9-]+$/.test(item.id) &&
            ['research', 'verify'].includes(item.role) && Array.isArray(item.history)) {
          this.sessions.set(item.id, structuredClone({ ...item, status: item.status === 'running' ? 'interrupted' : item.status }));
        }
      }
      this.run = run; this.signal = signal; this.onEvent = onEvent;
      this.active = new Set(); this.invocations = 0;
    }
    state() { return structuredClone([...this.sessions.values()]); }
    read({ taskId, index, start = 0, length = 12000 }) {
      const session = this.sessions.get(taskId);
      if (!session) throw new Error('Unknown sub-agent task ID.');
      if (!Number.isSafeInteger(index) || !session.history[index]) throw new Error('Choose a valid sub-agent archive index.');
      if (!Number.isSafeInteger(start) || start < 0) throw new Error('start must be a non-negative character offset.');
      const entry = session.history[index];
      const text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry);
      const size = Math.max(1, Math.min(24000, Math.floor(Number(length) || 12000)));
      return { taskId, index, role: entry.role, content: text.slice(start, start + size), totalCharacters: text.length,
        nextStart: start + size < text.length ? start + size : null };
    }
    async delegate({ task, role = 'research', taskId }) {
      this.signal?.throwIfAborted();
      if (typeof task !== 'string' || !task.trim() || task.length > 12000) throw new Error('Provide a sub-agent task of 1 to 12000 characters.');
      if (!['research', 'verify'].includes(role)) throw new Error('Choose research or verify.');
      if (this.active.size >= 3) throw new Error('Three sub-agents are already running. Resume after their results return.');
      if (this.invocations >= 16) throw new Error('Sub-agent invocation budget reached for this run. Continue with existing results.');
      let session;
      if (taskId !== undefined) {
        session = this.sessions.get(taskId);
        if (!session) throw new Error('Unknown sub-agent task ID.');
        if (this.active.has(taskId)) throw new Error('This sub-agent is already running.');
        if (session.role !== role) throw new Error('Resume using the original sub-agent role.');
      } else {
        if (this.sessions.size >= 8) throw new Error('Eight sub-agent sessions already exist. Reuse a returned task ID.');
        const id = 'agent-' + (root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
        session = { id, role, history: [], contextState: {}, status: 'pending' };
        this.sessions.set(id, session);
      }
      const controller = new AbortController();
      const stop = () => controller.abort(this.signal.reason);
      this.signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => controller.abort(new Error('Sub-agent time limit reached.')), 120000);
      const initialLength = session.history.length;
      this.invocations++; this.active.add(session.id); session.status = 'running'; delete session.error;
      this.onEvent({ type: 'progress', text: `${role === 'verify' ? 'Verification' : 'Research'} agent started · ${session.id}` });
      try {
        session.history = await this.run({ session, task, signal: controller.signal, onCheckpoint: event => {
          session.history = structuredClone(event.history); session.contextState = structuredClone(event.contextState || {});
        } });
        controller.signal.throwIfAborted();
        session.status = 'complete';
      } catch (error) {
        session.status = controller.signal.aborted ? 'interrupted' : 'failed';
        session.error = String(error.message || error).slice(0, 1000);
        if (this.signal?.aborted) this.signal.throwIfAborted();
      } finally {
        clearTimeout(timer); this.signal?.removeEventListener('abort', stop); this.active.delete(session.id);
        this.onEvent({ type: 'progress', text: `${role === 'verify' ? 'Verification' : 'Research'} agent ${session.status} · ${session.id}` });
      }
      const reportIndex = session.history.findLastIndex((entry, index) => index >= initialLength && entry.role === 'assistant' && !entry.tool_calls?.length);
      const report = session.history[reportIndex]?.content || '';
      return { taskId: session.id, role, status: session.status, completed: session.status === 'complete',
        report: String(report).slice(0, 6000), truncated: String(report).length > 6000,
        ...(session.status !== 'complete' ? { error: session.error } : {}),
        archiveLength: session.history.length, reportIndex };
    }
  }
  const api = { Subagents, canRead };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmniSubagents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
