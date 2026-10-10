(function () {
/*
 * Source adaptations for review; this file is not loaded by OmniBrowser.
 *
 * snapshotComparisonText is a JavaScript port of snapshot_comparison_text:
 * https://github.com/vercel-labs/agent-browser/blob/44af39842650f0bb9c1afb7354df9a82921d4f09/cli/src/native/diff.rs
 * Licensed under Apache-2.0. See LICENSE-agent-browser.
 * Modification: Rust iterator implementation replaced with JavaScript indexing.
 *
 * normalizeCachedActions is adapted from Browserbase Stagehand:
 * https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/cacheService.ts
 * Copyright (c) 2024 Browserbase Inc. MIT License.
 * See LICENSE-stagehand.
 * Modification: TypeScript types removed and CommonJS exports added.
 */
'use strict';

// Compare page content without generated IDs causing false differences.
// Keep the original snapshot, including refs, for every action.
function snapshotComparisonText(tree) {
  let output = '';
  let quoted = false;
  for (let index = 0; index < tree.length; index++) {
    const character = tree[index];
    if (quoted && character === '\\') {
      output += character;
      if (index + 1 < tree.length) output += tree[++index];
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '[' && output.endsWith(' ')) {
      let end = index + 1;
      while (end < tree.length && tree[end] !== ']' && tree[end] !== '\n') end++;
      if (tree[end] === ']') {
        const fields = tree.slice(index + 1, end).split(', ');
        const retained = fields.filter(field => !/^ref=e[0-9]+$/.test(field));
        if (retained.length !== fields.length) {
          output = retained.length ? output + '[' + retained.join(', ') + ']' : output.slice(0, -1);
          index = end;
          continue;
        }
      }
    }
    output += character;
  }
  return output;
}

// This normalizes cache entry shape. It does not authorize or validate actions.
function normalizeCachedActions(value) {
  if (!Array.isArray(value)) return [];
  const actions = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.selector !== 'string' || entry.selector.length === 0) continue;
    actions.push({
      selector: entry.selector,
      description: typeof entry.description === 'string' ? entry.description : '',
      method: typeof entry.method === 'string' ? entry.method : undefined,
      arguments: Array.isArray(entry.arguments) ? entry.arguments.filter(arg => typeof arg === 'string') : [],
    });
  }
  return actions;
}

const reusableApi = { snapshotComparisonText, normalizeCachedActions };
if (typeof module !== 'undefined' && module.exports) module.exports = reusableApi;
else globalThis.OmniReuseKernels = reusableApi;

})();
