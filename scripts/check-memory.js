/* Live smoke check: actual Hindsight storage, embedding retrieval and deletion.
 * Run with a local-search engine to avoid paid calls. Uses and removes an isolated bank. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
require('../extensions/chrome/vendor/hindsight/hindsight-client.js');
(async () => {
  const client = new OmniHindsightSDK.HindsightClient({ baseUrl: process.argv[2] || 'http://127.0.0.1:8888', maxAttempts: 1 });
  const bank = `omnibrowser-check-${crypto.randomUUID()}`, id = crypto.randomUUID();
  try {
    const version = await client.getVersion({ signal: AbortSignal.timeout(10000) });
    const retained = await client.retain(bank, 'Solar panels convert sunlight into electrical power that can be stored in batteries.', {
      documentId: id, updateMode: 'replace', async: false, tags: ['omnibrowser'],
      metadata: { title: 'Local smoke check', url: 'https://example.com/solar' }, signal: AbortSignal.timeout(90000)
    });
    const recall = await client.recall(bank, 'How can we harvest electricity from sunshine?', {
      types: ['world', 'experience'], budget: 'low', maxTokens: 2400, includeEntities: false,
      tags: ['omnibrowser'], tagsMatch: 'all_strict', signal: AbortSignal.timeout(30000)
    });
    assert.ok(recall.results.some(fact => fact.document_id === id && /sunlight/i.test(fact.text)), 'Live engine must return the saved source');
    await client.deleteDocument(bank, id, { signal: AbortSignal.timeout(30000) });
    const after = await client.recall(bank, 'Solar panels', { budget: 'low', maxTokens: 1000, signal: AbortSignal.timeout(30000) });
    assert.ok(!after.results.some(fact => fact.document_id === id), 'Deleted source must not be recalled');
    console.log(JSON.stringify({ version, retained: !!retained, recalled: recall.results.length, deletionVerified: true }, null, 2));
  } finally {
    await client.deleteBank(bank, { signal: AbortSignal.timeout(30000) });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
