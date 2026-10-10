/**
 * OmniBrowser Redacted Diagnostic Bundle Exporter
 *
 * Assembles reproducible diagnostic bundles with strict redaction of sensitive
 * credentials (API keys, Bearer tokens, passwords, credit cards) and strict tab scoping
 * (omits all browser tabs not participating in the task).
 */
(function (root) {
  // Luhn algorithm for validating credit card numbers
  function isValidLuhn(str) {
    const digits = String(str).replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let shouldDouble = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = parseInt(digits.charAt(i), 10);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }
    return sum % 10 === 0;
  }

  function redactCreditCards(text) {
    if (!text || typeof text !== 'string') return text;
    // Replace candidate card numbers: sequences of 13 to 19 digits with optional spaces or hyphens
    return text.replace(/\b(?:\d[ -]*?){13,19}\b/g, match => {
      const cleaned = match.replace(/[\s-]/g, '');
      if (/^\d{13,19}$/.test(cleaned) && isValidLuhn(cleaned)) {
        return '[REDACTED_CREDIT_CARD]';
      }
      // Also catch standard 15-16 digit formatted card blocks (Visa, Mastercard, Amex, Discover)
      if (/^(?:4\d{3}|5[1-5]\d{2}|6011|3[47]\d{2})[- ]?\d{4,6}[- ]?\d{4,5}[- ]?\d{0,4}$/.test(match)) {
        return '[REDACTED_CREDIT_CARD]';
      }
      // Match general 4x4 digit blocks
      if (/^\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}$/.test(match)) {
        return '[REDACTED_CREDIT_CARD]';
      }
      return match;
    });
  }

  function redactBasicAuth(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/\bBasic\s+[A-Za-z0-9+/=]{10,}\b/gi, 'Basic [REDACTED]')
      .replace(/Basic\s+\[REDACTED\]=+/gi, 'Basic [REDACTED]');
  }

  function redactEmails(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi, '[REDACTED_EMAIL]');
  }

  function redactApiKeysAndTokens(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      // OpenAI and OpenAI-compatible keys
      .replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]')
      // Google API keys
      .replace(/\bAIza[0-9A-Za-z_-]{20,40}\b/g, '[REDACTED_API_KEY]')
      // GitHub Personal Access Tokens
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, '[REDACTED_API_KEY]')
      // Bearer tokens in headers or strings
      .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
      // Basic Auth header
      .replace(/\bBasic\s+[A-Za-z0-9+/=]{10,}\b/gi, 'Basic [REDACTED]')
      .replace(/Basic\s+\[REDACTED\]=+/gi, 'Basic [REDACTED]')
      // Key assignments like apiKey="...", x-api-key: ...
      .replace(/\b((?:api[_-]?key|apikey|x-api-key)\s*[:=]\s*["']?)[A-Za-z0-9_-]{16,}(["']?)/gi, '$1[REDACTED]$2');
  }

  function redactPasswords(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      // password="..." or password: '...'
      .replace(/\b((?:password|passwd|pwd|client_secret)\s*[:=]\s*["']?)[^\s"'&,;]+(["']?)/gi, '$1[REDACTED]$2')
      // URL parameters with password / secret
      .replace(/([?&](?:password|passwd|pwd|secret|client_secret|token|api_key|apiKey)=)[^&#]*/gi, '$1[REDACTED]');
  }

  function redactUrlCredentials(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/(https?:\/\/)([^:\/\s]+):([^@\/\s]+)@/g, '$1$2:[REDACTED]@');
  }

  function redactString(text) {
    if (typeof text !== 'string') return text;
    let result = text;
    result = redactApiKeysAndTokens(result);
    result = redactPasswords(result);
    result = redactCreditCards(result);
    result = redactUrlCredentials(result);
    result = redactEmails(result);
    return result;
  }

  function redactUrl(urlStr) {
    if (typeof urlStr !== 'string' || !urlStr) return '';
    try {
      const parsed = new URL(urlStr);
      if (parsed.username) parsed.username = '[REDACTED]';
      if (parsed.password) parsed.password = '[REDACTED]';
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (/^(api[-_]?key|key|token|auth|password|passwd|secret|sig|signature|access[-_]?token|card|credit[-_]?card|cardNumber|cvv|cvc|email|bearer)$/i.test(key)) {
          parsed.searchParams.set(key, '[REDACTED]');
        }
      }
      let result = parsed.href;
      result = redactCreditCards(result);
      result = redactApiKeysAndTokens(result);
      return result;
    } catch {
      return redactString(urlStr);
    }
  }

  function isSensitiveKey(key) {
    if (typeof key !== 'string') return false;
    return /^(api[-_]?key|apikey|password|passwd|pwd|secret|client[-_]?secret|bearer|authorization|token|access[-_]?token|refresh[-_]?token|auth[-_]?token|private[-_]?key|privatekey|cvv|cvc|credit[-_]?card|card[-_]?number|cardNumber|card|cc[-_]?num|ssn|email|e[-_]?mail)$/i.test(key);
  }

  function isSensitiveField(field) {
    if (!field) return false;
    if (typeof field === 'string') {
      return /password|passwd|pass|pwd|secret|credit|card|cvv|cvc|token|auth|email|pin|ssn/i.test(field);
    }
    if (typeof field === 'object') {
      return /password|passwd|pass|pwd|secret|credit|card|cvv|cvc|token|auth|email|pin|ssn/i.test(
        String(field.selector || field.name || field.id || field.field || '')
      ) || /^(password|email)$/i.test(String(field.type || ''));
    }
    return false;
  }

  function formatError(err) {
    if (!err) return null;
    if (typeof err === 'string') return redactString(err);
    if (err instanceof Error) {
      const formatted = {
        name: redactString(err.name || 'Error'),
        message: redactString(err.message || '')
      };
      if (err.stack) formatted.stack = redactString(err.stack);
      return formatted;
    }
    if (typeof err === 'object') {
      const formatted = {
        name: redactString(err.name || 'Error'),
        message: redactString(err.message || '')
      };
      if (err.stack) formatted.stack = redactString(String(err.stack));
      for (const [k, v] of Object.entries(err)) {
        if (!formatted[k]) formatted[k] = redact(v);
      }
      return formatted;
    }
    return redactString(String(err));
  }

  function redact(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'bigint') {
      const biStr = value.toString();
      if (biStr.length >= 13 && biStr.length <= 19 && isValidLuhn(biStr)) {
        return '[REDACTED_CREDIT_CARD]';
      }
      return biStr;
    }
    if (typeof value === 'number') {
      const numStr = String(value);
      if (numStr.length >= 13 && numStr.length <= 19 && isValidLuhn(numStr)) {
        return '[REDACTED_CREDIT_CARD]';
      }
      return value;
    }
    if (value instanceof Error) {
      const formatted = {
        name: redactString(value.name || 'Error'),
        message: redactString(value.message || '')
      };
      if (value.stack) formatted.stack = redactString(value.stack);
      return formatted;
    }
    if (typeof value !== 'object') return value;

    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map(item => redact(item, seen));
    }

    const fieldIsSensitive = isSensitiveField(value);

    const result = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k) || (fieldIsSensitive && (k === 'value' || k === 'text'))) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redact(v, seen);
      }
    }
    return result;
  }

  function getExtensionVersion() {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.getManifest) {
      try {
        const manifest = chrome.runtime.getManifest();
        if (manifest?.version) return manifest.version;
      } catch {}
    }
    return '0.1.0';
  }

  function getChromeVersion() {
    if (typeof navigator !== 'undefined' && navigator?.userAgent) {
      const match = navigator.userAgent.match(/Chrome\/([0-9.]+)/);
      if (match) return match[1];
    }
    if (typeof process !== 'undefined' && process?.versions?.chrome) {
      return process.versions.chrome;
    }
    return '116+';
  }

  function getOSVersion() {
    if (typeof navigator !== 'undefined') {
      if (navigator?.userAgentData?.platform) return navigator.userAgentData.platform;
      if (navigator?.platform) return navigator.platform;
      if (navigator?.userAgent) {
        if (/Windows/i.test(navigator.userAgent)) return 'Windows';
        if (/Macintosh|Mac OS/i.test(navigator.userAgent)) return 'macOS';
        if (/Linux/i.test(navigator.userAgent)) return 'Linux';
      }
    }
    if (typeof process !== 'undefined' && process?.platform) {
      return process.platform;
    }
    return 'unknown';
  }

  function getVersions(overrides = {}) {
    overrides = overrides || {};
    return {
      extension: overrides.extension || overrides.extensionVersion || getExtensionVersion(),
      chrome: overrides.chrome || overrides.chromeVersion || getChromeVersion(),
      os: overrides.os || overrides.osVersion || getOSVersion()
    };
  }

  function scrubProvider(settings = {}) {
    if (typeof settings === 'string') {
      return { name: redactString(settings), apiKey: '[REDACTED]' };
    }
    settings = settings || {};
    const name = settings.provider || settings.name || 'openai';
    const baseUrl = settings.baseUrl ? redactUrl(settings.baseUrl) : undefined;
    return {
      name,
      ...(baseUrl ? { baseUrl } : {}),
      apiKey: '[REDACTED]'
    };
  }

  function scrubModel(settings = {}) {
    if (typeof settings === 'string') {
      return { id: redactString(settings) };
    }
    settings = settings || {};
    const id = settings.model || settings.id || 'unknown';
    const contextWindow = settings.contextWindowTokens || settings.modelContextWindow || settings.contextWindow || null;
    return {
      id: redactString(id),
      ...(contextWindow ? { contextWindow } : {})
    };
  }

  function extractParticipatingTabIds(options = {}) {
    options = options || {};
    const ids = new Set();
    if (Array.isArray(options.participatingTabIds)) {
      options.participatingTabIds.forEach(id => {
        const num = Number(id);
        if (Number.isSafeInteger(num)) ids.add(num);
      });
    }
    if (options.originTab?.id !== undefined) {
      const num = Number(options.originTab.id);
      if (Number.isSafeInteger(num)) ids.add(num);
    }
    if (options.tabId !== undefined) {
      const num = Number(options.tabId);
      if (Number.isSafeInteger(num)) ids.add(num);
    }
    const rawLedger = options.actionLedger || options.ledger || [];
    const ledger = Array.isArray(rawLedger) ? rawLedger.filter(Boolean) : [];
    for (const item of ledger) {
      if (!item || typeof item !== 'object') continue;
      if (item.tabId !== undefined && item.tabId !== null) {
        const num = Number(item.tabId);
        if (Number.isSafeInteger(num)) ids.add(num);
      }
      if (item.args?.tabId !== undefined) {
        const num = Number(item.args.tabId);
        if (Number.isSafeInteger(num)) ids.add(num);
      }
      if (Array.isArray(item.args?.tabIds)) {
        item.args.tabIds.forEach(id => {
          const num = Number(id);
          if (Number.isSafeInteger(num)) ids.add(num);
        });
      }
      if (item.result?.tabId !== undefined) {
        const num = Number(item.result.tabId);
        if (Number.isSafeInteger(num)) ids.add(num);
      }
      if (item.result?.id !== undefined && (item.action === 'new_tab' || item.action === 'create_tab')) {
        const num = Number(item.result.id);
        if (Number.isSafeInteger(num)) ids.add(num);
      }
    }
    return [...ids];
  }

  function filterParticipatingTabs(tabs, participatingIds) {
    if (!Array.isArray(tabs)) return [];
    const idSet = new Set((participatingIds || []).map(Number));
    return tabs
      .filter(tab => tab && idSet.has(Number(tab.id)))
      .map(tab => ({
        id: tab.id,
        url: redactUrl(tab.url || ''),
        title: redactString(tab.title || ''),
        windowId: tab.windowId,
        ...(tab.active !== undefined ? { active: tab.active } : {}),
        ...(tab.index !== undefined ? { index: tab.index } : {})
      }));
  }

  function filterScopedConsoleLogs(logs, participatingIds) {
    if (!logs) return [];
    const idSet = new Set((participatingIds || []).map(Number));
    let rawList = [];
    if (Array.isArray(logs)) {
      rawList = logs.filter(Boolean);
    } else if (typeof logs === 'object') {
      // Map of tabId -> logs
      for (const [key, list] of Object.entries(logs)) {
        if (Array.isArray(list)) {
          const tabId = Number(key);
          list.filter(Boolean).forEach(entry => rawList.push({ tabId, ...(typeof entry === 'string' ? { message: entry } : entry) }));
        }
      }
    }

    return rawList
      .filter(entry => entry && idSet.has(Number(entry.tabId)))
      .map(entry => {
        const item = typeof entry === 'string' ? { message: entry } : { ...entry };
        return redact(item);
      });
  }

  function filterNetworkResponses(responses, participatingIds) {
    if (!Array.isArray(responses)) return [];
    const validResponses = responses.filter(Boolean);
    const idSet = new Set((participatingIds || []).map(Number));
    return validResponses
      .filter(res => typeof res === 'object')
      .filter(res => {
        if (res.tabId !== undefined && res.tabId !== null) {
          return idSet.has(Number(res.tabId));
        }
        return false;
      })
      .map(res => ({
        url: redactUrl(res.url || ''),
        status: Number(res.status || res.statusCode || 0),
        statusText: redactString(res.statusText || ''),
        method: String(res.method || 'GET').toUpperCase(),
        durationMs: Number(res.durationMs || res.duration || 0),
        ...(res.tabId !== undefined ? { tabId: res.tabId } : {}),
        ...(res.timestamp ? { timestamp: res.timestamp } : {})
      }));
  }

  function createBundle(options = {}) {
    options = options || {};
    const runId = options.runId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
    const participatingTabIds = extractParticipatingTabIds(options);

    const versions = getVersions(options.versions || options);
    const provider = scrubProvider(options.settings || options.provider);
    const model = scrubModel(options.settings || options.model);

    const rawLedger = options.actionLedger || options.ledger || [];
    const ledgerArray = Array.isArray(rawLedger) ? rawLedger.filter(Boolean) : [];
    const actionLedger = ledgerArray.map((action, index) => {
      const durationMs = Number(action.durationMs ?? action.duration ?? 0);
      const actionName = action.action || action.name || 'unknown';

      let resultVal;
      if (action.result !== undefined) {
        if (actionName === 'list_tabs') {
          if (Array.isArray(action.result)) {
            resultVal = filterParticipatingTabs(action.result, participatingTabIds);
          } else if (action.result && typeof action.result === 'object' && Array.isArray(action.result.tabs)) {
            resultVal = {
              ...redact(action.result),
              tabs: filterParticipatingTabs(action.result.tabs, participatingTabIds)
            };
          } else {
            resultVal = redact(action.result);
          }
        } else {
          resultVal = redact(action.result);
        }
      }

      return {
        id: action.id || `action_${index + 1}`,
        action: actionName,
        ...(action.tabId !== undefined ? { tabId: action.tabId } : {}),
        args: redact(action.args || action.arguments || {}),
        timestamp: action.timestamp || Date.now(),
        durationMs,
        status: action.status || (action.error ? 'failed' : 'complete'),
        ...(action.error ? { error: formatError(action.error) } : {}),
        ...(resultVal !== undefined ? { result: resultVal } : {})
      };
    });

    const candidateTabs = options.tabs || (options.originTab ? [options.originTab] : []);
    const tabs = filterParticipatingTabs(candidateTabs, participatingTabIds);
    const scopedTabConsoleLogs = filterScopedConsoleLogs(options.consoleLogs || options.scopedTabConsoleLogs, participatingTabIds);

    const rawNetworkResponses = options.networkResponses || options.networkResponseStatuses || [];
    const validNetworkResponses = Array.isArray(rawNetworkResponses) ? rawNetworkResponses.filter(Boolean) : [];
    const networkResponseStatuses = filterNetworkResponses(validNetworkResponses, participatingTabIds);

    const startTime = options.startTime || (actionLedger[0]?.timestamp || Date.now());
    const endTime = options.endTime || Date.now();
    const totalDurationMs = Number(
      options.totalDurationMs ?? options.durationMs ?? (actionLedger.reduce((sum, a) => sum + (a.durationMs || 0), 0))
    );

    const actionDurations = {};
    actionLedger.forEach((a, i) => {
      actionDurations[`${i + 1}_${a.action}`] = a.durationMs;
    });

    const timings = {
      startTime,
      endTime,
      totalDurationMs,
      actionDurations
    };

    const bundle = {
      runId,
      timestamp: new Date().toISOString(),
      versions,
      provider,
      model,
      actionLedger,
      tabs,
      scopedTabConsoleLogs,
      networkResponseStatuses,
      timings
    };

    // Aliases for convenience
    bundle.action_ledger = bundle.actionLedger;
    bundle.consoleLogs = bundle.scopedTabConsoleLogs;
    bundle.networkResponses = bundle.networkResponseStatuses;
    bundle.durationTimings = bundle.timings;

    return bundle;
  }

  function exportBundle(bundleOrOptions, exportOptions = {}) {
    bundleOrOptions = bundleOrOptions || {};
    exportOptions = exportOptions || {};
    const bundle = (bundleOrOptions && bundleOrOptions.runId && bundleOrOptions.versions)
      ? bundleOrOptions
      : createBundle(bundleOrOptions);

    const jsonString = JSON.stringify(bundle, null, 2);

    if (typeof document !== 'undefined' && exportOptions.download !== false) {
      try {
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `omnibrowser-diagnostics-${bundle.runId}.json`;
        document.body.append(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.warn('Could not trigger file download:', err);
      }
    }

    if (exportOptions.clipboard && typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(jsonString).catch(() => {});
    }

    return bundle;
  }

  const api = {
    createBundle,
    exportBundle,
    redact,
    redactString,
    redactUrl,
    redactCreditCards,
    redactApiKeysAndTokens,
    redactBasicAuth,
    redactEmails,
    redactPasswords,
    formatError,
    isSensitiveKey,
    isSensitiveField,
    isValidLuhn,
    getVersions,
    scrubProvider,
    scrubModel,
    extractParticipatingTabIds,
    filterParticipatingTabs,
    filterScopedConsoleLogs,
    filterNetworkResponses
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OmniDiagnosticExporter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
