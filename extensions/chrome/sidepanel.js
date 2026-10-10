const dummyElement = {
  addEventListener() {},
  removeEventListener() {},
  querySelector() { return dummyElement; },
  querySelectorAll() { return []; },
  replaceChildren() {},
  append() {},
  prepend() {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  dataset: {},
  style: {},
  value: '',
  textContent: '',
  children: [],
  focus() {},
  click() {},
  setAttribute() {},
  removeAttribute() {},
  closest() { return null; }
};
if (typeof CSS === 'undefined') {
  const cssEscape = s => String(s).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  if (typeof globalThis !== 'undefined') globalThis.CSS = { escape: cssEscape };
  if (typeof window !== 'undefined') window.CSS = { escape: cssEscape };
}
const $ = id => typeof document !== 'undefined' ? (document.getElementById(id) || (id === 'takeOver' ? document.getElementById('takeOverTab') : id === 'resume' ? document.getElementById('resumeTask') : null) || dummyElement) : dummyElement;
const RunState = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING: 'waiting',
  STOPPED: 'stopped',
  FAILED: 'failed',
  COMPLETED: 'completed',
  UNKNOWN: 'unknown'
});
let currentRunState = RunState.IDLE;
let lastFailedTool = null;
let lastActiveTabId = null;
let currentOriginTab = null;

function setRunState(state, activityText = null) {
  currentRunState = state;
  if (typeof document !== 'undefined' && document.body) document.body.dataset.runState = state;
  if (activityText !== null && $("activity")) $("activity").textContent = activityText;
  updateRecoveryControls();
  if (typeof OmniTaskClient !== 'undefined') OmniTaskClient.publish();
}

function updateRecoveryControls() {
  const controls = $("recoveryControls");
  if (!controls) return;
  const isRecoverable = [RunState.STOPPED, RunState.FAILED, RunState.UNKNOWN].includes(currentRunState);
  controls.hidden = !isRecoverable;
  if (isRecoverable) {
    const badge = $("recoveryStateBadge");
    if (badge) {
      badge.textContent = {
        [RunState.STOPPED]: 'Stopped',
        [RunState.FAILED]: 'Failed',
        [RunState.UNKNOWN]: 'Uncertain'
      }[currentRunState] || currentRunState;
    }
  }
}
if (typeof document !== 'undefined' && document.body) setRunState(RunState.IDLE);

function extractSite(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const u = new URL(urlStr);
    return u.origin;
  } catch {
    return null;
  }
}

function normalizePath(p) {
  return String(p || '').replace(/[\/\\]+/g, '/').replace(/\/$/, '').toLowerCase();
}

function isSubpath(child, parent) {
  const normChild = normalizePath(child);
  const normParent = normalizePath(parent);
  return normChild === normParent || normChild.startsWith(normParent + '/');
}

function formatRemainingTime(expiresAt) {
  if (!expiresAt) return 'This task';
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return 'Expired';
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m left`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s left`;
  }
  return `${seconds}s left`;
}

class PolicyEngine {
  static SAFE_TOOLS = new Set([
    'browser_context', 'current_tab', 'list_tabs',
    'read_page', 'read_pages', 'verify_task', 'diagnostics_start', 'diagnostics_read', 'diagnostics_stop', 'downloads_status', 'recipe_list', 'form_inspect', 'form_verify', 'search_web', 'fetch_web',
    'files_roots', 'files_locations', 'files_find_folder',
    'update_plan', 'record_result', 'context_read', 'mcp_search',
    'memory_search', 'memory_read', 'memory_save', 'memory_capture', 'memory_inspect', 'memory_update', 'memory_delete'
  ]);

  constructor(options = {}) {
    this.granular = new (typeof OmniSidebarPolicy !== 'undefined' ? OmniSidebarPolicy : require('./sidebar-policy.js')).PolicyEngine();
    this.rules = [];
    this.siteGrants = new Map();
    this.folderGrants = new Map();
    this.activeTaskId = options.taskId || null;
    this.tabSites = new Map();
  }

  setTaskId(taskId) {
    this.activeTaskId = taskId;
  }

  setTabSite(tabId, urlOrOrigin) {
    if (!tabId) return;
    const site = extractSite(urlOrOrigin);
    if (site) this.tabSites.set(tabId, site);
  }

  getTabSite(tabId) {
    return this.tabSites.get(tabId) || null;
  }

  isSafe(name) {
    return PolicyEngine.SAFE_TOOLS.has(name);
  }

  cleanExpired() {
    const now = Date.now();
    for (const [site, grant] of this.siteGrants.entries()) {
      if (grant.expiresAt && grant.expiresAt <= now) {
        this.siteGrants.delete(site);
      }
    }
    for (const [path, grant] of this.folderGrants.entries()) {
      if (grant.expiresAt && grant.expiresAt <= now) {
        this.folderGrants.delete(path);
      }
    }
  }

  clearTaskGrants(taskId = this.activeTaskId) {
    this.rules = this.rules.filter(rule => !rule.taskId || taskId && rule.taskId !== taskId);
    for (const [site, grant] of this.siteGrants.entries()) {
      if (grant.scope === 'task' && (!taskId || grant.taskId === taskId)) {
        this.siteGrants.delete(site);
      }
    }
    for (const [path, grant] of this.folderGrants.entries()) {
      if (grant.scope === 'task' && (!taskId || grant.taskId === taskId)) {
        this.folderGrants.delete(path);
      }
    }
  }

  grantSite(site, scope = 'time', durationMs = 3600000) {
    if (!site) return null;
    this.cleanExpired();
    const expiresAt = scope === 'time' ? Date.now() + durationMs : null;
    const grant = {
      site,
      scope,
      expiresAt,
      taskId: scope === 'task' ? this.activeTaskId : null
    };
    if (scope !== 'once') {
      this.siteGrants.set(site, grant);
    }
    return grant;
  }

  grantFolder(path, scope = 'time', durationMs = null) {
    if (!path) return null;
    this.cleanExpired();
    const expiresAt = durationMs ? Date.now() + durationMs : null;
    const grant = {
      path,
      scope,
      expiresAt,
      taskId: scope === 'task' ? this.activeTaskId : null
    };
    if (scope !== 'once') {
      this.folderGrants.set(path, grant);
    }
    return grant;
  }

  revokeSite(site) {
    return this.siteGrants.delete(site);
  }

  revokeFolder(path) {
    return this.folderGrants.delete(path);
  }

  getActiveSiteGrants() {
    this.cleanExpired();
    return Array.from(this.siteGrants.values()).filter(grant => {
      if (grant.scope === 'task') return !this.activeTaskId || grant.taskId === this.activeTaskId;
      return true;
    });
  }

  getActiveFolderGrants() {
    this.cleanExpired();
    return Array.from(this.folderGrants.values()).filter(grant => {
      if (grant.scope === 'task') return !this.activeTaskId || grant.taskId === this.activeTaskId;
      return true;
    });
  }

  hasSiteGrant(site) {
    if (!site) return false;
    this.cleanExpired();
    const grant = this.siteGrants.get(site);
    if (!grant) return false;
    if (grant.scope === 'task') {
      return !this.activeTaskId || grant.taskId === this.activeTaskId;
    }
    if (grant.expiresAt) {
      return grant.expiresAt > Date.now();
    }
    return true;
  }

  hasFolderGrant(targetPath) {
    if (!targetPath) return false;
    this.cleanExpired();
    for (const [folderPath, grant] of this.folderGrants.entries()) {
      if (grant.scope === 'task' && this.activeTaskId && grant.taskId !== this.activeTaskId) continue;
      if (grant.expiresAt && grant.expiresAt <= Date.now()) continue;
      if (isSubpath(targetPath, folderPath)) return true;
    }
    return false;
  }

  checkPermission(name, args = {}, context = {}) {
    this.cleanExpired();
    const site = extractSite(context.currentUrl) || extractSite(args.url) || this.getTabSite(args.tabId) || extractSite(context.originTab?.url);
    const paths = args.paths || (args.path ? [args.path] : []);
    const request = { tool: name, args, url: site, taskId: this.activeTaskId, descriptor: context.descriptor };
    // Legacy grants are migrated into the same evaluator used for granular rules.
    this.granular.grants.clear();
    for (const rule of this.rules) this.granular.grant(rule);
    for (const grant of this.getActiveSiteGrants()) this.granular.allow({ domain: grant.site,
      category: ['browser_read', 'browser_write', 'navigation'], taskId: grant.taskId, expiresAt: grant.expiresAt, description: 'site_grant' });
    const folders = this.getActiveFolderGrants();
    for (const grant of folders) this.granular.allow({ path: grant.path, category: 'file_read',
      taskId: grant.taskId, expiresAt: grant.expiresAt, description: 'folder_grant' });
    const requests = context.urls?.length ? context.urls.map(url => ({ ...request, url })) : [request];
    if (name === 'upload_files') requests.push({ ...request, descriptor: { ...context.descriptor, category: 'file_read' } });
    const decisions = requests.flatMap(req => paths.length ? paths.map(path => this.granular.evaluate({ ...req, args: { ...args, paths: [path], path } })) : [this.granular.evaluate(req)]);
    const denied = decisions.find(decision => decision.decision === 'deny');
    if (denied) return { ...denied, site, target: site || paths[0] };
    if (decisions.every(decision => decision.allowed)) return { allowed: true, reason: decisions[0].reason, site };
    if (this.isSafe(name) && !decisions.some(decision => decision.grant)) return { allowed: true, reason: 'safe_tool', site };
    return { allowed: false, decision: decisions.some(decision => decision.grant) ? 'ask' : 'default', type: paths.length ? 'folder' : 'site', target: paths[0] || site || 'browser action', site, paths };
  }

  toJSON() {
    this.cleanExpired();
    return {
      siteGrants: Array.from(this.siteGrants.entries()),
      folderGrants: Array.from(this.folderGrants.entries()), rules: this.rules
    };
  }

  fromJSON(data) {
    this.rules = Array.isArray(data?.rules) ? structuredClone(data.rules) : [];
    this.siteGrants.clear(); this.folderGrants.clear();
    if (data?.siteGrants && Array.isArray(data.siteGrants)) {
      this.siteGrants = new Map(data.siteGrants);
    }
    if (data?.folderGrants && Array.isArray(data.folderGrants)) {
      this.folderGrants = new Map(data.folderGrants);
    }
    this.cleanExpired();
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.PolicyEngine = PolicyEngine;
}

let history = [];
let contextState = {};
let modelMetadata = {};
let mcpCatalogue = [];
let connectedMcpConfig = null;
let chats = [];
let chatId = crypto.randomUUID();
const policyEngine = new PolicyEngine({ taskId: chatId });
let accessMode = "ask";
let chatSaveQueue = Promise.resolve();
let controller = null;
let steeringMessages = [];
let submissionPending = false;
let modelController = null;
let modelTimer = null;
let modelGeneration = 0;
let approvalQueue = Promise.resolve();
let currentRunDiagnostics = null;
let lastDiagnosticsBundle = null;
const streamedMessages = new Map();
const toolRows = new Map();
const toolLabels = {
  delegate_task: 'Working with a sub-agent', subagent_read: 'Reading sub-agent evidence',
  request_user_input: 'Asking for your input',
  browser_context: 'Reading your browser context', current_tab: 'Finding the current tab', list_tabs: 'Finding open tabs',
  diagnostics_start: 'Watching for browser errors', diagnostics_read: 'Checking browser errors',
  diagnostics_stop: 'Stopping error capture', download_file: 'Downloading file', downloads_status: 'Checking download',
  recipe_list: 'Finding saved field recipes', recipe_save: 'Saving field recipe', recipe_run: 'Filling saved fields',
  verify_task: 'Checking task completion', read_page: 'Reading page', read_pages: 'Reading pages',
  search_web: 'Searching in background', fetch_web: 'Reading web sources',
  navigate: 'Opening page', new_tab: 'Opening a research tab', form_inspect: 'Inspecting form',
  form_verify: 'Verifying form values', batch_actions: 'Filling form fields', browser_step: 'Completing a form step',
  files_locations: 'Finding your desktop and documents', files_find_folder: 'Locating your folder',
  files_roots: 'Checking enabled folders', files_list: 'Finding documents', files_search: 'Searching documents',
  files_extract: 'Reading document', files_read_many: 'Reading source documents',
  update_plan: 'Updating task plan', record_result: 'Saving a task result',
  hover: 'Hovering element', press_key: 'Pressing key', type_text: 'Typing text',
  wait_for: 'Waiting for element', handle_dialog: 'Handling dialog',
  screenshot: 'Taking screenshot', upload_files: 'Uploading files',
  captcha_status: 'Checking CAPTCHA status', captcha_handoff: 'Handing off CAPTCHA'
};

let activeWorkBody = null;

function renderToolActivity(row, state, text, detail = '') {
  row.className = `toolRun ${state}`;
  row.dataset.text = text;
  row.dataset.detail = detail;
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.8');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  icon.classList.add('toolStateIcon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', state === 'running' ? 'M12 3a9 9 0 1 1-9 9' : state === 'complete' ? 'm5 12 4 4L19 6' : 'M12 8v5m0 3h.01M10.3 4.5 2.5 18a1.5 1.5 0 0 0 1.3 2.2h16.4a1.5 1.5 0 0 0 1.3-2.2L13.7 4.5a2 2 0 0 0-3.4 0Z');
  icon.append(path);
  const label = document.createElement('span'); label.className = 'toolLabel'; label.textContent = text;
  const status = document.createElement('span'); status.className = 'sr-only';
  status.textContent = state === 'complete' ? 'Completed: ' : state === 'failed' ? 'Needs attention: ' : 'In progress: ';
  row.replaceChildren(icon, status, label);
  if (detail) {
    const disclosure = document.createElement('details'); disclosure.className = 'toolError';
    const summary = document.createElement('summary'); summary.textContent = 'Error details';
    const message = document.createElement('p'); message.textContent = detail;
    disclosure.append(summary, message); row.append(disclosure);
  }
}

function renderScreenshot(data, container) {
  const target = container || activeWorkBody || $("messages");
  const card = document.createElement('div');
  card.className = 'screenshotCard';
  card.dataset.screenshot = data;
  const img = document.createElement('img');
  img.src = data.startsWith('data:') ? data : `data:image/png;base64,${data}`;
  img.alt = 'Tab screenshot';
  img.style.maxWidth = '100%';
  img.style.borderRadius = '8px';
  img.style.border = '1px solid var(--border)';
  img.style.marginTop = '6px';
  img.style.display = 'block';
  card.append(img);
  target.append(card);
  if (nearBottom()) $("messages").scrollTop = $("messages").scrollHeight;
}

function renderPlan(container, steps) {
  let plan = container.querySelector('.taskPlan');
  if (!plan) { plan = document.createElement('section'); plan.className = 'taskPlan'; container.prepend(plan); }
  plan.dataset.steps = JSON.stringify(steps); plan.setAttribute('aria-label', 'Task plan'); plan.replaceChildren();
  const title = document.createElement('h3'); title.textContent = 'The plan';
  const list = document.createElement('ol');
  for (const step of steps) {
    const item = document.createElement('li'); item.dataset.status = step.status;
    const state = document.createElement('span'); state.className = 'stepState'; state.setAttribute('aria-hidden', 'true');
    state.textContent = { complete: '✓', running: '•', blocked: '!', pending: '' }[step.status];
    const label = document.createElement('span'); label.textContent = step.title;
    const accessible = document.createElement('span'); accessible.className = 'sr-only'; accessible.textContent = ` (${step.status})`;
    item.append(state, label, accessible); list.append(item);
  }
  plan.append(title, list);
}

function renderResult(container, result) {
  const safe = OmniSidebarAgent.validateWorkflow('record_result', result);
  let board = container.querySelector('.taskResults');
  if (!board) { board = document.createElement('section'); board.className = 'taskResults'; board.setAttribute('aria-label', 'Task results'); const heading = document.createElement('h3'); heading.textContent = 'Results'; board.append(heading); container.append(board); }
  let card = [...board.querySelectorAll('.resultCard')].find(item => item.dataset.url === safe.url);
  if (!card) { card = document.createElement('article'); card.className = 'resultCard'; board.append(card); }
  card.dataset.url = safe.url; card.dataset.result = JSON.stringify(safe); card.replaceChildren();
  const top = document.createElement('div');
  const link = document.createElement('a'); link.href = safe.url; link.textContent = safe.title + ' ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer';
  const status = document.createElement('span'); status.className = 'resultStatus'; status.dataset.status = safe.status;
  const statusLabels = { researched: 'Researched', ready: 'Ready for review', submitted: 'Submitted', blocked: 'Needs input', skipped: 'Skipped', unknown: 'Unknown', outcome_unknown: 'Outcome unknown', needs_evidence: 'Needs evidence' };
  status.textContent = statusLabels[safe.status] || safe.status;
  top.append(link, status);
  if (safe.outcome || result.outcome) {
    const outcome = safe.outcome || result.outcome;
    const outcomeBadge = document.createElement('span');
    outcomeBadge.className = `outcomeBadge ${outcome}`;
    outcomeBadge.dataset.outcome = outcome;
    outcomeBadge.textContent = outcome === 'confirmed' ? 'Confirmed' : outcome === 'failed' ? 'Failed' : 'Unknown';
    top.append(outcomeBadge);
  }
  card.append(top);
  if (safe.note) { const note = document.createElement('p'); note.textContent = safe.note; card.append(note); }
  if (safe.evidence && (safe.evidence.sourceUrl || safe.evidence.sourcePath)) {
    const provenance = document.createElement('div'); provenance.className = 'resultProvenance'; provenance.setAttribute('aria-label', 'Source provenance');
    if (safe.evidence.sourceUrl) {
      const srcItem = document.createElement('span'); srcItem.className = 'provenanceItem';
      const label = document.createElement('span'); label.className = 'provenanceLabel'; label.textContent = 'Source: ';
      const srcLink = document.createElement('a'); srcLink.href = safe.evidence.sourceUrl; srcLink.textContent = safe.evidence.sourceUrl + ' ↗'; srcLink.target = '_blank'; srcLink.rel = 'noopener noreferrer';
      srcItem.append(label, srcLink); provenance.append(srcItem);
    }
    if (safe.evidence.sourcePath) {
      const pathItem = document.createElement('span'); pathItem.className = 'provenanceItem';
      const label = document.createElement('span'); label.className = 'provenanceLabel'; label.textContent = 'File: ';
      const pathCode = document.createElement('code'); pathCode.className = 'provenancePath'; pathCode.textContent = safe.evidence.sourcePath;
      pathItem.append(label, pathCode); provenance.append(pathItem);
    }
    card.append(provenance);
  }
  if (safe.evidence) {
    const hasConfirmation = Boolean(safe.evidence.observedConfirmation);
    const hasUnknowns = Array.isArray(safe.evidence.unknownFields) && safe.evidence.unknownFields.length > 0;
    const hasErrors = Array.isArray(safe.evidence.validationErrors) && safe.evidence.validationErrors.length > 0;
    if (hasConfirmation || hasUnknowns || hasErrors) {
      const tagsContainer = document.createElement('div'); tagsContainer.className = 'evidenceTags'; tagsContainer.setAttribute('aria-label', 'Evidence tags');
      if (hasConfirmation) {
        const tag = document.createElement('span'); tag.className = 'evidenceTag confirmed'; tag.dataset.tag = 'confirmation';
        tag.textContent = '✓ ' + safe.evidence.observedConfirmation; tagsContainer.append(tag);
      }
      if (hasUnknowns) {
        for (const field of safe.evidence.unknownFields) {
          const tag = document.createElement('span'); tag.className = 'evidenceTag unknown'; tag.dataset.tag = 'unknown';
          tag.textContent = 'Unknown: ' + field; tagsContainer.append(tag);
        }
      }
      if (hasErrors) {
        for (const err of safe.evidence.validationErrors) {
          const tag = document.createElement('span'); tag.className = 'evidenceTag error'; tag.dataset.tag = 'error';
          tag.textContent = '! ' + err; tagsContainer.append(tag);
        }
      }
      card.append(tagsContainer);
    }
  }
}

function nearBottom() {
  return $("messages").scrollHeight - $("messages").scrollTop - $("messages").clientHeight < 100;
}

function folderRequest(action, args = {}) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: 'sidebarFolder', action, args }, response => {
    if (chrome.runtime.lastError || !response?.success) reject(new Error(response?.error || 'Reconnect the extension to enable local folders.'));
    else resolve(response.result);
  }));
}

async function saveGrants() {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      await chrome.storage.local.set({ aiGrants: policyEngine.toJSON() });
    } catch {}
  }
}

let countdownInterval = null;
function startCountdownTimer() {
  if (countdownInterval || typeof window === 'undefined') return;
  countdownInterval = setInterval(() => {
    policyEngine.cleanExpired();
    const hasExpiringGrants = policyEngine.getActiveSiteGrants().some(g => g.expiresAt !== null) ||
      policyEngine.getActiveFolderGrants().some(g => g.expiresAt !== null);
    const isMenuOpen = Boolean($("accessMenu")?.open);
    if (hasExpiringGrants || isMenuOpen) {
      renderPermissionsUI();
    }
  }, 1000);
}

function renderPermissionsUI() {
  if (typeof document === 'undefined') return;
  const labels = { ask: 'Ask for approval', auto: 'Approve for me', full: 'Full access' };
  const label = $("accessLabel");
  if (label) label.textContent = labels[accessMode];
  if ($("accessMenu")) $("accessMenu").dataset.mode = accessMode;
  document.querySelectorAll('[data-access]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.access === accessMode));
  });

  const siteList = $("siteGrantsList");
  if (siteList) {
    siteList.replaceChildren();
    const siteGrants = policyEngine.getActiveSiteGrants();
    siteList.hidden = siteGrants.length === 0;
    $("siteGrantsHeading").hidden = siteList.hidden;
    if (siteGrants.length) {
      for (const grant of siteGrants) {
        const item = document.createElement('div');
        item.className = 'grantItem';
        const info = document.createElement('span');
        const remaining = grant.expiresAt ? Math.max(0, Math.ceil((grant.expiresAt - Date.now()) / 1000)) : null;
        info.textContent = `${grant.site} (${grant.scope}${remaining !== null ? ` ${remaining}s` : ''})`;
        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'quiet';
        revokeBtn.textContent = 'Revoke';
        revokeBtn.addEventListener('click', () => {
          policyEngine.revokeSite(grant.site);
          saveGrants();
          renderPermissionsUI();
        });
        item.append(info, revokeBtn);
        siteList.append(item);
      }
    }
  }

  const folderList = $("folderGrantsList");
  if (folderList) {
    folderList.replaceChildren();
    const folderGrants = policyEngine.getActiveFolderGrants();
    folderList.hidden = folderGrants.length === 0;
    $("folderGrantsHeading").hidden = folderList.hidden;
    if (folderGrants.length) {
      for (const grant of folderGrants) {
        const item = document.createElement('div');
        item.className = 'grantItem';
        const info = document.createElement('span');
        const remaining = grant.expiresAt ? Math.max(0, Math.ceil((grant.expiresAt - Date.now()) / 1000)) : null;
        info.textContent = `${grant.path} (${grant.scope}${remaining !== null ? ` ${remaining}s` : ''})`;
        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'quiet';
        revokeBtn.textContent = 'Revoke';
        revokeBtn.addEventListener('click', () => {
          policyEngine.revokeFolder(grant.path);
          saveGrants();
          renderPermissionsUI();
        });
        item.append(info, revokeBtn);
        folderList.append(item);
      }
    }
  }
  const grantsSection = document.querySelector('.activeGrantsSection');
  if (grantsSection) grantsSection.hidden = (!siteList || siteList.hidden) && (!folderList || folderList.hidden);
}

function displayFolders(roots) {
  $("folderList").replaceChildren();
  $("fileBadge").textContent = roots.length ? `${roots.length} enabled` : 'Add a folder';
  for (const path of roots) {
    if (!policyEngine.hasFolderGrant(path)) {
      policyEngine.grantFolder(path, 'session');
    }
    const row = document.createElement('div'); row.className = 'folderRow';
    const text = document.createElement('span'); text.textContent = path;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        policyEngine.revokeFolder(path);
        renderPermissionsUI();
        displayFolders((await folderRequest('remove_folder', { path })).roots);
      }
      catch (error) { $("folderFeedback").textContent = error.message; remove.disabled = false; }
    });
    row.append(text, remove); $("folderList").append(row);
  }
  renderPermissionsUI();
}

async function refreshFolders() {
  try { displayFolders((await folderRequest('files_roots')).roots); $("folderFeedback").textContent = 'PDF, Word, Excel and text documents are supported.'; }
  catch (error) { $("folderFeedback").textContent = error.message; }
}
$("refreshFolders").addEventListener('click', refreshFolders);
$("folderForm").addEventListener('submit', async event => {
  event.preventDefault(); $("addFolder").disabled = true;
  try {
    displayFolders((await folderRequest('allow_folder', { path: $("folderPath").value.trim() })).roots);
    $("folderFeedback").textContent = 'Folder enabled. You can now ask the AI to read its documents.';
    $("folderPath").value = '';
  } catch (error) { $("folderFeedback").textContent = error.message; }
  finally { $("addFolder").disabled = false; }
});
$("filesPanel").addEventListener('toggle', () => {
  if ($("filesPanel").open) { $("settingsPanel").open = false; refreshFolders(); }
});
$("settingsPanel").addEventListener('toggle', () => { if ($("settingsPanel").open) $("filesPanel").open = false; });
for (const id of ['settingsPanel', 'filesPanel']) {
  $(id).querySelector('summary').addEventListener('click', event => {
    event.preventDefault();
    const open = !$(id).open;
    $("settingsPanel").open = false;
    $("filesPanel").open = false;
    $(id).open = open;
  });
}

async function fetchModels() {
  clearTimeout(modelTimer);
  modelController?.abort();
  const generation = ++modelGeneration;
  $("refreshModels").disabled = false;
  $("modelPicker").disabled = false;
  const value = settings();
  try { OmniSidebarAgent.endpoint(value.baseUrl); }
  catch (error) { $("modelsFeedback").textContent = error.message; return; }
  const current = new AbortController();
  modelController = current;
  $("refreshModels").disabled = true;
  $("modelPicker").disabled = true;
  $("modelsFeedback").textContent = "Fetching models…";
  try {
    const models = await OmniSidebarAgent.listModels(value, { signal: current.signal, onMetadata: metadata => {
      if (generation === modelGeneration) modelMetadata = metadata;
    } });
    if (generation !== modelGeneration) return;
    $("modelPicker").replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = ""; placeholder.textContent = "Choose a model…";
    $("modelPicker").append(placeholder);
    for (const id of models) {
      const option = document.createElement("option");
      option.value = id; option.textContent = id;
      $("modelPicker").append(option);
    }
    if (models.includes($("model").value)) $("modelPicker").value = $("model").value;
    else if (models.length) {
      $("model").value = models[0]; $("modelPicker").value = models[0];
    }
    $("modelBadge").textContent = $("model").value; syncModelMenu();
    $("setupModel").replaceChildren();
    for (const id of models) {
      const option = document.createElement('option'); option.value = id; option.textContent = id; $("setupModel").append(option);
    }
    $("setupModel").value = $("model").value;
    $("modelsFeedback").textContent = `${models.length} models available. Choose a chat model below.`;
  } catch (error) {
    if (generation === modelGeneration && !current.signal.aborted) $("modelsFeedback").textContent = error.message;
  } finally {
    if (generation === modelGeneration) {
      $("refreshModels").disabled = false;
      $("modelPicker").disabled = false;
      modelController = null;
    }
  }
}

function queueModelFetch({ preserveMetadata = false } = {}) {
  if (!preserveMetadata) modelMetadata = {};
  clearTimeout(modelTimer);
  modelController?.abort();
  modelGeneration++;
  $("refreshModels").disabled = false;
  $("modelPicker").disabled = false;
  $("modelPicker").replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.textContent = "Models will load after you finish typing"; placeholder.value = "";
  $("modelPicker").append(placeholder);
  $("modelsFeedback").textContent = "Models load automatically after you enter your API URL and key.";
  // Local servers often allow model discovery without a key.
  const value = settings();
  if (value.baseUrl)
    modelTimer = setTimeout(fetchModels, 800);
}

$("apiKey").addEventListener("input", () => { $("model").value = ""; queueModelFetch(); });
$("baseUrl").addEventListener("input", () => { $("model").value = ""; queueModelFetch(); });
$("refreshModels").addEventListener("click", fetchModels);
$("setupModel").addEventListener('change', () => { $("model").value = $("setupModel").value; $("manualModel").value = ''; syncModelMenu(); });
$("manualModel").addEventListener('input', () => { $("model").value = $("manualModel").value.trim(); syncModelMenu(); });
$("testConnection").addEventListener('click', async () => {
  $("testConnection").disabled = true;
  $("connectionFeedback").textContent = 'Testing your selected model…';
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20000);
  try {
    await saveSettings();
    const value = settings();
    const response = await fetch(OmniSidebarAgent.endpoint(value.baseUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(value.apiKey ? { Authorization: `Bearer ${value.apiKey}` } : {}) },
      body: JSON.stringify({ model: value.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8, stream: false }),
      signal: abort.signal, credentials: 'omit', redirect: 'error'
    });
    if (!response.ok) throw new Error(`Connection test returned HTTP ${response.status}. Check the model, URL and key.`);
    const data = await response.json();
    if (typeof data.choices?.[0]?.message?.content !== 'string') throw new Error('Provider did not return a supported chat response.');
    $("connectionFeedback").textContent = 'Connected. Save settings, then try “Summarize this page”.';
  } catch (error) { $("connectionFeedback").textContent = abort.signal.aborted ? 'Connection test timed out.' : error.message; }
  finally { clearTimeout(timeout); $("testConnection").disabled = false; }
});
$("modelPicker").addEventListener("change", () => {
  if ($("modelPicker").value) { $("model").value = $("modelPicker").value; saveSettings().catch(error => { $("settingsFeedback").textContent = error.message; }); }
});

function appendMessage(role, text) {
  $("welcome").hidden = true;
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "You" : role === "error" ? "Could not finish" : "OmniBrowser x2";
  const content = document.createElement("div"); content.className = 'messageContent';
  OmniChatRenderer.render(text, content);
  article.append(label, content);
  article.dataset.role = role;
  article.dataset.text = text;
  $("messages").append(article);
  $("messages").scrollTop = $("messages").scrollHeight;
  return content;
}

function settings() {
  return { provider: $("provider").value, baseUrl: $("baseUrl").value.trim(),
    accessMode, model: $("model").value.trim(), apiKey: $("apiKey").value.trim(),
    browserTools: $("browserTools").checked, fileTools: $("fileTools").checked, memoryTools: $("memoryTools").checked,
    streaming: $("streaming").checked, parallelTools: $("parallelTools").checked,
    parallelLimit: Number($("parallelLimit").value), maxRounds: Number($("maxRounds").value),
    timeoutSeconds: Number($("timeoutSeconds").value), theme: $("theme").value,
    taskMinutes: Number($("taskMinutes").value),
    taskCostLimit: Number($("taskCostLimit").value), inputTokenPrice: Number($("inputTokenPrice").value), outputTokenPrice: Number($("outputTokenPrice").value),
    contextWindowTokens: Number($("contextWindowTokens").value) || null,
    modelContextWindow: modelMetadata[$("model").value]?.contextWindow || null,
    modelContextSource: modelMetadata[$("model").value]?.contextSource || null,
    autoCompact: $("autoCompact").checked, mcpTools: $("mcpTools").checked,
    textSize: $("textSize").value, shine: $("shine").checked,
    enterSend: $("enterSend").checked, rememberChats: $("rememberChats").checked };
}

async function saveSettings() {
  let value = settings();
  for (const field of ['taskMinutes', 'taskCostLimit', 'inputTokenPrice', 'outputTokenPrice']) {
    if (!Number.isFinite(value[field]) || value[field] < 0) throw new Error('Task limits and token prices must be zero or positive.');
  }
  if (value.taskMinutes > 720) throw new Error('Set a task time limit of at most 720 minutes.');
  if (value.taskCostLimit && !value.inputTokenPrice && !value.outputTokenPrice) throw new Error('Enter token prices before setting a cost limit.');
  if ($("contextWindowTokens").value && (!Number.isSafeInteger(value.contextWindowTokens) || value.contextWindowTokens < 4096)) throw new Error('Enter a context window of at least 4,096 tokens.');
  OmniSidebarAgent.endpoint(value.baseUrl);
  if (!value.model) { await fetchModels(); value = settings(); }
  if (!value.model) throw new Error("Could not discover a model. Check your API key and base URL, then refresh models.");
  const { apiKey, ...publicSettings } = value;
  await chrome.storage.local.set({ aiSettings: publicSettings });
  await chrome.storage.session.set({ aiApiKey: apiKey });
  if (!value.rememberChats && typeof OmniTaskClient !== 'undefined') await OmniTaskClient.disablePersistence();
  $("modelBadge").textContent = value.model;
  applyAppearance(); syncModelMenu();
}

$("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await saveSettings();
    $("settingsFeedback").textContent = "Saved. You're ready to chat.";
    $("settingsDialog").close();
    if (!$("rememberChats").checked) { chats = []; await chrome.storage.local.remove("aiChats"); renderChatList(); }
  } catch (error) { $("settingsFeedback").textContent = error.message; }
});

$("provider").addEventListener("change", () => {
  const provider = $("provider").value;
  $("baseUrl").value = provider === "openai" ? "https://api.openai.com/v1"
    : provider === "local" ? "http://localhost:1234/v1" : "";
  $("apiKey").value = "";
  $("model").value = "";
  queueModelFetch();
});

function rawBrowserTool(name, args) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "sidebarTool", name, args, chatId }, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error("Browser connection unavailable. Reload the extension."));
      else if (!response?.success) {
        const failure = new Error(response?.error || "Browser tool failed");
        if (response?.notDispatched === true) failure.notDispatched = true;
        if (response?.page) failure.page = response.page;
        reject(failure);
      }
      else resolve(response.result);
    });
  });
}

function mcpRequest(action, args = {}) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: 'sidebarMcp', action, args }, response => {
    if (chrome.runtime.lastError || !response?.success) reject(new Error(response?.error || 'Reconnect the installed bridge to use MCP servers.'));
    else resolve(response.result);
  }));
}
function showMcpStatus(result) {
  mcpCatalogue = result.tools || [];
  $("mcpFeedback").textContent = result.servers?.length ? result.servers.map(server =>
    `${server.name}: ${server.connected ? `${server.toolCount} tools ready` : server.error || 'disconnected'}`).join('\n') : 'No servers connected.';
}
async function connectMcp() {
  $("connectMcp").disabled = true;
  $("mcpFeedback").textContent = 'Connecting servers…';
  try {
    const config = JSON.parse($("mcpConfig").value);
    if (!config || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers) || config.mcpServers === null) throw new Error('Use JSON with an mcpServers object.');
    const result = await mcpRequest('configure', config);
    connectedMcpConfig = config;
    await chrome.storage.session.set({ aiMcpConfig: config });
    showMcpStatus(result);
  } catch (error) {
    $("mcpFeedback").textContent = error instanceof SyntaxError ? 'Check the JSON syntax, then connect again.' : error.message;
    $("mcpFeedback").focus();
  } finally { $("connectMcp").disabled = false; }
}
$("connectMcp").addEventListener('click', connectMcp);
$("disconnectMcp").addEventListener('click', async () => {
  try { showMcpStatus(await mcpRequest('disconnect')); connectedMcpConfig = null; await chrome.storage.session.remove('aiMcpConfig'); }
  catch (error) { $("mcpFeedback").textContent = error.message; }
});
function addMcpPreset(name, entry) {
  try {
    const config = JSON.parse($("mcpConfig").value);
    if (!config?.mcpServers || Array.isArray(config.mcpServers) || typeof config.mcpServers !== 'object') throw new Error();
    if (config.mcpServers[name]) { $("mcpFeedback").textContent = `${name} is already configured. Connect servers to refresh.`; return; }
    config.mcpServers[name] = entry;
    $("mcpConfig").value = JSON.stringify(config, null, 2);
    $("mcpFeedback").textContent = 'Added. Connect servers to enable these tools.';
  } catch { $("mcpFeedback").textContent = 'Check the existing server JSON before adding a preset.'; $("mcpFeedback").focus(); }
}
$("mcpParallelPreset").addEventListener('click', () => addMcpPreset('Parallel Search', { url: 'https://search.parallel.ai/mcp', readOnlyTools: ['web_search', 'web_fetch'], sessionTools: [] }));
$("mcpScraplingPreset").addEventListener('click', () => addMcpPreset('Scrapling', { command: 'scrapling', args: ['mcp'], readOnlyTools: ['bulk_get', 'fetch', 'bulk_fetch'] }));

function forbidDraftResetUndoingSubmission(text) {
  if (typeof text !== 'string') return;
  const undoRevert = /\b(?:undo(?:ing)?|undid|undone|revert(?:s|ing|ed)?)\b/i;
  const resetWord = /\b(?:reset|resetting|resets)\b/i;
  const submission = /\bsubmission\b/i;
  const draft = /\bdraft\b/i;

  const hasSubmissionAndReset =
    (/\b(?:reset|resetting|resets)\b.*\bsubmission/i.test(text) ||
     /\bsubmission\b.*\b(?:reset|resetting|resets)\b/i.test(text));

  const hasUndoRevertSubmissionDraft =
    ((undoRevert.test(text) && submission.test(text) && draft.test(text)) ||
     (undoRevert.test(text) && submission.test(text) && resetWord.test(text)));

  const hasDraftResetUndoRevert =
    /\b(?:draft\s+reset|resetting\s+draft|reset\s+draft)\b.*\b(?:undo(?:ing)?|undid|undone|revert(?:s|ing|ed)?)\b/i.test(text);

  if (hasSubmissionAndReset || hasUndoRevertSubmissionDraft || hasDraftResetUndoRevert) {
    throw new Error('Draft resets cannot undo submissions');
  }
}

function renderActionPreview(previewOrText) {
  const isObj = typeof previewOrText === 'object' && previewOrText !== null;
  const preview = isObj ? previewOrText : { text: String(previewOrText) };

  forbidDraftResetUndoingSubmission(preview.text || '');
  forbidDraftResetUndoingSubmission(preview.record || '');

  const outcomeEl = $("approvalOutcome");
  if (outcomeEl) {
    outcomeEl.setAttribute('role', 'status');
    outcomeEl.setAttribute('aria-live', 'polite');
    outcomeEl.hidden = true;
  }

  const titleEl = $("approvalTitle");
  if (titleEl) titleEl.textContent = preview.isConsequential ? 'Consequential Action Review' : 'Action Approval';

  const textEl = $("approvalText");
  if (textEl) {
    textEl.textContent = preview.text || (preview.name ? `Allow ${preview.name.replaceAll('_', ' ')}?` : 'Review action before execution:');
  }

  const previewEl = $("approvalPreview");
  const destEl = $("approvalDestination");
  const destRow = $("approvalDestinationRow") || destEl?.parentElement;
  const recordEl = $("approvalRecord");
  const recordRow = $("approvalRecordRow") || recordEl?.parentElement;
  const fieldsTable = $("approvalFields");
  const fieldsBody = $("approvalFieldsBody") || fieldsTable?.querySelector('tbody');
  const fieldsSection = $("approvalFieldsSection") || fieldsTable?.closest('.previewSection');
  const citationsList = $("approvalCitations");
  const citationsSection = $("approvalCitationsSection") || citationsList?.closest('.previewSection');

  let hasStructured = false;

  // 1. Target destination URL
  const destination = preview.destination || preview.url || preview.targetUrl || '';
  if (destEl) {
    if (destination) {
      destEl.textContent = destination;
      let isHttp = false;
      try {
        const u = new URL(destination);
        isHttp = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {}
      if (isHttp) {
        destEl.href = destination;
      } else {
        if (typeof destEl.removeAttribute === 'function') destEl.removeAttribute('href');
        else delete destEl.href;
      }
      if (destRow) destRow.hidden = false;
      hasStructured = true;
    } else {
      destEl.textContent = '';
      if (typeof destEl.removeAttribute === 'function') destEl.removeAttribute('href');
      else delete destEl.href;
      if (destRow) destRow.hidden = true;
    }
  }

  // 2. Affected record description
  const record = preview.record || preview.affectedRecord || preview.description || '';
  if (recordEl) {
    if (record) {
      recordEl.textContent = record;
      if (recordRow) recordRow.hidden = false;
      hasStructured = true;
    } else {
      recordEl.textContent = '';
      if (recordRow) recordRow.hidden = true;
    }
  }

  // 3. Proposed field values table
  const fields = preview.fields || preview.proposedFields || preview.actions || [];
  if (fieldsBody) {
    fieldsBody.replaceChildren();
    if (Array.isArray(fields) && fields.length > 0) {
      for (const field of fields) {
        const tr = document.createElement('tr');
        const tdField = document.createElement('td');
        tdField.textContent = field.name || field.selector || field.field || 'field';
        const tdVal = document.createElement('td');
        const val = field.value !== undefined ? field.value : (field.checked !== undefined ? (field.checked ? 'true' : 'false') : '');
        tdVal.textContent = String(val);
        tr.append(tdField, tdVal);
        fieldsBody.append(tr);
      }
      if (fieldsSection) fieldsSection.hidden = false;
      hasStructured = true;
    } else {
      if (fieldsSection) fieldsSection.hidden = true;
    }
  }

  // 4. Data source citations
  const citations = preview.citations || preview.sources || preview.dataSources || [];
  if (citationsList) {
    citationsList.replaceChildren();
    if (Array.isArray(citations) && citations.length > 0) {
      for (const cite of citations) {
        const li = document.createElement('li');
        if (typeof cite === 'string') {
          li.textContent = cite;
        } else if (cite && typeof cite === 'object') {
          li.textContent = cite.title || cite.path ? `${cite.title || cite.path}${cite.line ? ` (line ${cite.line})` : ''}` : JSON.stringify(cite);
        }
        citationsList.append(li);
      }
      if (citationsSection) citationsSection.hidden = false;
      hasStructured = true;
    } else {
      if (citationsSection) citationsSection.hidden = true;
    }
  }

  if (previewEl) previewEl.hidden = !hasStructured;
  return preview;
}

function renderSubmissionOutcome(outcome, details = {}) {
  const valid = ['confirmed', 'failed', 'unknown'];
  if (!valid.includes(outcome)) {
    throw new Error(`Invalid submission outcome: ${outcome}. Must be confirmed, failed, or unknown.`);
  }

  const message = details.message || details.note || details.error || '';
  forbidDraftResetUndoingSubmission(message);
  forbidDraftResetUndoingSubmission(details.description || '');

  const approvalEl = $("approval");
  const outcomeEl = $("approvalOutcome");
  const badgeEl = $("outcomeBadge");
  const msgEl = $("outcomeMessage");
  const actionsEl = $("approvalActions") || document.querySelector('.approvalChoices');

  if (badgeEl) {
    badgeEl.className = `outcomeBadge ${outcome}`;
    badgeEl.dataset.outcome = outcome;
    badgeEl.setAttribute('aria-label', `Outcome: ${outcome}`);
    if (outcome === 'confirmed') {
      badgeEl.textContent = 'Confirmed';
    } else if (outcome === 'failed') {
      badgeEl.textContent = 'Failed';
    } else {
      badgeEl.textContent = 'Unknown outcome';
    }
  }

  if (msgEl) {
    msgEl.textContent = message || (
      outcome === 'confirmed' ? 'Submission confirmed by destination.' :
      outcome === 'failed' ? 'Submission failed.' :
      'Submission outcome unknown. Check destination before retrying.'
    );
  }

  if (outcomeEl) {
    outcomeEl.setAttribute('role', 'status');
    outcomeEl.setAttribute('aria-live', 'polite');
    outcomeEl.hidden = false;
  }
  if (actionsEl) actionsEl.hidden = true;
  if (approvalEl) approvalEl.hidden = false;

  const destUrl = details.destination || details.url;
  if (destUrl) {
    const card = document.querySelector(`.resultCard[data-url="${CSS.escape(destUrl)}"]`);
    if (card) {
      let cardBadge = card.querySelector('.outcomeBadge');
      if (!cardBadge) {
        cardBadge = document.createElement('span');
        card.querySelector('div')?.append(cardBadge);
      }
      cardBadge.className = `outcomeBadge ${outcome}`;
      cardBadge.dataset.outcome = outcome;
      cardBadge.textContent = outcome === 'confirmed' ? 'Confirmed' : outcome === 'failed' ? 'Failed' : 'Unknown';
    }
  }

  return { outcome, message, destination: destUrl };
}

function isConsequentialAction(name, args) {
  if (name === 'upload_files') return true;
  if (args?.consequential || args?.isSubmission) return true;
  if (name === 'browser_step' && args?.clickSelector) return true;
  if (name === 'click' && args?.selector && /\b(?:submit|apply|confirm|purchase|pay|send|delete|checkout)\b/i.test(args.selector)) return true;
  return false;
}

function extractCitations(messages) {
  const sources = new Set();
  for (const msg of messages || []) {
    if (msg.role === 'assistant') {
      for (const call of msg.tool_calls || []) {
        try {
          const fnArgs = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
          if (fnArgs?.path) sources.add(fnArgs.path);
          if (Array.isArray(fnArgs?.paths)) fnArgs.paths.forEach(p => sources.add(p));
        } catch {}
      }
    }
  }
  return [...sources];
}

function determineSubmissionOutcome(result, error) {
  if (error || result?.error) return 'failed';
  if (result?.confirmed === true || result?.verified === true ||
      (result?.page?.text && /\b(?:thank you|successfully submitted|application (?:has been )?submitted|submission (?:received|confirmed|successful)|confirmation (?:number|code|#|id)|order (?:placed|confirmed)|we(?:'ve| have) received your|application has been confirmed|order has been confirmed|payment has been confirmed)\b/i.test(result.page.text))) {
    return 'confirmed';
  }
  return 'unknown';
}

function requestApproval(details) {
  setRunState(RunState.WAITING, "Waiting for approval…");
  const callSignal = controller?.signal;
  const task = approvalQueue.then(() => new Promise((resolve, reject) => {
    const signal = callSignal;
    if (signal?.aborted) { reject(new Error("Stopped")); return; }
    const preview = renderActionPreview(details);
    const text = typeof details === 'string' ? details : (details?.text || $("approvalText")?.textContent || '');
    const site = details?.site;

    const actionsEl = $("approvalActions") || document.querySelector('.approvalChoices');
    if (actionsEl) actionsEl.hidden = false;

    if ($("approvalText")) $("approvalText").textContent = text;
    if ($("allowSite")) $("allowSite").textContent = site ? "Allow for this site (1 hr)" : "Allow for this site (1 hr)";
    if ($("approval")) $("approval").hidden = false;

    const finish = choice => {
      cleanup();
      if (choice === 'deny') {
        if ($("approval")) $("approval").hidden = true;
        reject(new Error("User did not allow this action."));
      } else {
        if (!preview.isConsequential) {
          if ($("approval")) $("approval").hidden = true;
        } else {
          if (actionsEl) actionsEl.hidden = true;
        }
        setRunState(RunState.RUNNING, "Thinking…");
        resolve(choice);
      }
    };

    const onAllowOnce = () => finish('once');
    const onAllowTask = () => finish('task');
    const onAllowSite = () => finish('site');
    const onDeny = () => finish('deny');

    function cleanup() {
      $("allowOnce")?.removeEventListener("click", onAllowOnce);
      $("allowTask")?.removeEventListener("click", onAllowTask);
      $("allowSite")?.removeEventListener("click", onAllowSite);
      $("denyAction")?.removeEventListener("click", onDeny);
      $("allowAction")?.removeEventListener("click", onAllowOnce);
      signal?.removeEventListener("abort", onDeny);
    }

    $("allowOnce")?.addEventListener("click", onAllowOnce);
    $("allowTask")?.addEventListener("click", onAllowTask);
    $("allowSite")?.addEventListener("click", onAllowSite);
    $("denyAction")?.addEventListener("click", onDeny);
    $("allowAction")?.addEventListener("click", onAllowOnce);
    signal?.addEventListener("abort", onDeny, { once: true });
    ($("allowOnce") || $("allowAction"))?.focus();
  }));
  approvalQueue = task.catch(() => {});
  return task;
}
async function browserTool(name, args) {
  const durableSession = typeof OmniTaskClient !== 'undefined' ? OmniTaskClient.session : null;
  const descriptor = mcpCatalogue.find(item => item.function?.name === name);
  if (durableSession && OmniTaskSession.isWrite(name, descriptor)) {
    if (accessMode === 'full') {
      const pending = durableSession.unreviewedWrites;
      const inspected = [];
      for (const tabId of new Set(pending.map(item => item.tabId).filter(Number.isSafeInteger))) {
        const page = await browserTool('read_page', { tabId });
        if (!page || page.error || page.completed === false) throw new Error('Could not inspect the earlier action destination. Read its current state before continuing.');
        inspected.push(...pending.filter(item => item.tabId === tabId).map(item => item.id));
      }
      controller?.signal.throwIfAborted();
      if (inspected.length) await durableSession.acknowledgeReview({ source: 'automatic', ids: inspected });
      const target = String(args?.selector || args?.ref || args?.clickSelector || '');
      const repeat = durableSession.uncertainWrites.some(item =>
        item.reviewSource !== 'user' && item.tabId === args?.tabId &&
        // A fresh ref or alternate selector could activate the same control.
        // Finish independent field edits without replaying an uncertain click.
        ((target && target === item.target) || (!target && name === item.name) ||
          (['click', 'browser_step'].includes(item.name) &&
            (name === 'click' || name === 'browser_step' && (args?.clickSelector || args?.clickRef)))) &&
        !['fill', 'select_option', 'set_checked', 'scroll', 'hover'].includes(name));
      if (repeat) return { completed: false, error: 'The earlier action has an unknown outcome and was not repeated. Inspect for confirmation and continue the remaining work.', unknownOutcome: true };
    } else if (durableSession.unreviewedWrites.length) {
      await requestApproval({ text: `An earlier action has an uncertain outcome. Check its destination before allowing ${name.replaceAll('_', ' ')}.`, name, args });
      controller?.signal.throwIfAborted();
      await durableSession.acknowledgeReview();
    }
  }
  if (name === 'request_user_input') {
    setRunState(RunState.WAITING, 'Waiting for your answers…');
    try {
      return await OmniQuestions.request(args, {
        container: activeWorkBody || $("messages"), signal: controller?.signal,
        onAnswered: text => { appendMessage('user', text); }
      });
    } finally {
      if (!controller?.signal.aborted) setRunState(RunState.RUNNING, 'Thinking…');
    }
  }
  if (Number.isSafeInteger(args?.tabId)) lastActiveTabId = args.tabId;

  const recipeName = name === 'recipe_run' ? name : null;
  const recipeArguments = recipeName ? args : null;
  if (recipeName) {
    const prepared = await rawBrowserTool('recipe_prepare', args);
    args = { tabId: args.tabId, actions: prepared.actions };
    name = 'batch_actions';
  }

  const isConsequential = isConsequentialAction(name, args) || name.startsWith('mcp__') && descriptor?.readOnly !== true && descriptor?.annotations?.readOnlyHint !== true;
  let liveSourceUrl = null;
  let destination = args?.url || args?.destination || '';
  if (Number.isSafeInteger(args?.tabId) && chrome.tabs?.get) {
    try {
      const tab = await chrome.tabs.get(args.tabId);
      liveSourceUrl = tab?.url || '';
      if (name !== 'navigate') destination = tab?.url || '';
      policyEngine.tabSites.delete(args.tabId);
      if (destination) policyEngine.setTabSite(args.tabId, destination);
    } catch {}
  }
  if (!destination && currentOriginTab?.url) destination = currentOriginTab.url;
  const urls = Array.isArray(args?.tabIds) ? (await Promise.all(args.tabIds.map(async id => {
    try { return (await chrome.tabs.get(id)).url; } catch { return null; }
  }))).filter(Boolean) : null;
  const directPermission = policyEngine.checkPermission(name, args, { originTab: currentOriginTab, currentUrl: destination, descriptor, urls });
  const recipePermission = recipeName ? policyEngine.checkPermission(recipeName, recipeArguments, { originTab: currentOriginTab, currentUrl: destination, descriptor, urls }) : directPermission;
  const perm = recipePermission.decision === 'deny' ? recipePermission : directPermission.decision === 'deny' ? directPermission : recipePermission.decision === 'ask' ? recipePermission : directPermission;
  if (perm.decision === 'deny') throw new Error(perm.reason);

  let record = args?.record || args?.affectedRecord || '';
  if (!record) {
    if (name === 'browser_step' && args?.clickSelector) {
      record = `Submission via ${args.clickSelector}`;
    } else if (name === 'click') {
      record = `Action on ${args.selector}`;
    } else if (args?.actions) {
      record = `Form with ${args.actions.length} fields`;
    } else {
      record = `${name.replaceAll('_', ' ')} record`;
    }
  }

  const fields = args?.fields || (args?.actions ? args.actions.map(a => ({
    name: a.selector,
    value: a.value !== undefined ? a.value : (a.checked !== undefined ? (a.checked ? 'Checked' : 'Unchecked') : '')
  })) : (args?.selector && args?.value !== undefined ? [{ name: args.selector, value: args.value }] : []));

  const citations = args?.citations || args?.sources || extractCitations(history);

  const hasScopedGrant = perm.allowed && perm.reason !== 'safe_tool';
  const needsApproval = perm.decision === 'ask' || !hasScopedGrant && (accessMode === 'ask'
    ? !policyEngine.isSafe(name) || ['search_web', 'fetch_web', 'read_page', 'read_pages'].includes(name) || isConsequential
    : accessMode === 'auto' && isConsequential);
  if (needsApproval) {
    let site = perm.site;
    if (!site && args?.tabId) {
      site = policyEngine.getTabSite(args.tabId) || (currentOriginTab?.url ? extractSite(currentOriginTab.url) : null);
    }
    const targetPath = perm.target || args?.path || (args?.paths ? args.paths[0] : null);
    const description = `Allow ${name.replaceAll("_", " ")}? ${
      args?.actions ? `${args.actions.length} fields${args.clickSelector ? `, then click ${args.clickSelector}` : ''}` :
      name === 'handle_dialog' ? `${args.accept !== false ? 'Accept' : 'Dismiss'}${args.prompt_text ? ` ("${args.prompt_text}")` : ''}` :
      name === 'press_key' ? `key ${args.key}` :
      name === 'type_text' ? `text "${args.text?.slice(0, 50)}"` :
      name === 'upload_files' ? `${args.paths?.length || 0} files on ${args.selector || ''}` :
      args?.path || args?.paths?.join(", ") || args?.url || args?.selector || site || ""
    }`;
    const choice = await requestApproval({
      text: description,
      destination,
      record,
      fields,
      citations,
      isConsequential,
      site,
      targetPath,
      name,
      args
    });
    if (choice === 'once') {
      // Allowed once for this action
    } else if (choice === 'task') {
      if (descriptor?.mcpServer) policyEngine.rules.push({ tool: name, mcpServer: descriptor.mcpServer, taskId: policyEngine.activeTaskId, decision: 'allow' });
      else if (site) policyEngine.grantSite(site, 'task');
      if (targetPath) policyEngine.grantFolder(targetPath, 'task');
      await saveGrants();
      renderPermissionsUI();
    } else if (choice === 'site') {
      if (descriptor?.mcpServer) policyEngine.rules.push({ tool: name, mcpServer: descriptor.mcpServer, expiresAt: Date.now() + 3600000, decision: 'allow' });
      else if (site) policyEngine.grantSite(site, 'time', 3600000);
      if (targetPath) policyEngine.grantFolder(targetPath, 'time', 3600000);
      await saveGrants();
      renderPermissionsUI();
    }
  }

  if (currentRunDiagnostics) {
    if (args?.tabId !== undefined) currentRunDiagnostics.participatingTabIds.add(args.tabId);
    if (Array.isArray(args?.tabIds)) args.tabIds.forEach(id => currentRunDiagnostics.participatingTabIds.add(id));
  }

  const callStart = performance.now();
  const ledgerItem = {
    id: crypto.randomUUID(),
    action: name,
    tabId: args?.tabId,
    args: args ? structuredClone(args) : {},
    timestamp: Date.now(),
    status: 'running'
  };
  if (currentRunDiagnostics) currentRunDiagnostics.actionLedger.push(ledgerItem);
  if (durableSession) await OmniTaskClient.publish(true);
  controller?.signal.throwIfAborted();
  let dispatchDestination = destination;
  if (liveSourceUrl) {
    const liveUrl = (await chrome.tabs.get(args.tabId)).url;
    if (OmniTaskSession.isWrite(name, descriptor) && liveUrl !== liveSourceUrl)
      throw new Error('The destination changed while the action was being prepared. Inspect the page again before continuing.');
    if (name !== 'navigate') dispatchDestination = liveUrl;
  }
  const dispatchUrls = Array.isArray(args?.tabIds) ? (await Promise.all(args.tabIds.map(async id => {
    try { return (await chrome.tabs.get(id)).url; } catch { return null; }
  }))).filter(Boolean) : null;
  const dispatchContext = { originTab: currentOriginTab, currentUrl: dispatchDestination, descriptor, urls: dispatchUrls };
  const dispatchPermissions = [policyEngine.checkPermission(name, args, dispatchContext)];
  if (recipeName) dispatchPermissions.push(policyEngine.checkPermission(recipeName, recipeArguments, dispatchContext));
  const dispatchDenied = dispatchPermissions.find(permission => permission.decision === 'deny');
  if (dispatchDenied) throw new Error(dispatchDenied.reason);
  if ((hasScopedGrant && dispatchPermissions.some(permission => !permission.allowed)) ||
      (!needsApproval && dispatchPermissions.some(permission => permission.decision === 'ask')))
    throw new Error('Permissions changed while the action was being prepared. Review the action before continuing.');
  controller?.signal.throwIfAborted();
  const durableActionId = durableSession ? await durableSession.begin(name, args, descriptor) : null;

  const executeCall = async () => {
    if (name === 'screenshot') {
      try {
        if (chrome.tabs?.captureVisibleTab) {
          const tab = await chrome.tabs.get(args.tabId);
          await chrome.tabs.update(args.tabId, { active: true });
          if (tab.windowId) await chrome.windows?.update(tab.windowId, { focused: true }).catch(() => {});
          await new Promise(r => setTimeout(r, 100));
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
          const res = { screenshot: base64Data };
          renderScreenshot(base64Data);
          return res;
        }
      } catch (e) {
        // Fall back to rawBrowserTool
      }
      const res = await rawBrowserTool(name, args);
      if (res?.screenshot) renderScreenshot(res.screenshot);
      return res;
    }
    if (name === 'handle_dialog') {
      try {
        if (chrome.debugger) {
          try { await chrome.debugger.attach({ tabId: args.tabId }, "1.3"); } catch {}
          const accept = args.accept !== false;
          return await new Promise((resolve, reject) => {
            chrome.debugger.sendCommand({ tabId: args.tabId }, "Page.handleJavaScriptDialog", {
              accept,
              promptText: args.prompt_text || ""
            }, res => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve({ handled: true, accepted: accept, ...res });
            });
          });
        }
      } catch (e) {
        // Fall through to rawBrowserTool
      }
      return await rawBrowserTool(name, args);
    }
    return await rawBrowserTool(name, args);
  };

  let result;
  let execError = null;
  try {
      result = await executeCall();
      ledgerItem.durationMs = Math.round(performance.now() - callStart);
      ledgerItem.status = 'complete';
      ledgerItem.result = result ? structuredClone(result) : {};
      if (currentRunDiagnostics && result?.id && (name === 'new_tab' || name === 'create_tab')) {
        currentRunDiagnostics.participatingTabIds.add(result.id);
      }
      if (name === 'navigate' && args?.tabId && args?.url) {
        policyEngine.setTabSite(args.tabId, args.url);
      } else if (name === 'new_tab' && (result?.tabId || result?.id) && args?.url) {
        policyEngine.setTabSite(result.tabId || result.id, args.url);
      } else if (result?.page?.url && (args?.tabId || result.tabId)) {
        policyEngine.setTabSite(result.tabId || args.tabId, result.page.url);
      }
    }
    catch (error) {
      if (!name.startsWith("files_") || !/allowed folders|No local folders|File access is disabled/.test(error.message)) {
        ledgerItem.durationMs = Math.round(performance.now() - callStart);
        ledgerItem.status = 'failed';
        ledgerItem.error = error.message;
        execError = error;
      } else {
        const paths = args.paths || [args.path];
        for (const path of paths) {
          if (!path) throw error;
          await folderRequest("allow_path", { path });
          policyEngine.grantFolder(path, 'time', 3600000);
        }
        await saveGrants();
        renderPermissionsUI();
        try {
          result = await executeCall();
          ledgerItem.durationMs = Math.round(performance.now() - callStart);
          ledgerItem.status = 'complete';
          ledgerItem.result = result ? structuredClone(result) : {};
        } catch (retryError) {
          ledgerItem.durationMs = Math.round(performance.now() - callStart);
          ledgerItem.status = 'failed';
          ledgerItem.error = retryError.message;
          execError = retryError;
        }
      }
    }

    if (isConsequential && !result?.submissionBlocked && !result?.blockedByUser) {
      const outcome = determineSubmissionOutcome(result, execError);
      renderSubmissionOutcome(outcome, {
        destination,
        record,
        message: execError ? execError.message : (result?.error || (
          outcome === 'confirmed' ? 'Submission confirmed by destination.' :
          outcome === 'failed' ? 'Submission failed.' :
          'Submission outcome unknown. Check destination before retrying.'
        ))
      });
    }

    if (durableActionId) await durableSession.settle(durableActionId, result, execError);
    if (execError) throw execError;
    return result;
}
async function setAccess(mode) {
  if (!['ask', 'auto', 'full'].includes(mode)) return;
  await folderRequest("set_access", { mode }).catch(() => {});
  accessMode = mode;
  await chrome.storage.local.set({ aiAccessMode: mode }).catch(() => {});
  renderPermissionsUI();
  if ($("accessMenu")) $("accessMenu").open = false;
}
if (typeof document !== 'undefined') {
  document.querySelectorAll('[data-access]').forEach(button => {
    button.addEventListener('click', () => setAccess(button.dataset.access));
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && $("accessMenu")) $("accessMenu").open = false; });
  document.addEventListener("click", event => { if ($("accessMenu") && !$("accessMenu").contains(event.target)) $("accessMenu").open = false; });
}

function hasUnknownOutcome(messages, workBody) {
  if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.session?.uncertainWrites.length) return true;
  if (!$("approvalOutcome").hidden && ['unknown', 'failed'].includes($("outcomeBadge").dataset.outcome)) return true;
  if (!workBody) return false;
  const planItems = [...workBody.querySelectorAll('.taskPlan li')];
  if (planItems.length > 0) {
    const hasBlocked = planItems.some(li => li.dataset.status === 'blocked');
    const hasIncomplete = planItems.some(li => ['running', 'pending'].includes(li.dataset.status));
    if (hasBlocked || hasIncomplete) return true;
  }
  const results = [...workBody.querySelectorAll('.resultCard')];
  if (results.length > 0) {
    const hasBlockedResult = results.some(card => {
      try { return ['blocked', 'outcome_unknown', 'needs_evidence'].includes(JSON.parse(card.dataset.result).status); } catch { return false; }
    });
    if (hasBlockedResult) return true;
  }
  return false;
}

async function runTask(prompt, ownedStart = false) {
  if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.enabled && !ownedStart)
    return OmniTaskClient.start(prompt);
  if (controller || submissionPending) return;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) return;
  $("approvalOutcome").hidden = true;
  $("approval").hidden = true;
  submissionPending = true;
  policyEngine.setTaskId(typeof OmniTaskClient !== 'undefined' && OmniTaskClient.session ? OmniTaskClient.session.record.taskId : crypto.randomUUID());
  steeringMessages = [];
  lastFailedTool = null;

  // Start capturing immediately, before settings/model requests can delay the run.
  const originTabPromise = (async () => {
    if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.originTab) return OmniTaskClient.originTab;
    try {
      const tab = chrome.tabs?.query ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0] : await rawBrowserTool('current_tab', {});
      if (!Number.isSafeInteger(tab?.id)) return null;
      return { id: tab.id, title: tab.title || '', url: tab.url || '', windowId: tab.windowId };
    } catch { return null; }
  })();
  try { await saveSettings(); } catch (error) {
    submissionPending = false;
    $("settingsPanel").open = true;
    $("settingsDialog").showModal();
    $("settingsFeedback").textContent = error.message;
    return;
  }
  const originTab = await originTabPromise;
  currentOriginTab = originTab;
  if (originTab?.id) lastActiveTabId = originTab.id;
  submissionPending = false;
  const runController = new AbortController();
  const previousUsage = typeof OmniTaskClient !== 'undefined' ? OmniTaskClient.session?.record.usageStats || {} : {};
  const taskDeadline = settings().taskMinutes > 0 ? setTimeout(() => runController.abort(new Error('Task time limit reached.')), Math.max(1, settings().taskMinutes * 60000 - (previousUsage.elapsedMs || 0))) : null;
  streamedMessages.clear(); toolRows.clear(); $("toolActivity").replaceChildren(); $("toolActivity").hidden = true;
  const startTime = performance.now();
  controller = runController;
  currentRunDiagnostics = {
    runId: crypto.randomUUID(),
    startTime: Date.now(),
    originTab,
    participatingTabIds: new Set(originTab?.id !== undefined ? [originTab.id] : []),
    actionLedger: [],
    networkResponses: [],
    consoleLogs: []
  };
  $("historyButton").disabled = true; $("settingsButton").disabled = true; $("modelButton").disabled = true; closeModelMenu();
  appendMessage("user", prompt);
  resizeComposer();
  const work = document.createElement('details'); work.className = 'workLog isLive'; work.open = true;
  const workSummary = document.createElement('summary'); workSummary.textContent = 'Working…';
  const workBody = document.createElement('div'); workBody.className = 'workBody';
  activeWorkBody = workBody;
  work.append(workSummary, workBody); $("messages").append(work);
  let checkpointed = false;
  const recordProgress = text => {
    const follow = nearBottom();
    const entry = document.createElement('p'); entry.className = 'workProgress'; entry.textContent = text;
    workBody.append(entry);
    if (follow) $("messages").scrollTop = $("messages").scrollHeight;
  };
  $("send").disabled = false;
  $("send").setAttribute('aria-label', 'Send a follow-up instruction');
  $("prompt").placeholder = 'Add a detail or change direction while I work…';
  $("newChat").disabled = true;
  $("stop").hidden = false;
  setRunState(RunState.RUNNING, "Thinking…");
  $("settingsPanel").open = false;
  $("filesPanel").open = false;
  document.body.classList.add('working');

  let runOutcome = RunState.COMPLETED;

  try {
    if (settings().mcpTools && connectedMcpConfig) {
      try { const status = await mcpRequest('configure', connectedMcpConfig); showMcpStatus(status);
        for (const server of status.servers || []) if (!server.connected) recordProgress(`${server.name}: ${server.error}`);
      } catch (error) { mcpCatalogue = []; recordProgress(error.message); }
    }
    let recalledMemories = [];
    if (settings().memoryTools) {
      try {
        const result = await rawBrowserTool('memory_search', { query: prompt.slice(0, 1000), limit: 5, recall: true,
          ...(/^https?:\/\//.test(originTab?.url || '') ? { url: originTab.url } : {}) });
        recalledMemories = result.memories || [];
        if (recalledMemories.length) recordProgress(`Recalled ${recalledMemories.length} relevant ${recalledMemories.length === 1 ? 'memory' : 'memories'}.`);
      } catch (error) { recordProgress(`Saved memories could not be searched: ${error.message}`); }
    }
    runController.signal.throwIfAborted();
    const updated = await OmniSidebarAgent.run({ settings: settings(), history, contextState, mcpTools: mcpCatalogue, recalledMemories, prompt, originTab,
      executeTool: browserTool, signal: runController.signal, budgetState: previousUsage,
      drainUserMessages: () => steeringMessages.splice(0),
      onEvent: event => {
        if (typeof OmniTaskClient !== 'undefined') OmniTaskClient.publish();
        if (event.type === "checkpoint") { history = structuredClone(event.history); contextState = event.contextState || {}; checkpointed = true; persistChat(); }
        else if (event.type === 'task_usage') {
          if (typeof OmniTaskClient !== 'undefined') OmniTaskClient.setUsage(event);
          $("taskUsage").textContent = `${event.estimated ? '~' : ''}${event.tokens.toLocaleString()} tokens${event.cost !== null ? ` · ~$${event.cost.toFixed(4)}` : ''}`;
        }
        else if (event.type === 'context_usage') {
          $("contextFill").style.width = `${Math.min(100, Math.max(0, event.used / event.window * 100))}%`;
          animateChange($("contextUsage"));
          $("contextUsage").textContent = `${event.estimated ? '~' : ''}${Math.round(event.used / 1000)}k / ${Math.round(event.window / 1000)}k context`;
          const source = { manual: 'Manual setting', provider: 'Provider metadata', published: 'Published model limit', default: 'Default fallback' }[event.windowSource] || 'Configured limit';
          $("contextUsage").title = `${event.estimated ? 'Estimated' : 'Provider reported'} input tokens; ${source}: ${event.window.toLocaleString()} tokens; ${event.reserved.toLocaleString()} tokens reserved for the reply.`;
        }
        else if (event.type === "context_compacted") recordProgress(event.text);
        else if (event.type === 'plan') { renderPlan(workBody, event.steps); workSummary.textContent = `${event.steps.filter(step => step.status === 'complete').length} of ${event.steps.length} steps complete`; }
        else if (event.type === 'result') renderResult(workBody, event);
        else if (event.type === "assistant") { const content = appendMessage("assistant", event.text); if (event.intermediate) workBody.append(content.parentElement); }
        else if (event.type === 'assistant_delta') {
          let content = streamedMessages.get(event.turnId);
          if (!content) { content = appendMessage('assistant', ''); streamedMessages.set(event.turnId, content); }
          const follow = nearBottom();
          content.parentElement.dataset.text = event.content; content.textContent = event.content; content.classList.add('streaming');
          if (follow) $("messages").scrollTop = $("messages").scrollHeight;
          $("activity").textContent = 'Writing…';
        } else if (event.type === 'assistant_done') {
          const content = streamedMessages.get(event.turnId) || appendMessage('assistant', '');
          content.parentElement.dataset.text = event.text; content.classList.remove('streaming'); OmniChatRenderer.render(event.text, content);
          if (event.intermediate) workBody.append(content.parentElement);
        } else if (event.type === 'tool_start') {
          const follow = nearBottom();
          const row = document.createElement('div'); renderToolActivity(row, 'running', `${toolLabels[event.name] || event.text}${event.count > 1 ? ` · ${event.count} fields together` : ''}`);
          toolRows.set(event.id, row); workBody.append(row);
          if (follow) $("messages").scrollTop = $("messages").scrollHeight;
          $("activity").textContent = event.active > 1 ? `Working · ${event.active} tools at once` : 'Working with your tools…';
        } else if (event.type === 'tool_done') {
          if (event.error) {
            lastFailedTool = event.name;
          }
          const row = toolRows.get(event.id);
          if (row) { renderToolActivity(row, event.error ? 'failed' : 'complete', `${toolLabels[event.name] || event.name.replaceAll('_', ' ')}${event.count > 1 ? ` · ${event.count} fields together` : ''} · ${(event.duration / 1000).toFixed(1)}s`, event.error || ''); row.title = event.error || ''; }
          $("activity").textContent = event.active > 0 ? `Working · ${event.active} tools at once` : 'Thinking…';
        } else $("activity").textContent = event.text;
      }
    });
    history = updated;
    const lastMsg = updated?.at(-1);
    if (lastMsg?.content && typeof lastMsg.content === 'string' && /Completed \d+ tool rounds/i.test(lastMsg.content)) {
      runOutcome = RunState.UNKNOWN;
    } else if (hasUnknownOutcome(updated, workBody)) {
      runOutcome = RunState.UNKNOWN;
    } else {
      runOutcome = RunState.COMPLETED;
    }
  } catch (error) {
    if (runController.signal.aborted || error.name === 'AbortError' || error.message === 'Stopped') {
      runOutcome = RunState.STOPPED;
    } else if (error.outcome === 'unknown' || error.unknownOutcome || /unknown|uncertain|indeterminate/i.test(error.message)) {
      runOutcome = RunState.UNKNOWN;
    } else {
      runOutcome = RunState.FAILED;
    }
    const text = runOutcome === RunState.STOPPED ? `${runController.signal.reason?.message && runController.signal.reason.name !== 'AbortError' ? runController.signal.reason.message : 'Stopped.'} Actions already completed remain on the page.` : error.message;
    appendMessage("error", text);
    // Keep an API-valid history even when a tool sequence was interrupted.
    if (!checkpointed) history.push({ role: "user", content: OmniSidebarAgent.userPrompt(prompt, originTab) });
    history.push({ role: "assistant", content: text });
  } finally {
    const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(1);
    clearTimeout(taskDeadline);
    if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.session?.record.usageStats) {
      const usage = OmniTaskClient.session.record.usageStats;
      usage.elapsedMs = Math.max(usage.elapsedMs || 0, (previousUsage.elapsedMs || 0) + performance.now() - startTime);
    }
    const seconds = Math.round((performance.now() - startTime) / 1000);
    const timeFormatted = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

    if (runController.signal.aborted) {
      runOutcome = RunState.STOPPED;
    }

    if (runOutcome === RunState.STOPPED) {
      workSummary.textContent = `Stopped after ${timeFormatted}`;
      $("activity").textContent = `Stopped · ${elapsedSec}s`;
    } else if (runOutcome === RunState.FAILED) {
      workSummary.textContent = `Failed after ${timeFormatted}`;
      $("activity").textContent = `Failed · ${elapsedSec}s`;
    } else if (runOutcome === RunState.UNKNOWN) {
      workSummary.textContent = `Ended with unknown outcome after ${timeFormatted}`;
      $("activity").textContent = `Outcome uncertain · ${elapsedSec}s`;
    } else {
      workSummary.textContent = `Worked for ${timeFormatted}`;
      $("activity").textContent = `Finished · ${elapsedSec}s`;
    }

    setRunState(runOutcome);

    work.open = !!workBody.querySelector('.taskPlan, .taskResults');
    work.classList.remove('isLive');
    for (const row of toolRows.values()) if (row.classList.contains('running')) renderToolActivity(row, 'failed', row.querySelector('.toolLabel').textContent + ' · interrupted');
    controller = null;
    for (const text of steeringMessages.splice(0)) history.push({ role: 'user', content: text });
    $("send").setAttribute('aria-label', 'Send message');
    $("prompt").placeholder = 'Ask anything, or give me a task…';
    activeWorkBody = null;
    approvalQueue = Promise.resolve();
    const outcomeEl = $("approvalOutcome");
    const isOutcomeDisplayed = outcomeEl && !outcomeEl.hidden;
    const approvalEl = $("approval");
    if (approvalEl && !approvalEl.hidden && !isOutcomeDisplayed) {
      approvalEl.hidden = true;
    }
    $("send").disabled = false;
    $("newChat").disabled = false;
    $("stop").hidden = true;
    document.body.classList.remove('working');
    if (currentRunDiagnostics) {
      currentRunDiagnostics.endTime = Date.now();
      currentRunDiagnostics.totalDurationMs = Math.round(performance.now() - startTime);
      if (typeof OmniDiagnosticExporter !== 'undefined') {
        try {
          lastDiagnosticsBundle = OmniDiagnosticExporter.createBundle({
            runId: currentRunDiagnostics.runId,
            settings: settings(),
            originTab: currentRunDiagnostics.originTab,
            participatingTabIds: [...currentRunDiagnostics.participatingTabIds],
            actionLedger: currentRunDiagnostics.actionLedger,
            consoleLogs: currentRunDiagnostics.consoleLogs,
            networkResponses: currentRunDiagnostics.networkResponses,
            startTime: currentRunDiagnostics.startTime,
            endTime: currentRunDiagnostics.endTime,
            totalDurationMs: currentRunDiagnostics.totalDurationMs
          });
          if (typeof window !== 'undefined') window.__lastDiagnosticsBundle = lastDiagnosticsBundle;
        } catch (err) {
          console.warn('Diagnostic bundle error:', err);
        }
      }
    }
    $("historyButton").disabled = false; $("settingsButton").disabled = false; $("modelButton").disabled = false;
    await persistChat();
    if (typeof OmniTaskClient !== 'undefined') await OmniTaskClient.publish(true);
    $("prompt").focus();
  }
}

$("composer").addEventListener("submit", async event => {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.remoteActive) {
    await OmniTaskClient.command('followup', prompt).catch(error => { $('activity').textContent = error.message; });
    $('prompt').value = ''; resizeComposer();
    return;
  }
  if (controller) {
    steeringMessages.push(prompt);
    appendMessage('user', prompt);
    $("prompt").value = ''; resizeComposer();
    $("activity").textContent = 'Follow-up queued for the next action…';
    return;
  }
  if (submissionPending) return;
  $("prompt").value = "";
  await runTask(prompt);
});

$("resumeTask")?.addEventListener("click", () => {
  if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.enabled) {
    OmniTaskClient.recover(); return;
  }
  if (controller || submissionPending) return;
  const resumePrompt = "Continue the task from the current page state. Inspect the active tab and proceed with the remaining steps.";
  runTask(resumePrompt);
});

$("retryStep")?.addEventListener("click", () => {
  if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.enabled) {
    OmniTaskClient.recover(); return;
  }
  if (controller || submissionPending) return;
  const stepInfo = lastFailedTool ? ` (${lastFailedTool.replaceAll('_', ' ')})` : '';
  const retryPrompt = `Retry the last failed step${stepInfo}. Inspect the current page state first and retry the action idempotently.`;
  runTask(retryPrompt);
});

$("takeOverTab")?.addEventListener("click", async () => {
  try {
    const targetTabId = lastActiveTabId || currentOriginTab?.id;
    if (chrome.tabs?.update && Number.isSafeInteger(targetTabId)) {
      await chrome.tabs.update(targetTabId, { active: true });
      if (chrome.windows?.update && currentOriginTab?.windowId) {
        await chrome.windows.update(currentOriginTab.windowId, { focused: true });
      }
    } else if (chrome.tabs?.query) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        await chrome.tabs.update(tabs[0].id, { active: true });
      }
    }
    $("activity").textContent = "Tab brought to foreground. Complete actions manually, then click Resume.";
  } catch (err) {
    $("activity").textContent = "Could not activate tab: " + err.message;
  }
});

$("stop").addEventListener("click", () => {
  if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.remoteActive)
    OmniTaskClient.command('stop').catch(error => { $('activity').textContent = error.message; });
  else controller?.abort();
});
$("newChat").addEventListener("click", () => {
  if (controller) return;
  if (typeof OmniTaskClient !== 'undefined') OmniTaskClient.detach();
  persistChat();
  approvalQueue = Promise.resolve();
  currentOriginTab = null;
  lastActiveTabId = null;
  if ($("approval")) $("approval").hidden = true;
  if ($("approvalOutcome")) $("approvalOutcome").hidden = true;
  if ($("approvalPreview")) $("approvalPreview").hidden = true;
  policyEngine.clearTaskGrants(chatId);
  chatId = crypto.randomUUID();
  policyEngine.setTaskId(chatId);
  saveGrants();
  renderPermissionsUI();
  history = [];
  contextState = {}; $("contextUsage").textContent = '';
  document.querySelectorAll(".message, .workLog").forEach(message => message.remove());
  $("welcome").hidden = false;
  $("toolActivity").hidden = true; streamedMessages.clear(); toolRows.clear();
  lastFailedTool = null;
  setRunState(RunState.IDLE, '');
});
function resizeComposer() {
  const input = $("prompt");
  input.style.height = 'auto';
  const style = getComputedStyle(input);
  input.style.height = Math.min(parseFloat(style.maxHeight), Math.max(parseFloat(style.minHeight), input.scrollHeight)) + 'px';
}
$("prompt").addEventListener('input', resizeComposer);
$("prompt").addEventListener("keydown", event => {
  if (event.key === "Enter" && $("enterSend").checked && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
if (typeof document !== 'undefined') {
  document.querySelectorAll("[data-prompt]").forEach(button => button.addEventListener("click", () => {
    $("prompt").value = button.dataset.prompt; resizeComposer();
    $("prompt").focus();
  }));
}

function applyAppearance() {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = $("theme").value;
  document.documentElement.style.setProperty('--chat-size', $("textSize").value + 'px');
  document.body.classList.toggle('noShine', !$("shine").checked);
}
for (const field of ['theme', 'textSize', 'shine']) $(field).addEventListener('change', applyAppearance);
$("settingsButton").addEventListener('click', () => { $("settingsDialog").showModal(); $("settingsPanel").open = true; });
$("historyButton").addEventListener('click', () => { renderChatList(); $("historyDialog").showModal(); });
if (typeof document !== 'undefined') {
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  for (const id of ['settingsDialog', 'historyDialog']) $(id).addEventListener('click', event => { if (event.target === $(id)) { const rect = $(id).getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $(id).close(); } });
}
function closeModelMenu() { $("modelMenu").hidden = true; $("modelButton").setAttribute('aria-expanded', 'false'); }
function animateChange(element) {
  if (!element?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  element.getAnimations().forEach(animation => animation.cancel());
  element.animate([{ opacity: .35, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
function syncModelMenu() {
  if (typeof document === 'undefined') return;
  const modelName = $("model").value || 'Connect your AI';
  if ($("modelName").textContent !== modelName) animateChange($("modelName"));
  $("modelName").textContent = modelName;
  $("modelButton").title = modelName;
  const query = $("modelSearch").value.toLowerCase();
  $("modelOptions").replaceChildren();
  for (const option of $("modelPicker").options) {
    if (!option.value || !option.value.toLowerCase().includes(query)) continue;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = option.value;
    button.setAttribute('aria-pressed', String(option.value === $("model").value));
    button.addEventListener('click', async () => {
      $("modelPicker").value = option.value; $("model").value = option.value;
      closeModelMenu(); syncModelMenu(); $("modelButton").focus();
      try { await saveSettings(); } catch (error) { appendMessage('error', error.message); }
    });
    $("modelOptions").append(button);
  }
  if (!$("modelOptions").children.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Models are loading, or no matches were found. Refresh in Settings.'; $("modelOptions").append(empty); }
}
$("modelButton").addEventListener('click', () => {
  $("accessMenu").open = false;
  $("modelMenu").hidden = !$("modelMenu").hidden;
  $("modelButton").setAttribute('aria-expanded', String(!$("modelMenu").hidden));
  if (!$("modelMenu").hidden) { syncModelMenu(); $("modelSearch").focus(); }
});
$("modelSearch").addEventListener('input', syncModelMenu);
$("modelMenu").addEventListener('keydown', event => {
  const choices = [...$("modelOptions").querySelectorAll('button')];
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && choices.length) { event.preventDefault(); const index = choices.indexOf(document.activeElement); choices[(index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus(); }
});
if (typeof document !== 'undefined') {
  document.addEventListener('click', event => { if (!event.target.closest('.modelControl')) closeModelMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$("modelMenu").hidden) { closeModelMenu(); $("modelButton").focus(); } });
}
$("accessMenu").addEventListener('toggle', () => { if ($("accessMenu").open) closeModelMenu(); });
function serializeTranscript() {
  return [...$("messages").children].filter(node => node.matches('.message, .workLog')).map(node => {
    if (node.matches('.message')) return { role: node.dataset.role, text: node.dataset.text || node.textContent };
    return { work: true, title: node.querySelector('summary').textContent, entries: [...node.querySelector('.workBody').children].map(entry => {
      if (entry.matches('.taskPlan')) return { plan: JSON.parse(entry.dataset.steps) };
      if (entry.matches('.taskResults')) return { results: [...entry.querySelectorAll('.resultCard')].map(card => JSON.parse(card.dataset.result)) };
      if (entry.matches('.screenshotCard')) return { screenshot: entry.dataset.screenshot };
      return { text: entry.dataset.text || entry.textContent, ...(entry.dataset.detail ? { detail: entry.dataset.detail } : {}), role: entry.dataset.role, state: entry.classList.contains('failed') ? 'failed' : 'complete' };
    }) };
  });
}
function persistChat() {
  if (typeof OmniTaskClient !== 'undefined' && OmniTaskClient.observing) return Promise.resolve();
  if (!$("rememberChats").checked || !history.length) return Promise.resolve();
  const title = chats.find(item => item.id === chatId)?.title || history.find(message => message.role === 'user')?.content?.split('\n\n[Browser context at send time:')[0] || 'New chat';
  const chat = { id: chatId, title: title.slice(0, 80), updated: Date.now(), history: structuredClone(history), contextState: structuredClone(contextState), transcript: serializeTranscript() };
  chats = [chat, ...chats.filter(item => item.id !== chatId)].slice(0, 50);
  const snapshot = structuredClone(chats);
  chatSaveQueue = chatSaveQueue.catch(() => {}).then(() => chrome.storage.local.set({ aiChats: snapshot })).catch(() => { $("activity").textContent = 'Chat could not be saved. Storage may be full.'; });
  renderChatList();
  return chatSaveQueue;
}
function openChat(id) {
  if (controller) return;
  const chat = chats.find(item => item.id === id); if (!chat) return;
  chatId = id;
  policyEngine.setTaskId(id);
  renderPermissionsUI();
  history = structuredClone(chat.history); contextState = structuredClone(chat.contextState || {}); $("contextUsage").textContent = '';
  document.querySelectorAll('.message, .workLog').forEach(node => node.remove());
  $("welcome").hidden = true;
  for (const item of chat.transcript) {
    if (!item.work) { appendMessage(item.role || 'assistant', item.text); continue; }
    const work = document.createElement('details'); work.className = 'workLog';
    const summary = document.createElement('summary'); summary.textContent = item.title;
    const body = document.createElement('div'); body.className = 'workBody';
    work.append(summary, body); $("messages").append(work);
    for (const entry of item.entries) {
      if (entry.plan) { try { renderPlan(body, OmniSidebarAgent.validateWorkflow('update_plan', { steps: entry.plan }).steps); } catch {} }
      else if (entry.results) { for (const result of entry.results) { try { renderResult(body, result); } catch {} } }
      else if (entry.screenshot) renderScreenshot(entry.screenshot, body);
      else if (entry.role) body.append(appendMessage(entry.role, entry.text).parentElement);
      else { const row = document.createElement('div'); renderToolActivity(row, entry.state, entry.text.replace(/^(?:Completed: |Needs attention: |In progress: |[◌✓!]\s)/, ''), entry.detail || ''); body.append(row); }
    }
  }
  $("historyDialog").close();
  setRunState(RunState.IDLE, '');
  $("messages").scrollTop = $("messages").scrollHeight; renderChatList();
}
function renderChatList() {
  $("chatList").replaceChildren();
  const query = $("historySearch").value.toLowerCase();
  for (const chat of chats.filter(item => item.title.toLowerCase().includes(query))) {
    const row = document.createElement('div'); row.className = 'chatHistoryRow';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'chatHistoryOpen'; open.textContent = chat.title; open.setAttribute('aria-current', String(chat.id === chatId)); open.addEventListener('click', () => {
      persistChat();
      if (chat.id !== chatId && typeof OmniTaskClient !== 'undefined') OmniTaskClient.detach();
      openChat(chat.id);
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet iconButton'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Delete ' + chat.title);
    remove.addEventListener('click', async () => {
      chats = chats.filter(item => item.id !== chat.id);
      if (chat.id === chatId) {
        if (typeof OmniTaskClient !== 'undefined') OmniTaskClient.detach();
        chatId = crypto.randomUUID();
        policyEngine.setTaskId(chatId);
        policyEngine.clearTaskGrants(chatId);
        approvalQueue = Promise.resolve();
        currentOriginTab = null;
        lastActiveTabId = null;
        if ($("approval")) $("approval").hidden = true;
        if ($("approvalOutcome")) $("approvalOutcome").hidden = true;
        if ($("approvalPreview")) $("approvalPreview").hidden = true;
        history = [];
        contextState = {};
        $("contextUsage").textContent = "";
        document.querySelectorAll('.message, .workLog').forEach(node => node.remove());
        $("welcome").hidden = false;
        renderPermissionsUI();
      }
      await chatSaveQueue;
      await chrome.storage.local.set({ aiChats: chats });
      renderChatList();
    });
    row.append(open, remove); $("chatList").append(row);
  }
  if (!$("chatList").children.length) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No saved chats yet.'; $("chatList").append(empty); }
}
$("historySearch").addEventListener('input', renderChatList);

async function exportDiagnostics() {
  const exporter = typeof OmniDiagnosticExporter !== 'undefined' ? OmniDiagnosticExporter : null;
  if (!exporter) throw new Error('Diagnostic exporter is not available.');

  let allTabs = [];
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      allTabs = await chrome.tabs.query({});
    }
  } catch {}

  const participating = currentRunDiagnostics ? [...currentRunDiagnostics.participatingTabIds] : [];

  const bundle = exporter.createBundle({
    runId: currentRunDiagnostics?.runId || crypto.randomUUID(),
    settings: settings(),
    originTab: currentRunDiagnostics?.originTab || null,
    participatingTabIds: participating,
    tabs: allTabs,
    actionLedger: currentRunDiagnostics?.actionLedger || [],
    consoleLogs: currentRunDiagnostics?.consoleLogs || [],
    networkResponses: currentRunDiagnostics?.networkResponses || [],
    startTime: currentRunDiagnostics?.startTime || Date.now(),
    endTime: currentRunDiagnostics?.endTime || Date.now(),
    totalDurationMs: currentRunDiagnostics?.totalDurationMs || 0
  });

  lastDiagnosticsBundle = bundle;
  if (typeof window !== 'undefined') window.__lastDiagnosticsBundle = bundle;

  exporter.exportBundle(bundle, { download: true, clipboard: true });

  const feedback = $("settingsFeedback");
  if (feedback) feedback.textContent = `Diagnostics exported (${bundle.runId.slice(0, 8)}).`;

  return bundle;
}

if (typeof window !== 'undefined') window.exportDiagnostics = exportDiagnostics;

$("exportDiagnostics")?.addEventListener('click', async () => {
  const btn = $("exportDiagnostics");
  if (btn) btn.disabled = true;
  try {
    await exportDiagnostics();
  } catch (err) {
    const feedback = $("settingsFeedback");
    if (feedback) feedback.textContent = `Diagnostics export failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (async () => {
    try {
      const [saved, secret] = await Promise.all([
        chrome.storage.local.get(["aiSettings", "aiAccessMode", "aiGrants", "aiChats"]), chrome.storage.session.get(["aiApiKey", "aiMcpConfig"])
      ]);
      accessMode = ['ask', 'auto', 'full'].includes(saved.aiAccessMode) ? saved.aiAccessMode : 'ask';
      await folderRequest('set_access', { mode: accessMode }).catch(() => {});
      if (saved.aiGrants) {
        policyEngine.fromJSON(saved.aiGrants);
      }
      renderPermissionsUI();
      startCountdownTimer();
      chats = Array.isArray(saved.aiChats) ? saved.aiChats.filter(chat => chat && typeof chat.id === "string" && typeof chat.title === "string" && Array.isArray(chat.history) && Array.isArray(chat.transcript)) : [];
      renderChatList();
      if (saved.aiSettings) {
        for (const field of ["provider", "baseUrl", "model"]) $(field).value = saved.aiSettings[field] || "";
        $("browserTools").checked = saved.aiSettings.browserTools !== false;
        for (const option of ['fileTools', 'streaming', 'parallelTools', 'autoCompact', 'mcpTools', 'memoryTools']) $(option).checked = saved.aiSettings[option] !== false;
        $("contextWindowTokens").value = saved.aiSettings.contextWindowTokens || '';
        if (saved.aiSettings.model && saved.aiSettings.modelContextWindow) {
          modelMetadata[saved.aiSettings.model] = { contextWindow: saved.aiSettings.modelContextWindow, contextSource: saved.aiSettings.modelContextSource || 'provider' };
        }
        $("modelBadge").textContent = saved.aiSettings.model || "Set up your AI";
        for (const field of ['parallelLimit', 'maxRounds', 'timeoutSeconds', 'theme', 'textSize', 'taskMinutes', 'taskCostLimit', 'inputTokenPrice', 'outputTokenPrice'])
          if (saved.aiSettings[field] !== undefined) $(field).value = String(saved.aiSettings[field]);
        for (const field of ['shine', 'enterSend', 'rememberChats']) $(field).checked = saved.aiSettings[field] !== false;
      } else { $("settingsPanel").open = true; $("settingsDialog").showModal(); }
      if (!$("rememberChats").checked) { chats = []; await chrome.storage.local.remove("aiChats"); }
      applyAppearance();
      syncModelMenu();
      if (chats.length && $("rememberChats").checked) openChat(chats[0].id);
      $("apiKey").value = secret.aiApiKey || "";
      if (secret.aiMcpConfig) { $("mcpConfig").value = JSON.stringify(secret.aiMcpConfig, null, 2); connectedMcpConfig = secret.aiMcpConfig; await connectMcp(); }
      await setAccess(accessMode).catch(error => { $("folderFeedback").textContent = error.message; });
      queueModelFetch({ preserveMetadata: true });
      setRunState(RunState.IDLE, '');
      if (typeof OmniTaskClient !== 'undefined') await OmniTaskClient.initialize();
    } catch { $("settingsFeedback").textContent = "Could not load settings. Reload this extension."; }
  })();
}

if (typeof window !== 'undefined') {
  window.RunState = RunState;
  window.setRunState = setRunState;
  window.runTask = runTask;
  window.PolicyEngine = PolicyEngine;
  window.policyEngine = policyEngine;
  window.requestApproval = requestApproval;
  window.renderActionPreview = renderActionPreview;
  window.renderSubmissionOutcome = renderSubmissionOutcome;
  window.determineSubmissionOutcome = determineSubmissionOutcome;
  window.forbidDraftResetUndoingSubmission = forbidDraftResetUndoingSubmission;
  window.isConsequentialAction = isConsequentialAction;
  window.renderResult = renderResult;
}
if (typeof globalThis !== 'undefined') {
  globalThis.RunState = RunState;
  globalThis.PolicyEngine = PolicyEngine;
  globalThis.renderActionPreview = renderActionPreview;
  globalThis.renderSubmissionOutcome = renderSubmissionOutcome;
  globalThis.determineSubmissionOutcome = determineSubmissionOutcome;
  globalThis.forbidDraftResetUndoingSubmission = forbidDraftResetUndoingSubmission;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PolicyEngine,
    extractSite,
    normalizePath,
    isSubpath,
    formatRemainingTime,
    policyEngine,
    browserTool,
    requestApproval,
    renderActionPreview,
    renderSubmissionOutcome,
    determineSubmissionOutcome,
    forbidDraftResetUndoingSubmission,
    isConsequentialAction,
    renderResult
  };
}
