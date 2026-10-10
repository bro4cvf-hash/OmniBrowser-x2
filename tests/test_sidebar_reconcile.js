const assert = require('node:assert/strict');
const {
  STATES,
  reconcileBrowserState,
  evaluateExtractedState,
  isConfirmationUrl,
  detectConfirmationSignals,
  detectErrorSignals,
  inspectSubmitButtons,
  normalizeAndCompareValues
} = require('../extensions/chrome/sidebar-reconcile.js');

(async () => {
  // Test 1: URL helpers
  assert.equal(isConfirmationUrl('https://example.com/checkout/confirmation'), true);
  assert.equal(isConfirmationUrl('https://example.com/apply/thank-you'), true);
  assert.equal(isConfirmationUrl('https://example.com/order?status=confirmed'), true);
  assert.equal(isConfirmationUrl('https://example.com/checkout/step2'), false);
  assert.equal(isConfirmationUrl('https://example.com/login'), false);

  // Test 2: Text signal detection
  assert.ok(detectConfirmationSignals('Thank you for your submission.').length > 0);
  assert.ok(detectConfirmationSignals('We have received your application. Confirmation number: ABC-123').length >= 2);
  assert.ok(detectConfirmationSignals('Your response has been recorded').length > 0);
  assert.equal(detectConfirmationSignals('Please fill in your address.').length, 0);

  const errors = detectErrorSignals('500 Internal Server Error: Submission failed.');
  assert.ok(errors.critical.length > 0);
  const validation = detectErrorSignals('Please fix the errors below: this field is required.');
  assert.ok(validation.validation.length > 0);

  // Test 3: CONFIRMED_SUBMITTED via URL transition
  const urlTransitionRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    lastAction: { name: 'click', selector: '#submit-btn' },
    page: {
      url: 'https://service.example.com/apply/thank-you',
      text: 'Thank you for applying. We will review your submission shortly.',
      headings: ['Thank you!']
    }
  });
  assert.equal(urlTransitionRes.state, STATES.CONFIRMED_SUBMITTED);
  assert.ok(urlTransitionRes.confidence >= 0.9);
  assert.equal(urlTransitionRes.recommendedAction, 'COMPLETE');

  // Test 4: CONFIRMED_SUBMITTED via AJAX in-place update (URL unchanged)
  const ajaxRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/contact',
    lastAction: { name: 'click', selector: '#send-btn' },
    page: {
      url: 'https://service.example.com/contact',
      text: 'Your message has been successfully submitted. Reference number: REF-998811.',
      headings: ['Submission Received']
    }
  });
  assert.equal(ajaxRes.state, STATES.CONFIRMED_SUBMITTED);
  assert.ok(ajaxRes.confidence >= 0.9);

  // Test 5: IN_PROGRESS - Submit button disabled with loading indicator
  const inProgressBtnRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    lastAction: { name: 'click', selector: '#submit-btn' },
    page: {
      url: 'https://service.example.com/apply',
      text: 'Please wait while we process your request...',
      buttons: [
        {
          selector: '#submit-btn',
          text: 'Submitting...',
          type: 'submit',
          disabled: true,
          className: 'btn-primary is-loading',
          visible: true
        }
      ]
    }
  });
  assert.equal(inProgressBtnRes.state, STATES.IN_PROGRESS);
  assert.ok(inProgressBtnRes.confidence >= 0.9);
  assert.equal(inProgressBtnRes.recommendedAction, 'WAIT_AND_POLL');
  assert.ok(inProgressBtnRes.reason.includes('disabled') || inProgressBtnRes.reason.includes('Submitting'));

  // Test 6: IN_PROGRESS - Active loading spinner after submit click
  const inProgressSpinnerRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    lastAction: { action: 'click', selector: 'button[type="submit"]' },
    page: {
      url: 'https://service.example.com/apply',
      text: 'Creating your account...',
      hasActiveSpinner: true,
      buttons: [
        {
          selector: 'button[type="submit"]',
          text: 'Submit Application',
          type: 'submit',
          disabled: true,
          visible: true
        }
      ]
    }
  });
  assert.equal(inProgressSpinnerRes.state, STATES.IN_PROGRESS);
  assert.equal(inProgressSpinnerRes.recommendedAction, 'WAIT_AND_POLL');

  // Test 7: NOT_SUBMITTED - Form intact, expected values match, submit button enabled
  const notSubmittedRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    expectedSelectors: ['#name', '#email', '#submit-btn'],
    expectedValues: {
      '#name': 'Acme Corp',
      '#email': 'admin@acme.com'
    },
    lastAction: { name: 'fill', selector: '#email', value: 'admin@acme.com' },
    page: {
      url: 'https://service.example.com/apply',
      text: 'Fill out the form below to apply.',
      elements: [
        { selector: '#name', value: 'Acme Corp', visible: true },
        { selector: '#email', value: 'admin@acme.com', visible: true },
        { selector: '#submit-btn', type: 'submit', text: 'Submit Application', disabled: false, visible: true }
      ]
    }
  });
  assert.equal(notSubmittedRes.state, STATES.NOT_SUBMITTED);
  assert.ok(notSubmittedRes.confidence >= 0.9);
  assert.equal(notSubmittedRes.recommendedAction, 'SAFE_TO_RESUBMIT');

  // Test 8: NOT_SUBMITTED - Client validation error prevented submission
  const validationErrorRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    lastAction: { name: 'click', selector: '#submit-btn' },
    page: {
      url: 'https://service.example.com/apply',
      text: 'Please fix the errors below: This field is required.',
      headings: ['Application Form'],
      buttons: [
        { selector: '#submit-btn', text: 'Submit', disabled: false, visible: true, type: 'submit' }
      ]
    }
  });
  assert.equal(validationErrorRes.state, STATES.NOT_SUBMITTED);
  assert.equal(validationErrorRes.recommendedAction, 'FIX_VALIDATION_AND_RESUBMIT');

  // Test 9: AMBIGUOUS - Unexpected redirect to login or other page without confirmation
  const unexpectedNavRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    expectedSelectors: ['#name', '#submit-btn'],
    page: {
      url: 'https://service.example.com/login?redirect=1',
      text: 'Please log in to your account.',
      headings: ['Sign In'],
      buttons: [
        { selector: '#login-btn', text: 'Log In', disabled: false, visible: true }
      ]
    }
  });
  assert.equal(unexpectedNavRes.state, STATES.AMBIGUOUS);
  assert.equal(unexpectedNavRes.recommendedAction, 'MANUAL_INSPECTION_REQUIRED');
  assert.ok(unexpectedNavRes.reason.includes('unexpected URL') || unexpectedNavRes.reason.includes('missing'));

  // Test 10: AMBIGUOUS - Critical server error 500
  const serverErrorRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    lastAction: { name: 'click', selector: '#submit-btn' },
    page: {
      url: 'https://service.example.com/apply',
      text: '500 Internal Server Error. Submission failed. An unexpected error occurred while processing.',
      headings: ['Server Error']
    }
  });
  assert.equal(serverErrorRes.state, STATES.AMBIGUOUS);
  assert.ok(serverErrorRes.reason.includes('Server or processing error'));

  // Test 11: AMBIGUOUS - Expected fields disappeared but no receipt/confirmation
  const missingFieldsRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    expectedSelectors: ['#field-1', '#field-2', '#submit-btn'],
    page: {
      url: 'https://service.example.com/apply',
      text: 'Welcome to our platform.',
      selectorsStatus: {
        '#field-1': { exists: false },
        '#field-2': { exists: false },
        '#submit-btn': { exists: false }
      }
    }
  });
  assert.equal(missingFieldsRes.state, STATES.AMBIGUOUS);

  // Test 12: Chrome API mock integration
  let injected = null;
  const mockChrome = {
    tabs: {
      get: async id => {
        assert.equal(id, 42);
        return { id: 42, url: 'https://portal.example.com/form/confirmation' };
      }
    },
    scripting: {
      executeScript: async spec => {
        injected = spec;
        return [{
          result: {
            url: 'https://portal.example.com/form/confirmation',
            bodyText: 'Thank you for your order! Your confirmation code is #ORDER-776.',
            headings: ['Order Confirmed'],
            buttons: [],
            hasActiveSpinner: false,
            selectorsStatus: {},
            valuesStatus: {}
          }
        }];
      }
    }
  };

  const chromeRes = await reconcileBrowserState({
    tabId: 42,
    expectedUrl: 'https://portal.example.com/form',
    chrome: mockChrome
  });
  assert.equal(chromeRes.state, STATES.CONFIRMED_SUBMITTED);
  assert.equal(injected.target.tabId, 42);
  assert.equal(typeof injected.func, 'function');

  // Test 13: Tab not found / injection failure returns AMBIGUOUS gracefully
  const failingChrome = {
    tabs: {
      get: async () => { throw new Error('Tab 999 does not exist'); }
    },
    scripting: { executeScript: async () => [] }
  };
  const failRes = await reconcileBrowserState({
    tabId: 999,
    expectedUrl: 'https://example.com',
    chrome: failingChrome
  });
  assert.equal(failRes.state, STATES.AMBIGUOUS);
  assert.ok(failRes.reason.includes('Tab 999 does not exist'));

  // Test 14: Check 1 conflicting signals (confirmation signals + validation/critical errors)
  const conflictingValRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    page: {
      url: 'https://service.example.com/apply',
      text: 'Thank you for your order! Please fix the errors below: this field is required.',
      headings: ['Order Received']
    }
  });
  assert.equal(conflictingValRes.state, STATES.AMBIGUOUS);
  assert.ok(conflictingValRes.reason.toLowerCase().includes('conflicting signals'));
  assert.ok(conflictingValRes.reason.includes('validation error'));

  const conflictingCritRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/apply',
    page: {
      url: 'https://service.example.com/apply/thank-you',
      text: 'Thank you! 500 Internal Server Error: Transaction failed.',
      headings: ['Thank you']
    }
  });
  assert.equal(conflictingCritRes.state, STATES.AMBIGUOUS);
  assert.ok(conflictingCritRes.reason.toLowerCase().includes('conflicting signals'));
  assert.ok(conflictingCritRes.reason.includes('critical error'));

  // Test 15: Value normalization (whitespace/newlines, numbers, booleans, ISO dates)
  assert.equal(normalizeAndCompareValues('   hello \n\n world  \t ', 'hello world'), true);
  assert.equal(normalizeAndCompareValues(42, '42'), true);
  assert.equal(normalizeAndCompareValues('100', 100), true);
  assert.equal(normalizeAndCompareValues(true, true), true);
  assert.equal(normalizeAndCompareValues(false, false), true);
  assert.equal(normalizeAndCompareValues(true, false), false);
  assert.equal(normalizeAndCompareValues('2026-10-10', '2026-10-10T00:00:00.000Z'), true);
  assert.equal(normalizeAndCompareValues('2026-10-10', '2026-10-11'), false);

  const normalizedFormRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://service.example.com/form',
    expectedValues: {
      '#notes': 'First line\nSecond line',
      '#quantity': 5,
      '#agree': { value: 'on', checked: true },
      '#dob': '2026-10-10'
    },
    page: {
      url: 'https://service.example.com/form',
      elements: [
        { selector: '#notes', value: '   First line \n Second line   ', visible: true },
        { selector: '#quantity', value: '5', visible: true },
        { selector: '#agree', value: 'on', checked: true, visible: true },
        { selector: '#dob', value: '2026-10-10T00:00:00.000Z', visible: true },
        { selector: '#submit-btn', type: 'submit', text: 'Submit', disabled: false, visible: true }
      ]
    }
  });
  assert.equal(normalizedFormRes.state, STATES.NOT_SUBMITTED);
  assert.equal(normalizedFormRes.recommendedAction, 'SAFE_TO_RESUBMIT');

  // Test 16: SPA hash routing
  const spaSameRouteRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://spa.example.com/#/checkout',
    expectedSelectors: ['#submit-btn'],
    page: {
      url: 'https://spa.example.com/#/checkout',
      elements: [
        { selector: '#submit-btn', type: 'submit', text: 'Place Order', disabled: false, visible: true }
      ]
    }
  });
  assert.equal(spaSameRouteRes.state, STATES.NOT_SUBMITTED);

  const spaNavAwayRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://spa.example.com/#/checkout',
    page: {
      url: 'https://spa.example.com/#/catalog',
      text: 'Welcome to catalog.',
      buttons: [
        { selector: '#buy', text: 'Buy', disabled: false, visible: true }
      ]
    }
  });
  assert.equal(spaNavAwayRes.state, STATES.AMBIGUOUS);
  assert.ok(spaNavAwayRes.reason.includes('Navigated away'));

  const spaConfirmRes = await reconcileBrowserState({
    tabId: 1,
    expectedUrl: 'https://spa.example.com/#/checkout',
    page: {
      url: 'https://spa.example.com/#/thank-you',
      text: 'Your order has been placed.'
    }
  });
  assert.equal(spaConfirmRes.state, STATES.CONFIRMED_SUBMITTED);

  // Test 17: Expanded confirmation text patterns
  const newConfirmPhrases = [
    'Your account has been created',
    'Changes saved successfully',
    'Settings updated',
    'Your post has been published',
    'Booking confirmed',
    'Payment successful',
    'Your response has been recorded'
  ];
  for (const phrase of newConfirmPhrases) {
    const signals = detectConfirmationSignals(`System status: ${phrase}. Have a great day.`);
    assert.ok(signals.length > 0, `Expected confirmation signal for "${phrase}"`);
  }

  // Test 18: Expanded detectErrorSignals
  const newErrorPhrases = [
    'payment declined',
    'invalid credit card',
    'already taken',
    'network error',
    'unauthorized'
  ];
  for (const phrase of newErrorPhrases) {
    const errSignals = detectErrorSignals(`Notice: ${phrase} detected.`);
    const totalErrors = errSignals.critical.length + errSignals.validation.length;
    assert.ok(totalErrors > 0, `Expected error signal for "${phrase}"`);
  }

  console.log('Reconciliation-Driven Resume Engine tests passed successfully.');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
