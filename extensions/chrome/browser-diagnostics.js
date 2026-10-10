/* Event collection adapted to raw CDP from Chrome DevTools MCP PageCollector.ts
 * f08dbe152502, Copyright 2025 Google LLC, Apache-2.0.
 * Modification: bounded plain JSON records, no Puppeteer/DevTools dependency.
 * See vendor/browser-reuse/NOTICE.md and LICENSE-devtools.
 */
(function (root) {
  'use strict';
  const safeUrl = raw => { try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; } catch { return ''; } };
  class Collector {
    constructor(limit = 200) { this.limit = limit; this.generation = 0; this.sequence = 0; this.network = new Map(); this.console = []; this.active = false; }
    event(method, params = {}) {
      if (!this.active) return;
      if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
        this.generation++;
        // The navigation request can arrive before frameNavigated. Keep its loader.
        for (const [id, item] of this.network) {
          if (!params.frame?.loaderId || item.loaderId !== params.frame.loaderId) this.network.delete(id);
          else item.generation = this.generation;
        }
        this.console = []; return;
      }
      if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded') {
        const entry = params.entry || params.exceptionDetails || params;
        const text = entry.text || entry.exception?.description || (params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ');
        this.console.push({ id: ++this.sequence, generation: this.generation,
          level: method === 'Runtime.exceptionThrown' ? 'error' : entry.level || params.type || 'log', text: String(text).slice(0, 2000), url: safeUrl(entry.url), observedAt: Date.now() });
        if (this.console.length > this.limit) this.console.shift();
      }
      if (method === 'Network.requestWillBeSent') {
        // Redirects replace the record for a CDP requestId; retain the prior status.
        this.network.delete(params.requestId);
        this.network.set(params.requestId, { id: ++this.sequence, requestId: params.requestId, generation: this.generation,
          url: safeUrl(params.request?.url), method: params.request?.method, type: params.type, loaderId: params.loaderId,
          state: 'pending', redirectStatus: params.redirectResponse?.status, observedAt: Date.now() });
        while (this.network.size > this.limit) this.network.delete(this.network.keys().next().value);
      }
      const item = this.network.get(params.requestId);
      if (item && method === 'Network.responseReceived') Object.assign(item, { status: params.response?.status, mimeType: params.response?.mimeType, url: safeUrl(params.response?.url) });
      if (item && method === 'Network.loadingFinished') Object.assign(item, { state: 'complete', bytes: params.encodedDataLength });
      if (item && method === 'Network.loadingFailed') Object.assign(item, { state: params.canceled ? 'canceled' : 'failed', error: String(params.errorText || '').slice(0, 500) });
    }
    read({ kind = 'all', failuresOnly = false, afterId = 0, limit = 100 } = {}) {
      if (!['all', 'console', 'network'].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(afterId) || afterId < 0) throw new Error('Invalid diagnostics filter');
      const network = [...this.network.values()].filter(item => item.id > afterId && (!failuresOnly || item.state === 'failed' || item.state === 'canceled' || item.status >= 400));
      const messages = this.console.filter(item => item.id > afterId && (!failuresOnly || ['error', 'warning', 'warn'].includes(item.level)));
      return { capturing: this.active, generation: this.generation, network: kind === 'console' ? [] : network.slice(-limit),
        console: kind === 'network' ? [] : messages.slice(-limit), truncated: network.length > limit || messages.length > limit,
        hint: 'Only events captured after diagnostics_start are available. URLs omit queries; bodies, headers and cookies are not collected.' };
    }
  }
  const api = { Collector, safeUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OmniDiagnostics = api;
})(globalThis);
