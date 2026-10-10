/* Durable, indexed local memory. Large content and image bytes never enter the list index. */
(function (root) {
  const MAX_TEXT = 100000, MAX_ASSET = 8 * 1024 * 1024, MAX_LIBRARY_BYTES = 128 * 1024 * 1024;
  const STOP = new Set('a an and are as at be been but by can could do for from had has have how i in is it me my of on or our please remember save saved that the their these this to use was we website what with would you your'.split(' '));
  function tokens(text) {
    return [...new Set((String(text).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{2,64}/gu) || [])
      .filter(word => !STOP.has(word)).map(word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))];
  }
  function text(value, max, field, required = false) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
      throw new Error(`${field} must be ${required ? '1' : '0'} to ${max} characters.`);
    return value.trim();
  }
  function sourceUrl(raw) {
    if (!raw) return '';
    const url = new URL(text(raw, 4000, 'Source URL'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Memory sources must be HTTP(S) URLs without credentials.');
    url.hash = ''; return url.href;
  }
  function tags(raw = []) {
    if (!Array.isArray(raw) || raw.length > 12) throw new Error('Use at most 12 tags.');
    return [...new Set(raw.map(tag => text(tag, 40, 'Tag', true).toLowerCase()))];
  }
  function chunksFor(record, content) {
    const chunks = [{ id: `${record.id}:meta`, memoryId: record.id, order: -1,
      text: [record.title, record.url, record.summary, record.note, ...record.tags].join('\n') }];
    for (let offset = 0, order = 0; offset < content.length; offset += 1620, order++) {
      chunks.push({ id: `${record.id}:${order}`, memoryId: record.id, order, text: content.slice(offset, offset + 1800) });
    }
    return chunks.map(chunk => ({ ...chunk, tokens: tokens(chunk.text) }));
  }
  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const finished = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error('Memory write was cancelled.')); tx.onerror = () => {}; });
  class MemoryStore {
    constructor({ indexedDB = root.indexedDB, name = 'omnibrowser-memories-v1' } = {}) { this.indexedDB = indexedDB; this.name = name; }
    async open() {
      if (!this.db) this.db = new Promise((resolve, reject) => {
        if (!this.indexedDB) { reject(new Error('Local memory storage is unavailable.')); return; }
        const req = this.indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => {
          const records = req.result.createObjectStore('records', { keyPath: 'id' });
          records.createIndex('fingerprint', 'fingerprint', { unique: true });
          records.createIndex('updatedAt', 'updatedAt');
          const chunks = req.result.createObjectStore('chunks', { keyPath: 'id' });
          chunks.createIndex('memoryId', 'memoryId');
          const lookup = req.result.createObjectStore('lookup', { keyPath: 'id' });
          lookup.createIndex('tokens', 'tokens', { multiEntry: true });
          req.result.createObjectStore('assets', { keyPath: 'id' });
          req.result.createObjectStore('state', { keyPath: 'key' });
        };
        req.onerror = () => { this.db = null; reject(req.error); };
        req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); this.db = null; }; resolve(req.result); };
      });
      return this.db;
    }
    async transaction(mode, fn) {
      const db = await this.open(), tx = db.transaction(['records', 'chunks', 'lookup', 'assets', 'state'], mode);
      const done = finished(tx);
      try { const value = await fn(tx); await done; return value; }
      catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
    }
    async save(input, asset = null) {
      const kind = input.kind || 'note';
      if (!['note', 'page', 'excerpt', 'summary', 'image', 'screenshot'].includes(kind)) throw new Error('Unknown memory kind.');
      const content = text(input.content, MAX_TEXT, 'Memory content');
      const summary = text(input.summary, 6000, 'Summary'), note = text(input.note, 6000, 'Note');
      const title = text(input.title, 300, 'Title', true), url = sourceUrl(input.url);
      const imageUrl = sourceUrl(input.imageUrl), cleanTags = tags(input.tags);
      if (!content && !summary && !note && !asset) throw new Error('Provide content or an image to save.');
      if (asset && (!(asset instanceof Blob) || !/^image\/(png|jpeg|webp|gif|avif)$/.test(asset.type) || asset.size > MAX_ASSET || !asset.size))
        throw new Error('Use a PNG, JPEG, WebP, GIF or AVIF image up to 8 MiB.');
      if (['image', 'screenshot'].includes(kind) && !asset) throw new Error('An image memory requires a saved image copy.');
      const encoder = new TextEncoder();
      const assetHash = asset ? await this.hash(await asset.arrayBuffer()) : '';
      const automatic = input.automatic === true;
      const autoKey = automatic ? `automatic-page:${await this.hash(encoder.encode(url))}` : '';
      if (automatic && (!url || kind !== 'page')) throw new Error('Automatic captures require a website page.');
      const fingerprint = await this.hash(encoder.encode(JSON.stringify([kind, url, imageUrl, content, summary, note, assetHash, ...(automatic ? ['automatic'] : [])])));
      const bytes = encoder.encode([title, url, summary, note, ...cleanTags].join('\n') + content).length + (asset?.size || 0);
      const now = Date.now(), id = root.crypto.randomUUID();
      const record = { id, kind, title, url, imageUrl, summary, note, tags: cleanTags, pinned: input.pinned === true,
        createdAt: now, updatedAt: now, capturedAt: now, characters: content.length, bytes, hasAsset: !!asset, fingerprint,
        truncated: input.truncated === true, automatic };
      return this.transaction('readwrite', async tx => {
        const records = tx.objectStore('records');
        const autoState = autoKey ? await request(tx.objectStore('state').get(autoKey)) : null;
        if (autoState?.suppressed) return { skipped: true, reason: 'Previously deleted automatic memory.' };
        const existing = await request(records.index('fingerprint').get(fingerprint));
        if (existing) return { memory: existing, deduplicated: true };
        const previous = autoState?.id ? await request(records.get(autoState.id)) : null;
        if (previous) {
          record.id = previous.id; record.createdAt = previous.createdAt;
          record.updatedAt = Math.max(now, previous.updatedAt + 1);
          record.pinned = previous.pinned; record.note = previous.note; record.tags = previous.tags;
          record.bytes = encoder.encode([record.title, url, summary, record.note, ...record.tags].join('\n') + content).length + (asset?.size || 0);
          const keys = await request(tx.objectStore('chunks').index('memoryId').getAllKeys(previous.id));
          keys.forEach(key => tx.objectStore('chunks').delete(key));
          tx.objectStore('assets').delete(previous.id);
        }
        const usage = await request(tx.objectStore('state').get('usage')) || { key: 'usage', count: 0, bytes: 0 };
        const nextBytes = usage.bytes - (previous?.bytes || 0) + record.bytes;
        if ((!previous && usage.count >= 2000) || nextBytes > MAX_LIBRARY_BYTES)
          throw new Error('Memory library is full (2,000 items or 128 MiB). Delete older items to make room.');
        records.put(record);
        const chunks = chunksFor(record, content);
        for (const chunk of chunks) tx.objectStore('chunks').put(chunk);
        tx.objectStore('lookup').put({ id: record.id, tokens: [...new Set(chunks.flatMap(chunk => chunk.tokens))] });
        if (asset) tx.objectStore('assets').put({ id: record.id, blob: asset });
        if (autoKey) tx.objectStore('state').put({ key: autoKey, id: record.id });
        tx.objectStore('state').put({ ...usage, count: usage.count + (previous ? 0 : 1), bytes: nextBytes });
        return { memory: record, deduplicated: false, replaced: !!previous };
      });
    }
    async hash(data) { return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join(''); }
    async getState(key) {
      return this.transaction('readonly', tx => request(tx.objectStore('state').get(key)));
    }
    async setState(key, value) {
      return this.transaction('readwrite', tx => tx.objectStore('state').put({ ...value, key }));
    }
    async clearState(key) {
      return this.transaction('readwrite', tx => tx.objectStore('state').delete(key));
    }
    async states(prefix) {
      return this.transaction('readonly', async tx => (await request(tx.objectStore('state').getAll())).filter(item => item.key.startsWith(prefix)));
    }
    async read({ id, start = 0, length = 12000 }) {
      if (!Number.isSafeInteger(start) || start < 0) throw new Error('Use a non-negative character offset.');
      const size = Math.max(1, Math.min(12000, Math.floor(Number(length) || 12000)));
      return this.transaction('readonly', async tx => {
        const memory = await request(tx.objectStore('records').get(id));
        if (!memory) throw new Error('Memory not found. It may have been deleted.');
        const end = Math.min(memory.characters, start + size), first = Math.floor(start / 1620), last = Math.floor((end - 1) / 1620);
        const keys = end > start ? Array.from({ length: last - first + 1 }, (_, index) => `${id}:${first + index}`) : [];
        const chunks = await Promise.all(keys.map(key => request(tx.objectStore('chunks').get(key))));
        if (chunks.some(chunk => !chunk)) throw new Error('Saved text is incomplete. Export another capture or save the page again.');
        const content = chunks.map((chunk, index) => index ? chunk.text.slice(180) : chunk.text).join('');
        const relative = start - first * 1620;
        return { memory, content: content.slice(relative, relative + size), totalCharacters: memory.characters,
          nextStart: start + size < memory.characters ? start + size : null };
      });
    }
    async search({ query = '', limit = 20, offset = 0, kind = '', url = '', pinnedOnly = false, recall = false } = {}) {
      text(query, 1000, 'Search query');
      const words = tokens(query).slice(0, 24), size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 20)));
      if (recall && !words.length) return { memories: [], total: 0, nextOffset: null, indexed: true };
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Use a non-negative list offset.');
      const source = url ? sourceUrl(url) : '';
      return this.transaction('readonly', async tx => {
        const records = tx.objectStore('records');
        let matches;
        if (words.length) {
          const hits = await Promise.all(words.map(word => request(tx.objectStore('lookup').index('tokens').getAllKeys(word))));
          const candidates = new Map();
          hits.forEach((ids, index) => ids.forEach(id => {
            const candidate = candidates.get(id) || { words: new Set() };
            candidate.words.add(words[index]); candidates.set(id, candidate);
          }));
          const found = await Promise.all([...candidates.keys()].map(id => request(records.get(id))));
          matches = found.filter(Boolean).map(memory => ({ ...memory,
            score: candidates.get(memory.id).words.size * 10 + words.filter(word => tokens([memory.title, ...memory.tags].join(' ')).includes(word)).length * 4 +
              (memory.pinned ? 2 : 0) + (source && memory.url === source ? 20 : 0) }));
        } else matches = (await request(records.getAll())).map(memory => ({ ...memory, excerpt: memory.summary || memory.note, score: memory.pinned ? 1 : 0 }));
        matches = matches.filter(memory => (!kind || memory.kind === kind) && (!pinnedOnly || memory.pinned));
        matches.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        const page = matches.slice(offset, offset + size);
        if (!words.length) await Promise.all(page.map(async memory => {
          const first = await request(tx.objectStore('chunks').get(`${memory.id}:0`));
          memory.excerpt = memory.summary || memory.note || first?.text.slice(0, 800) || '';
        }));
        else await Promise.all(page.map(async memory => {
          const chunks = await request(tx.objectStore('chunks').index('memoryId').getAll(memory.id));
          const best = chunks.map(chunk => ({ chunk, score: words.filter(word => chunk.tokens.includes(word)).length }))
            .sort((a, b) => b.score - a.score || a.chunk.order - b.chunk.order)[0]?.chunk;
          const position = best ? Math.max(0, best.text.toLowerCase().indexOf(words.find(word => best.tokens.includes(word)) || '') - 180) : 0;
          memory.excerpt = best?.text.slice(position, position + 800) || '';
        }));
        const compact = page.map(({ summary, note, fingerprint, bytes, ...memory }) => ({ ...memory, excerpt: (memory.excerpt || summary || note || '').slice(0, 800) }));
        return { memories: compact, total: matches.length,
          nextOffset: offset + size < matches.length ? offset + size : null, indexed: true };
      });
    }
    async update({ id, title, summary, note, tags: rawTags, pinned }) {
      return this.transaction('readwrite', async tx => {
        const records = tx.objectStore('records'), memory = await request(records.get(id));
        if (!memory) throw new Error('Memory not found.');
        if (title !== undefined) memory.title = text(title, 300, 'Title', true);
        if (summary !== undefined) memory.summary = text(summary, 6000, 'Summary');
        if (note !== undefined) memory.note = text(note, 6000, 'Note');
        if (rawTags !== undefined) memory.tags = tags(rawTags);
        if (pinned !== undefined) { if (typeof pinned !== 'boolean') throw new Error('Pinned must be true or false.'); memory.pinned = pinned; }
        // Editing metadata leaves the source capture fingerprint and original content intact.
        const meta = chunksFor(memory, '')[0], oldMeta = await request(tx.objectStore('chunks').get(meta.id));
        const chunks = await request(tx.objectStore('chunks').index('memoryId').getAll(id));
        const delta = new TextEncoder().encode(meta.text).length - new TextEncoder().encode(oldMeta.text).length;
        const usage = await request(tx.objectStore('state').get('usage'));
        if (usage.bytes + delta > MAX_LIBRARY_BYTES) throw new Error('Memory library is full.');
        memory.updatedAt = Date.now(); memory.bytes += delta;
        records.put(memory); tx.objectStore('chunks').put(meta);
        tx.objectStore('lookup').put({ id, tokens: [...new Set([meta, ...chunks.filter(chunk => chunk.order >= 0)].flatMap(chunk => chunk.tokens))] });
        tx.objectStore('state').put({ ...usage, bytes: Math.max(0, usage.bytes + delta) });
        return { memory };
      });
    }
    async delete({ id }) {
      const { memory: candidate } = await this.read({ id, length: 1 }).catch(() => ({ memory: null }));
      const autoKey = candidate?.automatic ? `automatic-page:${await this.hash(new TextEncoder().encode(candidate.url))}` : '';
      return this.transaction('readwrite', async tx => {
        const records = tx.objectStore('records'), memory = await request(records.get(id));
        if (!memory) return { deleted: false };
        const keys = await request(tx.objectStore('chunks').index('memoryId').getAllKeys(id));
        const usage = await request(tx.objectStore('state').get('usage'));
        records.delete(id); tx.objectStore('assets').delete(id); tx.objectStore('lookup').delete(id);
        keys.forEach(key => tx.objectStore('chunks').delete(key));
        if (autoKey) tx.objectStore('state').put({ key: autoKey, suppressed: true });
        tx.objectStore('state').put({ ...usage, count: Math.max(0, usage.count - 1), bytes: Math.max(0, usage.bytes - memory.bytes) });
        return { deleted: true };
      });
    }
    async asset({ id }) {
      const asset = await this.transaction('readonly', tx => request(tx.objectStore('assets').get(id)));
      if (!asset) throw new Error('No saved image for this memory.');
      const bytes = new Uint8Array(await asset.blob.arrayBuffer()); let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return { dataUrl: `data:${asset.blob.type};base64,${root.btoa(binary)}` };
    }
  }
  const api = { MemoryStore, tokens, sourceUrl, MAX_TEXT, MAX_ASSET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.OmniMemory = api;
})(globalThis);
