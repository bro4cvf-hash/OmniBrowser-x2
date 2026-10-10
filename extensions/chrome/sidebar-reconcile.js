/* Reconciliation-Driven Resume Engine
 * Reconciles browser tab state to determine whether actions were submitted,
 * are currently in-flight, remained unsubmitted, or require user clarification.
 */
(function (root) {
  const STATES = {
    CONFIRMED_SUBMITTED: 'CONFIRMED_SUBMITTED',
    IN_PROGRESS: 'IN_PROGRESS',
    NOT_SUBMITTED: 'NOT_SUBMITTED',
    AMBIGUOUS: 'AMBIGUOUS'
  };

  const CONFIRMATION_URL_PATTERNS = [
    /\/(confirmation|confirm|thank-you|thankyou|thanks|success|submitted|receipt|complete|completed|order-received|done)(\/|\?|#|$)/i,
    /[?&](status=(success|confirmed|completed)|success=(true|1)|submitted=true|step=(confirmation|complete))/i,
    /[?&](order_?id|confirmation_?id|submission_?id|ref_?id)=/i
  ];

  const CONFIRMATION_TEXT_PATTERNS = [
    /\bthank\s+you\b/i,
    /\bthanks\s+for\s+(your\s+)?(submission|order|application|signing\s+up|contacting|registering|request)\b/i,
    /\b(submission|application|order|request|registration)\s+(has\s+been\s+)?(received|confirmed|completed|submitted|recorded)\b/i,
    /\b(successfully\s+(submitted|received|completed|processed|sent))\b/i,
    /\b(has\s+been|was)\s+successfully\s+(submitted|received|completed|processed|sent)\b/i,
    /\bwe('?ve|\s+have)\s+received\s+your\s+(submission|application|order|request|message|response)\b/i,
    /\byour\s+(submission|application|order|request|response|message)\s+(is\s+complete|has\s+been\s+received|was\s+received|is\s+confirmed)\b/i,
    /\byour\s+response\s+has\s+been\s+recorded\b/i,
    /\byour\s+account\s+has\s+been\s+created\b/i,
    /\bchanges\s+(have\s+been\s+)?saved\s+successfully\b/i,
    /\bsettings\s+(have\s+been\s+)?updated\b/i,
    /\byour\s+post\s+has\s+been\s+published\b/i,
    /\bbooking\s+(is\s+|has\s+been\s+)?confirmed\b/i,
    /\bpayment\s+successful\b/i,
    /\bconfirmation\s+(#|number|code|id|ref|reference)\b/i,
    /\breference\s+(number|#|code|id)\s*[:#]?\s*[a-z0-9_-]+/i,
    /\border\s+(number|#|id)\s*[:#]?\s*[a-z0-9_-]+/i,
    /\bsubmission\s+(id|#|number)\s*[:#]?\s*[a-z0-9_-]+/i
  ];

  const CRITICAL_ERROR_PATTERNS = [
    /\b(500\s+internal\s+server\s+error|internal\s+server\s+error|502\s+bad\s+gateway|503\s+service\s+unavailable|504\s+gateway\s+timeout)\b/i,
    /\b(an\s+error\s+occurred\s+while\s+processing|submission\s+failed|could\s+not\s+process\s+your\s+(request|order|submission|payment))\b/i,
    /\b(there\s+was\s+a\s+problem\s+submitting|failed\s+to\s+submit|transaction\s+failed|payment\s+failed|payment\s+declined)\b/i,
    /\b(network\s+error|connection\s+(error|failed|timed\s+out))\b/i,
    /\b(unauthorized|401\s+unauthorized|403\s+forbidden|access\s+denied)\b/i
  ];

  const VALIDATION_ERROR_PATTERNS = [
    /\b(please\s+(fix|correct)\s+the\s+errors?|required\s+fields?\s+(are\s+)?missing|invalid\s+email|please\s+fill\s+out\s+this\s+field|must\s+be\s+a\s+valid)\b/i,
    /\b(this\s+field\s+is\s+required|field\s+cannot\s+be\s+blank|check\s+the\s+highlighted\s+fields)\b/i,
    /\b(invalid\s+credit\s+card|invalid\s+card(\s+number)?)\b/i,
    /\b(already\s+taken|already\s+in\s+use|already\s+exists)\b/i
  ];

  const SUBMIT_BUTTON_TEXT_PATTERNS = /\b(submit|apply|send|place\s+order|confirm|register|pay|complete\s+order|save\s+and\s+submit)\b/i;
  const SUBMITTING_TEXT_PATTERNS = /\b(submitting|processing|sending|please\s*wait|loading|saving|authorizing)\b/i;
  const SUBMITTING_CLASS_PATTERNS = /\b(loading|spinner|busy|submitting|is-loading|btn-loading)\b/i;

  function normalizeAndCompareValues(actualVal, expectedVal) {
    if (expectedVal === undefined) return true;
    if (actualVal === expectedVal) return true;

    // Normalize booleans / checkboxes
    if (typeof actualVal === 'boolean' || typeof expectedVal === 'boolean') {
      return Boolean(actualVal) === Boolean(expectedVal);
    }

    // Cast numbers
    if (typeof actualVal === 'number' || typeof expectedVal === 'number') {
      return String(actualVal).trim() === String(expectedVal).trim();
    }

    if (actualVal == null || expectedVal == null) {
      return actualVal === expectedVal;
    }

    // Date objects
    if (actualVal instanceof Date || expectedVal instanceof Date) {
      const t1 = actualVal instanceof Date ? actualVal.getTime() : new Date(actualVal).getTime();
      const t2 = expectedVal instanceof Date ? expectedVal.getTime() : new Date(expectedVal).getTime();
      if (!isNaN(t1) && !isNaN(t2)) return t1 === t2;
    }

    const actualStr = String(actualVal).trim();
    const expectedStr = String(expectedVal).trim();

    // Normalize date strings if ISO dates are compared
    const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
    if (ISO_DATE_REGEX.test(actualStr) && ISO_DATE_REGEX.test(expectedStr)) {
      const d1 = new Date(actualStr);
      const d2 = new Date(expectedStr);
      if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
        return d1.getTime() === d2.getTime();
      }
    }

    // Trim strings and normalize whitespace / newlines
    const normActual = actualStr.replace(/\s+/g, ' ');
    const normExpected = expectedStr.replace(/\s+/g, ' ');
    return normActual === normExpected;
  }

  function normalizeUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') return null;
    try {
      const parsed = new URL(urlString);
      return {
        href: parsed.href,
        origin: parsed.origin,
        pathname: parsed.pathname.replace(/\/+$/, '') || '/',
        search: parsed.search,
        hash: parsed.hash
      };
    } catch {
      return null;
    }
  }

  function isConfirmationUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return CONFIRMATION_URL_PATTERNS.some(pattern => pattern.test(url));
  }

  function detectConfirmationSignals(text) {
    if (!text || typeof text !== 'string') return [];
    return CONFIRMATION_TEXT_PATTERNS.filter(pattern => pattern.test(text)).map(pattern => pattern.toString());
  }

  function detectErrorSignals(text) {
    if (!text || typeof text !== 'string') return { critical: [], validation: [] };
    const critical = CRITICAL_ERROR_PATTERNS.filter(pattern => pattern.test(text)).map(p => p.toString());
    const validation = VALIDATION_ERROR_PATTERNS.filter(pattern => pattern.test(text)).map(p => p.toString());
    return { critical, validation };
  }

  function inspectSubmitButtons(buttons = [], lastAction = null) {
    const lastSelector = lastAction?.selector || lastAction?.clickSelector || null;
    const candidates = [];

    for (const btn of buttons) {
      const text = (btn.text || btn.value || btn.ariaLabel || '').trim();
      const type = (btn.type || '').toLowerCase();
      const selector = btn.selector || '';
      const isTarget = lastSelector && (selector === lastSelector || (btn.id && lastSelector.includes(btn.id)));
      const isSubmitLike = type === 'submit' || SUBMIT_BUTTON_TEXT_PATTERNS.test(text) || isTarget;

      if (isSubmitLike) {
        const textIsSubmitting = SUBMITTING_TEXT_PATTERNS.test(text);
        const classIsSubmitting = SUBMITTING_CLASS_PATTERNS.test(btn.className || '');
        const hasAriaBusy = btn.ariaBusy === true || btn.ariaBusy === 'true' || btn.busy === true;
        const isDisabled = btn.disabled === true || btn.ariaDisabled === true || btn.ariaDisabled === 'true';

        const isSubmitting = hasAriaBusy || (isDisabled && (textIsSubmitting || classIsSubmitting)) || textIsSubmitting;

        candidates.push({
          selector,
          text,
          disabled: isDisabled,
          busy: hasAriaBusy,
          isSubmitting,
          visible: btn.visible !== false,
          isTarget: !!isTarget
        });
      }
    }

    return candidates;
  }

  function inspectPageForReconciliation(options = {}) {
    const currentUrl = location.href;
    const title = document.title || '';
    const readyState = document.readyState;
    const bodyText = (document.body ? document.body.innerText || document.body.textContent || '' : '').slice(0, 20000);

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], [role="alert"], .alert, .success, .confirmation, .notice'))
      .map(el => (el.innerText || el.textContent || '').trim())
      .filter(t => t.length > 0)
      .slice(0, 30);

    const buttons = [];
    const buttonElements = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'));
    for (const el of buttonElements) {
      const text = el.isContentEditable ? el.textContent : (el.innerText || el.value || el.getAttribute('aria-label') || '');
      const visible = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
      let sel = el.id ? '#' + el.id : el.tagName.toLowerCase();
      if (el.getAttribute('type')) sel += `[type="${el.getAttribute('type')}"]`;
      buttons.push({
        selector: sel,
        text: text.trim(),
        type: el.getAttribute('type') || '',
        className: el.className || '',
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        ariaBusy: el.getAttribute('aria-busy') === 'true',
        ariaLabel: el.getAttribute('aria-label') || '',
        visible
      });
    }

    const spinners = Array.from(document.querySelectorAll('[aria-busy="true"], .spinner, .loading-spinner, .loader, [data-loading="true"]'))
      .filter(el => el.getClientRects().length > 0);

    const selectorsStatus = {};
    if (Array.isArray(options.expectedSelectors)) {
      for (const sel of options.expectedSelectors) {
        try {
          const match = document.querySelector(sel);
          selectorsStatus[sel] = {
            exists: !!match,
            visible: match ? (match.getClientRects().length > 0 && getComputedStyle(match).visibility !== 'hidden') : false
          };
        } catch (e) {
          selectorsStatus[sel] = { exists: false, visible: false, error: e.message };
        }
      }
    }

    function _compareValues(actualVal, expectedVal) {
      if (expectedVal === undefined) return true;
      if (actualVal === expectedVal) return true;
      if (typeof actualVal === 'boolean' || typeof expectedVal === 'boolean') {
        return Boolean(actualVal) === Boolean(expectedVal);
      }
      if (typeof actualVal === 'number' || typeof expectedVal === 'number') {
        return String(actualVal).trim() === String(expectedVal).trim();
      }
      if (actualVal == null || expectedVal == null) {
        return actualVal === expectedVal;
      }
      if (actualVal instanceof Date || expectedVal instanceof Date) {
        const t1 = actualVal instanceof Date ? actualVal.getTime() : new Date(actualVal).getTime();
        const t2 = expectedVal instanceof Date ? expectedVal.getTime() : new Date(expectedVal).getTime();
        if (!isNaN(t1) && !isNaN(t2)) return t1 === t2;
      }
      const actualStr = String(actualVal).trim();
      const expectedStr = String(expectedVal).trim();
      const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
      if (ISO_DATE_REGEX.test(actualStr) && ISO_DATE_REGEX.test(expectedStr)) {
        const d1 = new Date(actualStr);
        const d2 = new Date(expectedStr);
        if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
          return d1.getTime() === d2.getTime();
        }
      }
      const normActual = actualStr.replace(/\s+/g, ' ');
      const normExpected = expectedStr.replace(/\s+/g, ' ');
      return normActual === normExpected;
    }

    const valuesStatus = {};
    if (options.expectedValues && typeof options.expectedValues === 'object') {
      const entries = Array.isArray(options.expectedValues)
        ? options.expectedValues.map(v => [v.selector, v.value, v.checked])
        : Object.entries(options.expectedValues).map(([k, v]) => [k, typeof v === 'object' && v !== null ? v.value : v, typeof v === 'object' && v !== null ? v.checked : undefined]);

      for (const [sel, expectedVal, expectedChecked] of entries) {
        try {
          const el = document.querySelector(sel);
          if (!el) {
            valuesStatus[sel] = { exists: false, matches: false };
          } else {
            const actualVal = el.isContentEditable ? el.textContent : el.value;
            const valueMatches = expectedVal === undefined || _compareValues(actualVal, expectedVal);
            const checkedMatches = expectedChecked === undefined || Boolean(el.checked) === Boolean(expectedChecked);
            valuesStatus[sel] = {
              exists: true,
              actualValue: actualVal,
              expectedValue: expectedVal,
              actualChecked: el.checked,
              expectedChecked,
              matches: valueMatches && checkedMatches
            };
          }
        } catch (e) {
          valuesStatus[sel] = { exists: false, matches: false, error: e.message };
        }
      }
    }

    return {
      url: currentUrl,
      title,
      readyState,
      bodyText,
      headings,
      buttons,
      hasActiveSpinner: spinners.length > 0,
      selectorsStatus,
      valuesStatus
    };
  }

  function evaluateExtractedState({
    currentUrl,
    expectedUrl,
    pageText = '',
    headings = [],
    buttons = [],
    hasActiveSpinner = false,
    selectorsStatus = {},
    valuesStatus = {},
    lastAction = null,
    error = null
  }) {
    if (error) {
      return {
        state: STATES.AMBIGUOUS,
        confidence: 0.2,
        reason: `Could not inspect browser state: ${error}`,
        recommendedAction: 'MANUAL_INSPECTION_REQUIRED',
        details: { error }
      };
    }

    const normCurrent = normalizeUrl(currentUrl);
    const normExpected = normalizeUrl(expectedUrl);
    const expectedHasHashRoute = typeof expectedUrl === 'string' && expectedUrl.includes('#');
    let urlMatchesExpected = null;
    if (normExpected && normCurrent) {
      const originMatches = normCurrent.origin === normExpected.origin;
      const pathMatches = normCurrent.pathname === normExpected.pathname;
      if (expectedHasHashRoute) {
        const normalizeHash = h => (h || '').replace(/^#\/?/, '').replace(/\/+$/, '');
        const hashMatches = normalizeHash(normCurrent.hash) === normalizeHash(normExpected.hash);
        urlMatchesExpected = originMatches && pathMatches && hashMatches;
      } else {
        urlMatchesExpected = originMatches && pathMatches;
      }
    }
    const urlIsConfirmation = isConfirmationUrl(currentUrl);

    const fullText = (pageText + ' ' + headings.join(' ')).trim();
    const confirmationSignals = detectConfirmationSignals(fullText);
    const errorSignals = detectErrorSignals(fullText);

    const submitButtons = inspectSubmitButtons(buttons, lastAction);
    const inProgressButton = submitButtons.find(b => b.isSubmitting);
    const enabledSubmitButton = submitButtons.find(b => !b.disabled && b.visible);

    const fieldEntries = Object.entries(valuesStatus);
    const totalFields = fieldEntries.length;
    const matchingFields = fieldEntries.filter(([, s]) => s.matches).length;
    const missingFields = fieldEntries.filter(([, s]) => !s.exists).length;

    const selectorEntries = Object.entries(selectorsStatus);
    const totalSelectors = selectorEntries.length;
    const existingSelectors = selectorEntries.filter(([, s]) => s.exists).length;
    const missingSelectors = selectorEntries.filter(([, s]) => !s.exists).length;

    const hasCriticalError = errorSignals.critical.length > 0;
    const hasValidationError = errorSignals.validation.length > 0;

    // Check 1: CONFIRMED_SUBMITTED
    // Triggered if page transitioned to confirmation/success URL, or contains explicit confirmation patterns.
    if (urlIsConfirmation || confirmationSignals.length > 0) {
      if (hasCriticalError || hasValidationError) {
        const conflictingErrors = [];
        if (hasCriticalError) conflictingErrors.push(`critical error(s): ${errorSignals.critical.join(', ')}`);
        if (hasValidationError) conflictingErrors.push(`validation error(s): ${errorSignals.validation.join(', ')}`);
        return {
          state: STATES.AMBIGUOUS,
          confidence: 0.5,
          reason: `Conflicting signals detected: confirmation indicators present alongside ${conflictingErrors.join(' and ')}.`,
          recommendedAction: 'MANUAL_INSPECTION_REQUIRED',
          details: {
            currentUrl,
            expectedUrl,
            urlIsConfirmation,
            confirmationSignals,
            errorSignals,
            hasCriticalError,
            hasValidationError,
            submitButtons
          }
        };
      }

      const signals = [];
      if (urlIsConfirmation) signals.push(`URL transitioned to confirmation pattern (${currentUrl})`);
      if (confirmationSignals.length > 0) signals.push(`Found confirmation text signals: ${confirmationSignals.length} pattern(s) matched`);

      return {
        state: STATES.CONFIRMED_SUBMITTED,
        confidence: urlIsConfirmation && confirmationSignals.length > 0 ? 0.98 : 0.9,
        reason: signals.join(' and ') + '.',
        recommendedAction: 'COMPLETE',
        details: {
          currentUrl,
          expectedUrl,
          urlIsConfirmation,
          confirmationSignals,
          submitButtons
        }
      };
    }

    // Check 2: IN_PROGRESS
    // Submit button is disabled/submitting, active spinners present, or page/form has aria-busy while processing submit
    if (inProgressButton || (hasActiveSpinner && (lastAction?.name === 'click' || lastAction?.action === 'click' || lastAction?.clickSelector))) {
      const reason = inProgressButton
        ? `Submit button (${inProgressButton.selector}) is disabled or displaying in-progress state (${inProgressButton.text || 'submitting'}).`
        : 'Active loading spinner detected following submission action.';

      return {
        state: STATES.IN_PROGRESS,
        confidence: 0.92,
        reason,
        recommendedAction: 'WAIT_AND_POLL',
        details: {
          currentUrl,
          expectedUrl,
          inProgressButton,
          hasActiveSpinner,
          submitButtons
        }
      };
    }

    // Check 3: NOT_SUBMITTED
    // On expected form page, form controls are intact, submit button is enabled/ready, or validation error blocked submission
    const formIsIntact = (totalFields > 0 && matchingFields === totalFields) || (totalSelectors > 0 && existingSelectors === totalSelectors);
    const notNavigatedAway = urlMatchesExpected !== false;

    if (notNavigatedAway && !hasCriticalError && (enabledSubmitButton || hasValidationError || formIsIntact)) {
      if (hasValidationError) {
        return {
          state: STATES.NOT_SUBMITTED,
          confidence: 0.94,
          reason: 'Validation error displayed on form; submission was prevented by client validation.',
          recommendedAction: 'FIX_VALIDATION_AND_RESUBMIT',
          details: {
            currentUrl,
            expectedUrl,
            validationErrors: errorSignals.validation,
            matchingFields,
            totalFields,
            submitButtons
          }
        };
      }

      if (formIsIntact && enabledSubmitButton) {
        return {
          state: STATES.NOT_SUBMITTED,
          confidence: 0.95,
          reason: 'Form remains on page with intact values and an enabled submit button ready for submission.',
          recommendedAction: 'SAFE_TO_RESUBMIT',
          details: {
            currentUrl,
            expectedUrl,
            matchingFields,
            totalFields,
            enabledSubmitButton,
            submitButtons
          }
        };
      }

      if (enabledSubmitButton && !missingFields && !missingSelectors) {
        return {
          state: STATES.NOT_SUBMITTED,
          confidence: 0.88,
          reason: 'Page has an active enabled submit button with no confirmation or in-progress indicators.',
          recommendedAction: 'SAFE_TO_RESUBMIT',
          details: {
            currentUrl,
            expectedUrl,
            enabledSubmitButton,
            submitButtons
          }
        };
      }
    }

    // Check 4: AMBIGUOUS
    // Conflicting indicators, unexpected navigation, missing fields with no receipt, or server 500 error
    const ambiguousReasons = [];
    if (hasCriticalError) {
      ambiguousReasons.push(`Server or processing error detected (${errorSignals.critical.join(', ')})`);
    }
    if (urlMatchesExpected === false && !urlIsConfirmation) {
      ambiguousReasons.push(`Navigated away from expected URL (${expectedUrl}) to unexpected URL (${currentUrl})`);
    }
    if (missingFields > 0 || missingSelectors > 0) {
      ambiguousReasons.push(`Expected form controls are missing (${missingFields || missingSelectors} missing) without confirmation`);
    }
    if (!ambiguousReasons.length) {
      ambiguousReasons.push('Page state does not match clear submission, in-progress, or unsubmitted signatures');
    }

    return {
      state: STATES.AMBIGUOUS,
      confidence: 0.7,
      reason: ambiguousReasons.join('; ') + '.',
      recommendedAction: 'MANUAL_INSPECTION_REQUIRED',
      details: {
        currentUrl,
        expectedUrl,
        hasCriticalError,
        missingFields,
        missingSelectors,
        submitButtons,
        errorSignals
      }
    };
  }

  async function reconcileBrowserState({
    tabId,
    expectedUrl,
    expectedSelectors = [],
    expectedValues = {},
    lastAction = null,
    page = null,
    chrome: chromeApi = globalThis.chrome
  } = {}) {
    // Path A: A page snapshot was passed directly (from read_page or test mock)
    if (page && typeof page === 'object') {
      const pageText = page.text || page.bodyText || '';
      const currentUrl = page.url || '';
      const headings = page.headings || [];
      const buttons = page.buttons || [];

      // If elements are present in read_page format
      if (Array.isArray(page.elements) && !buttons.length) {
        for (const el of page.elements) {
          if (['button', 'submit'].includes(el.tag) || el.type === 'submit' || el.role === 'button' || SUBMIT_BUTTON_TEXT_PATTERNS.test(el.text || '')) {
            buttons.push({
              selector: el.selector,
              text: el.text || el.value || '',
              type: el.type || '',
              className: el.className || '',
              disabled: !!el.disabled,
              ariaBusy: !!el.ariaBusy,
              ariaLabel: el.ariaLabel || '',
              visible: el.visible !== false
            });
          }
        }
      }

      // Check selectors in page.elements if selectorsStatus wasn't provided
      const selectorsStatus = page.selectorsStatus || {};
      if (Array.isArray(expectedSelectors) && !Object.keys(selectorsStatus).length && Array.isArray(page.elements)) {
        for (const sel of expectedSelectors) {
          const match = page.elements.find(el => el.selector === sel);
          selectorsStatus[sel] = { exists: !!match, visible: match ? match.visible !== false : false };
        }
      }

      // Check values in page.elements if valuesStatus wasn't provided
      const valuesStatus = page.valuesStatus || {};
      if (expectedValues && !Object.keys(valuesStatus).length && Array.isArray(page.elements)) {
        const entries = Array.isArray(expectedValues)
          ? expectedValues.map(v => [v.selector, v.value, v.checked])
          : Object.entries(expectedValues).map(([k, v]) => [k, typeof v === 'object' && v !== null ? v.value : v, typeof v === 'object' && v !== null ? v.checked : undefined]);

        for (const [sel, expectedVal, expectedChecked] of entries) {
          const match = page.elements.find(el => el.selector === sel);
          if (!match) {
            valuesStatus[sel] = { exists: false, matches: false };
          } else {
            const valMatches = expectedVal === undefined || normalizeAndCompareValues(match.value, expectedVal);
            const chkMatches = expectedChecked === undefined || Boolean(match.checked) === Boolean(expectedChecked);
            valuesStatus[sel] = {
              exists: true,
              actualValue: match.value,
              expectedValue: expectedVal,
              actualChecked: match.checked,
              expectedChecked,
              matches: valMatches && chkMatches
            };
          }
        }
      }

      return evaluateExtractedState({
        currentUrl,
        expectedUrl,
        pageText,
        headings,
        buttons,
        hasActiveSpinner: !!page.hasActiveSpinner,
        selectorsStatus,
        valuesStatus,
        lastAction
      });
    }

    // Path B: Query live browser tab using Chrome Extension APIs
    if (!chromeApi || !chromeApi.tabs || !chromeApi.scripting) {
      return {
        state: STATES.AMBIGUOUS,
        confidence: 0,
        reason: 'Chrome tabs/scripting API is not available and no page snapshot was provided.',
        recommendedAction: 'MANUAL_INSPECTION_REQUIRED',
        details: { tabId, expectedUrl }
      };
    }

    try {
      const tab = await chromeApi.tabs.get(tabId);
      if (!tab) throw new Error(`Tab ${tabId} not found`);

      const currentUrl = tab.url;
      const injectionResults = await chromeApi.scripting.executeScript({
        target: { tabId },
        func: inspectPageForReconciliation,
        args: [{ expectedSelectors, expectedValues, lastAction }]
      });

      const extracted = injectionResults[0]?.result;
      if (!extracted) throw new Error(`Could not inspect DOM for tab ${tabId}`);

      return evaluateExtractedState({
        currentUrl: extracted.url || currentUrl,
        expectedUrl,
        pageText: extracted.bodyText || '',
        headings: extracted.headings || [],
        buttons: extracted.buttons || [],
        hasActiveSpinner: extracted.hasActiveSpinner || false,
        selectorsStatus: extracted.selectorsStatus || {},
        valuesStatus: extracted.valuesStatus || {},
        lastAction
      });
    } catch (err) {
      return evaluateExtractedState({
        currentUrl: null,
        expectedUrl,
        error: err.message
      });
    }
  }

  const api = {
    STATES,
    reconcileBrowserState,
    evaluateExtractedState,
    inspectPageForReconciliation,
    inspectSubmitButtons,
    detectConfirmationSignals,
    detectErrorSignals,
    isConfirmationUrl,
    normalizeUrl,
    normalizeAndCompareValues
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OmniSidebarReconcile = api;
  }
})(globalThis);
