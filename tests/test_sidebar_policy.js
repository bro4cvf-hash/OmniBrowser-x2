const assert = require('node:assert/strict');
const {
  PolicyEngine,
  ACTION_CATEGORIES,
  TOOL_CATEGORY_MAP,
  normalizePath,
  isPathWithin,
  matchPath,
  extractDomainAndOrigin,
  matchDomainOrOrigin,
  matchToolName,
  matchMcpServerName
} = require('../extensions/chrome/sidebar-policy.js');

(async () => {
  // ==========================================
  // 1. Path Normalization & Containment Tests
  // ==========================================
  assert.equal(normalizePath('C:\\Users\\PC\\Documents\\notes.txt'), 'C:/Users/PC/Documents/notes.txt');
  assert.equal(normalizePath('/home/user/docs/../secrets'), '/home/user/secrets');
  assert.equal(normalizePath('C:\\Users\\PC\\Documents\\..\\..\\..\\Windows\\System32'), 'C:/Windows/System32');
  assert.equal(normalizePath('C:\\Users\\PC\\Documents\\..\\..\\..\\..\\Windows\\System32'), 'C:/Windows/System32');
  assert.equal(normalizePath('C:/Users/PC/'), 'C:/Users/PC');

  assert.ok(isPathWithin('C:/Users/PC/Desktop/LLC/file.pdf', 'C:/Users/PC/Desktop/LLC'));
  assert.ok(isPathWithin('C:\\Users\\PC\\Desktop\\LLC\\sub\\file.pdf', 'C:/Users/PC/Desktop/LLC'));
  assert.ok(isPathWithin('c:/users/pc/desktop/llc/file.pdf', 'C:/Users/PC/Desktop/LLC')); // Case insensitivity
  assert.ok(!isPathWithin('C:/Users/PC/Desktop/LLC_OTHER/file.pdf', 'C:/Users/PC/Desktop/LLC')); // Directory boundary
  assert.ok(!isPathWithin('C:/Users/PC/Desktop/LLC/../Secrets/pass.txt', 'C:/Users/PC/Desktop/LLC')); // Traversal
  assert.equal(normalizePath('\\\\Server\\Share\\Docs'), '//Server/Share/Docs');
  assert.equal(normalizePath('\\\\Server\\Share\\..\\Docs'), '//Server/Share/Docs', 'UNC traversal cannot escape the share root');
  assert.ok(isPathWithin('\\\\SERVER\\SHARE\\Docs\\file.txt', '//server/share/docs'));
  assert.ok(!isPathWithin('C:/Private/%2e%2e/Public/file.txt', 'C:/Public'), 'Filesystem paths are literal, not URL encoded');

  assert.ok(matchPath('C:/Users/PC/Desktop/LLC/doc.pdf', 'C:/Users/PC/Desktop/LLC'));
  assert.ok(matchPath('C:/Users/PC/Desktop/LLC/report.pdf', 'C:/Users/PC/Desktop/LLC/*.pdf'));
  assert.ok(!matchPath('C:/Users/PC/Desktop/LLC/report.docx', 'C:/Users/PC/Desktop/LLC/*.pdf'));

  // ==========================================
  // 2. Domain / Origin Wildcard Matching Tests
  // ==========================================
  const info = extractDomainAndOrigin('https://sub.example.com:8080/path?query=1');
  assert.equal(info.hostname, 'sub.example.com');
  assert.equal(info.origin, 'https://sub.example.com:8080');

  assert.ok(matchDomainOrOrigin('https://example.com/login', '*.example.com')); // Root domain
  assert.ok(matchDomainOrOrigin('https://auth.example.com/oauth', '*.example.com')); // Subdomain
  assert.ok(matchDomainOrOrigin('https://a.b.example.com', '*.example.com')); // Deep subdomain
  assert.ok(!matchDomainOrOrigin('https://evil-example.com', '*.example.com')); // Sibling domain
  assert.ok(!matchDomainOrOrigin('https://example.com.attacker.com', '*.example.com')); // Prefix trap

  assert.ok(matchDomainOrOrigin('https://github.com/repo', 'https://*.github.com'));
  assert.ok(!matchDomainOrOrigin('http://github.com/repo', 'https://*.github.com')); // Scheme mismatch
  assert.ok(!matchDomainOrOrigin('https://github.com:8443/repo', 'https://github.com'));
  assert.ok(matchDomainOrOrigin('https://github.com:443/repo', 'https://github.com'));
  assert.ok(matchDomainOrOrigin('http://localhost:8080', 'http://localhost:*'));
  assert.ok(matchDomainOrOrigin('http://localhost:3000', 'localhost:3000'));
  assert.ok(matchDomainOrOrigin('http://localhost:8080', 'localhost:*'));
  assert.ok(matchDomainOrOrigin('https://anything.org', '*'));
  assert.ok(matchDomainOrOrigin('https://anything.org', '<all_urls>'));

  // ==========================================
  // 3. Tool & MCP Server Name Matching Tests
  // ==========================================
  assert.ok(matchToolName('read_page', 'read_page'));
  assert.ok(matchToolName('files_extract', 'files_*'));
  assert.ok(matchToolName('files_list', 'files_*'));
  assert.ok(!matchToolName('read_page', 'files_*'));
  assert.ok(matchToolName('click', ['click', 'fill']));

  assert.ok(matchMcpServerName('github', 'github'));
  assert.ok(matchMcpServerName('local-filesystem', 'local-*'));
  assert.ok(!matchMcpServerName('remote-filesystem', 'local-*'));

  // ==========================================
  // 4. Dimension 1: Tool Name Permission Tests
  // ==========================================
  const engine = new PolicyEngine();
  engine.allow({ tool: 'navigate' });
  engine.allow({ tool: 'files_*' });

  assert.ok(engine.isAllowed({ tool: 'navigate' }));
  assert.ok(engine.isAllowed({ tool: 'files_list' }));
  assert.ok(engine.isAllowed({ tool: 'files_extract' }));
  assert.ok(!engine.isAllowed({ tool: 'click' })); // Default ask

  // ==========================================
  // 5. Dimension 2: Action Category Tests
  // ==========================================
  assert.equal(engine.resolveCategory('read_page'), ACTION_CATEGORIES.BROWSER_READ);
  assert.equal(engine.resolveCategory('click'), ACTION_CATEGORIES.BROWSER_WRITE);
  assert.equal(engine.resolveCategory('navigate'), ACTION_CATEGORIES.NAVIGATION);
  assert.equal(engine.resolveCategory('files_extract'), ACTION_CATEGORIES.FILE_READ);
  assert.equal(engine.resolveCategory('mcp__github__issue_create'), ACTION_CATEGORIES.MCP_CALL);
  assert.equal(engine.resolveCategory('custom_tool', { mcpServer: 'sqlite' }), ACTION_CATEGORIES.MCP_CALL);

  const catEngine = new PolicyEngine({ defaultDecision: 'ask' });
  catEngine.allow({ category: ACTION_CATEGORIES.BROWSER_READ });

  assert.ok(catEngine.isAllowed({ tool: 'read_page' }));
  assert.ok(catEngine.isAllowed({ tool: 'browser_context' }));
  assert.ok(catEngine.isAllowed({ tool: 'current_tab' }));
  assert.ok(!catEngine.isAllowed({ tool: 'click' })); // browser_write not allowed
  assert.ok(!catEngine.isAllowed({ tool: 'navigate' })); // navigation not allowed

  // Register custom tool category
  catEngine.registerToolCategory('custom_scanner', ACTION_CATEGORIES.BROWSER_READ);
  assert.ok(catEngine.isAllowed({ tool: 'custom_scanner' }));

  // ==========================================
  // 6. Dimension 3: Domain / Origin Wildcard Tests
  // ==========================================
  const domainEngine = new PolicyEngine({ defaultDecision: 'ask' });
  domainEngine.allow({ category: ACTION_CATEGORIES.NAVIGATION, domain: '*.wikipedia.org' });

  assert.ok(domainEngine.isAllowed({ tool: 'navigate', args: { url: 'https://en.wikipedia.org/wiki/Main_Page' } }));
  assert.ok(domainEngine.isAllowed({ tool: 'new_tab', url: 'https://wikipedia.org' }));
  assert.ok(!domainEngine.isAllowed({ tool: 'navigate', args: { url: 'https://evil.com' } }));
  assert.ok(!domainEngine.isAllowed({ tool: 'navigate', args: { url: 'https://wikipedia.org.evil.com' } }));

  // ==========================================
  // 7. Dimension 4: Folder Path Dimension Tests
  // ==========================================
  const fileEngine = new PolicyEngine({ defaultDecision: 'ask' });
  fileEngine.allow({ category: ACTION_CATEGORIES.FILE_READ, path: 'C:/Users/PC/Desktop/LLC' });

  // Single file read inside folder
  assert.ok(fileEngine.isAllowed({ tool: 'files_extract', args: { path: 'C:/Users/PC/Desktop/LLC/tax_2025.pdf' } }));
  // Nested subfolder inside allowed folder
  assert.ok(fileEngine.isAllowed({ tool: 'files_list', args: { path: 'C:\\Users\\PC\\Desktop\\LLC\\invoices' } }));
  // File outside folder
  assert.ok(!fileEngine.isAllowed({ tool: 'files_extract', args: { path: 'C:/Users/PC/Documents/personal.txt' } }));
  // Directory traversal attack
  assert.ok(!fileEngine.isAllowed({ tool: 'files_extract', args: { path: 'C:/Users/PC/Desktop/LLC/../../Windows/System32/cmd.exe' } }));

  // Multiple paths (e.g. files_read_many)
  assert.ok(fileEngine.isAllowed({
    tool: 'files_read_many',
    args: { paths: ['C:/Users/PC/Desktop/LLC/a.pdf', 'C:/Users/PC/Desktop/LLC/b.docx'] }
  }));
  assert.ok(!fileEngine.isAllowed({
    tool: 'files_read_many',
    args: { paths: ['C:/Users/PC/Desktop/LLC/a.pdf', 'C:/Users/PC/Desktop/Other/leak.pdf'] }
  }));
  const batchDeny = new PolicyEngine({ defaultDecision: 'allow' });
  batchDeny.deny({ category: 'file_read', path: 'C:/Private' });
  assert.ok(batchDeny.isDenied({ tool: 'files_read_many', args: { paths: ['C:/Public/a', 'C:/Private/b'] } }), 'Any denied path blocks a mixed batch');

  // ==========================================
  // 8. Dimension 5: MCP Server Dimension Tests
  // ==========================================
  const mcpEngine = new PolicyEngine({ defaultDecision: 'ask' });
  mcpEngine.allow({ category: ACTION_CATEGORIES.MCP_CALL, mcpServer: 'github' });

  assert.ok(mcpEngine.isAllowed({ tool: 'mcp__github__create_issue' }));
  assert.ok(mcpEngine.isAllowed({ tool: 'query_issues', descriptor: { mcpServer: 'github' } }));
  assert.ok(!mcpEngine.isAllowed({ tool: 'mcp__filesystem__read_file' }));
  assert.ok(!mcpEngine.isAllowed({ tool: 'run_sql', descriptor: { mcpServer: 'sqlite' } }));

  // ==========================================
  // 9. Multi-Dimensional Scoped Grants
  // ==========================================
  const multiEngine = new PolicyEngine({ defaultDecision: 'ask' });
  multiEngine.allow({
    category: ACTION_CATEGORIES.BROWSER_WRITE,
    domain: '*.github.com',
    taskId: 'task-100',
    description: 'Allow writing only to GitHub during task 100'
  });

  // Matches all 3 specified dimensions (browser_write, *.github.com, task-100)
  assert.ok(multiEngine.isAllowed({ tool: 'click', url: 'https://github.com/pulls', taskId: 'task-100' }));
  // Wrong domain
  assert.ok(!multiEngine.isAllowed({ tool: 'click', url: 'https://gitlab.com/pulls', taskId: 'task-100' }));
  // Wrong task
  assert.ok(!multiEngine.isAllowed({ tool: 'click', url: 'https://github.com/pulls', taskId: 'task-200' }));
  // Wrong category (navigation)
  assert.ok(!multiEngine.isAllowed({ tool: 'navigate', url: 'https://github.com/pulls', taskId: 'task-100' }));

  // ==========================================
  // 10. Expiration Timestamps & TTL
  // ==========================================
  const expireEngine = new PolicyEngine({ defaultDecision: 'ask' });
  const fixedNow = 1700000000000;
  expireEngine.allow({
    tool: 'read_page',
    expiresAt: fixedNow + 5000
  });

  assert.ok(expireEngine.isAllowed({ tool: 'read_page' }, { now: fixedNow + 1000 }));
  assert.ok(expireEngine.isAllowed({ tool: 'read_page' }, { now: fixedNow + 4999 }));
  assert.ok(!expireEngine.isAllowed({ tool: 'read_page' }, { now: fixedNow + 5000 })); // Expired
  assert.ok(!expireEngine.isAllowed({ tool: 'read_page' }, { now: fixedNow + 10000 })); // Expired

  // TTL grant creation
  const ttlGrant = expireEngine.allow({ tool: 'scroll', ttl: 50 });
  assert.ok(ttlGrant.expiresAt > Date.now());
  assert.ok(expireEngine.isAllowed({ tool: 'scroll' }));
  await new Promise(r => setTimeout(r, 60));
  assert.ok(!expireEngine.isAllowed({ tool: 'scroll' }));

  // ==========================================
  // 11. Task and Chat Lifetimes & Revocation
  // ==========================================
  const lifetimeEngine = new PolicyEngine({ defaultDecision: 'ask' });
  lifetimeEngine.allow({ tool: 'files_list', taskId: 'task-abc' });
  lifetimeEngine.allow({ domain: '*.openai.com', chatId: 'chat-xyz' });

  assert.ok(lifetimeEngine.isAllowed({ tool: 'files_list', taskId: 'task-abc' }));
  assert.ok(!lifetimeEngine.isAllowed({ tool: 'files_list', taskId: 'task-def' }));
  assert.ok(!lifetimeEngine.isAllowed({ tool: 'files_list' })); // No task specified

  assert.ok(lifetimeEngine.isAllowed({ tool: 'navigate', url: 'https://api.openai.com', chatId: 'chat-xyz' }));
  assert.ok(!lifetimeEngine.isAllowed({ tool: 'navigate', url: 'https://api.openai.com', chatId: 'chat-other' }));

  // Clear task grants
  const revokedTasks = lifetimeEngine.clearTask('task-abc');
  assert.equal(revokedTasks, 1);
  assert.ok(!lifetimeEngine.isAllowed({ tool: 'files_list', taskId: 'task-abc' }));

  // Clear chat grants
  const revokedChats = lifetimeEngine.clearChat('chat-xyz');
  assert.equal(revokedChats, 1);
  assert.ok(!lifetimeEngine.isAllowed({ tool: 'navigate', url: 'https://api.openai.com', chatId: 'chat-xyz' }));

  // ==========================================
  // 12. Explicit Revocation
  // ==========================================
  const revokeEngine = new PolicyEngine({ defaultDecision: 'ask' });
  const g1 = revokeEngine.allow({ tool: 'navigate' });
  const g2 = revokeEngine.allow({ domain: '*.anthropic.com' });

  assert.ok(revokeEngine.isAllowed({ tool: 'navigate' }));
  assert.ok(!revokeEngine.isRevoked(g1.id));

  assert.ok(revokeEngine.revoke(g1.id));
  assert.ok(revokeEngine.isRevoked(g1.id));
  assert.ok(!revokeEngine.isAllowed({ tool: 'navigate' }));

  // revokeMatching
  assert.ok(revokeEngine.isAllowed({ tool: 'navigate', url: 'https://anthropic.com' }));
  const matchRevoked = revokeEngine.revokeMatching({ domain: '*.anthropic.com' });
  assert.equal(matchRevoked, 1);
  assert.ok(!revokeEngine.isAllowed({ tool: 'navigate', url: 'https://anthropic.com' }));

  // ==========================================
  // 13. Precedence: Deny Overrides Allow
  // ==========================================
  const precEngine = new PolicyEngine({ defaultDecision: 'ask' });
  precEngine.allow({ category: ACTION_CATEGORIES.NAVIGATION, domain: '*' }); // Broad allow
  precEngine.deny({ domain: '*.phishing.net', description: 'Malicious domain blocked' }); // Specific deny

  assert.ok(precEngine.isAllowed({ tool: 'navigate', url: 'https://google.com' }));
  const evalDeny = precEngine.evaluate({ tool: 'navigate', url: 'https://login.phishing.net/steal' });
  assert.equal(evalDeny.allowed, false);
  assert.equal(evalDeny.decision, 'deny');
  assert.match(evalDeny.reason, /Malicious domain blocked/);

  // ==========================================
  // 14. Enforcement & Custom Errors
  // ==========================================
  assert.doesNotThrow(() => precEngine.enforce({ tool: 'navigate', url: 'https://google.com' }));
  assert.throws(() => precEngine.enforce({ tool: 'navigate', url: 'https://login.phishing.net' }), /Action not permitted by policy \[deny\]/);
  assert.throws(() => precEngine.enforce({ tool: 'click' }), /Action not permitted by policy \[ask\]/);

  // ==========================================
  // 15. Serialization & Hydration
  // ==========================================
  const serEngine = new PolicyEngine({ defaultDecision: 'deny' });
  serEngine.allow({ tool: 'read_page', description: 'Safe read' });
  serEngine.deny({ domain: '*.tracker.com' });

  const serialized = serEngine.toJSON();
  assert.equal(serialized.defaultDecision, 'deny');
  assert.equal(serialized.grants.length, 2);

  const restored = PolicyEngine.fromJSON(serialized);
  assert.equal(restored.defaultDecision, 'deny');
  assert.ok(restored.isAllowed({ tool: 'read_page' }));
  assert.ok(restored.isDenied({ tool: 'navigate', url: 'https://ad.tracker.com' }));
  assert.ok(!restored.isAllowed({ tool: 'click' })); // Default deny

  // ==========================================
  // 16. Security Hardening & IPv6 Tests
  // ==========================================
  const secEngine = new PolicyEngine({ defaultDecision: 'deny' });

  // 1. Task ID and Chat ID spoofing prevention
  secEngine.allow({ tool: 'files_list', taskId: 'trusted-task', chatId: 'trusted-chat' });
  // Matching trusted context allows action
  assert.ok(secEngine.isAllowed({ tool: 'files_list' }, { taskId: 'trusted-task', chatId: 'trusted-chat' }));
  // Untrusted req cannot spoof trusted-task when ctx is attacker-task
  assert.ok(!secEngine.isAllowed({ tool: 'files_list', taskId: 'trusted-task' }, { taskId: 'attacker-task', chatId: 'trusted-chat' }));
  assert.ok(!secEngine.isAllowed({ tool: 'files_list', chatId: 'trusted-chat' }, { taskId: 'trusted-task', chatId: 'attacker-chat' }));
  const normReq = secEngine.normalizeRequest({ tool: 'test', taskId: 'attacker-task', chatId: 'attacker-chat' }, { taskId: 'trusted-task', chatId: 'trusted-chat' });
  assert.equal(normReq.taskId, 'trusted-task');
  assert.equal(normReq.chatId, 'trusted-chat');

  // 2. Category spoofing prevention
  secEngine.allow({ category: ACTION_CATEGORIES.BROWSER_READ });
  // Attacker claims "fill" (browser_write) is "browser_read"
  assert.ok(!secEngine.isAllowed({ tool: 'fill', category: ACTION_CATEGORIES.BROWSER_READ }));
  const normCatReq = secEngine.normalizeRequest({ tool: 'fill', category: ACTION_CATEGORIES.BROWSER_READ });
  assert.equal(normCatReq.category, ACTION_CATEGORIES.BROWSER_WRITE);

  // 3. Timestamp spoofing prevention
  const spoofExpireEngine = new PolicyEngine({ defaultDecision: 'deny' });
  spoofExpireEngine.allow({ tool: 'navigate', expiresAt: fixedNow + 1000 });
  // req.now trying to forge a past timestamp when ctx.now has expired
  assert.ok(!spoofExpireEngine.isAllowed({ tool: 'navigate', now: fixedNow }, { now: fixedNow + 5000 }));
  const normTimeReq = spoofExpireEngine.normalizeRequest({ tool: 'navigate', now: 12345 }, { now: 67890 });
  assert.equal(normTimeReq.now, 67890);

  // 4. Filesystem names retain literal percent sequences.
  assert.equal(normalizePath('C:/Users/PC/Desktop/%4c%4c%43/file.pdf'), 'C:/Users/PC/Desktop/%4c%4c%43/file.pdf');
  assert.equal(normalizePath('C:/Users/PC/Desktop/LLC/%2e%2e/Secrets/pass.txt'), 'C:/Users/PC/Desktop/LLC/%2e%2e/Secrets/pass.txt');
  assert.equal(normalizePath('/var/%2e%2e/etc/passwd'), '/var/%2e%2e/etc/passwd');
  // Malformed percent-encoding should not throw
  assert.doesNotThrow(() => normalizePath('C:/path/%E0%A4%A/invalid'));

  // 5. Preserving revoked flag in fromJSON
  const revokeSaveEngine = new PolicyEngine({ defaultDecision: 'deny' });
  const gToRevoke = revokeSaveEngine.allow({ tool: 'read_page' });
  revokeSaveEngine.revoke(gToRevoke.id);
  assert.ok(revokeSaveEngine.isRevoked(gToRevoke.id));

  const jsonDump = revokeSaveEngine.toJSON();
  const hydrated = PolicyEngine.fromJSON(jsonDump);
  assert.ok(hydrated.isRevoked(gToRevoke.id));
  assert.ok(!hydrated.isAllowed({ tool: 'read_page' }));

  // 6. IPv6 host parsing
  assert.ok(matchDomainOrOrigin('http://[::1]:8080/api', '[::1]:8080'));
  assert.ok(matchDomainOrOrigin('http://[::1]:8080/api', 'http://[::1]:8080'));
  assert.ok(matchDomainOrOrigin('http://[::1]:8080', '[::1]:*'));
  assert.ok(matchDomainOrOrigin('http://[::1]:8080', '[::1]'));
  assert.ok(!matchDomainOrOrigin('http://[::1]:8080', '[::1]:9090'));
  assert.ok(matchDomainOrOrigin('https://[2001:db8::1]:443', '[2001:db8::1]:443'));

  const ipv6Info = extractDomainAndOrigin('http://[::1]:8080/path');
  assert.equal(ipv6Info.hostname, '[::1]');
  assert.equal(ipv6Info.port, '8080');
  assert.equal(ipv6Info.origin, 'http://[::1]:8080');

  console.log('All sidebar policy engine tests passed successfully.');
})();
