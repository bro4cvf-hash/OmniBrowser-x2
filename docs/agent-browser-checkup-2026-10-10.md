# Agent browser implementation checkup — 2026-10-10

The applied work does not yet cover the complete 56-item research backlog.
This checkup inspected the current execution paths and ran deterministic tests,
sidebar UI checks in actual headless Chrome, and the disposable Chrome/CDP
integration test. Provider replies in these tests are fixtures; no paid model
calls or real applications were submitted.

## Confirmed defects repaired

- Result recording now waits for preceding tool calls to settle. A parallel
  `form_verify` followed by `record_result` previously produced an incorrect
  “Needs evidence” card.
- Completion evidence rejects generic IDs, failed/uncertain results, arbitrary
  document prose, empty verification fields and unrelated URL prefixes. A
  reservation mention alone is no longer a confirmation. The no-result path
  also requires a preceding action for confirmation text.
- Each run uses its own action-ledger storage key; duplicate observations from
  the executor wrapper were removed.
- Outcome-unknown and needs-evidence cards prevent the sidebar from declaring
  the task finished successfully.
- Scoped site/folder approval grants now affect dispatch. Live tab URLs refresh
  site scope before checking a grant.
- Covered targets fail instead of dispatching a native click onto an overlay
  and reporting success. Native fallback remains available for custom widgets.
- Form verification and visibility waits normalize frame-qualified references.
- CDP file upload initializes the document tree before requesting a node ID;
  this fixes a failure reproduced in real Chrome.
- UI tests use the current approval controls and extract the complete injected
  verifier, including its nested helpers. Regression cases cover the defects.
- Python imports, unused variables and formatting were cleaned up. Remaining
  strict lint violations are long lines, largely in embedded JavaScript.

## Coverage against the research backlog

“Partial” means some relevant behavior exists; it is not a completion claim.
Module unit tests alone do not establish that the product uses a module.

| Items | Current implementation and remaining work |
|---|---|
| 1 | **Not integrated.** `sidepanel.js:runTask` still calls the agent directly. Background run maps and ports exist, but `startRun` does not connect the real agent loop. Its executor function cannot be sent through Chrome message serialization. Runs are not restored after service-worker restart. |
| 2–3 | **Partial.** Per-action settlement, ledger storage and transcript reconciliation exist. Durable run association, restoration and recovery across sidebar/service-worker restarts remain incomplete. |
| 4–5 | **Partial.** Active-run follow-ups are now queued at action boundaries and invalidate stale planned actions. Structured question cards support choices and custom answers. Checkpoint-fork UI/runtime remains absent. |
| 6 | **Partial.** Round and request timeout limits exist, and three consecutive identical failed rounds stop the task. Task elapsed-time/token/cost budgets remain absent. |
| 7 | **Partial, repaired.** Completion judge is wired into result cards. Confirmation remains heuristic, and some evidence paths such as multi-page observations and public research need broader integration. It is not a guarantee of server acceptance. |
| 8 | **Missing.** Parallel tools exist; independent worker contexts and shared budgets do not. |
| 9–10 | **Partial.** Actionable references and connected-node/generation checks exist. Unqualified short references can be reused after a new observation; document identity needs to travel with action arguments to guarantee stale-reference rejection across navigation. |
| 11–12 | **Implemented paths exercised.** Semantic locators and readiness checks pass fixtures. This does not establish complete accessibility-name compliance or compatibility with every website. |
| 13–14 | **Partial.** Native keyboard/mouse tools and frame/open-shadow routing exist. Ordinary clicks still use synthetic dispatch; fallback coordinates from child frames need stronger real-browser coverage. Closed shadow roots remain inaccessible. |
| 15–16 | **Partial/missing.** Screenshots exist; annotated vision and controlled vision fallback are absent. Page observations flag truncation but do not provide a general cursor for omitted controls. |
| 17–19 | **Missing.** No page-delta protocol, dedicated observe/action separation or validated recipe cache. |
| 20 | **Partial.** Tool schemas and structured workflow records exist; there is no universal validated result/provenance schema. |
| 21 | **Partial.** Bounded scheduling, per-tab ordering and adaptive throttling exist; worker ownership is absent. |
| 22–24 | **Partial.** Generic chat-completions transport, context usage and retry/backoff exist. Provider-specific adapters, capability matrix, full token/cache/cost ledger and configured provider fallback are absent. |
| 25–29 | **Missing.** No reusable skill runtime, progressive skill discovery, configurable lifecycle hooks, layered user/site rules or editable scoped memory. |
| 30 | **Partial.** Transcript/archive preservation and compaction exist. Exact facts and permissions are not maintained in a separate durable store. |
| 31–32 | **Partial/missing.** MCP discovery and persistent sessions exist; OAuth, resources/prompts and Codex/Claude runtime adapters are absent. |
| 33–34 | **Partial.** Sidebar scoped grants are wired and repaired. The separate granular `sidebar-policy.js` engine is not the policy used by `browserTool`; its passing tests do not prove enforcement of all five policy dimensions. |
| 35–38 | **Partial/missing.** Observation boundaries, source checks and diagnostic redaction exist. There is no complete read-only execution mode, end-to-end redaction guarantee or OS credential vault. Injection tests cover selected attacks only. |
| 39 | **Partial.** Action preview and tri-state outcome display exist; confirmation is still heuristic. |
| 40 | **Partial.** Separate Chrome profiles are available; ordinary tabs do not isolate cookies/accounts and are not a sandbox. |
| 41 | **Partial.** Sidebar exposes more MCP-style interactions and uploads. Test coverage is not full real-extension parity, particularly for frame-native input and screenshots. |
| 42–43 | **Missing/partial.** Bounded document extraction exists; verified download lifecycle, prompt attachments and OCR are absent. |
| 44 | **Implemented path exercised.** Background search/fetch exists with bounded source content and no visible-browser research fallback. External service behavior was fixture-tested. |
| 45 | **Partial.** Diagnostics export exists; general JSON/CSV task reports and artifact retention controls are absent. |
| 46–48 | **Partial/missing.** Console collection exists. Python CDP still discards unsolicited events while awaiting command responses. There is no complete scoped network event dispatcher, recording/trace system or WebMCP integration. |
| 49 | **Partial.** Scenario fixtures and actual Chrome checks exist. Many “realistic” task fixtures execute against mocked DOM/Chrome APIs rather than a loaded extension. |
| 50–52 | **Partial.** Deterministic faults/injection tests exist. The benchmark harness does not run a real model-driven task benchmark or establish actual token/cost/success baselines. |
| 53 | **Implemented path exercised.** Diagnostic assembly, redaction and participating-tab scoping have tests; this is not proof that every secret format is redacted. |
| 54 | **Missing.** No repository CI workflow was present. Local checks are not an automated release gate. |
| 55 | **Partial, repaired.** Lifecycle UI and recovery controls exist. Recovery still launches the sidebar loop rather than restoring a durable background run. |
| 56 | **Partial.** Doctor and capability generation exist. Registry/tool checks do not demonstrate actual model capability or live sidebar-to-runner continuity. |

## Verification

- Full Python suite with `OMNIBROWSER_LIVE_TEST=1`: **145 passed**.
- All **23 JavaScript suites**, including the three Playwright sidebar UI suites,
  were run using the bundled Playwright package and installed Chrome.
- Python formatter check passes. Lint passes with only `E501` (line length)
  excluded; strict default lint still reports long lines. No rules were disabled
  in project configuration.
- One MCP SDK deprecation warning remains for the streamable HTTP client name.

Highest-priority remaining work: connect and persist the actual background
runner, carry document identity with target references, enforce one granular
policy engine at dispatch, and add real model-driven acceptance evaluations.
These require further implementation, not merely relabeling passing unit tests.
