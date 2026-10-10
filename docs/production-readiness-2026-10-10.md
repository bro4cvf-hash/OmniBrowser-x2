# Production readiness check — 10 October 2026

Update: the task workspace, checkpoint recovery, immutable target identity,
shared budgets and real dispatch policy now have implementation and loaded-extension
acceptance coverage. See [Task reliability](task-reliability.md). The findings below
describe the earlier check. Paid-provider acceptance and hosted CI execution still
need separate verification; unattended production approval remains withheld.

Verdict: suitable for a supervised pilot; full unattended production approval is withheld.

## Fresh verification

- Installed runtime: `.omnibrowser-venv`, Python 3.12.14. Dependency consistency check passes.
- Python suite with `OMNIBROWSER_LIVE_TEST=1`: 155 passed in 27.30 seconds. Includes disposable Chrome integration. One MCP transport deprecation warning remains.
- Extension runner with bundled Playwright available through `NODE_PATH`: all 27 suites passed, including three headless Chrome sidebar UI suites. These UI suites use mocked extension APIs/provider responses; they do not prove a loaded extension's complete end-to-end operation.
- Python formatting: all 30 files pass. Lint passes excluding E501; strict lint reports 51 line-length violations.
- Isolated wheel build succeeds: `omnibrowser-0.1.0-py3-none-any.whl`. Building without isolation initially failed because hatchling is absent from the runtime environment; standard isolated builds install it successfully.
- Native-host manifest, launcher and Windows registration pass diagnostics. No persistent Chrome debugging endpoint is running; extension mode does not require one. Live sidebar-to-native-host connection was not exercised in this pass.
- Existing `.venv` uses Python 3.10.0, below the declared Python 3.10.1 minimum, and fails test collection. Use the working installed runtime above.
- Git whitespace validation passes. Existing workspace changes were preserved; there is no committed release snapshot from this pass.

## Release blockers confirmed by source inspection

1. Actual tasks still execute in `sidepanel.js` through `OmniSidebarAgent.run`. The background `startRun` handler creates a run record but does not own this real execution loop. Closing the sidebar or restarting the worker does not provide durable continuation of the task. Recovery must reconcile completed and uncertain actions before any retry.
2. Element references have connected-node and generation checks, but short reference IDs are regenerated during observations. Action arguments need immutable document/observation identity to prevent an old ID from targeting a different control after navigation or reinspection.
3. The separate granular policy module is not the single policy authority for real tool dispatch. Its unit tests cannot establish end-to-end enforcement. Consolidate dispatch policy and test browser, file and connected-MCP routes through it.
4. Provider behavior and model-driven task success remain fixture-tested. Run acceptance tasks against the intended provider and a loaded extension, including interruption, cancellation, navigation, folder revocation and uncertain submissions. Confirm server acceptance where a workflow requires it.
5. The new CI workflow has not been observed on a hosted run. Browser suites are not included in that workflow. Establish a reproducible release candidate and automated browser acceptance gate before claiming production readiness.

## Pilot operating limits

Keep the sidebar open during tasks and supervise consequential actions. After interruptions or uncertain outcomes, inspect the destination before resuming; completed actions remain in place. Enable only required folders and verify final form values and destination confirmation. These limits support evaluation, not an unattended production guarantee.

This pass did not call a paid model provider, submit a real application, publish a release, or alter existing runtime behavior. Logs and the wheel are under the ignored `.omnibrowser` directory. Earlier backlog reports contain historical results; the results above are from this check.
