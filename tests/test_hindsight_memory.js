/* Exercise the actual vendored SDK over HTTP; the engine responses are contract fixtures. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
require('../extensions/chrome/vendor/hindsight/hindsight-client.js');
const { HindsightMemory, connection } = require('../extensions/chrome/hindsight-memory.js');
class Archive {
  constructor() { this.records = new Map(); this.state = new Map(); this.clock = 1; }
  async getState(key) { return this.state.get(key); }
  async setState(key, value) { this.state.set(key, { ...value, key }); }
  async clearState(key) { this.state.delete(key); }
  async states(prefix) { return [...this.state.values()].filter(state => state.key.startsWith(prefix)); }
  async save(input, asset) {
    const memory = { id: crypto.randomUUID(), createdAt: 1, capturedAt: 1, updatedAt: ++this.clock, kind: 'note', url: '',
      title: input.title, tags: [], summary: '', note: '', content: input.content || '', hasAsset: !!asset, ...input };
    this.records.set(memory.id, memory); return { memory: { ...memory }, deduplicated: false };
  }
  async read({ id, start = 0, length = 12000 }) {
    const record = this.records.get(id); if (!record) throw new Error('Not found');
    const { content, ...memory } = record;
    return { memory, content: content.slice(start, start + length), nextStart: start + length < content.length ? start + length : null };
  }
  async asset() { return { dataUrl: 'data:image/png;base64,cGl4ZWxz' }; }
  async search({ offset = 0, limit = 20 } = {}) {
    const records = [...this.records.values()];
    return { memories: records.slice(offset, offset + limit), total: records.length, nextOffset: offset + limit < records.length ? offset + limit : null };
  }
  async update({ id, ...changes }) { Object.assign(this.records.get(id), changes, { updatedAt: ++this.clock }); return { memory: { ...this.records.get(id) } }; }
  async delete({ id }) { return { deleted: this.records.delete(id) }; }
}
(async () => {
  const requests = [], documents = new Map(); let failRetain = false, failDelete = false, missingDelete = false, engineOffline = false;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    requests.push({ url: req.url, method: req.method, body, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    const respond = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    if (engineOffline) return respond(503, { detail: 'offline' });
    if (req.url.endsWith('/version')) return respond(200, { version: '0.10.3' });
    if (req.url.endsWith('/memories') && req.method === 'POST') {
      if (failRetain) return respond(503, { detail: 'model not configured' });
      for (const item of body.items) documents.set(item.document_id, item);
      return respond(200, { success: true, memories: [] });
    }
    if (req.url.endsWith('/recall')) return respond(200, { results: [
      // External and orphan facts must not enter the browser's recalled evidence.
      { id: 'foreign', text: 'private information from another application', document_id: 'unknown' },
      ...[...documents.keys()].map(document_id => ({ id: `fact-${document_id}`, document_id, text: 'Electricity can be collected from sunlight.', scores: { final: 0.9 } }))
    ] });
    if (req.method === 'DELETE') {
      if (failDelete) return respond(503, { detail: 'not found in cache but deletion failed' });
      const id = decodeURIComponent(req.url.split('/').pop());
      documents.delete(id); return respond(missingDelete ? 404 : 200, missingDelete ? { detail: 'Document not found' } : { deleted: true });
    }
    return respond(404, { detail: req.url });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const store = new Archive(), secrets = {};
    const sessions = { get: async () => secrets, set: async values => Object.assign(secrets, values) };
    let engine = new HindsightMemory(store, { sessions });
    const configs = await Promise.all([engine.config(), engine.config(), engine.config()]);
    assert.equal(new Set(configs.map(config => config.bank)).size, 1, 'Concurrent first reads must share one isolated bank');
    const original = 'Solar panels retain energy. '.repeat(1200);
    const local = await engine.save({ title: 'Energy research', content: original, url: 'https://example.com/study' });
    assert.equal(local.indexed, false); assert.match(local.warning, /Connect Hindsight/); assert.equal(requests.length, 0);
    await assert.rejects(engine.search({ query: 'harvest electricity' }), /not connected/);
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com?key=secret', 'file:///tmp'])
      assert.throws(() => connection({ endpoint: url, bank: 'test', apiKey: '' }));
    await engine.configure({ endpoint, bank: 'browser-bank', apiKey: 'session-only-secret' });
    assert.equal((await engine.sync()).indexed, 1);
    const retain = requests.find(request => request.url.endsWith('/memories'));
    assert.equal(retain.authorization, 'Bearer session-only-secret');
    assert.equal(retain.body.items[0].document_id, local.memory.id);
    assert.equal(retain.body.items[0].update_mode, 'replace');
    assert.equal(retain.body.async, false); assert.ok(retain.body.items[0].content.endsWith(original));
    assert.equal(retain.body.items[0].metadata.url, 'https://example.com/study');
    assert.ok(!JSON.stringify([...store.state.values()]).includes('session-only-secret'));
    let recalled = await engine.search({ query: 'harvest electricity', limit: 5, recall: true });
    assert.equal(recalled.engine, 'Hindsight'); assert.equal(recalled.memories.length, 1);
    assert.equal(recalled.memories[0].id, local.memory.id); assert.match(recalled.memories[0].excerpt, /sunlight/);
    const recall = requests.find(request => request.url.endsWith('/recall'));
    assert.equal(recall.body.query, 'harvest electricity'); assert.equal(recall.body.budget, 'low');
    assert.equal(recall.body.max_tokens, 2400); assert.equal(recall.body.tags_match, 'all_strict');
    assert.deepEqual(recall.body.tags, ['omnibrowser']);
    // A recreated service worker uses the same target and index markers.
    engine = new HindsightMemory(store, { sessions });
    assert.equal((await engine.search({ query: 'electricity' })).memories[0].id, local.memory.id);
    await assert.rejects(engine.configure({ endpoint, bank: 'another-bank', apiKey: '' }), /another memory bank/);
    failRetain = true;
    const updated = await engine.update({ id: local.memory.id, note: 'Corrected after review' });
    assert.equal(updated.indexed, false); assert.equal((await engine.status()).pending, 1);
    assert.equal((await engine.search({ query: 'electricity' })).memories.length, 0, 'Failed updates must not recall stale facts');
    failRetain = false; await engine.sync();
    assert.match(documents.get(local.memory.id).content, /Corrected after review/);
    failDelete = true;
    await assert.rejects(engine.delete({ id: local.memory.id }), /could not confirm deletion/);
    assert.ok(store.records.has(local.memory.id));
    failDelete = false; missingDelete = true;
    assert.equal((await engine.delete({ id: local.memory.id })).deleted, true);
    assert.equal((await engine.status()).indexed, 0);
    assert.equal((await store.states('hindsight-index:')).length, 0);
    missingDelete = false;
    const image = await engine.save({ title: 'Architecture sketch', content: '', kind: 'image' }, new Blob(['pixels']));
    assert.equal(typeof documents.get(image.memory.id).content, 'string', 'Image bytes stay local by default');
    await engine.configure({ endpoint, bank: 'browser-bank', apiKey: 'session-only-secret', images: true });
    assert.equal((await engine.status()).pending, 1); await engine.sync();
    assert.equal(documents.get(image.memory.id).content[1].type, 'image');
    assert.equal(documents.get(image.memory.id).content[1].source.data, 'cGl4ZWxz');
    engineOffline = true;
    const offlineSave = await engine.save({ title: 'Offline note', content: 'Recoverable original' });
    assert.equal(offlineSave.indexed, false); assert.ok(store.records.has(offlineSave.memory.id));
    await assert.rejects(engine.search({ query: 'electricity' }), /unavailable/);
    const before = requests.length; await engine.search({ query: 'energy', archive: true });
    assert.equal(requests.length, before, 'Archive browsing does not make engine requests');
    engineOffline = false; await engine.sync(); await engine.disconnect();
    await assert.rejects(engine.search({ query: 'electricity' }), /not connected/);
    // Pausing recall still allows deletion from the engine's original bank.
    await engine.delete({ id: image.memory.id }); assert.ok(!documents.has(image.memory.id));
    const vendor = fs.readFileSync('extensions/chrome/vendor/hindsight/hindsight-client.js', 'utf8');
    const provenance = JSON.parse(fs.readFileSync('extensions/chrome/vendor/hindsight/provenance.json'));
    const originalCode = vendor.slice(vendor.indexOf('"use strict";'), vendor.lastIndexOf('\nglobalThis.OmniHindsightSDK'));
    assert.equal(crypto.createHash('sha256').update(originalCode).digest('hex'), provenance.upstreamSha256);
    console.log('Official Hindsight SDK: retain/recall/delete HTTP contracts, provenance, session secrets, stale suppression, offline recovery and optional visual memory passed.');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
