# Task execution, recovery and verification

Tasks execute directly in the sidebar. The sidebar owns the model loop, approval
cards, structured questions and progress. Keep it open while work runs. Closing
the sidebar or Chrome interrupts work; reopening offers Resume from the saved
checkpoint. Restarting the service worker leaves the open sidebar running. Only
one task runs per Chrome profile, and no separate task tab is created.

Sidebar follow-ups reach the current task at action boundaries. Stop cancels provider requests and
prevents queued actions from starting. Completed browser actions remain in place.

## Recovery

Task state contains the original goal, send-time tab, transcript, model context,
usage and an action journal. Actions are persisted before dispatch; storage failure
prevents the action. A lost write response has an unknown outcome, even if the
browser appears to have performed it. Recovery reports these actions and reads live
state before continuing. Further writes require explicit human review, including
in Full access mode. Acknowledging review allows continuation but does not establish
server acceptance; the original outcome stays uncertain in the journal.

Short numeric element references are no longer reused for different controls.
Sidebar references combine document identity and a monotonic node counter; repeated
reads retain the reference for the same attached node. Replacement nodes and new
documents cannot inherit it. CDP inspection references include document identity,
generation and element position, and expire on reinspection. Frame prefixes still
route controls to their original frame. Always use references returned by inspection.

The service worker coordinates sidebar ownership in Chrome storage. It checks
the owning sidebar, detects closed execution documents and serializes starts.
A second sidebar cannot adopt an active run. Legacy task-tab checkpoints can be
recovered in the sidebar. A new execution replaces the latest recovery record;
ordinary saved chats retain prior transcripts.

Provider keys remain in session storage and are excluded from task records. With
Save chat history off, task recovery uses session storage and disappears when Chrome
closes. Disabling saved history removes persistent task records as well as saved
chats. Memories have their own retention controls. Re-enter a provider key after
restarting Chrome before resuming a task that requires authentication.

## Permissions and limits

Actual browser, file and connected-MCP dispatch uses the granular policy evaluator.
It checks tool, category, domain/origin, every requested file path and MCP server.
Denials take precedence even in Full access. Existing site and folder grants are
migrated into the evaluator; task grants are bound to the task, rather than the chat.
Multi-tab reads evaluate every requested destination. Writes check for URL changes
while awaiting permission. The native helper still enforces enabled file roots.

Advanced settings contain task time and estimated cost limits. The initial time
limit is 20 minutes; zero disables a limit. There is no cumulative task token cap,
and legacy saved token caps are ignored. Sub-agents, compaction and retries share
usage accounting. Recovery retains consumed usage. Adjust a time or cost limit in
settings before resuming if a task has exhausted it. A provider request
reserves estimated input and maximum output before starting, preventing concurrent
children from independently spending the same allowance. Lost responses account
for the reservation because they may still be billed.

Cost estimates use the input/output prices entered by the user. They do not include
provider-specific cache discounts or guarantee a provider billing cap. Missing
provider usage is estimated. Setup exposes provider and model selection, a manual
model ID, and a connection test that makes one small chat request. It may use API
credit; it does not establish compatibility with every browser tool.

## Acceptance checks

Install test dependencies with `npm ci`, then `npx playwright install chromium`.
Run `npm test` for deterministic suites or `npm run test:browser` for browser checks.
Set `CHROME_PATH` to the Playwright browser executable for the older UI suites;
the loaded-extension suite uses Playwright's Chrome for Testing by default.

The loaded-extension suite uses a disposable profile and a local deterministic
chat provider. It exercises the actual sidebar, service worker,
Chrome tools, checkpoint storage and provider transport. It verifies sidebar closure,
worker termination, observed form values, replacement/navigation reference rejection,
dispatch denials, lost-response recovery, cancellation, connection setup and privacy.
The native-messaging permission is removed from its copied manifest so it cannot
connect to the user's real native host. This suite does not prove native-helper
integration, paid-model success or arbitrary website compatibility.

The browser job in GitHub Actions installs the pinned Playwright dependency and runs
these checks. A local pass does not establish that the hosted job has run.

For opt-in real-provider acceptance, set `OMNI_EVAL_BASE_URL`, `OMNI_EVAL_MODEL`, and
optionally `OMNI_EVAL_API_KEY`, then run `npm run eval:provider`. This uses API credit
and runs a real model against a disposable local form with a submission hold. The
report verifies actual field values, no submission, elapsed time, usage and action
outcomes in `.omnibrowser/provider-acceptance.json`. Deterministic test evidence is
written to `.omnibrowser/task-acceptance.json`. No provider key is written to either
report. Run provider evaluation separately for each intended provider/model.

Sidebar execution remains separate from Chrome's documented service worker shutdown
behavior: [service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
