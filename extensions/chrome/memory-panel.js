/* The library and assistant share one durable background memory service. */
(function () {
  const get = id => document.getElementById(id);
  if (!get('memoryButton')) return;
  let selected = null, nextOffset = null, nextStart = null, version = 0, timer;
  const tags = value => value.split(',').map(tag => tag.trim()).filter(Boolean);
  const feedback = message => { get('memoryFeedback').textContent = message; };
  const call = (name, args) => rawBrowserTool(name, args);
  function action(id, fn) {
    get(id).addEventListener('click', async () => {
      get(id).disabled = true;
      try { await fn(); } catch (error) { feedback(error.message); }
      finally { get(id).disabled = false; }
    });
  }
  async function activeTab() {
    if (controller || submissionPending) throw new Error('Wait for the current task to finish before saving another website.');
    const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!Number.isSafeInteger(tab?.id) || !/^https?:\/\//.test(tab.url || '')) throw new Error('Open a website tab to save it.');
    return tab;
  }
  async function list(append = false) {
    const current = ++version;
    if (!append) get('memoryList').replaceChildren();
    const result = await call('memory_search', { query: get('memorySearch').value.slice(0, 1000), kind: get('memoryKind').value,
      pinnedOnly: get('memoryPinned').checked, archive: !get('memorySemantic').checked, offset: append ? nextOffset || 0 : 0, limit: 20 });
    if (current !== version || !get('memoryDialog').open) return;
    if (!append) get('memoryList').replaceChildren();
    if (!result.memories?.length && !append) {
      const empty = document.createElement('p'); empty.className = 'hint';
      empty.textContent = get('memorySearch').value || get('memoryKind').value || get('memoryPinned').checked ?
        'No matches. Try fewer words or choose All types.' : 'Your library is empty. Keep a website open for 10 seconds to save it automatically.';
      get('memoryList').append(empty);
    }
    for (const memory of result.memories || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'memoryCard quiet';
      const title = document.createElement('strong'); title.textContent = memory.title;
      const meta = document.createElement('small'); meta.textContent = `${memory.pinned ? 'Pinned · ' : ''}${memory.automatic ? 'Automatically saved' : memory.kind} · ${new Date(memory.capturedAt).toLocaleDateString()}`;
      const excerpt = document.createElement('span'); excerpt.textContent = (memory.excerpt || '').slice(0, 200);
      button.append(title, meta, excerpt); button.addEventListener('click', () => detail(memory.id).catch(error => feedback(error.message)));
      get('memoryList').append(button);
    }
    nextOffset = result.nextOffset; get('memoryMore').hidden = nextOffset == null;
  }
  async function detail(id) {
    const result = await call('memory_read', { id }); selected = result.memory; nextStart = result.nextStart;
    get('memoryLibrary').hidden = true; get('memoryNewNote').hidden = true; get('memoryDetail').hidden = false;
    get('memoryEditTitle').value = selected.title; get('memoryEditSummary').value = selected.summary;
    get('memoryEditNote').value = selected.note; get('memoryEditTags').value = selected.tags.join(', '); get('memoryEditPinned').checked = selected.pinned;
    get('memoryOriginal').textContent = result.content || 'No original text for this memory.';
    get('memoryReadMore').hidden = nextStart == null; get('memorySource').replaceChildren();
    const date = document.createElement('span'); date.textContent = `Saved ${new Date(selected.capturedAt).toLocaleString()}${selected.truncated ? ' · Page text was truncated' : ''}. `;
    get('memorySource').append(date);
    if (selected.url) {
      const link = document.createElement('a'); link.href = selected.url; link.textContent = 'Open source'; link.target = '_blank'; link.rel = 'noopener noreferrer'; get('memorySource').append(link);
    }
    get('memoryImage').hidden = true; get('memoryImage').removeAttribute('src');
    if (selected.hasAsset) {
      const asset = await call('memory_asset', { id });
      if (selected?.id === id && /^data:image\/(png|jpeg|webp|gif|avif);base64,/.test(asset.dataUrl)) {
        get('memoryImage').src = asset.dataUrl; get('memoryImage').hidden = false;
      }
    }
    get('memoryEditTitle').focus();
  }
  function back() {
    selected = null; get('memoryImage').removeAttribute('src');
    get('memoryDetail').hidden = true; get('memoryLibrary').hidden = false; get('memoryNewNote').hidden = false;
  }
  async function capture(kind, extra = {}, tab = null) {
    tab = tab || await activeTab(); feedback('Saving…');
    const result = await call('memory_capture', { tabId: tab.id, kind, ...extra });
    feedback(result.warning || (result.deduplicated ? 'Already saved. Your existing memory is available below.' :
      result.indexed ? `Saved ${kind} and indexed with Hindsight.` : `Saved ${kind} to memories.`));
    back(); await list();
  }
  action('memoryButton', async () => { back(); get('memoryDialog').showModal(); feedback(''); await list(); });
  action('memorySavePage', () => capture('page'));
  action('memorySaveSelection', () => capture('excerpt'));
  action('memorySaveScreenshot', () => capture('screenshot'));
  action('memorySummarize', async () => {
    const tab = await activeTab();
    if (!get('browserTools').checked || !get('memoryTools').checked) throw new Error('Enable Browser tools and Use saved memories in AI settings to create a saved summary.');
    get('memoryDialog').close();
    await runTask(`Read the website in tab ${tab.id} (${tab.url}), create a concise factual summary of its key details, then use memory_capture with kind summary to save the summary and original page text to memories. Include useful tags and the source. Report the saved memory only after the tool succeeds.`);
  });
  action('memoryChooseImage', async () => {
    const tab = await activeTab(), source = await call('memory_inspect', { tabId: tab.id });
    get('memoryImageOptions').replaceChildren(); get('memoryImagePicker').hidden = false; let count = 0;
    for (const image of source.images || []) {
      if (!/^https?:\/\//.test(image.url)) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'memoryCard quiet';
      button.textContent = `${image.alt || 'Website image'} · ${image.width} × ${image.height}`;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await capture('image', { imageUrl: image.url, title: image.alt || source.title || 'Website image' }, tab); get('memoryImagePicker').hidden = true; }
        catch (error) { feedback(error.message); } finally { button.disabled = false; }
      }); get('memoryImageOptions').append(button); count++;
    }
    feedback(count ? 'Choose an image to keep a local copy. Some sites block downloads; a screenshot is another option.' : 'No downloadable images found. Try saving a screenshot.');
  });
  action('memoryCancelImages', async () => { get('memoryImagePicker').hidden = true; });
  action('memoryBack', async () => { back(); await list(); get('memorySearch').focus(); });
  action('memoryMore', () => list(true));
  action('memoryReadMore', async () => {
    const result = await call('memory_read', { id: selected.id, start: nextStart });
    get('memoryOriginal').textContent += result.content; nextStart = result.nextStart; get('memoryReadMore').hidden = nextStart == null;
  });
  action('memoryDelete', async () => {
    const automatic = selected.automatic;
    await call('memory_delete', { id: selected.id }); back();
    feedback(automatic ? 'Memory deleted. This page will not be saved automatically again.' : 'Memory and its saved image deleted.'); await list();
  });
  action('memoryExport', async () => {
    const memory = selected, pieces = []; let start = 0;
    do { const result = await call('memory_read', { id: memory.id, start }); pieces.push(result.content); start = result.nextStart; } while (start != null);
    const asset = memory.hasAsset ? await call('memory_asset', { id: memory.id }) : {};
    const blob = new Blob([JSON.stringify({ version: 1, memory, content: pieces.join(''), ...asset }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `memory-${memory.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    feedback('Memory exported with its original text and saved image.');
  });
  for (const [id, fn] of [['memoryNoteForm', async () => {
    const result = await call('memory_save', { title: get('memoryNoteTitle').value, content: get('memoryNoteContent').value, tags: tags(get('memoryNoteTags').value) });
    get('memoryNoteForm').reset(); get('memoryNewNote').open = false;
    feedback(result.warning || (result.deduplicated ? 'This note is already saved.' : 'Note saved and indexed with Hindsight.')); await list();
  }], ['memoryEditForm', async () => {
    const result = await call('memory_update', { id: selected.id, title: get('memoryEditTitle').value,
      summary: get('memoryEditSummary').value, note: get('memoryEditNote').value, tags: tags(get('memoryEditTags').value), pinned: get('memoryEditPinned').checked });
    selected = result.memory; feedback(result.warning || 'Memory updated in the library and Hindsight.');
  }]]) get(id).addEventListener('submit', async event => {
    event.preventDefault(); if (event.submitter) event.submitter.disabled = true;
    try { await fn(); } catch (error) { feedback(error.message); }
    finally { if (event.submitter) event.submitter.disabled = false; }
  });
  get('memorySearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => list().catch(error => feedback(error.message)), 180); });
  for (const id of ['memoryKind', 'memoryPinned', 'memorySemantic']) get(id).addEventListener('change', () => list().catch(error => feedback(error.message)));
  function engineCall(action, args) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: 'sidebarMemorySettings', action, args }, response => {
      const error = chrome.runtime.lastError?.message || (!response?.success && response?.error);
      if (error || !response) reject(new Error(error || 'Memory settings are unavailable.'));
      else resolve(response.result);
    }));
  }
  function showEngine(result) {
    if (typeof result?.endpoint !== 'string' || typeof result?.bank !== 'string') {
      get('memoryEngineFeedback').textContent = 'Memory connection could not be read. Reload the extension.'; return;
    }
    get('memoryEndpoint').value = result.endpoint; get('memoryBank').value = result.bank; get('memoryVision').checked = result.images;
    get('memoryEngineFeedback').textContent = result.warning ||
      `${result.enabled ? 'Hindsight connected' : 'Hindsight paused'}${result.features?.observations === false ? ' · Local search; fact consolidation unavailable' : ''} · ${result.indexed} indexed · ${result.pending} saved items awaiting sync.`;
  }
  function showAutomatic(result, fill = true) {
    if (typeof result?.enabled !== 'boolean' || !Array.isArray(result.excludedSites)) return;
    if (fill) {
      get('automaticMemoryEnabled').checked = result.enabled;
      get('automaticMemoryImages').checked = result.images;
      get('automaticMemoryExcluded').value = result.excludedSites.join('\n');
    }
    get('automaticMemoryFeedback').textContent = !result.enabled ? 'Automatic saving paused.' :
      `Automatic saving is on.${result.lastTitle ? ` Last saved: ${result.lastTitle}.` : ''}${result.message ? ` ${result.message}` : ''}`;
  }
  async function saveAutomatic() {
    try {
      showAutomatic(await engineCall('automaticConfigure', { enabled: get('automaticMemoryEnabled').checked,
        images: get('automaticMemoryImages').checked, excludedSites: get('automaticMemoryExcluded').value }));
    } catch (error) { get('automaticMemoryFeedback').textContent = error.message; }
  }
  get('automaticMemoryEnabled').addEventListener('change', saveAutomatic);
  get('automaticMemoryImages').addEventListener('change', saveAutomatic);
  action('automaticMemoryApply', saveAutomatic);
  get('memoryButton').addEventListener('click', () => {
    engineCall('automaticStatus').then(result => showAutomatic(result)).catch(error => { get('automaticMemoryFeedback').textContent = error.message; });
    engineCall('status').then(showEngine).catch(() => {});
  });
  engineCall('automaticStatus').then(result => showAutomatic(result)).catch(error => { get('automaticMemoryFeedback').textContent = error.message; });
  action('memoryConnect', async () => {
    get('memoryEngineFeedback').textContent = 'Connecting…';
    try {
      showEngine(await engineCall('configure', { endpoint: get('memoryEndpoint').value, bank: get('memoryBank').value,
        apiKey: get('memoryServiceKey').value, images: get('memoryVision').checked }));
      get('memoryServiceKey').value = '';
    } catch (error) { get('memoryEngineFeedback').textContent = error.message; }
  });
  action('memoryDisconnect', async () => { showEngine(await engineCall('disconnect')); });
  action('memorySync', async () => {
    get('memoryEngineFeedback').textContent = 'Syncing saved items…';
    try {
      let result;
      do { result = await engineCall('sync'); showEngine(result); } while (result.pending > 0 && result.synced > 0 && !result.warning);
    } catch (error) { get('memoryEngineFeedback').textContent = error.message; }
  });
  engineCall('status').then(showEngine).catch(error => { get('memoryEngineFeedback').textContent = error.message; });
  get('memoryDialog').addEventListener('close', () => { version++; get('memoryImage').removeAttribute('src'); get('memoryImagePicker').hidden = true; });
})();
