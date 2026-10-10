/* Snapshot comparison adapted from agent-browser 44af39842650, Apache-2.0.
 * See vendor/browser-reuse/NOTICE.md and LICENSE-agent-browser.
 * Modification: compare OmniBrowser JSON observations; bounded per-tab baselines.
 */
(function (root) {
  'use strict';
  const kernels = typeof module !== 'undefined' && module.exports ? require('./vendor/browser-reuse/kernels.js') : root.OmniReuseKernels;
  class Observations {
    constructor() { this.tabs = new Map(); this.sequence = 0; this.epoch = Math.random().toString(36).slice(2); }
    clear(tabId) { this.tabs.delete(tabId); }
    capture(tabId, page, options = {}) {
      const snapshotId = `obs-${this.epoch}-${++this.sequence}`;
      const full = { ...page, snapshotId, mode: 'full' };
      const documents = JSON.stringify((page.frames || [page]).map(frame => [frame.frameId || 0, frame.documentId]));
      const scope = JSON.stringify([options.selector || '', options.interactiveOnly || false,
        options.frameId ?? null, options.depth ?? null, options.offset || 0, options.textOffset || 0, options.maxElements || 300, options.maxChars || 12000]);
      const previous = this.tabs.get(tabId);
      this.tabs.delete(tabId);
      // Keep at most 32 bounded observations. Eviction causes an explicit full fallback.
      if (JSON.stringify(page).length <= 512000) this.tabs.set(tabId, { snapshotId, documents, scope, page });
      while (this.tabs.size > 32) this.tabs.delete(this.tabs.keys().next().value);
      if (!options.sinceSnapshotId) return full;
      if (!(page.frames || [page]).every(frame => frame.documentId) || !previous || previous.snapshotId !== options.sinceSnapshotId || previous.documents !== documents || previous.scope !== scope)
        return { ...full, baselineMissing: true };
      const oldText = previous.page.text || '', text = page.text || '';
      let start = 0, endBefore = oldText.length, endAfter = text.length;
      while (start < endBefore && start < endAfter && oldText[start] === text[start]) start++;
      while (endBefore > start && endAfter > start && oldText[endBefore - 1] === text[endAfter - 1]) { endBefore--; endAfter--; }
      const normalize = value => {
        if (Array.isArray(value)) return value.map(normalize);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).filter(([key]) => !['ref', 'elements', 'observedAt', 'generation'].includes(key))
          .map(([key, item]) => [key, normalize(item)]));
      };
      const content = value => JSON.stringify(normalize(value)) + '\n' + kernels.snapshotComparisonText(
        (value.elements || []).map(({ ref, ...element }) => '- control ' + JSON.stringify(element) +
          (ref ? ' [ref=' + ref.replace(/^@(?:f\d+)?e/, 'e') + ']' : '')).join('\n'));
      const changed = content(previous.page) !== content(page);
      const { text: omitted, ...metadata } = full;
      metadata.frames = (full.frames || []).map(frame => frame.frameId === 0 ? Object.fromEntries(Object.entries(frame).filter(([key]) => key !== 'text')) : frame);
      return { ...metadata, mode: 'delta', baselineId: previous.snapshotId, changed,
        textPatch: { start, deleteCount: endBefore - start, insert: text.slice(start, endAfter) },
        // Fresh target refs are always supplied, even for an unchanged page.
        hint: 'Apply textPatch to baseline text. Elements and frames are current. Use read_page without sinceSnapshotId for full text.' };
    }
  }
  const api = { Observations, snapshotComparisonText: kernels?.snapshotComparisonText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.OmniObservations = api;
})(globalThis);
