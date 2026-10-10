const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const exporter = require('../extensions/chrome/diagnostic-exporter.js');

(async () => {
  // 1. Basic bundle assembly with defaults and versions
  const defaultBundle = exporter.createBundle();
  assert.ok(defaultBundle.runId && typeof defaultBundle.runId === 'string', 'runId must be generated');
  assert.ok(defaultBundle.timestamp && typeof defaultBundle.timestamp === 'string', 'timestamp must be present');
  assert.ok(defaultBundle.versions, 'versions must be present');
  assert.equal(typeof defaultBundle.versions.extension, 'string');
  assert.equal(typeof defaultBundle.versions.chrome, 'string');
  assert.equal(typeof defaultBundle.versions.os, 'string');
  assert.ok(Array.isArray(defaultBundle.actionLedger), 'actionLedger must be an array');
  assert.ok(Array.isArray(defaultBundle.tabs), 'tabs must be an array');
  assert.ok(Array.isArray(defaultBundle.scopedTabConsoleLogs), 'scopedTabConsoleLogs must be an array');
  assert.ok(Array.isArray(defaultBundle.networkResponseStatuses), 'networkResponseStatuses must be an array');
  assert.ok(defaultBundle.timings && typeof defaultBundle.timings === 'object', 'timings must be an object');

  // 2. Preserves explicit runId and scrubs provider & model
  const fixedRunId = 'test-run-12345-abcde';
  const customSettings = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1?token=secret-token-123',
    apiKey: 'sk-abcdef1234567890abcdef1234567890',
    model: 'gpt-4o',
    contextWindowTokens: 128000
  };

  const bundle = exporter.createBundle({
    runId: fixedRunId,
    settings: customSettings,
    versions: { extension: '0.1.0', chrome: '124.0.0.0', os: 'Windows 11' }
  });

  assert.equal(bundle.runId, fixedRunId);
  assert.equal(bundle.versions.extension, '0.1.0');
  assert.equal(bundle.versions.chrome, '124.0.0.0');
  assert.equal(bundle.versions.os, 'Windows 11');
  assert.equal(bundle.provider.name, 'openai');
  assert.equal(bundle.provider.apiKey, '[REDACTED]', 'Provider apiKey must be redacted');
  assert.ok(!bundle.provider.baseUrl.includes('secret-token-123'), 'URL token query param must be redacted');
  assert.equal(bundle.model.id, 'gpt-4o');
  assert.equal(bundle.model.contextWindow, 128000);

  // 3. Strict Redaction of Sensitive Data: API keys, Bearer tokens, passwords, credit cards
  const secretKey = 'sk-proj-abc1234567890abcdef1234567890';
  const anthropicKey = 'sk-ant-api03-abcdef1234567890abcdef123456';
  const googleKey = 'AIzaSyD-1234567890abcdefghijklmnopqr';
  const bearerToken = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID';
  const visaCard = '4111 1111 1111 1111';
  const masterCard = '5500 0000 0000 0004';
  const amexCard = '3782 822463 10005';
  const plainPassword = 'SuperSecretPassword!2026';

  const rawText = `Connecting to API with ${secretKey} and ${anthropicKey} and ${googleKey}. Authorization header: ${bearerToken}. Paid with card ${visaCard} and backup ${masterCard} and Amex ${amexCard}. Password is password="${plainPassword}".`;
  const redactedText = exporter.redactString(rawText);

  assert.ok(!redactedText.includes(secretKey), 'OpenAI key must be scrubbed');
  assert.ok(!redactedText.includes(anthropicKey), 'Anthropic key must be scrubbed');
  assert.ok(!redactedText.includes(googleKey), 'Google key must be scrubbed');
  assert.ok(!redactedText.includes(bearerToken), 'Bearer token must be scrubbed');
  assert.ok(!redactedText.includes(visaCard), 'Visa credit card must be scrubbed');
  assert.ok(!redactedText.includes(masterCard), 'MasterCard credit card must be scrubbed');
  assert.ok(!redactedText.includes(amexCard), 'Amex credit card must be scrubbed');
  assert.ok(!redactedText.includes(plainPassword), 'Password must be scrubbed');
  assert.ok(redactedText.includes('[REDACTED_API_KEY]'), 'Contains REDACTED_API_KEY marker');
  assert.ok(redactedText.includes('Bearer [REDACTED]'), 'Contains Bearer [REDACTED]');
  assert.ok(redactedText.includes('[REDACTED_CREDIT_CARD]'), 'Contains REDACTED_CREDIT_CARD');

  // Verify non-card numbers are preserved
  const innocentText = 'Port 8080 active on PID 4321 with 150 items and tabId 7';
  assert.equal(exporter.redactString(innocentText), innocentText, 'Innocent numbers must not be touched');

  // Verify object redaction for forms and ledger entries
  const sensitiveObject = {
    apiKey: 'my-secret-key-12345678',
    client_secret: 'client-secret-999',
    form: {
      selector: '#password',
      value: 'MySecretPassword123'
    },
    payment: {
      selector: 'input[name="creditCard"]',
      value: '4242 4242 4242 4242'
    },
    loginUrl: 'https://admin:secretPass@internal.example.com/login?token=abc12345',
    normalField: {
      selector: '#username',
      value: 'john_doe'
    }
  };

  const redactedObj = exporter.redact(sensitiveObject);
  assert.equal(redactedObj.apiKey, '[REDACTED]');
  assert.equal(redactedObj.client_secret, '[REDACTED]');
  assert.equal(redactedObj.form.value, '[REDACTED]');
  assert.equal(redactedObj.payment.value, '[REDACTED]');
  assert.equal(redactedObj.normalField.value, 'john_doe');
  assert.ok(!redactedObj.loginUrl.includes('secretPass'));
  assert.ok(redactedObj.loginUrl.includes(':[REDACTED]@'));

  // 4. Strict Tab Scoping: Omit all browser tabs not participating in the task
  const allTabs = [
    { id: 1, title: 'Personal Bank Account', url: 'https://bank.example.com/overview?token=private' },
    { id: 2, title: 'Personal Email - Inbox', url: 'https://mail.example.com/inbox' },
    { id: 7, title: 'Application Form', url: 'https://service.example.com/apply?apiKey=12345' },
    { id: 8, title: 'Application Confirmation', url: 'https://service.example.com/confirm' },
    { id: 99, title: 'Social Media', url: 'https://social.example.com/feed' }
  ];

  const rawConsoleLogs = [
    { tabId: 1, level: 'log', message: 'Bank statement loaded for user 44' },
    { tabId: 2, level: 'warn', message: 'New personal email from mom' },
    { tabId: 7, level: 'info', message: 'Form fields initialized with auth Bearer secret-auth-token-777' },
    { tabId: 8, level: 'log', message: 'Confirmation received. Reference: REF-9901' },
    { tabId: 99, level: 'error', message: 'Failed to load social feed' }
  ];

  const rawNetworkResponses = [
    { tabId: 1, method: 'GET', url: 'https://bank.example.com/api/balance', status: 200, statusText: 'OK' },
    { tabId: 7, method: 'POST', url: 'https://service.example.com/api/submit?key=privateKey123', status: 201, statusText: 'Created', durationMs: 250 },
    { tabId: 8, method: 'GET', url: 'https://service.example.com/confirm?id=9901', status: 200, statusText: 'OK', durationMs: 80 }
  ];

  const actionLedger = [
    {
      id: 'step_1',
      action: 'navigate',
      tabId: 7,
      args: { tabId: 7, url: 'https://service.example.com/apply' },
      timestamp: 1000,
      durationMs: 320,
      status: 'complete',
      result: { title: 'Application Form' }
    },
    {
      id: 'step_2',
      action: 'fill',
      tabId: 7,
      args: { tabId: 7, selector: '#userPassword', value: 'hunter2Password!' },
      timestamp: 1400,
      durationMs: 45,
      status: 'complete',
      result: { filled: true }
    },
    {
      id: 'step_3',
      action: 'new_tab',
      args: { url: 'https://service.example.com/confirm' },
      timestamp: 1500,
      durationMs: 410,
      status: 'complete',
      result: { id: 8, url: 'https://service.example.com/confirm' }
    }
  ];

  // The task only used Tab 7 and opened Tab 8 (participatingTabIds automatically discovered or passed)
  const taskBundle = exporter.createBundle({
    runId: 'bundle-scoped-task-1',
    settings: customSettings,
    tabs: allTabs,
    actionLedger,
    consoleLogs: rawConsoleLogs,
    networkResponses: rawNetworkResponses,
    startTime: 1000,
    endTime: 2100,
    totalDurationMs: 1100
  });

  // Verify participating tab identification
  const participatingIds = exporter.extractParticipatingTabIds({ actionLedger });
  assert.deepEqual(participatingIds.sort(), [7, 8], 'Task tabs 7 and 8 must be identified as participating');

  // Omit all browser tabs not participating in the task
  assert.equal(taskBundle.tabs.length, 2, 'Only participating tabs 7 and 8 should remain in tabs array');
  const bundleTabIds = taskBundle.tabs.map(t => t.id).sort();
  assert.deepEqual(bundleTabIds, [7, 8]);
  assert.ok(!taskBundle.tabs.some(t => t.id === 1 || t.id === 2 || t.id === 99), 'Tabs 1, 2, 99 MUST be omitted');
  assert.ok(!taskBundle.tabs[0].url.includes('apiKey=12345'), 'Query params on participating tab URLs must be redacted');

  // Verify console logs are strictly scoped to participating tabs
  assert.equal(taskBundle.scopedTabConsoleLogs.length, 2, 'Console logs must only contain logs from tabs 7 and 8');
  assert.ok(!taskBundle.scopedTabConsoleLogs.some(log => log.tabId === 1 || log.tabId === 2 || log.tabId === 99), 'Console logs from tabs 1, 2, 99 MUST be omitted');
  const tab7Log = taskBundle.scopedTabConsoleLogs.find(l => l.tabId === 7);
  assert.ok(tab7Log.message.includes('Bearer [REDACTED]'), 'Console log message must have Bearer token redacted');
  assert.ok(!tab7Log.message.includes('secret-auth-token-777'), 'Raw token in console log must not leak');

  // Verify network responses are strictly scoped
  assert.equal(taskBundle.networkResponseStatuses.length, 2, 'Network statuses must only contain requests from participating tabs');
  assert.ok(!taskBundle.networkResponseStatuses.some(n => n.tabId === 1), 'Network response from tab 1 MUST be omitted');
  assert.equal(taskBundle.networkResponseStatuses[0].status, 201);
  assert.ok(!taskBundle.networkResponseStatuses[0].url.includes('privateKey123'), 'Network URL query keys must be redacted');

  // Verify action ledger scrubbed password
  assert.equal(taskBundle.actionLedger.length, 3);
  const fillAction = taskBundle.actionLedger.find(a => a.action === 'fill');
  assert.equal(fillAction.args.value, '[REDACTED]', 'Password value in fill action must be redacted');

  // Verify duration timings breakdown
  assert.equal(taskBundle.timings.startTime, 1000);
  assert.equal(taskBundle.timings.endTime, 2100);
  assert.equal(taskBundle.timings.totalDurationMs, 1100);
  assert.equal(taskBundle.timings.actionDurations['1_navigate'], 320);
  assert.equal(taskBundle.timings.actionDurations['2_fill'], 45);
  assert.equal(taskBundle.timings.actionDurations['3_new_tab'], 410);

  // 5. Serialization and reproducibility check
  const serialized = JSON.stringify(taskBundle);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.runId, 'bundle-scoped-task-1');
  assert.equal(parsed.actionLedger.length, 3);
  assert.equal(parsed.tabs.length, 2);
  assert.equal(parsed.scopedTabConsoleLogs.length, 2);
  assert.equal(parsed.networkResponseStatuses.length, 2);

  // 6. Verify sidepanel.html contains "Export Diagnostics" button & diagnostic-exporter script
  const sidepanelHtml = fs.readFileSync(path.resolve(__dirname, '../extensions/chrome/sidepanel.html'), 'utf8');
  assert.ok(sidepanelHtml.includes('id="exportDiagnostics"'), 'sidepanel.html must contain #exportDiagnostics button');
  assert.ok(sidepanelHtml.includes('Export Diagnostics'), 'sidepanel.html must contain text "Export Diagnostics"');
  assert.ok(sidepanelHtml.includes('src="diagnostic-exporter.js"'), 'sidepanel.html must include diagnostic-exporter.js');

  // 7. Verify sidepanel.js wires handler for exportDiagnostics
  const sidepanelJs = fs.readFileSync(path.resolve(__dirname, '../extensions/chrome/sidepanel.js'), 'utf8');
  assert.ok(sidepanelJs.includes('exportDiagnostics'), 'sidepanel.js must define exportDiagnostics');
  assert.ok(sidepanelJs.includes('$("exportDiagnostics")'), 'sidepanel.js must wire exportDiagnostics event listener');

  // 8. Verify the 9 specific diagnostic exporter fixes
  // 1. Basic Auth header redaction
  const basicAuthHeader = 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==';
  assert.equal(exporter.redactString(basicAuthHeader), 'Authorization: Basic [REDACTED]');

  // 2. Email address redaction & sensitive key/field checks
  const emailText = 'Contact support at user.name+tag@example.co.uk or admin@sub.domain.org for help.';
  assert.equal(exporter.redactString(emailText), 'Contact support at [REDACTED_EMAIL] or [REDACTED_EMAIL] for help.');
  assert.ok(exporter.isSensitiveKey('email'), 'email must be sensitive key');
  assert.ok(exporter.isSensitiveKey('email_address') || exporter.isSensitiveKey('email'), 'email keys must be sensitive');
  assert.ok(exporter.isSensitiveField('email'), 'email must be sensitive field');
  assert.ok(exporter.isSensitiveField({ name: 'user_email' }), 'email input must be sensitive field');

  // 3. redactUrl: parsed.username redacted if non-empty, query params (card, credit_card, cardNumber, cvv, email, bearer), and credit card / api key in URL
  const testUrl = 'https://myuser:mypassword@example.com/api/v1/sk-proj-1234567890abcdef1234567890?card=4111111111111111&credit_card=5500000000000004&cardNumber=378282246310005&cvv=123&email=test@example.com&bearer=secrettoken123&other=4111111111111111';
  const redactedUrl = exporter.redactUrl(testUrl);
  assert.ok(!redactedUrl.includes('myuser'), 'URL username must be redacted');
  assert.ok(!redactedUrl.includes('mypassword'), 'URL password must be redacted');
  assert.ok(!redactedUrl.includes('sk-proj-1234567890abcdef1234567890'), 'API key in URL path must be redacted');
  assert.ok(redactedUrl.includes('card=%5BREDACTED%5D') || redactedUrl.includes('card=[REDACTED]'), 'card param must be redacted');
  assert.ok(redactedUrl.includes('credit_card=%5BREDACTED%5D') || redactedUrl.includes('credit_card=[REDACTED]'), 'credit_card param must be redacted');
  assert.ok(redactedUrl.includes('cardNumber=%5BREDACTED%5D') || redactedUrl.includes('cardNumber=[REDACTED]'), 'cardNumber param must be redacted');
  assert.ok(redactedUrl.includes('cvv=%5BREDACTED%5D') || redactedUrl.includes('cvv=[REDACTED]'), 'cvv param must be redacted');
  assert.ok(redactedUrl.includes('email=%5BREDACTED%5D') || redactedUrl.includes('email=[REDACTED]'), 'email param must be redacted');
  assert.ok(redactedUrl.includes('bearer=%5BREDACTED%5D') || redactedUrl.includes('bearer=[REDACTED]'), 'bearer param must be redacted');
  assert.ok(!redactedUrl.includes('4111111111111111'), 'Credit card in query value must be redacted by redactCreditCards');

  // 4. isSensitiveField: pass, pin, ssn
  assert.ok(exporter.isSensitiveField('pass'), 'pass must be sensitive field');
  assert.ok(exporter.isSensitiveField('pin'), 'pin must be sensitive field');
  assert.ok(exporter.isSensitiveField('ssn'), 'ssn must be sensitive field');
  assert.ok(exporter.isSensitiveField({ selector: '#user_pin' }), 'pin selector must be sensitive field');
  assert.ok(exporter.isSensitiveField({ name: 'ssn_number' }), 'ssn name must be sensitive field');
  assert.ok(exporter.isSensitiveField({ id: 'quick_pass' }), 'pass id must be sensitive field');

  // 5. Network response filtering: default to dropping requests where res.tabId is undefined or null
  const responsesWithNullTabId = [
    { url: 'https://background.example.com/api', status: 200, tabId: null },
    { url: 'https://untracked.example.com/api', status: 200, tabId: undefined },
    { url: 'https://notab.example.com/api', status: 200 },
    { url: 'https://tracked.example.com/api', status: 200, tabId: 7 }
  ];
  const filteredResponses = exporter.filterNetworkResponses(responsesWithNullTabId, [7]);
  assert.equal(filteredResponses.length, 1, 'Only request with participating tabId 7 must be kept');
  assert.equal(filteredResponses[0].tabId, 7);

  // 6. When action === 'list_tabs', filter out non-participating tab data from action.result
  const listTabsLedger = [
    {
      action: 'list_tabs',
      tabId: 7,
      result: [
        { id: 1, title: 'Secret Bank Tab', url: 'https://bank.example.com' },
        { id: 7, title: 'Working Tab', url: 'https://service.example.com?apiKey=xyz' },
        { id: 99, title: 'Secret Social Tab', url: 'https://social.example.com' }
      ]
    },
    {
      action: 'list_tabs',
      tabId: 7,
      result: {
        tabs: [
          { id: 1, title: 'Secret Bank Tab', url: 'https://bank.example.com' },
          { id: 7, title: 'Working Tab', url: 'https://service.example.com' }
        ]
      }
    }
  ];
  const listTabsBundle = exporter.createBundle({
    participatingTabIds: [7],
    actionLedger: listTabsLedger
  });
  assert.equal(listTabsBundle.actionLedger[0].result.length, 1, 'list_tabs array result must filter out non-participating tabs');
  assert.equal(listTabsBundle.actionLedger[0].result[0].id, 7);
  assert.ok(!JSON.stringify(listTabsBundle.actionLedger[0].result).includes('Secret Bank Tab'), 'Bank tab must be stripped from list_tabs result');
  assert.equal(listTabsBundle.actionLedger[1].result.tabs.length, 1, 'list_tabs object.tabs result must filter out non-participating tabs');
  assert.equal(listTabsBundle.actionLedger[1].result.tabs[0].id, 7);

  // 7. Defensive checks: default options = options || {}, filter Array.isArray and truthy entries
  const defensiveBundle = exporter.createBundle(null);
  assert.ok(defensiveBundle && defensiveBundle.runId, 'createBundle(null) must succeed');
  const bundleWithDirtyArrays = exporter.createBundle({
    actionLedger: [null, undefined, false, { action: 'click', tabId: 7 }],
    networkResponses: [null, undefined, { url: 'https://example.com', tabId: 7 }]
  });
  assert.equal(bundleWithDirtyArrays.actionLedger.length, 1, 'Dirty entries in actionLedger must be filtered');
  assert.equal(bundleWithDirtyArrays.networkResponseStatuses.length, 1, 'Dirty entries in networkResponses must be filtered');

  // 8. Convert BigInt to string in redact() so JSON.stringify(bundle) never throws
  const bigIntObject = {
    bigNumber: 9007199254740991n,
    cardBigInt: 4111111111111111n
  };
  const redactedBigInt = exporter.redact(bigIntObject);
  assert.equal(typeof redactedBigInt.bigNumber, 'string');
  assert.equal(redactedBigInt.bigNumber, '9007199254740991');
  assert.equal(redactedBigInt.cardBigInt, '[REDACTED_CREDIT_CARD]');
  assert.doesNotThrow(() => JSON.stringify(exporter.createBundle({
    actionLedger: [{ action: 'compute', args: { count: 12345678901234567890n } }]
  })), 'BigInt in bundle must not throw during JSON.stringify');

  // 9. Format Error objects properly in action.error and action.result
  const errorLedger = [
    {
      action: 'fail_action',
      error: new TypeError('Cannot read properties of null with sk-proj-1234567890abcdef1234567890')
    },
    {
      action: 'catch_action',
      result: new Error('Execution failed with secret password: MySecretPassword!')
    }
  ];
  const errorBundle = exporter.createBundle({ actionLedger: errorLedger });
  const failedAction = errorBundle.actionLedger[0];
  const caughtAction = errorBundle.actionLedger[1];
  assert.ok(failedAction.error && typeof failedAction.error === 'object', 'action.error must be formatted object');
  assert.equal(failedAction.error.name, 'TypeError');
  assert.ok(!failedAction.error.message.includes('sk-proj'), 'API key in error message must be redacted');
  assert.ok(caughtAction.result && typeof caughtAction.result === 'object', 'action.result Error must be formatted object');
  assert.equal(caughtAction.result.name, 'Error');
  assert.ok(!caughtAction.result.message.includes('MySecretPassword!'), 'Password in Error message must be redacted');
  assert.ok(caughtAction.result.message.length > 0, 'Error message must not be lost');

  console.log('Diagnostic Exporter: Bundle assembly, strict redactions, participating tab scoping, network responses and UI wiring verified');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
