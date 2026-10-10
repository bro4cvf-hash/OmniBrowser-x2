const assert = require('node:assert/strict');
const {
  evaluateCompletionEvidence,
  extractEvidence,
  checkTextPatterns
} = require('../extensions/chrome/completion-judge.js');
const {
  evaluateCompletionEvidence: sidebarJudge,
  executeCalls,
  tools
} = require('../extensions/chrome/sidebar-agent.js');

const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
});

(async () => {
  console.log('Testing Completion Judge...');

  // 1. Export check: evaluateCompletionEvidence is available both standalone and via sidebar-agent
  assert.equal(typeof evaluateCompletionEvidence, 'function');
  assert.equal(typeof sidebarJudge, 'function');

  // 2. Disallow model-asserted completion as sole truth (No action, no evidence -> needs_evidence)
  {
    const judgment = evaluateCompletionEvidence({
      results: [
        { title: 'Merchant App', url: 'https://example.com/apply', status: 'submitted', note: 'I submitted the form' }
      ],
      ledger: []
    });
    assert.equal(judgment.completed, false);
    assert.equal(judgment.verdict, 'needs_evidence');
    assert.equal(judgment.results[0].status, 'needs_evidence');
    assert.equal(judgment.results[0].originalStatus, 'submitted');
    assert.match(judgment.results[0].reason, /without evidence/i);
    assert.ok(judgment.missingEvidence.length > 0);
  }

  // 3. Submission attempted without confirmation evidence -> outcome_unknown
  {
    const judgment = evaluateCompletionEvidence({
      results: [
        { title: 'Merchant App', url: 'https://example.com/apply', status: 'submitted', note: 'Clicked submit button' }
      ],
      ledger: [
        { tool: 'click', args: { tabId: 1, selector: '#submit-application' }, result: { success: true } }
      ]
    });
    assert.equal(judgment.completed, false);
    assert.equal(judgment.verdict, 'outcome_unknown');
    assert.equal(judgment.results[0].status, 'outcome_unknown');
    assert.match(judgment.results[0].reason, /outcome is unknown/i);
  }

  // 4. Submission attempted with browser_step without confirmation evidence -> outcome_unknown
  {
    const judgment = evaluateCompletionEvidence({
      results: { title: 'Loan App', url: 'https://example.com/form', status: 'submitted' },
      ledger: [
        {
          tool: 'browser_step',
          args: { tabId: 2, actions: [{ action: 'fill', selector: '#name', value: 'Test' }], clickSelector: 'button[type="submit"]' },
          result: { page: { title: 'Processing...', text: 'Please wait while we process your request...' } }
        }
      ]
    });
    assert.equal(judgment.completed, false);
    assert.equal(judgment.status, 'outcome_unknown');
    assert.equal(judgment.verdict, 'outcome_unknown');
  }

  // 5. Successful submission verified via confirmation text from read_page
  {
    const judgment = evaluateCompletionEvidence({
      results: [
        { title: 'Merchant App', url: 'https://example.com/apply', status: 'submitted' }
      ],
      ledger: [
        { tool: 'click', args: { tabId: 1, selector: '#submit-btn' }, result: { success: true } },
        {
          tool: 'read_page',
          args: { tabId: 1 },
          result: {
            text: 'Thank you for your submission! We have received your application. Confirmation Number: APP-98234.'
          }
        }
      ]
    });
    assert.equal(judgment.completed, true);
    assert.equal(judgment.verdict, 'complete');
    assert.equal(judgment.results[0].status, 'submitted');
    assert.equal(judgment.results[0].verified, true);
    assert.ok(judgment.results[0].evidence.some(e => e.type === 'confirmation_text' && e.verified));
  }

  // 6. Confirmation text in currentTabState
  {
    const judgment = evaluateCompletionEvidence({
      results: [
        { title: 'Merchant App', url: 'https://example.com/apply', status: 'submitted' }
      ],
      ledger: [
        { tool: 'click', args: { tabId: 1, selector: 'button.submit' }, result: {} }
      ],
      currentTabState: {
        url: 'https://example.com/apply/success',
        text: 'Your application has been received and is complete.'
      }
    });
    assert.equal(judgment.completed, true);
    assert.equal(judgment.results[0].status, 'submitted');
  }

  // 7. Submission rejected if page text indicates failure / errors
  {
    const judgment = evaluateCompletionEvidence({
      results: [
        { title: 'Merchant App', url: 'https://example.com/apply', status: 'submitted' }
      ],
      ledger: [
        { tool: 'click', args: { tabId: 1, selector: '#submit' }, result: {} },
        {
          tool: 'read_page',
          args: { tabId: 1 },
          result: {
            text: 'Submission failed: Please correct the following errors before submitting.'
          }
        }
      ]
    });
    assert.equal(judgment.completed, false);
    assert.equal(judgment.results[0].status, 'blocked');
    assert.match(judgment.results[0].reason, /Submission failed/i);
  }

  // 8. Programmatic DOM verification via form_verify for 'ready' status
  {
    // A. Without form_verify -> downgraded to needs_evidence
    const unverified = evaluateCompletionEvidence({
      results: [
        { title: 'Form Ready', url: 'https://example.com/form', status: 'ready' }
      ],
      ledger: [
        { tool: 'fill', args: { selector: '#email', value: 'contact@example.com' }, result: {} }
      ]
    });
    assert.equal(unverified.completed, false);
    assert.equal(unverified.results[0].status, 'needs_evidence');
    assert.match(unverified.results[0].reason, /form_verify/i);

    // B. With successful form_verify -> confirmed ready
    const verified = evaluateCompletionEvidence({
      results: [
        { title: 'Form Ready', url: 'https://example.com/form', status: 'ready' }
      ],
      ledger: [
        {
          tool: 'form_verify',
          args: { tabId: 1, fields: [{ selector: '#email', value: 'contact@example.com' }] },
          result: { verified: true, results: [{ selector: '#email', matches: true, valid: true }] }
        }
      ]
    });
    assert.equal(verified.completed, true);
    assert.equal(verified.results[0].status, 'ready');
    assert.ok(verified.results[0].evidence.some(e => e.type === 'form_verify' && e.verified));

    // C. With failed form_verify -> downgraded to needs_evidence
    const failedVerify = evaluateCompletionEvidence({
      results: [
        { title: 'Form Ready', url: 'https://example.com/form', status: 'ready' }
      ],
      ledger: [
        {
          tool: 'form_verify',
          args: { tabId: 1, fields: [{ selector: '#email', value: 'contact@example.com' }] },
          result: { verified: false, results: [{ selector: '#email', matches: false, valid: false }] }
        }
      ]
    });
    assert.equal(failedVerify.completed, false);
    assert.equal(failedVerify.results[0].status, 'needs_evidence');
    assert.match(failedVerify.results[0].reason, /failed validation/i);
  }

  // 9. Verified downloaded files as programmatic evidence
  {
    const dlJudgment = evaluateCompletionEvidence({
      results: [
        { title: 'Download Tax Return', url: 'https://example.com/tax.pdf', status: 'submitted' }
      ],
      ledger: [
        {
          tool: 'download',
          args: { url: 'https://example.com/tax.pdf' },
          result: { complete: true, path: 'C:\\Users\\PC\\Downloads\\tax.pdf', size: 1048576 }
        }
      ]
    });
    assert.equal(dlJudgment.completed, true);
    assert.equal(dlJudgment.results[0].status, 'submitted');
    assert.ok(dlJudgment.results[0].evidence.some(e => e.type === 'download_verified'));
  }

  // 10. Explicit structured records as programmatic evidence
  {
    const structuredJudgment = evaluateCompletionEvidence({
      results: [
        { title: 'Gateway Partner', url: 'https://api.gateway.example/apply', status: 'submitted' }
      ],
      ledger: [
        {
          tool: 'click',
          args: { selector: '#btn-submit' },
          result: { success: true, confirmationId: 'GATEWAY-CONF-44910' }
        }
      ]
    });
    assert.equal(structuredJudgment.completed, true);
    assert.equal(structuredJudgment.results[0].status, 'submitted');
    assert.ok(structuredJudgment.results[0].evidence.some(e => e.type === 'structured_record' && e.confirmationId === 'GATEWAY-CONF-44910'));
  }

  // 11. Multi-candidate judging with mixed outcomes
  {
    const multi = evaluateCompletionEvidence({
      results: [
        { title: 'Candidate 1', url: 'https://example.com/c1', status: 'submitted' },
        { title: 'Candidate 2', url: 'https://example.com/c2', status: 'ready' },
        { title: 'Candidate 3', url: 'https://example.com/c3', status: 'submitted' }
      ],
      ledger: [
        // C1: attempted submit without confirmation -> outcome_unknown
        { tool: 'click', args: { selector: '#submit-c1' }, result: { success: true } },
        // C2: form_verify succeeded -> ready
        { tool: 'form_verify', args: { tabId: 2, fields: [{ selector: '#f1', value: 'val' }] }, result: { verified: true } },
        // C3: submit + confirmation text -> submitted
        { tool: 'click', args: { selector: '#submit-c3' }, result: { success: true } },
        { tool: 'read_page', args: { tabId: 3 }, result: { text: 'Your application submitted successfully! Confirmation #777' } }
      ]
    });
    assert.equal(multi.completed, false);
    assert.equal(multi.verdict, 'outcome_unknown');
    assert.equal(multi.results[0].status, 'outcome_unknown');
    assert.equal(multi.results[1].status, 'ready');
    assert.equal(multi.results[2].status, 'submitted');
  }

  // 12. Direct integration into sidebar-agent executeCalls
  {
    const events = [];
    const executionLedger = [];

    // Attempting record_result 'submitted' with an empty ledger downgrades it to needs_evidence
    await executeCalls([
      call('res1', 'record_result', {
        title: 'Unverified Provider',
        url: 'https://example.com/apply',
        status: 'submitted',
        note: 'Attempting to record completed'
      })
    ], {
      allowedTools: tools,
      parallel: false,
      onEvent: e => events.push(e),
      executeTool: async () => ({}),
      ledger: executionLedger
    });

    const emittedResult = events.find(e => e.type === 'result');
    assert.ok(emittedResult);
    assert.equal(emittedResult.status, 'needs_evidence');
    assert.match(emittedResult.note, /needs_evidence/);
    assert.doesNotMatch(emittedResult.note, /Attempting to record completed/);
  }

  // 13. Direct integration with submit click in ledger
  {
    const events = [];
    const executionLedger = [];

    await executeCalls([
      call('click1', 'click', { tabId: 1, selector: '#submit-form' }),
      call('res2', 'record_result', {
        title: 'Pending Confirmation Provider',
        url: 'https://example.com/apply',
        status: 'submitted',
        note: 'Submitted the application'
      })
    ], {
      allowedTools: tools,
      parallel: false,
      onEvent: e => events.push(e),
      executeTool: async () => ({ success: true }),
      ledger: executionLedger
    });

    const result2 = events.find(e => e.type === 'result');
    assert.ok(result2);
    // Submit was clicked, but no confirmation read -> outcome_unknown
    assert.equal(result2.status, 'outcome_unknown');
    assert.match(result2.note, /outcome_unknown/);
  }

  // 14. Pattern helper unit test
  {
    assert.equal(checkTextPatterns('Thank you! Your application has been received.').confirmed, true);
    assert.equal(checkTextPatterns('Your order is complete. Reference ID: 1234').confirmed, true);
    assert.equal(checkTextPatterns('Submission failed: Error submitting form').error, true);
    assert.equal(checkTextPatterns('Just normal page content with nothing special').confirmed, false);
    assert.equal(checkTextPatterns('Just normal page content with nothing special').error, false);
  }

  // 15. False Positive Protection & Temporal Causality
  {
    // A. Confirmation text observed but NO submission action in ledger -> needs_evidence
    const noAction = evaluateCompletionEvidence({
      results: [{ title: 'App', url: 'https://example.com/apply', status: 'submitted' }],
      ledger: [
        { tool: 'read_page', args: { url: 'https://example.com/apply' }, result: { text: 'Thank you for your submission!' } }
      ]
    });
    assert.equal(noAction.completed, false);
    assert.equal(noAction.results[0].status, 'needs_evidence');

    // B. Temporal causality violation: Confirmation text observed BEFORE submit action -> outcome_unknown
    const wrongOrder = evaluateCompletionEvidence({
      results: [{ title: 'App', url: 'https://example.com/apply', status: 'submitted' }],
      ledger: [
        { index: 0, timestamp: 100, tool: 'read_page', args: { url: 'https://example.com/apply' }, result: { text: 'Thank you for your submission!' } },
        { index: 1, timestamp: 200, tool: 'click', args: { url: 'https://example.com/apply', selector: '#submit' }, result: { success: true } }
      ]
    });
    assert.equal(wrongOrder.completed, false);
    assert.equal(wrongOrder.results[0].status, 'outcome_unknown');

    // C. Valid temporal order: Submit action THEN confirmation text -> submitted verified
    const correctOrder = evaluateCompletionEvidence({
      results: [{ title: 'App', url: 'https://example.com/apply', status: 'submitted' }],
      ledger: [
        { index: 0, timestamp: 100, tool: 'click', args: { url: 'https://example.com/apply', selector: '#submit' }, result: { success: true } },
        { index: 1, timestamp: 200, tool: 'read_page', args: { url: 'https://example.com/apply' }, result: { text: 'Thank you for your submission!' } }
      ]
    });
    assert.equal(correctOrder.completed, true);
    assert.equal(correctOrder.results[0].status, 'submitted');
  }

  // 16. Candidate URL and Domain Target Enforcement in matchesCandidate (even when isSingle is true)
  {
    const mismatchedDomain = evaluateCompletionEvidence({
      results: [{ title: 'Target App', url: 'https://target.com/form', status: 'submitted' }],
      ledger: [
        { tool: 'click', args: { url: 'https://other-domain.com/form', selector: '#submit' }, result: { success: true } },
        { tool: 'read_page', args: { url: 'https://other-domain.com/form' }, result: { text: 'Thank you for your submission!' } }
      ]
    });
    assert.equal(mismatchedDomain.completed, false);
    assert.equal(mismatchedDomain.results[0].status, 'needs_evidence');
  }

  // 17. Multiline regex fix with dotAll (s flag)
  {
    const multilineText = 'Thank you for your interest!\n\nYour application has been received.';
    assert.equal(checkTextPatterns(multilineText).confirmed, true);

    const multilineText2 = 'Submission\n\nwas successful!';
    assert.equal(checkTextPatterns(multilineText2).confirmed, true);
  }

  // 18. Expanded success patterns
  {
    const patternsToTest = [
      'Your response has been recorded',
      'Booking confirmed! See details below.',
      'Reservation confirmed',
      'Payment successful. Thank you!',
      'Transaction ID: TX-88239',
      'You are all set!',
      "Done! We've received your request.",
      'Your appointment was scheduled successfully.'
    ];

    for (const text of patternsToTest) {
      const match = checkTextPatterns(text);
      assert.equal(match.confirmed, true, `Pattern should match: "${text}"`);
    }
  }

  // 19. Researched status and ghost research bug fix
  {
    // A. Empty URL -> needs_evidence
    const emptyUrlRes = evaluateCompletionEvidence({
      results: [{ title: 'Empty URL Research', url: '', status: 'researched' }],
      ledger: [{ tool: 'read_page', args: { url: 'https://random.com' }, result: { text: 'Random content' } }]
    });
    assert.equal(emptyUrlRes.completed, false);
    assert.equal(emptyUrlRes.results[0].status, 'needs_evidence');

    // B. Unvisited URL -> needs_evidence
    const unvisitedRes = evaluateCompletionEvidence({
      results: [{ title: 'Unvisited', url: 'https://unvisited.com/info', status: 'researched' }],
      ledger: [{ tool: 'navigate', args: { url: 'https://different.com' }, result: { success: true } }]
    });
    assert.equal(unvisitedRes.completed, false);
    assert.equal(unvisitedRes.results[0].status, 'needs_evidence');

    // C. Visited URL -> researched verified
    const visitedRes = evaluateCompletionEvidence({
      results: [{ title: 'Visited', url: 'https://visited.com/docs', status: 'researched' }],
      ledger: [{ tool: 'navigate', args: { url: 'https://visited.com/docs' }, result: { success: true } }]
    });
    assert.equal(visitedRes.completed, true);
    assert.equal(visitedRes.results[0].status, 'researched');
  }

  // 20. Enter key submissions tracking
  {
    const enterSubmission = evaluateCompletionEvidence({
      results: [{ title: 'Enter Submit Form', url: 'https://example.com/login', status: 'submitted' }],
      ledger: [
        { tool: 'press_key', args: { key: 'Enter', url: 'https://example.com/login' }, result: { success: true } },
        { tool: 'read_page', args: { url: 'https://example.com/login' }, result: { text: 'Your submission has been received.' } }
      ]
    });
    assert.equal(enterSubmission.completed, true);
    assert.equal(enterSubmission.results[0].status, 'submitted');
  }

  // 21. Expanded recordId identifiers in structured records
  {
    const idFields = ['transactionId', 'submissionId', 'bookingId', 'reservationId', 'ticketId', 'paymentId', 'caseId'];
    for (const field of idFields) {
      const structuredRes = evaluateCompletionEvidence({
        results: [{ title: 'Record Test', url: 'https://api.example.com', status: 'submitted' }],
        ledger: [
          { tool: 'api_call', args: { url: 'https://api.example.com' }, result: { [field]: `VAL-${field}-123` } }
        ]
      });
      assert.equal(structuredRes.completed, true, `Field ${field} should be recognized as structured record`);
      assert.equal(structuredRes.results[0].status, 'submitted');
      assert.ok(structuredRes.results[0].evidence.some(e => e.type === 'structured_record'));
    }
  }

  // Unrelated IDs, failed responses and untrusted document prose are not receipts.
  for (const entry of [
    { tool: 'current_tab', result: { id: 7 } },
    { tool: 'api_call', result: { confirmationId: 'old', error: 'Rejected' } },
    { tool: 'form_verify', result: { verified: false, fields: [{}] } },
    { tool: 'form_verify', result: { fields: [{}] } },
    { tool: 'files_extract', result: { text: 'Thank you for your submission!' } }
  ]) {
    const verdict = evaluateCompletionEvidence({ results: { title: 'App', status: 'submitted' }, ledger: [entry] });
    assert.equal(verdict.completed, false, JSON.stringify(entry));
  }
  assert.equal(checkTextPatterns('Make a reservation using this form.').confirmed, false);
  const unrelatedPath = evaluateCompletionEvidence({
    results: { title: 'App', url: 'https://example.com/apply', status: 'submitted' },
    ledger: [{ tool: 'api_call', args: { url: 'https://example.com/apply-other' }, result: { confirmationId: 'other' } }]
  });
  assert.equal(unrelatedPath.completed, false);
  assert.equal(evaluateCompletionEvidence({ ledger: [{ tool: 'read_page', result: { text: 'Thank you for your submission!' } }] }).completed, false);
  const corrected = evaluateCompletionEvidence({
    results: { title: 'App', status: 'ready' }, ledger: [
      { tool: 'form_verify', result: { verified: false } },
      { tool: 'form_verify', result: { verified: true } }
    ]
  });
  assert.equal(corrected.status, 'ready', 'A corrected form must supersede its earlier failed verification');
  // Parallel verification must settle before recording a dependent result card.
  const events = [];
  await executeCalls([
    call('verify-race', 'form_verify', { tabId: 7, fields: [{ selector: '#name', value: 'Example' }] }),
    call('result-race', 'record_result', { title: 'App', url: 'https://example.com/apply', status: 'ready' })
  ], { allowedTools: tools, parallel: true, ledger: [], onEvent: e => events.push(e), executeTool: async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { verified: true };
  } });
  assert.equal(events.find(e => e.type === 'result').status, 'ready');

  console.log('All Completion Judge tests passed successfully!');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
