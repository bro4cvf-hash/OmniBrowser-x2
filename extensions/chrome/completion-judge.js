/* Programmatic Evidence-Based Completion Judge for OmniBrowser */
(function (root) {
  const CONFIRMATION_PATTERNS = [
    /\b(?:thank\s+you|thanks)\b[\s\S]*?\b(?:submi\w*|order|application|request|message|inquiry|form|received|registered)\b/is,
    /\b(?:submission|application|request|order|registration|message)\b[\s\S]*?\b(?:received|successful|submitted|confirmed|completed|accepted)\b/is,
    /\b(?:successfully|has been)\b[\s\S]*?\b(?:submitted|received|processed|sent|created|saved|registered)\b/is,
    /\bconfirmation\s+(?:number|code|id|#)\b/i,
    /\breference\s+(?:number|code|id|#)\b/i,
    /\bapplication\s+(?:id|number|reference|#)\b/i,
    /\b(?:order|tracking)\s+(?:id|number|#)\b/i,
    /\byour\s+(?:application|order|request|submission)\s+is\s+complete\b/i,
    /\bwe\s+have\s+received\s+your\b/i,
    /\bsubmission\s+received\b/i,
    /\bapplication\s+submitted\b/i,
    /\byour\s+response\s+has\s+been\s+recorded\b/i,
    /\bbooking\s+confirmed\b/i,
    /\breservation\s+(?:is\s+)?confirmed\b/i,
    /\bpayment\s+successful\b/i,
    /\btransaction\s+(?:id|number|#)\b/i,
    /\ball\s+set\b/i,
    /\bdone!\s*we(?:'ve|\s+have)\s+received\b/i,
    /\bscheduled\s+successfully\b/i
  ];

  const NEGATIVE_PATTERNS = [
    /\b(?:submission|application|request)\s+(?:failed|rejected|error|unsuccessful)\b/i,
    /\b(?:please|must)\s+correct\s+the\s+(?:following\s+)?errors?\b/i,
    /\b(?:required|mandatory)\s+fields?\s+(?:are\s+)?missing\b/i,
    /\bthere\s+was\s+an\s+error\s+processing\b/i,
    /\bfailed\s+to\s+submit\b/i,
    /\berror\s+submitting\s+form\b/i
  ];

  const SUBMIT_SELECTOR_PATTERN = /(?:submit|apply|send|checkout|register|place-order|btn-submit|submit-btn)/i;

  function parseJsonSafely(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); }
    catch { return value; }
  }

  function normalizeLedgerEntry(entry, index) {
    if (!entry || typeof entry !== 'object') return null;
    let tool = entry.tool || entry.name || entry.action || entry.function?.name || '';
    let args = entry.args || entry.input || entry.arguments || {};
    let result = entry.result !== undefined ? entry.result : (entry.output !== undefined ? entry.output : entry.response);

    if (entry.role === 'tool' && entry.content !== undefined) {
      result = parseJsonSafely(entry.content);
      if (!tool && entry.tool_call_id) tool = entry.tool_call_id;
    }

    if (typeof args === 'string') args = parseJsonSafely(args);
    if (typeof result === 'string') result = parseJsonSafely(result);

    return {
      index,
      tool: String(tool || ''),
      args: typeof args === 'object' && args !== null ? args : {},
      result: result ?? null,
      timestamp: entry.timestamp !== undefined ? entry.timestamp : index,
      raw: entry
    };
  }

  function checkTextPatterns(text) {
    if (typeof text !== 'string' || !text.trim()) return { confirmed: false, error: false };
    
    // Check error patterns first
    for (const pattern of NEGATIVE_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        return {
          confirmed: false,
          error: true,
          pattern: pattern.toString(),
          snippet: text.slice(Math.max(0, match.index - 40), Math.min(text.length, match.index + match[0].length + 40)).trim()
        };
      }
    }

    // Check confirmation patterns
    for (const pattern of CONFIRMATION_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        return {
          confirmed: true,
          error: false,
          pattern: pattern.toString(),
          snippet: text.slice(Math.max(0, match.index - 40), Math.min(text.length, match.index + match[0].length + 40)).trim()
        };
      }
    }

    return { confirmed: false, error: false };
  }

  function urlsMatch(url1, url2) {
    if (!url1 || !url2) return false;
    if (url1 === url2) return true;
    try {
      const u1 = new URL(url1);
      const u2 = new URL(url2);
      if (u1.origin !== u2.origin) return false;
      const p1 = u1.pathname.replace(/\/$/, '');
      const p2 = u2.pathname.replace(/\/$/, '');
      return p1 === p2 || p1.startsWith(p2 + '/') || p2.startsWith(p1 + '/');
    } catch {
      return false;
    }
  }

  function extractEvidence(ledgerItems, currentTabState) {
    const evidence = [];
    const submissionActions = [];
    const observedUrls = new Set();
    const tabUrls = new Map();

    // 1. Scan ledger items
    for (const item of ledgerItems) {
      if (!item) continue;
      const { tool, args, result, timestamp, index } = item;
      // Failed, skipped and uncertain tool outputs cannot establish success.
      if (result?.error || result?.skipped || result?.interrupted || result?.completed === false || result?.success === false) continue;

      // Track tab URLs
      const targetUrl = args?.url || result?.url || result?.page?.url;
      if (targetUrl) {
        observedUrls.add(String(targetUrl));
        if (args?.tabId !== undefined) tabUrls.set(args.tabId, String(targetUrl));
        if (result?.tabId !== undefined) tabUrls.set(result.tabId, String(targetUrl));
      }

      const activeUrl = targetUrl || (args?.tabId !== undefined ? tabUrls.get(args.tabId) : undefined);

      // A. DOM verification via form_verify
      if (tool === 'form_verify') {
        const isVerified = result?.verified === true || (result?.verified !== false && (
          (Array.isArray(result?.results) && result.results.length > 0 &&
           result.results.every(r => r.matches === true && r.valid !== false && !r.error)) ||
          (Array.isArray(result?.fields) && result.fields.length > 0 &&
           result.fields.every(f => f.matches === true && f.valid !== false && !f.error))));

        evidence.push({
          id: `ev-${index}`,
          index,
          type: 'form_verify',
          verified: isVerified,
          tabId: args.tabId,
          url: activeUrl,
          fields: result?.results || result?.fields || args.fields || [],
          timestamp,
          detail: isVerified ? 'Form fields verified against DOM values' : (result?.error || 'Form verification failed')
        });
      }

      // B. Confirmation text from read_page or read_pages or browser_step or tool result
      const pageText = result?.text || result?.page?.text || (typeof result === 'string' ? result : null);
      if (pageText && ['read_page', 'read_pages', 'browser_step', 'navigate', 'click'].includes(tool)) {
        const check = checkTextPatterns(pageText);
        if (check.confirmed) {
          evidence.push({
            id: `ev-${index}`,
            index,
            type: 'confirmation_text',
            verified: true,
            tabId: args.tabId,
            url: activeUrl,
            snippet: check.snippet,
            timestamp,
            detail: `Confirmation text observed: "${check.snippet}"`
          });
        } else if (check.error) {
          evidence.push({
            id: `ev-${index}`,
            index,
            type: 'error_text',
            verified: false,
            tabId: args.tabId,
            url: activeUrl,
            snippet: check.snippet,
            timestamp,
            detail: `Form submission error detected: "${check.snippet}"`
          });
        }
      }

      // C. Downloaded files verification
      const isDownloadTool = tool === 'download' || tool === 'downloads_status' || item.raw?.type === 'download' || item.raw?.action === 'download';
      if (isDownloadTool || result?.download || result?.downloads) {
        const dl = result?.download || (Array.isArray(result?.downloads) ? result.downloads[0] : result);
        const complete = dl?.verified !== false && (dl?.complete === true ||
          dl?.state === 'complete' || dl?.state === 'completed' || dl?.status === 'complete' ||
          (typeof dl?.path === 'string' && (dl?.size > 0 || dl?.exists === true)));
        if (complete) {
          evidence.push({
            id: `ev-${index}`,
            index,
            type: 'download_verified',
            verified: true,
            url: activeUrl,
            path: dl.path || dl.filename || args.path || args.filename,
            size: dl.size,
            timestamp,
            detail: `Verified downloaded file: ${dl.path || dl.filename || 'completed'}`
          });
        }
      }

      // Local file reading tools verifying a downloaded file
      if (['files_extract', 'files_list', 'files_search'].includes(tool)) {
        if (!result?.error && (result?.content || (Array.isArray(result?.files) && result.files.length > 0))) {
          evidence.push({
            id: `ev-${index}`,
            index,
            type: 'file_verified',
            verified: true,
            path: args.path,
            timestamp,
            detail: `Verified local file content via ${tool}`
          });
        }
      }

      // D. Explicit structured records (e.g. backend confirmationId, receipt)
      const recordId = result?.confirmationId || result?.confirmationNumber || result?.referenceId ||
        result?.receiptId || result?.applicationId || result?.orderId || result?.trackingId ||
        result?.transactionId || result?.submissionId || result?.bookingId || result?.reservationId ||
        result?.ticketId || result?.paymentId || result?.caseId;
      if (recordId) {
        evidence.push({
          id: `ev-${index}`,
          index,
          type: 'structured_record',
          verified: true,
          confirmationId: String(recordId),
          tabId: args.tabId,
          url: activeUrl,
          timestamp,
          detail: `Structured confirmation record received: ${recordId}`
        });
      }

      // Track submission actions
      const isSubmitClick = tool === 'click' && typeof args.selector === 'string' &&
        (SUBMIT_SELECTOR_PATTERN.test(args.selector) || /submit/i.test(args.selector));
      const isSubmitStep = tool === 'browser_step' && (
        (typeof args.clickSelector === 'string' && SUBMIT_SELECTOR_PATTERN.test(args.clickSelector)) ||
        (Array.isArray(args.actions) && args.actions.some(a => (a.action === 'press_key' || a.action === 'pressKey') && (a.key === 'Enter' || String(a.key).toLowerCase() === 'enter')))
      );
      const isEnterPress = tool === 'press_key' &&
        (args?.key === 'Enter' || args?.key === 'Return' || String(args?.key).toLowerCase() === 'enter');

      if (isSubmitClick || isSubmitStep || isEnterPress) {
        submissionActions.push({
          id: `act-${index}`,
          index,
          tool,
          selector: args.selector || args.clickSelector || (isEnterPress ? (args.selector || 'Enter') : undefined),
          tabId: args.tabId,
          url: activeUrl,
          timestamp
        });
      }
    }

    // 2. Check currentTabState
    if (currentTabState) {
      if (currentTabState.url) observedUrls.add(String(currentTabState.url));

      const tabText = currentTabState.text || currentTabState.page?.text || currentTabState.title;
      if (tabText) {
        const check = checkTextPatterns(tabText);
        if (check.confirmed) {
          evidence.push({
            id: 'ev-tabstate',
            index: Infinity,
            type: 'confirmation_text',
            verified: true,
            url: currentTabState.url,
            snippet: check.snippet,
            timestamp: Infinity,
            detail: `Current page confirmation text: "${check.snippet}"`
          });
        } else if (check.error) {
          evidence.push({
            id: 'ev-tabstate-err',
            index: Infinity,
            type: 'error_text',
            verified: false,
            url: currentTabState.url,
            snippet: check.snippet,
            timestamp: Infinity,
            detail: `Current page error detected: "${check.snippet}"`
          });
        }
      }

      if (Array.isArray(currentTabState.downloads)) {
        for (const dl of currentTabState.downloads) {
          if (dl && (dl.state === 'complete' || dl.complete === true)) {
            evidence.push({
              id: 'ev-tabstate-dl',
              index: Infinity,
              type: 'download_verified',
              verified: true,
              path: dl.path || dl.filename,
              size: dl.size,
              timestamp: Infinity,
              detail: `Current tab completed download: ${dl.path || dl.filename}`
            });
          }
        }
      }
    }

    return { evidence, submissionActions, observedUrls };
  }

  function matchesCandidate(item, candidate, isSingle) {
    if (!item || !candidate) return false;
    const cUrl = candidate.url ? String(candidate.url) : '';
    const cTitle = candidate.title ? String(candidate.title).toLowerCase() : '';

    // Match by URL
    if (item.url && cUrl) {
      if (urlsMatch(item.url, cUrl)) return true;
      try {
        const u1 = new URL(item.url);
        const u2 = new URL(cUrl);
        if (u1.origin !== u2.origin || u1.pathname !== u2.pathname) return false;
      } catch {
        return false;
      }
      return false;
    }

    // Match by selector containing URL slug or title tokens (e.g. #submit-c1 matching /c1 or c1)
    const selectors = [item.selector, ...(Array.isArray(item.fields) ? item.fields.map(f => f.selector) : [])].filter(Boolean);
    for (const sel of selectors) {
      if (cUrl) {
        try {
          const pathname = new URL(cUrl).pathname.replace(/^\/|\/$/g, '');
          if (pathname && sel.toLowerCase().includes(pathname.toLowerCase())) return true;
        } catch {}
      }
      if (cTitle) {
        const tokens = cTitle.split(/\W+/).filter(t => t.length > 0);
        if (tokens.some(t => sel.toLowerCase().includes(t.toLowerCase()))) return true;
      }
    }

    // Match tabId with tokens (e.g. tabId: 2 with Candidate 2 or /c2)
    if (item.tabId !== undefined && (cTitle || cUrl)) {
      const tabStr = String(item.tabId);
      if (cTitle.includes(tabStr) || cUrl.includes(tabStr) || cUrl.includes(`c${tabStr}`)) return true;
    }

    // Match snippet text
    if (item.snippet && cTitle) {
      const tokens = cTitle.split(/\W+/).filter(t => t.length > 2);
      if (tokens.some(t => item.snippet.toLowerCase().includes(t))) return true;
    }

    // If item has no URL and no selector conflicting with candidate, and candidate status matches item type:
    if (!item.url && item.type === 'form_verify' && candidate.status === 'ready') return true;

    // For single candidate, match if there is no conflicting URL
    if (isSingle && (!item.url || !cUrl)) return true;

    return false;
  }

  function evaluateSingleResult(result, { evidence, submissionActions, observedUrls, isSingle, claimedEvidence, claimedActions }) {
    if (!result || typeof result !== 'object') {
      return {
        result,
        status: 'outcome_unknown',
        originalStatus: undefined,
        verified: false,
        evidence: [],
        missingEvidence: ['Valid result object required'],
        reason: 'Missing result object'
      };
    }

    const originalStatus = result.status;
    const itemUrl = result.url ? String(result.url) : '';
    const itemEvidence = [];
    const missingEvidence = [];
    let judgedStatus = originalStatus;
    let reason = '';

    // Match candidate actions
    const candidateActions = submissionActions.filter(act =>
      !claimedActions.has(act.id) && matchesCandidate(act, result, isSingle)
    );

    // If no candidate action matched by attributes and this is single or unassigned, take available action
    if (!candidateActions.length && isSingle && submissionActions.length > 0 && !claimedActions.has(submissionActions[0].id)) {
      const act = submissionActions[0];
      if (!act.url || !itemUrl || urlsMatch(act.url, itemUrl)) {
        candidateActions.push(act);
      }
    }
    candidateActions.forEach(act => claimedActions.add(act.id));

    // Match candidate confirmations
    const candidateConfirmations = evidence.filter(e =>
      e.verified &&
      ['confirmation_text', 'structured_record', 'download_verified'].includes(e.type) &&
      !claimedEvidence.has(e.id) &&
      matchesCandidate(e, result, isSingle)
    );

    // If single candidate or unassigned confirmation exists after candidate action
    if (!candidateConfirmations.length && isSingle) {
      const anyConf = evidence.find(e =>
        e.verified &&
        ['confirmation_text', 'structured_record', 'download_verified'].includes(e.type) &&
        !claimedEvidence.has(e.id) &&
        (!e.url || !itemUrl || urlsMatch(e.url, itemUrl))
      );
      if (anyConf) candidateConfirmations.push(anyConf);
    }

    // False Positive Protection & Temporal Causality:
    // DO NOT verify solely on confirmation text unless a submission action (candidateActions.length > 0)
    // actually occurred in the ledger or was verified, and confirmation was observed at or after the submission action.
    const validConfirmations = candidateConfirmations.filter(conf => {
      if (conf.type === 'confirmation_text') {
        if (!candidateActions.length) return false;
        const confTime = conf.timestamp !== undefined ? conf.timestamp : conf.index;
        return candidateActions.some(act => {
          const actTime = act.timestamp !== undefined ? act.timestamp : act.index;
          return confTime >= actTime;
        });
      }
      return true;
    });

    // Match DOM verifications
    const latestVerification = evidence.filter(e => e.type === 'form_verify' && matchesCandidate(e, result, isSingle)).at(-1);
    const domVerifications = latestVerification?.verified ? [latestVerification] : [];
    const domFailures = latestVerification && !latestVerification.verified ? [latestVerification] : [];
    const lastActionTime = candidateActions.length ? Math.max(...candidateActions.map(action => action.timestamp)) : -Infinity;
    const errorsDetected = evidence.filter(e => !e.verified &&
      (e.type === 'error_text' || domFailures.includes(e)) && e.timestamp >= lastActionTime &&
      matchesCandidate(e, result, isSingle));

    // Check if URL was observed / visited (non-empty URL required)
    const isUrlObserved = Boolean(itemUrl) && (observedUrls.has(itemUrl) || [...observedUrls].some(u => urlsMatch(itemUrl, u)));

    switch (originalStatus) {
      case 'submitted': {
        if (errorsDetected.length > 0) {
          judgedStatus = 'blocked';
          reason = `Submission failed or page has errors: ${errorsDetected[0].detail}`;
          missingEvidence.push('Successful submission without page errors');
        } else if (validConfirmations.length > 0) {
          judgedStatus = 'submitted';
          itemEvidence.push(...validConfirmations);
          validConfirmations.forEach(c => claimedEvidence.add(c.id));
          reason = `Confirmed by programmatic evidence: ${validConfirmations[0].detail}`;
        } else {
          // Lacking confirmation evidence!
          if (candidateActions.length > 0 || submissionActions.some(act => matchesCandidate(act, result, isSingle))) {
            judgedStatus = 'outcome_unknown';
            reason = 'Submission was attempted, but outcome is unknown without confirmation evidence (e.g. confirmation text from read_page or structured receipt).';
            missingEvidence.push('Confirmation text from read_page, confirmation number, or structured receipt');
          } else {
            judgedStatus = 'needs_evidence';
            reason = 'Model asserted submission without evidence of submission action or confirmation.';
            missingEvidence.push('Executed submit action and verified confirmation');
          }
        }
        break;
      }

      case 'ready': {
        if (domFailures.length > 0) {
          judgedStatus = 'needs_evidence';
          reason = `Form fields failed validation: ${domFailures[0].detail}`;
          missingEvidence.push('Successful form_verify matching expected values');
        } else if (domVerifications.length > 0) {
          judgedStatus = 'ready';
          itemEvidence.push(...domVerifications);
          domVerifications.forEach(v => claimedEvidence.add(v.id));
          reason = 'Form fields verified against DOM values via form_verify.';
        } else {
          judgedStatus = 'needs_evidence';
          reason = 'Form values have not been programmatically verified with form_verify.';
          missingEvidence.push('Verified DOM values from form_verify');
        }
        break;
      }

      case 'complete': {
        if (errorsDetected.length > 0) {
          judgedStatus = 'blocked';
          reason = `Errors detected during action: ${errorsDetected[0].detail}`;
        } else if (validConfirmations.length > 0 || domVerifications.length > 0) {
          judgedStatus = 'complete';
          itemEvidence.push(...validConfirmations, ...domVerifications);
          validConfirmations.forEach(c => claimedEvidence.add(c.id));
          domVerifications.forEach(v => claimedEvidence.add(v.id));
          reason = 'Action completed with programmatic evidence.';
        } else if (candidateActions.length > 0) {
          judgedStatus = 'outcome_unknown';
          reason = 'Action performed, but outcome unknown without confirmation evidence.';
          missingEvidence.push('Programmatic confirmation evidence');
        } else {
          judgedStatus = 'needs_evidence';
          reason = 'Completed status asserted without programmatic verification.';
          missingEvidence.push('Programmatic evidence (form_verify, confirmation text, or verified download)');
        }
        break;
      }

      case 'researched': {
        if (itemUrl && isUrlObserved) {
          judgedStatus = 'researched';
          reason = 'Target researched and observed in browser ledger.';
          itemEvidence.push({ type: 'navigation_observed', verified: true, detail: `URL observed in session: ${itemUrl}` });
        } else {
          judgedStatus = 'needs_evidence';
          reason = itemUrl
            ? 'Candidate URL was not inspected or navigated to in the ledger.'
            : 'Candidate URL is missing for researched item.';
          missingEvidence.push('Observed navigation or read_page for target URL');
        }
        break;
      }

      case 'blocked':
      case 'skipped':
      case 'outcome_unknown':
      case 'needs_evidence': {
        judgedStatus = originalStatus;
        reason = result.note || `Status marked as ${originalStatus}.`;
        break;
      }

      default: {
        judgedStatus = 'needs_evidence';
        reason = `Unrecognized or missing status: ${originalStatus}`;
        missingEvidence.push('Valid verified status');
        break;
      }
    }

    return {
      title: result.title,
      url: result.url,
      status: judgedStatus,
      originalStatus,
      note: result.note || '',
      verified: ['submitted', 'ready', 'complete', 'researched', 'skipped'].includes(judgedStatus) && missingEvidence.length === 0,
      evidence: itemEvidence,
      missingEvidence,
      reason
    };
  }

  function evaluateCompletionEvidence({ results, ledger = [], currentTabState = null } = {}) {
    const rawLedger = Array.isArray(ledger) ? ledger : (Array.isArray(ledger?.entries) ? ledger.entries : []);
    const normalizedLedger = rawLedger.map(normalizeLedgerEntry).filter(Boolean);
    const { evidence, submissionActions, observedUrls } = extractEvidence(normalizedLedger, currentTabState);

    const isSingleResult = results && !Array.isArray(results) && typeof results === 'object';
    const resultsList = isSingleResult ? [results] : (Array.isArray(results) ? results : []);

    const claimedEvidence = new Set();
    const claimedActions = new Set();
    const isSingle = resultsList.length <= 1;

    const judgedResults = resultsList.map(item =>
      evaluateSingleResult(item, {
        evidence,
        submissionActions,
        observedUrls,
        isSingle,
        claimedEvidence,
        claimedActions
      })
    );

    // Global missing evidence & verdict calculation
    const allMissing = [...new Set(judgedResults.flatMap(r => r.missingEvidence))];
    const hasOutcomeUnknown = judgedResults.some(r => r.status === 'outcome_unknown');
    const hasNeedsEvidence = judgedResults.some(r => r.status === 'needs_evidence');
    const hasBlocked = judgedResults.some(r => r.status === 'blocked');

    let verdict = 'complete';
    let completed = false;

    if (resultsList.length === 0) {
      const confirmations = evidence.filter(e => e.verified && (
        ['structured_record', 'download_verified'].includes(e.type) ||
        (e.type === 'confirmation_text' && submissionActions.some(action =>
          e.timestamp >= action.timestamp &&
          (e.tabId === undefined || action.tabId === undefined || e.tabId === action.tabId) &&
          (!e.url || !action.url || urlsMatch(e.url, action.url))))
      ));
      const errors = evidence.filter(e => !e.verified);
      if (errors.length > 0) {
        verdict = 'blocked';
        completed = false;
      } else if (confirmations.length > 0) {
        verdict = 'complete';
        completed = true;
      } else if (submissionActions.length > 0) {
        verdict = 'outcome_unknown';
        completed = false;
        allMissing.push('Confirmation text or receipt following submission action');
      } else {
        verdict = 'needs_evidence';
        completed = false;
        allMissing.push('Programmatic completion evidence');
      }
    } else {
      if (hasOutcomeUnknown) verdict = 'outcome_unknown';
      else if (hasNeedsEvidence) verdict = 'needs_evidence';
      else if (hasBlocked) verdict = 'blocked';
      else verdict = 'complete';

      completed = verdict === 'complete' && judgedResults.every(r => r.verified);
    }

    const summary = completed
      ? 'All actions and results verified with programmatic evidence.'
      : (verdict === 'outcome_unknown'
          ? 'Submission or action occurred, but outcome is unknown without confirmation evidence.'
          : (verdict === 'needs_evidence'
              ? 'Programmatic evidence required before completion can be verified.'
              : `Evaluation verdict: ${verdict}.`));

    const response = {
      completed,
      verdict,
      results: judgedResults,
      evidence,
      missingEvidence: allMissing,
      summary
    };

    if (isSingleResult && judgedResults.length === 1) {
      response.status = judgedResults[0].status;
      response.result = judgedResults[0];
      response.reason = judgedResults[0].reason;
    }

    return response;
  }

  // Task-specific evidence gates, adapted from Browser Use/Stagehand verifier contracts.
  // The checklist describes requirements; only live tool observations can satisfy them.
  function evaluateTaskCriteria({ criteria, page, fields = [], downloads = [] }) {
    if (!Array.isArray(criteria) || !criteria.length || criteria.length > 20) throw new Error('Provide 1 to 20 task criteria');
    const checks = criteria.map(criterion => {
      if (!criterion || typeof criterion !== 'object') throw new Error('Provide a valid task criterion');
      let passed = false, unknown = false;
      if (criterion.kind === 'text') {
        if (typeof criterion.text !== 'string' || !criterion.text || criterion.text.length > 1000) throw new Error('Provide expected page text');
        passed = (page?.text || '').includes(criterion.text);
        unknown = !passed && (page?.textTruncated || page?.pageError || !page);
      } else if (['field', 'checked'].includes(criterion.kind)) {
        if (typeof criterion.selector !== 'string' || !criterion.selector.trim() ||
          (criterion.kind === 'field' ? typeof criterion.value !== 'string' : typeof criterion.checked !== 'boolean')) throw new Error('Provide a field selector and its expected value or checkbox state');
        const candidates = fields.filter(item => item.selector === criterion.selector && (item.frameId || 0) === (criterion.frameId || 0));
        passed = candidates.some(field => field.matches === true && field.valid !== false && !field.error &&
          (criterion.kind === 'field' ? field.value === criterion.value : field.checked === criterion.checked));
        unknown = !candidates.length || candidates.every(field => !!field.error);
      } else if (criterion.kind === 'download') {
        const download = downloads.find(item => String(item.id) === String(criterion.id));
        passed = download?.verified === true && ['complete', 'completed'].includes(download.state);
        unknown = !download || ['in_progress', 'inProgress', 'outcome_unknown'].includes(download.state);
      } else throw new Error('Unsupported task criterion');
      return { ...criterion, passed, state: passed ? 'verified' : unknown ? 'unknown' : 'failed' };
    });
    const verified = checks.every(check => check.passed);
    const failed = checks.filter(check => check.state === 'failed').length;
    const unknown = checks.filter(check => check.state === 'unknown').length;
    return { verified, checks, summary: verified ? `All ${checks.length} checks passed.` : `${failed} checks failed; ${unknown} need more evidence.`,
      hint: 'Checks verify the supplied checklist against live observations. Field state does not prove server acceptance.' };
  }

  const api = {
    evaluateTaskCriteria,
    evaluateCompletionEvidence,
    extractEvidence,
    checkTextPatterns,
    CONFIRMATION_PATTERNS,
    NEGATIVE_PATTERNS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmniCompletionJudge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
