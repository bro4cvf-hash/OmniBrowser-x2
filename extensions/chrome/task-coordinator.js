/* The service worker coordinates ownership; the submitting sidebar owns execution. */
(function () {
  'use strict';
  let queue = Promise.resolve();
  const key = 'omniTaskOwner';
  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);
  const isPanel = sender => sender.id === chrome.runtime.id &&
    sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('sidepanel.html');
  const areaFor = owner => owner.persistent ? chrome.storage.local : chrome.storage.session;
  async function current() {
    const owner = (await chrome.storage.session.get(key))[key] || (await chrome.storage.local.get(key))[key];
    if (!owner || !validId(owner.id)) return null;
    const area = areaFor(owner);
    const record = (await area.get('omniTask:' + owner.id))['omniTask:' + owner.id];
    if (!record) return null;
    let pong;
    // Legacy task tabs are never adopted. A new sidebar restores their checkpoint.
    try {
      if (validId(owner.clientId))
        pong = await chrome.runtime.sendMessage({ type: 'taskPing', id: owner.id, clientId: owner.clientId });
    } catch {}
    const live = pong?.alive === true;
    if (live && OmniTaskSession.ACTIVE.has(record.status) && ['completed', 'failed', 'stopped', 'unknown'].includes(pong?.status)) {
      const settled = { ...record, status: pong.status, activity: pong.activity, updatedAt: Date.now() };
      await area.set({ ['omniTask:' + owner.id]: settled });
      return { owner, record: settled, live };
    }
    // Give the submitting sidebar time to receive ownership and save its session.
    if (!live && validId(owner.clientId) && record.status === 'starting' && Date.now() - record.createdAt < 30000)
      return { owner, record, live: false };
    if (!live && OmniTaskSession.ACTIVE.has(record.status)) {
      const stopped = OmniTaskSession.interrupted(record);
      await area.set({ ['omniTask:' + owner.id]: stopped });
      return { owner, record: stopped, live };
    }
    return { owner, record, live };
  }
  async function start(payload, clientId) {
    if (!validId(clientId)) throw new Error('Task sidebar identity is missing.');
    const existing = await current();
    if (existing && OmniTaskSession.ACTIVE.has(existing.record.status))
      throw new Error('A task is already running. Return to its sidebar or stop it first.');
    const id = crypto.randomUUID();
    const persistent = payload.remember !== false;
    const area = persistent ? chrome.storage.local : chrome.storage.session;
    const record = { id, chatId: payload.chatId, prompt: String(payload.prompt || '').slice(0, 16000),
      taskId: payload.recovery?.taskId || id,
      goal: payload.recovery?.goal || payload.recovery?.prompt || String(payload.prompt || '').slice(0, 16000),
      history: payload.history || [], contextState: payload.contextState || {}, transcript: payload.transcript || [],
      originTab: payload.originTab || null, status: 'starting', activity: 'Starting task in sidebar…',
      journal: payload.recovery?.journal || [], createdAt: Date.now(), updatedAt: Date.now() };
    if (payload.recovery?.usageStats) record.usageStats = payload.recovery.usageStats;
    if (!record.prompt.trim()) throw new Error('Enter a task first.');
    await area.set({ ['omniTask:' + id]: record });
    const owner = { id, clientId, persistent };
    await chrome.storage.session.set({ [key]: owner });
    if (persistent) await chrome.storage.local.set({ [key]: owner });
    else await chrome.storage.local.remove(key);
    if (existing && existing.owner.id !== id)
      await areaFor(existing.owner).remove('omniTask:' + existing.owner.id);
    return { owner, record, live: true };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!['taskStart', 'taskCurrent'].includes(message?.type)) return false;
    if (!isPanel(sender || {})) { reply({ success: false, error: 'Only OmniBrowser can manage tasks.' }); return false; }
    const operation = () => message.type === 'taskStart' ? start(message.payload || {}, message.clientId) : current();
    const next = queue.then(operation);
    queue = next.catch(() => {});
    next.then(result => reply({ success: true, result }), error => reply({ success: false, error: error.message }));
    return true;
  });
})();
