const assert = require('node:assert/strict');
const { AutomaticMemory, eligible, exclusions, DWELL } = require('../extensions/chrome/automatic-memory.js');
require('../extensions/chrome/sidebar-memory.js');
(async () => {
  let clock = 1000, focused = true, tab = { id: 4, windowId: 1, active: true, status: 'complete', url: 'https://research.test/article' };
  const state = new Map(), session = {}, alarms = new Map(), saves = [];
  const store = { getState: async key => state.get(key), setState: async (key, value) => state.set(key, value),
    hash: async bytes => OmniMemory.MemoryStore.prototype.hash(bytes) };
  const event = () => ({ addListener() {} });
  const chrome = { tabs: { query: async () => [tab], onUpdated: event(), onActivated: event(), onRemoved: event() },
    windows: { get: async () => ({ focused }), onFocusChanged: event() },
    storage: { session: { get: async () => session, set: async value => Object.assign(session, value), remove: async key => { delete session[key]; } } },
    alarms: { create: async (key, value) => alarms.set(key, value), clear: async key => alarms.delete(key), get: async key => alarms.get(key), onAlarm: event() } };
  let source = { title: 'Research', url: tab.url, content: 'Solar panels turn sunlight into electricity. Batteries store the collected energy for use after sunset.',
    images: [{ url: 'https://research.test/photo.png', alt: 'Solar power diagram', width: 800, height: 600 }] };
  let configured = 0, synced = 0, fetched = 0, observed = 0, failConnect = false;
  let engineConfig = { enabled: false, endpoint: 'http://127.0.0.1:8888', bank: 'test' };
  const engine = { config: async () => engineConfig,
    configure: async () => { configured++; if (failConnect) throw new Error('offline'); engineConfig.enabled = true; },
    sync: async () => { synced++; return {}; },
    save: async (input, asset, { allowed }) => {
      if (!await allowed()) return { skipped: true };
      saves.push({ input, asset }); return { memory: { id: 'page-id', ...input }, indexed: engineConfig.enabled,
        warning: engineConfig.enabled ? '' : 'Saved locally. Memory service unavailable.' };
    } };
  let duringImage;
  const args = { chrome, store, engine, observe: async () => { observed++; return source; }, now: () => clock,
    setTimer: () => 1, clearTimer: () => {}, fetch: async () => {
      fetched++; if (duringImage) await duringImage();
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    } };
  let auto = new AutomaticMemory(args);
  const config = await auto.config(); assert.equal(config.enabled, true); assert.equal(config.images, true);
  for (const unsafe of ['https://research.test/login', 'https://research.test/checkout', 'https://research.test/article?access_token=secret', 'file:///private', 'https://user:pass@research.test/'])
    assert.equal(eligible({ ...tab, url: unsafe }, config), false, unsafe);
  assert.equal(eligible({ ...tab, incognito: true }, config), false);
  assert.equal(eligible({ ...tab, active: false }, config), false);
  assert.deepEqual(exclusions('EXAMPLE.com\nhttps://private.test/'), ['example.com', 'private.test']);
  assert.throws(() => exclusions('https://private.test/secret'), /without page paths/);
  assert.equal(eligible({ ...tab, url: 'https://sub.example.com/article' }, { ...config, excludedSites: ['example.com'] }), false);
  await auto.schedule(); await auto.capture(); assert.equal(saves.length, 0, 'No immediate capture');
  clock += DWELL; await auto.capture(); assert.equal(saves.length, 1);
  assert.equal(saves[0].input.automatic, true); assert.equal(saves[0].asset.size, 3);
  assert.match(saves[0].input.content, /Image descriptions:\nSolar power diagram/);
  await auto.capture(); assert.equal(saves.length, 1); assert.equal(fetched, 1, 'Unchanged pages do not re-download images');
  await auto.retry(); assert.equal(configured, 1); assert.equal(synced, 1, 'Local service connects and retries automatically');
  // Pending dwell lives outside the worker; replacement worker can complete it.
  source.content += ' Updated research results.'; await auto.schedule(); clock += DWELL;
  auto = new AutomaticMemory(args); await auto.capture(); assert.equal(saves.length, 2);
  await auto.configure({ enabled: false, images: true, excludedSites: [] });
  await auto.capture(); await auto.retry(); assert.equal(saves.length, 2); assert.equal(synced, 1);
  await auto.configure({ enabled: true, images: false, excludedSites: ['research.test'] });
  clock += DWELL; await auto.capture(); assert.equal(saves.length, 2);
  await auto.configure({ enabled: true, images: false, excludedSites: [] }); clock += DWELL;
  source.sensitive = true; await auto.capture(); assert.equal(saves.length, 2); source.sensitive = false;
  source.visible = false; await auto.capture(); assert.equal(saves.length, 2); source.visible = true;
  focused = false; await auto.capture(); assert.equal(saves.length, 2); focused = true;
  const oldTab = tab; tab = { ...tab, url: 'https://research.test/other' }; await auto.capture(); assert.equal(saves.length, 2); tab = oldTab;
  await auto.capture(); assert.equal(saves.length, 3); assert.equal(saves[2].asset, undefined);
  // A navigation during image retrieval must cancel the save at the final write boundary.
  await auto.configure({ enabled: true, images: true, excludedSites: [] }); clock += DWELL; source.content += ' More changes.';
  duringImage = async () => { tab = { ...tab, url: 'https://research.test/changed' }; };
  await auto.capture(); assert.equal(saves.length, 3); duringImage = null; tab = oldTab;
  engineConfig = { ...engineConfig, enabled: false, paused: true };
  await auto.retry(); assert.equal(configured, 1, 'Explicit engine pause is respected');
  engineConfig = { ...engineConfig, paused: false, endpoint: 'https://remote.test' };
  await auto.retry(); assert.equal(configured, 1, 'No automatic remote connection');
  engineConfig.endpoint = 'http://127.0.0.1:8888'; failConnect = true;
  await auto.retry(); assert.equal(configured, 2);
  const signed = { images: [{ url: 'https://research.test/photo.png?token=secret', width: 800, height: 600 }] };
  const countBefore = fetched; assert.deepEqual(await auto.image(signed), {}); assert.equal(fetched, countBefore);
  auto.fetch = async () => new Response('oversized', { headers: { 'content-type': 'image/png', 'content-length': String(2 * 1024 * 1024) } });
  assert.deepEqual(await auto.image(source), {}, 'Oversized image headers are rejected');
  let cancelled = false;
  auto.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; } }), { headers: { 'content-type': 'image/png' } });
  assert.deepEqual(await auto.image(source), {}); assert.equal(cancelled, true, 'Streaming image limit is enforced');
  assert.ok(observed > 0);
  console.log('Automatic memory: dwell, restart, exclusions, private pages, image limits, deduplication, navigation races, local reconnect and pause passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
