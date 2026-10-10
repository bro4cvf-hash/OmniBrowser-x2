/* Sidebar-owned execution with shared checkpoints and exclusive task ownership. */
(function (root) {
  'use strict';
  const enabled = typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
  const clientId = enabled ? crypto.randomUUID() : null;
  let task = null, session = null, starting = false, timer = null, observing = false;
  const request = async message => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.success) throw new Error(response?.error || 'Task connection unavailable.');
    return response.result;
  };
  const api = {
    enabled,
    get originTab() { return session?.record.originTab; },
    get remoteActive() { return observing && task && OmniTaskSession.ACTIVE.has(task.record.status); },
    get observing() { return observing; },
    get session() { return session; },
    setUsage(event) { if (session && !observing) session.record.usageStats = structuredClone(event); },
    async disablePersistence() {
      if (!enabled) return;
      if (api.remoteActive) {
        const reply = await chrome.runtime.sendMessage({ type: 'taskCommand', id: task.owner.id, action: 'privacy' }).catch(() => null);
        if (reply?.success) return;
      }
      clearTimeout(timer); timer = null;
      if (session) { session.storage = chrome.storage.session; await session.queue.catch(() => {}); }
      const saved = await chrome.storage.local.get(null);
      const owner = (await chrome.storage.session.get('omniTaskOwner')).omniTaskOwner || saved.omniTaskOwner;
      if (owner?.persistent && saved['omniTask:' + owner.id]) {
        await chrome.storage.session.set({ ['omniTask:' + owner.id]: session?.record || saved['omniTask:' + owner.id],
          omniTaskOwner: { ...owner, persistent: false } });
      }
      const keys = Object.keys(saved).filter(key => key.startsWith('omniTask:') || key === 'omniTaskOwner');
      if (keys.length) await chrome.storage.local.remove(keys);
    },
    detach() {
      if (api.remoteActive || controller || starting) return;
      clearTimeout(timer); timer = null; observing = false; task = null; session = null;
    },
    async start(prompt, recovery) {
      if (starting || controller || submissionPending) return;
      starting = true;
      try {
        let originTab = recovery?.originTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (originTab?.url?.startsWith(chrome.runtime.getURL(''))) originTab = session?.record.originTab || null;
        await saveSettings();
        clearTimeout(timer); timer = null;
        if (session) await session.queue;
        task = await request({ type: 'taskStart', clientId, payload: { prompt, chatId, history, contextState,
          transcript: serializeTranscript(), originTab, remember: settings().rememberChats, recovery } });
        observing = false;
        session = new OmniTaskSession.TaskSession(task.owner.persistent ? chrome.storage.local : chrome.storage.session, task.record);
        await session.save({ status: 'running' });
        // The submitting sidebar owns the model loop, approvals and questions.
        await runTask(task.record.prompt, true);
        if (!controller && OmniTaskSession.ACTIVE.has(session.record.status))
          await session.save({ status: 'failed', activity: $('settingsFeedback').textContent || 'Task could not start. Check your AI connection.' });
      } catch (error) {
        appendMessage('error', error.message);
        $('settingsFeedback').textContent = error.message;
      } finally { starting = false; }
    },
    async command(action, text) {
      if (!task) return;
      const response = await chrome.runtime.sendMessage({ type: 'taskCommand', id: task.owner.id, action, text });
      if (!response?.success) throw new Error(response?.error || 'The task sidebar is unavailable.');
    },
    async recover() {
      if (!task || api.remoteActive) return;
      const record = session?.record || task.record;
      await api.start(OmniTaskSession.recoveryPrompt(record, accessMode), record);
    },
    publish(immediate = false) {
      if (!session || observing) return Promise.resolve();
      const target = session;
      const write = () => target.save({ history, contextState, transcript: serializeTranscript(),
        status: currentRunState === 'idle' ? target.record.status : currentRunState,
        usage: $('taskUsage').textContent,
        activity: $('activity').textContent, originTab: currentOriginTab || target.record.originTab });
      if (immediate) { clearTimeout(timer); timer = null; return write(); }
      if (!timer) timer = setTimeout(() => {
        timer = null;
        write().catch(error => { controller?.abort(error); $('activity').textContent = 'Task checkpoint failed: ' + error.message; });
      }, 250);
      return Promise.resolve();
    },
    async initialize() {
      if (!enabled) return;
      try {
        task = await request({ type: 'taskCurrent' });
        if (task) {
          observing = true;
          render(task.record);
          if (!task.live) {
            observing = false;
            session = new OmniTaskSession.TaskSession(task.owner.persistent ? chrome.storage.local : chrome.storage.session, task.record);
          }
        }
      } catch (error) { $('activity').textContent = error.message; }
    }
  };
  function render(record) {
    const wasFollowing = nearBottom();
    const scroll = $('messages').scrollTop;
    chats = [{ id: record.chatId, title: record.prompt.slice(0, 80), history: record.history,
      contextState: record.contextState, transcript: record.transcript || [] }, ...chats.filter(chat => chat.id !== record.chatId)];
    openChat(record.chatId);
    currentOriginTab = record.originTab;
    lastActiveTabId = record.originTab?.id;
    setRunState(record.status, record.activity);
    $('taskUsage').textContent = record.usage || '';
    const active = OmniTaskSession.ACTIVE.has(record.status);
    $('stop').hidden = !active;
    $('newChat').disabled = active;
    $('historyButton').disabled = active;
    $('settingsButton').disabled = active;
    $('modelButton').disabled = active;
    if (active) $('activity').textContent = record.status === 'waiting' ?
      'Your input is needed in the sidebar where you started this task.' : record.activity;
    if (!wasFollowing) $('messages').scrollTop = scroll;
  }
  if (enabled) {
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if (sender?.id !== chrome.runtime.id) return false;
      const ownsTask = session && !observing && task?.owner.clientId === clientId;
      if (message?.type === 'taskPing' && message.id === task?.owner.id && message.clientId === clientId && ownsTask) {
        reply({ alive: true, status: session.record.status, activity: $('activity').textContent }); return false;
      }
      const panel = sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('sidepanel.html');
      if (message?.type !== 'taskCommand' || message.id !== task?.owner.id || !panel || !ownsTask) return false;
      if (message.action === 'privacy') {
        api.disablePersistence().then(() => reply({ success: true }), error => reply({ success: false, error: error.message }));
        return true;
      }
      if (message.action === 'stop') controller?.abort();
      else if (message.action === 'followup' && controller && typeof message.text === 'string' && message.text.length <= 16000) {
        steeringMessages.push(message.text); appendMessage('user', message.text); api.publish();
      } else { reply({ success: false, error: 'Task is no longer accepting that action.' }); return false; }
      reply({ success: true });
      return false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (session && changes.omniTaskOwner?.newValue?.id === task?.owner.id) {
        session.storage = changes.omniTaskOwner.newValue.persistent ? chrome.storage.local : chrome.storage.session;
        task.owner = changes.omniTaskOwner.newValue;
      }
      if (area === 'local' && changes.aiGrants) policyEngine.fromJSON(changes.aiGrants.newValue || {});
      if (area === 'local' && changes.aiAccessMode) accessMode = changes.aiAccessMode.newValue || 'ask';
      if (observing && task && changes['omniTask:' + task.owner.id]?.newValue) {
        task.record = changes['omniTask:' + task.owner.id].newValue;
        render(task.record);
      }
    });
  }
  root.OmniTaskClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
