/* Capture scheduling only. The downloaded Hindsight engine retains and recalls memories. */
(function (root) {
  const DEFAULTS = { enabled: true, images: true, excludedSites: [] };
  const SETTINGS = 'automatic-memory-config', PENDING = 'automatic-memory-pending';
  const CAPTURE = 'omnibrowser-memory-capture', RETRY = 'omnibrowser-memory-retry';
  const DWELL = 10000;
  function exclusions(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
    if (list.length > 100) throw new Error('Exclude at most 100 sites.');
    return [...new Set(list.filter(Boolean).map(site => {
      const url = new URL(site.includes('://') ? site : `https://${site}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
          !['', '/'].includes(url.pathname) || !/^[a-z0-9.\-\[\]:]+$/i.test(url.hostname))
        throw new Error('Enter site names, such as example.com, without page paths.');
      return url.hostname.toLowerCase();
    }))];
  }
  function eligible(tab, config) {
    if (!config.enabled || !tab?.active || tab.incognito || tab.status === 'loading') return false;
    try {
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
      if (config.excludedSites.some(site => url.hostname === site || url.hostname.endsWith(`.${site}`))) return false;
      const path = decodeURIComponent(url.pathname);
      if (/(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|auth|oauth|account|accounts|checkout|payment|payments|billing|banking|wallet)(?:\/|$)/i.test(path) ||
          /^(?:accounts|login|auth|banking)\./i.test(url.hostname) ||
          [...url.searchParams.keys()].some(key => /^(?:token|access_token|id_token|api_key|apikey|password|secret|code)$/i.test(key))) return false;
      return true;
    } catch { return false; }
  }
  class AutomaticMemory {
    constructor({ chrome = root.chrome, store, engine, observe, fetch = root.fetch.bind(root), now = Date.now,
      setTimer = root.setTimeout.bind(root), clearTimer = root.clearTimeout.bind(root) } = {}) {
      Object.assign(this, { chrome, store, engine, observe, fetch, now, setTimer, clearTimer });
      this.generation = 0; this.busy = false; this.retrying = false;
    }
    async config() { return { ...DEFAULTS, ...await this.store.getState(SETTINGS) }; }
    async status() { return { ...await this.config(), ...await this.store.getState('automatic-memory-status'), dwellSeconds: DWELL / 1000 }; }
    async configure(input) {
      const config = { enabled: input.enabled === true, images: input.images === true,
        excludedSites: input.enabled === false ? (await this.config()).excludedSites : exclusions(input.excludedSites) };
      await this.store.setState(SETTINGS, config);
      await this.schedule();
      return this.status();
    }
    async active() {
      const [tab] = await this.chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return null;
      const window = await this.chrome.windows.get(tab.windowId);
      return window.focused ? tab : null;
    }
    async cancel() {
      this.generation++; this.clearTimer(this.timer);
      await this.chrome.storage.session.remove(PENDING);
      await this.chrome.alarms.clear(CAPTURE);
    }
    async schedule() {
      const generation = ++this.generation; this.clearTimer(this.timer);
      const [config, tab] = await Promise.all([this.config(), this.active()]);
      if (generation !== this.generation) return;
      if (!eligible(tab, config)) {
        await this.chrome.storage.session.remove(PENDING); await this.chrome.alarms.clear(CAPTURE); return;
      }
      const pending = { id: root.crypto.randomUUID(), tabId: tab.id, url: tab.url, due: this.now() + DWELL };
      await this.chrome.storage.session.set({ [PENDING]: pending });
      await this.chrome.alarms.create(CAPTURE, { when: pending.due });
      if (generation !== this.generation) return;
      this.timer = this.setTimer(() => this.capture().catch(error => this.report(error.message)), DWELL);
    }
    async valid(pending) {
      const [tab, config, state] = await Promise.all([this.active(), this.config(), this.chrome.storage.session.get(PENDING)]);
      return state[PENDING]?.id === pending.id && tab?.id === pending.tabId && tab.url === pending.url && eligible(tab, config);
    }
    async report(message, extra = {}) {
      await this.store.setState('automatic-memory-status', { ...await this.store.getState('automatic-memory-status'), message, ...extra });
    }
    async image(source) {
      const candidate = source.images?.find(item => item.width >= 200 && item.height >= 100 && /^https?:\/\//.test(item.url));
      if (!candidate) return {};
      try {
        const url = new URL(candidate.url);
        if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|key|signature/i.test(key))) return {};
        const response = await this.fetch(url.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8000) });
        const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
        const limit = 1024 * 1024;
        if (!response.ok || !/^image\/(png|jpeg|webp|gif|avif)$/.test(type) || Number(response.headers.get('content-length')) > limit) return {};
        const reader = response.body.getReader(), parts = []; let bytes = 0;
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > limit) { await reader.cancel(); return {}; }
          parts.push(value);
        }
        return bytes ? { asset: new Blob(parts, { type }), imageUrl: url.href } : {};
      } catch { return {}; }
    }
    async capture() {
      if (this.busy) return;
      this.busy = true;
      try {
        const pending = (await this.chrome.storage.session.get(PENDING))[PENDING];
        if (!pending || this.now() < pending.due || !await this.valid(pending)) return;
        const source = await this.observe(pending.tabId);
        if (!source || source.sensitive || source.visible === false || source.url !== pending.url || source.content.trim().length < 80 || !await this.valid(pending)) return;
        const config = await this.config();
        const descriptions = (source.images || []).slice(0, 12).filter(image => image.alt).map(image => image.alt).join('\n');
        const content = (source.content + (descriptions ? `\nImage descriptions:\n${descriptions}` : '')).slice(0, 100000);
        const url = root.OmniMemory.sourceUrl(source.url);
        const digest = await this.store.hash(new TextEncoder().encode(JSON.stringify([source.title, content, source.description || '', config.images, source.images?.map(image => image.url)])));
        const key = `automatic-capture:${await this.store.hash(new TextEncoder().encode(url))}`;
        const old = await this.store.getState(key);
        // Identical page content needs neither another image download nor another retain call.
        if (old?.digest === digest) return;
        const image = config.images ? await this.image(source) : {};
        const saved = await this.engine.save({ kind: 'page', automatic: true, title: source.title || 'Saved website',
          url, content, summary: (source.description || '').slice(0, 6000), truncated: source.truncated,
          tags: ['automatic'], imageUrl: image.imageUrl || '' }, image.asset, { allowed: () => this.valid(pending) });
        if (saved.skipped) return;
        await this.store.setState(key, { digest, id: saved.memory.id });
        await this.report(saved.warning || 'Page saved automatically and indexed in Hindsight.',
          { lastSavedAt: this.now(), lastTitle: saved.memory.title, indexed: saved.indexed });
      } finally { this.busy = false; }
    }
    async retry() {
      if (this.retrying || this.busy) return;
      this.retrying = true;
      try {
        if (!(await this.config()).enabled) return;
        let config = await this.engine.config();
        // Connect only the bundled local service automatically; explicit pause stays paused.
        if (!config.enabled && !config.paused && config.endpoint === 'http://127.0.0.1:8888') {
          try { await this.engine.configure({ ...config, apiKey: '' }, { automatic: true }); }
          catch { return; }
          config = await this.engine.config();
        }
        if (config.enabled) {
          const result = await this.engine.sync();
          if (result.warning) await this.report(result.warning);
          else if (result.synced) await this.report('Saved memories synced automatically to Hindsight.', { indexed: result.pending === 0 });
        }
      } finally { this.retrying = false; }
    }
    start() {
      const safe = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(error => this.report(error.message).catch(() => {}));
      this.chrome.tabs.onUpdated.addListener(safe((id, change, tab) => {
        if (tab.active && (change.url || change.status)) return this.schedule();
      }));
      this.chrome.tabs.onActivated.addListener(safe(() => this.schedule()));
      this.chrome.tabs.onRemoved.addListener(safe(async id => {
        if ((await this.chrome.storage.session.get(PENDING))[PENDING]?.tabId === id) await this.cancel();
      }));
      this.chrome.windows.onFocusChanged.addListener(safe(() => this.schedule()));
      this.chrome.alarms.onAlarm.addListener(safe(async alarm => {
        if (alarm.name === CAPTURE) return this.capture();
        if (alarm.name === RETRY) { await this.retry(); await this.schedule(); }
      }));
      // Chrome may discard alarms on restart: reconstruct the recurring job each worker start.
      safe(async () => {
        if (!await this.chrome.alarms.get(RETRY)) await this.chrome.alarms.create(RETRY, { periodInMinutes: 1 });
        await this.schedule(); await this.retry();
      })();
    }
  }
  root.OmniAutomaticMemory = { AutomaticMemory, eligible, exclusions, DEFAULTS, DWELL };
  if (typeof module !== 'undefined') module.exports = root.OmniAutomaticMemory;
})(globalThis);
