/**
 * Granular Scoped Policy Engine for OmniBrowser Assistant.
 * Evaluates permissions across 5 dimensions:
 * 1. Tool name
 * 2. Action category (browser_read, browser_write, navigation, file_read, mcp_call)
 * 3. Domain / Origin wildcard
 * 4. Folder path
 * 5. MCP server
 *
 * Supports scoped grants with expiration timestamps, task/chat lifetimes, and explicit revocation.
 */
(function (root) {
  'use strict';

  const ACTION_CATEGORIES = Object.freeze({
    BROWSER_READ: 'browser_read',
    BROWSER_WRITE: 'browser_write',
    NAVIGATION: 'navigation',
    FILE_READ: 'file_read',
    MCP_CALL: 'mcp_call'
  });

  const TOOL_CATEGORY_MAP = Object.freeze({
    // browser_read
    browser_context: 'browser_read',
    current_tab: 'browser_read',
    list_tabs: 'browser_read',
    read_page: 'browser_read',
    read_pages: 'browser_read',
    verify_task: 'browser_read', diagnostics_start: 'browser_read', diagnostics_read: 'browser_read', diagnostics_stop: 'browser_read',
    downloads_status: 'browser_read', recipe_list: 'browser_read',
    download_file: 'browser_write', recipe_run: 'browser_write', recipe_save: 'browser_write',
    form_inspect: 'browser_read',
    form_verify: 'browser_read',
    scroll: 'browser_write',
    wait_for: 'browser_read',
    captcha_status: 'browser_read',
    screenshot: 'browser_read',

    // browser_write
    click: 'browser_write',
    fill: 'browser_write',
    select_option: 'browser_write',
    set_checked: 'browser_write',
    batch_actions: 'browser_write',
    browser_step: 'browser_write',
    hover: 'browser_write',
    press_key: 'browser_write',
    type_text: 'browser_write',
    handle_dialog: 'browser_write',
    upload_files: 'browser_write',
    captcha_handoff: 'browser_write',

    // navigation
    navigate: 'navigation',
    new_tab: 'navigation',
    search_web: 'mcp_call',
    fetch_web: 'mcp_call',

    // file_read
    files_roots: 'file_read',
    files_locations: 'file_read',
    files_find_folder: 'file_read',
    files_list: 'file_read',
    files_search: 'file_read',
    files_extract: 'file_read',
    files_read_many: 'file_read',

    // workflow
    update_plan: 'workflow',
    record_result: 'workflow'
  });

  /**
   * Normalizes a file or directory path across Windows and POSIX conventions.
   * Resolves relative traversal segments (. and ..) safely without leaking above root.
   */
  function normalizePath(rawPath) {
    if (typeof rawPath !== 'string') return '';
    let str = rawPath.trim().replace(/\\/g, '/');
    if (!str) return '';

    let prefix = '';
    const driveMatch = /^([a-zA-Z]):(\/|$)/.exec(str);
    if (driveMatch) {
      prefix = driveMatch[1].toUpperCase() + ':';
      str = str.slice(2);
    } else if (str.startsWith('//')) {
      prefix = '//';
      str = str.slice(2);
    }

    const isAbsolute = str.startsWith('/') || Boolean(prefix);
    const parts = str.split('/').filter(Boolean);
    const resolved = [];

    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        if (resolved.length > (prefix === '//' ? 2 : 0) && resolved[resolved.length - 1] !== '..') {
          resolved.pop();
        } else if (!isAbsolute) {
          resolved.push('..');
        }
      } else {
        resolved.push(part);
      }
    }

    const body = resolved.join('/');
    if (prefix === '//') return prefix + body;
    if (prefix) {
      return prefix + '/' + body;
    }
    return (isAbsolute ? '/' : '') + body;
  }

  /**
   * Checks if targetPath is contained within or equal to folderPath.
   * Handles Windows case-insensitivity and strict directory separator boundaries.
   */
  function isPathWithin(targetPath, folderPath) {
    const target = normalizePath(targetPath);
    const folder = normalizePath(folderPath);
    if (!target || !folder) return false;

    const isWindows = /^[A-Z]:\//i.test(target) || /^[A-Z]:\//i.test(folder) || target.startsWith('//') || folder.startsWith('//');
    const t = isWindows ? target.toLowerCase() : target;
    const f = isWindows ? folder.toLowerCase() : folder;

    if (t === f) return true;
    const prefix = f.endsWith('/') ? f : f + '/';
    return t.startsWith(prefix);
  }

  /**
   * Simple glob pattern matcher (* matches any non-separator or separator as configured).
   */
  function matchGlob(str, pattern, caseInsensitive = false) {
    if (pattern === '*' || pattern === '**') return true;
    let s = str;
    let p = pattern;
    if (caseInsensitive) {
      s = s.toLowerCase();
      p = p.toLowerCase();
    }
    if (s === p) return true;

    const regexStr = '^' + p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§DOUBLE§')
      .replace(/\*/g, '[^/]*')
      .replace(/§DOUBLE§/g, '.*')
      .replace(/\?/g, '.') + '$';

    try {
      return new RegExp(regexStr).test(s);
    } catch {
      return false;
    }
  }

  /**
   * Matches a target path against a folder path or glob pattern.
   */
  function matchPath(targetPath, pattern) {
    if (!targetPath || !pattern) return false;
    if (pattern === '*' || pattern === '**') return true;

    const normTarget = normalizePath(targetPath);
    const normPattern = normalizePath(pattern);
    const isWindows = /^[A-Z]:\//i.test(normTarget) || /^[A-Z]:\//i.test(normPattern) || normTarget.startsWith('//') || normPattern.startsWith('//');

    if (pattern.includes('*') || pattern.includes('?')) {
      return matchGlob(normTarget, normPattern, isWindows);
    }
    return isPathWithin(normTarget, normPattern);
  }

  /**
   * Safely splits host and port, handling IPv6 brackets like [::1]:8080.
   */
  function splitHostAndPort(hostAndPort) {
    if (!hostAndPort) return ['', ''];
    const str = String(hostAndPort).trim();
    if (str.startsWith('[')) {
      const closeBracket = str.indexOf(']');
      if (closeBracket !== -1) {
        const host = str.slice(0, closeBracket + 1);
        const rest = str.slice(closeBracket + 1);
        const port = rest.startsWith(':') ? rest.slice(1) : '';
        return [host, port];
      }
    }
    const colonCount = (str.match(/:/g) || []).length;
    if (colonCount === 1) {
      const parts = str.split(':');
      return [parts[0], parts[1]];
    }
    if (colonCount > 1) {
      return [str, ''];
    }
    return [str, ''];
  }

  /**
   * Parses domain, origin, protocol, and hostname from URL or domain string.
   */
  function extractDomainAndOrigin(input) {
    if (typeof input !== 'string' || !input.trim()) return null;
    const trimmed = input.trim();
    try {
      const hasProto = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
      let toParse = trimmed;
      if (!hasProto) {
        const colonCount = (trimmed.match(/:/g) || []).length;
        if (colonCount >= 2 && !trimmed.startsWith('[')) {
          toParse = `https://[${trimmed}]`;
        } else {
          toParse = `https://${trimmed}`;
        }
      }
      const url = new URL(toParse);
      return {
        hostname: url.hostname.toLowerCase(),
        origin: url.origin.toLowerCase(),
        protocol: url.protocol.toLowerCase(),
        port: url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '')
      };
    } catch {
      const hostPart = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').split('/')[0];
      const [h, p] = splitHostAndPort(hostPart);
      return {
        hostname: h.toLowerCase(),
        origin: trimmed.toLowerCase(),
        protocol: '',
        port: p || ''
      };
    }
  }

  /**
   * Matches hostname against wildcard pattern like *.example.com or example.com.
   */
  function matchHost(host, pattern) {
    if (!host || !pattern) return false;
    const h = host.toLowerCase();
    const p = pattern.toLowerCase();
    if (p === '*' || p === '**') return true;
    if (h === p) return true;
    if (h.replace(/^\[|\]$/g, '') === p.replace(/^\[|\]$/g, '')) return true;

    if (p.startsWith('*.')) {
      const rootDomain = p.slice(2);
      return h === rootDomain || h.endsWith('.' + rootDomain);
    }
    if (p.startsWith('.')) {
      const rootDomain = p.slice(1);
      return h === rootDomain || h.endsWith('.' + rootDomain);
    }

    if (p.includes('*')) {
      const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`, 'i').test(h);
    }
    return false;
  }

  /**
   * Matches target URL, domain, or origin against pattern.
   * Supports:
   * - '*' or '<all_urls>'
   * - '*.example.com', 'example.com'
   * - 'https://*.example.com', 'http://localhost:*'
   */
  function matchDomainOrOrigin(target, pattern) {
    if (!target || !pattern) return false;
    const p = pattern.trim();
    if (p === '*' || p === '<all_urls>' || p === '*://*/*') return true;

    const parsed = typeof target === 'object' && target.hostname ? target : extractDomainAndOrigin(target);
    if (!parsed) return false;

    if (p.includes('://')) {
      const protoEnd = p.indexOf('://');
      const expectedProto = p.slice(0, protoEnd).toLowerCase();
      if (expectedProto !== '*' && parsed.protocol && parsed.protocol !== `${expectedProto}:`) {
        return false;
      }
      const hostAndPort = p.slice(protoEnd + 3).replace(/\/.*$/, '');
      const [hostPattern, portPattern] = splitHostAndPort(hostAndPort);
      const effectivePort = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
      if (portPattern && portPattern !== '*' && effectivePort !== portPattern) {
        return false;
      }
      if (!portPattern && expectedProto !== '*') {
        const defaultPort = expectedProto === 'https' ? '443' : expectedProto === 'http' ? '80' : '';
        if (effectivePort !== defaultPort) return false;
      }
      return matchHost(parsed.hostname, hostPattern);
    }

    const hostAndPort = p.split('/')[0];
    const [hostPattern, portPattern] = splitHostAndPort(hostAndPort);
    const effectivePort = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    if (portPattern && portPattern !== '*' && effectivePort !== portPattern) {
      return false;
    }
    return matchHost(parsed.hostname, hostPattern);
  }

  /**
   * Matches tool name against exact string or wildcard pattern.
   */
  function matchToolName(toolName, pattern) {
    if (!pattern || pattern === '*') return true;
    if (!toolName) return false;
    if (Array.isArray(pattern)) return pattern.some(p => matchToolName(toolName, p));
    if (pattern === toolName) return true;
    if (pattern.includes('*')) {
      const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      return new RegExp(regexStr).test(toolName);
    }
    return false;
  }

  /**
   * Matches MCP server name against pattern.
   */
  function matchMcpServerName(serverName, pattern) {
    if (!pattern || pattern === '*') return true;
    if (!serverName) return false;
    if (Array.isArray(pattern)) return pattern.some(p => matchMcpServerName(serverName, p));
    if (serverName.toLowerCase() === pattern.toLowerCase()) return true;
    if (pattern.includes('*')) {
      const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
      return new RegExp(regexStr, 'i').test(serverName);
    }
    return false;
  }

  let nextGrantSeq = 1;

  class PolicyEngine {
    constructor(options = {}) {
      this.defaultDecision = options.defaultDecision || 'ask'; // 'allow' | 'deny' | 'ask'
      this.grants = new Map();
      this.toolCategoryMap = { ...TOOL_CATEGORY_MAP, ...(options.toolCategoryMap || {}) };
      this.autoPrune = options.autoPrune !== false;

      if (Array.isArray(options.grants)) {
        for (const g of options.grants) this.grant(g);
      }
    }

    /**
     * Resolves the category of a given tool name and optional descriptor.
     */
    resolveCategory(toolName, descriptor) {
      if (descriptor?.category) return descriptor.category;
      if (descriptor?.mcpServer || toolName?.startsWith('mcp_') || toolName?.startsWith('mcp__')) {
        return ACTION_CATEGORIES.MCP_CALL;
      }
      return this.toolCategoryMap[toolName] || 'unknown';
    }

    /**
     * Registers a custom category mapping for a tool name.
     */
    registerToolCategory(toolName, category) {
      if (typeof toolName === 'string' && typeof category === 'string') {
        this.toolCategoryMap[toolName] = category;
      }
    }

    /**
     * Adds a scoped policy grant.
     */
    grant(spec = {}) {
      const id = String(spec.id || `grant_${Date.now()}_${nextGrantSeq++}`);
      const decision = ['allow', 'deny', 'ask'].includes(spec.decision) ? spec.decision :
                       ['allow', 'deny', 'ask'].includes(spec.action) ? spec.action : 'allow';

      const lifetime = spec.lifetime || (spec.taskId ? 'task' : spec.chatId ? 'chat' : spec.ttl ? 'session' : 'permanent');
      let expiresAt = null;
      if (spec.expiresAt) {
        expiresAt = spec.expiresAt instanceof Date ? spec.expiresAt.getTime() : Number(spec.expiresAt);
      } else if (spec.ttl && Number(spec.ttl) > 0) {
        expiresAt = Date.now() + Number(spec.ttl);
      }

      const grantObj = {
        id,
        decision,
        // Dimension 1: Tool name
        tool: spec.tool || spec.tools || null,
        // Dimension 2: Action category
        category: spec.category || spec.categories || null,
        // Dimension 3: Domain / Origin wildcard
        domain: spec.domain || spec.domains || spec.origin || spec.origins || null,
        // Dimension 4: Folder path
        path: spec.path || spec.paths || spec.folder || spec.folders || null,
        // Dimension 5: MCP server
        mcpServer: spec.mcpServer || spec.mcpServers || null,

        // Lifetimes & Scopes
        lifetime,
        expiresAt,
        taskId: spec.taskId ? String(spec.taskId) : null,
        chatId: spec.chatId ? String(spec.chatId) : null,
        createdAt: Number(spec.createdAt || Date.now()),
        revoked: Boolean(spec.revoked || false),
        description: spec.description || ''
      };

      this.grants.set(id, grantObj);
      return { ...grantObj };
    }

    allow(spec = {}) {
      return this.grant({ ...spec, decision: 'allow' });
    }

    deny(spec = {}) {
      return this.grant({ ...spec, decision: 'deny' });
    }

    ask(spec = {}) {
      return this.grant({ ...spec, decision: 'ask' });
    }

    getGrant(id) {
      const g = this.grants.get(String(id));
      return g ? { ...g } : null;
    }

    getGrants() {
      return [...this.grants.values()].map(g => ({ ...g }));
    }

    getActiveGrants({ taskId, chatId, now = Date.now() } = {}) {
      const result = [];
      for (const grant of this.grants.values()) {
        if (grant.revoked) continue;
        if (grant.expiresAt && now >= grant.expiresAt) continue;
        if (grant.taskId && taskId && grant.taskId !== String(taskId)) continue;
        if (grant.chatId && chatId && grant.chatId !== String(chatId)) continue;
        result.push({ ...grant });
      }
      return result;
    }

    /**
     * Explicitly revokes a grant by its ID.
     */
    revoke(id) {
      const g = this.grants.get(String(id));
      if (!g) return false;
      g.revoked = true;
      return true;
    }

    isRevoked(id) {
      const g = this.grants.get(String(id));
      return Boolean(g?.revoked);
    }

    /**
     * Revokes all grants matching a filter object or predicate function.
     */
    revokeMatching(filter) {
      let count = 0;
      const isFn = typeof filter === 'function';
      for (const grant of this.grants.values()) {
        if (grant.revoked) continue;
        let match = false;
        if (isFn) {
          match = filter(grant);
        } else if (filter && typeof filter === 'object') {
          match = Object.entries(filter).every(([key, val]) => grant[key] === val);
        }
        if (match) {
          grant.revoked = true;
          count++;
        }
      }
      return count;
    }

    /**
     * Revokes all grants bound to a task lifetime.
     */
    revokeTask(taskId) {
      if (!taskId) return 0;
      const idStr = String(taskId);
      return this.revokeMatching(g => g.taskId === idStr);
    }

    clearTask(taskId) {
      return this.revokeTask(taskId);
    }

    /**
     * Revokes all grants bound to a chat lifetime.
     */
    revokeChat(chatId) {
      if (!chatId) return 0;
      const idStr = String(chatId);
      return this.revokeMatching(g => g.chatId === idStr);
    }

    clearChat(chatId) {
      return this.revokeChat(chatId);
    }

    clearSession() {
      return this.revokeMatching(g => g.lifetime === 'session' || g.expiresAt !== null);
    }

    clearAll() {
      const count = this.grants.size;
      this.grants.clear();
      return count;
    }

    /**
     * Removes expired and revoked grants from the internal map.
     */
    pruneExpired(now = Date.now()) {
      let pruned = 0;
      for (const [id, grant] of this.grants.entries()) {
        if (grant.revoked || (grant.expiresAt && now >= grant.expiresAt)) {
          this.grants.delete(id);
          pruned++;
        }
      }
      return pruned;
    }

    /**
     * Normalizes a policy evaluation request from flexible argument shapes.
     */
    normalizeRequest(request, context = {}) {
      let req = typeof request === 'string' ? { tool: request } : { ...request };
      const ctx = typeof context === 'object' && context !== null ? context : {};

      const tool = req.tool || ctx.tool || '';
      const descriptor = req.descriptor || ctx.descriptor || null;
      const args = req.args || ctx.args || {};
      const taskId = ctx.taskId || req.taskId || null;
      const chatId = ctx.chatId || req.chatId || null;
      const now = Number(ctx.now || Date.now());

      // Dimension 2: Action category
      const category = this.resolveCategory(tool, descriptor);

      // Dimension 3: Target domain or URL
      const url = req.url || ctx.url || req.domain || ctx.domain || req.origin || ctx.origin ||
                  args.url || ctx.tabUrl || req.tabUrl || null;

      // Dimension 4: Target path(s)
      let paths = [];
      if (req.paths && Array.isArray(req.paths)) paths = req.paths;
      else if (args.paths && Array.isArray(args.paths)) paths = args.paths;
      else if (req.path) paths = [req.path];
      else if (args.path) paths = [args.path];
      else if (req.folder) paths = [req.folder];
      else if (ctx.path) paths = [ctx.path];

      // Dimension 5: Target MCP server
      let mcpServer = req.mcpServer || ctx.mcpServer || descriptor?.mcpServer || args.server || null;
      if (!mcpServer && typeof tool === 'string' && tool.startsWith('mcp__')) {
        const parts = tool.split('__');
        if (parts.length >= 2) mcpServer = parts[1];
      }

      return {
        tool,
        category,
        url,
        paths,
        mcpServer,
        descriptor,
        args,
        taskId: taskId ? String(taskId) : null,
        chatId: chatId ? String(chatId) : null,
        now
      };
    }

    /**
     * Checks if a single active grant matches a normalized request across the 5 dimensions.
     */
    matchesGrant(grant, req) {
      if (grant.revoked) return false;
      if (grant.expiresAt && req.now >= grant.expiresAt) return false;

      // Lifetime & scope checks
      if (grant.taskId && grant.taskId !== req.taskId) return false;
      if (grant.chatId && grant.chatId !== req.chatId) return false;

      // Dimension 1: Tool name
      if (grant.tool && grant.tool !== '*') {
        if (!matchToolName(req.tool, grant.tool)) return false;
      }

      // Dimension 2: Action category
      if (grant.category && grant.category !== '*') {
        const cats = Array.isArray(grant.category) ? grant.category : [grant.category];
        if (!cats.some(c => c.toLowerCase() === req.category.toLowerCase())) return false;
      }

      // Dimension 3: Domain / Origin wildcard
      if (grant.domain && grant.domain !== '*') {
        if (!req.url) return false;
        const doms = Array.isArray(grant.domain) ? grant.domain : [grant.domain];
        if (!doms.some(pattern => matchDomainOrOrigin(req.url, pattern))) return false;
      }

      // Dimension 4: Folder path
      if (grant.path && grant.path !== '*') {
        if (!req.paths.length) return false;
        const patterns = Array.isArray(grant.path) ? grant.path : [grant.path];
        // Every path in the request must be permitted by at least one of the grant's path patterns
        const pathMatches = targetP => patterns.some(pattern => matchPath(targetP, pattern));
        // One forbidden destination blocks a batch; an allow must cover all paths.
        if (!(grant.decision === 'deny' ? req.paths.some(pathMatches) : req.paths.every(pathMatches))) return false;
      }

      // Dimension 5: MCP server
      if (grant.mcpServer && grant.mcpServer !== '*') {
        if (!req.mcpServer) return false;
        if (!matchMcpServerName(req.mcpServer, grant.mcpServer)) return false;
      }

      return true;
    }

    /**
     * Evaluates permission for a request across all 5 dimensions.
     * Deny rules take precedence over allow rules.
     */
    evaluate(request, context = {}) {
      const req = this.normalizeRequest(request, context);
      if (this.autoPrune) this.pruneExpired(req.now);

      const matchedGrants = [];
      const denyGrants = [];
      const allowGrants = [];
      const askGrants = [];

      for (const grant of this.grants.values()) {
        if (this.matchesGrant(grant, req)) {
          matchedGrants.push({ ...grant });
          if (grant.decision === 'deny') denyGrants.push(grant);
          else if (grant.decision === 'allow') allowGrants.push(grant);
          else if (grant.decision === 'ask') askGrants.push(grant);
        }
      }

      // Precedence: 1. Deny overrides everything
      if (denyGrants.length > 0) {
        const topDeny = denyGrants[0];
        return {
          allowed: false,
          decision: 'deny',
          reason: topDeny.description || `Action explicitly denied by policy grant (${topDeny.id})`,
          grant: { ...topDeny },
          matchedGrants,
          request: req
        };
      }

      // Precedence: 2. Explicit Allow
      if (allowGrants.length > 0) {
        const topAllow = allowGrants[allowGrants.length - 1]; // most recent
        return {
          allowed: true,
          decision: 'allow',
          reason: topAllow.description || `Action permitted by policy grant (${topAllow.id})`,
          grant: { ...topAllow },
          matchedGrants,
          request: req
        };
      }

      // Precedence: 3. Explicit Ask
      if (askGrants.length > 0) {
        const topAsk = askGrants[0];
        return {
          allowed: false,
          decision: 'ask',
          reason: topAsk.description || `Approval required by policy grant (${topAsk.id})`,
          grant: { ...topAsk },
          matchedGrants,
          request: req
        };
      }

      // Fallback: Default decision
      const isAllowedDefault = this.defaultDecision === 'allow';
      return {
        allowed: isAllowedDefault,
        decision: this.defaultDecision,
        reason: `No matching policy rule; applied default '${this.defaultDecision}'`,
        grant: null,
        matchedGrants: [],
        request: req
      };
    }

    check(request, context) {
      return this.evaluate(request, context);
    }

    isAllowed(request, context) {
      return this.evaluate(request, context).allowed;
    }

    isDenied(request, context) {
      return this.evaluate(request, context).decision === 'deny';
    }

    requiresApproval(request, context) {
      return this.evaluate(request, context).decision === 'ask';
    }

    enforce(request, context) {
      const result = this.evaluate(request, context);
      if (!result.allowed) {
        const error = new Error(`Action not permitted by policy [${result.decision}]: ${result.reason}`);
        error.policyResult = result;
        throw error;
      }
      return result;
    }

    toJSON() {
      return {
        defaultDecision: this.defaultDecision,
        grants: this.getGrants()
      };
    }

    static fromJSON(data, options = {}) {
      if (!data || typeof data !== 'object') return new PolicyEngine(options);
      const grants = Array.isArray(data.grants)
        ? data.grants.map(spec => ({ ...spec, revoked: Boolean(spec.revoked || false) }))
        : [];
      return new PolicyEngine({
        defaultDecision: data.defaultDecision || options.defaultDecision,
        grants,
        ...options
      });
    }
  }

  const api = {
    PolicyEngine,
    ACTION_CATEGORIES,
    TOOL_CATEGORY_MAP,
    normalizePath,
    isPathWithin,
    matchPath,
    extractDomainAndOrigin,
    splitHostAndPort,
    matchDomainOrOrigin,
    matchToolName,
    matchMcpServerName
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OmniSidebarPolicy = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
