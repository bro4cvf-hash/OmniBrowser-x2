# Reliability improvements — 2026-10-10

This pass fixes the local bridge discovery and verification infrastructure.
Existing workspace changes were preserved.

## Changes

- Keep a live bridge's endpoint record after request timeouts or connection resets.
  Previously any socket error removed the record, breaking subsequent commands
  until the native host restarted. Connection refusal still removes stale records.
- Ignore and remove malformed endpoint records instead of failing discovery.
- Validate authenticated command shapes before forwarding them to Chrome and
  reject non-object responses with a useful error.
- Add eight regression cases covering malformed discovery records, recovery after
  a timeout, and invalid commands.
- Add a JavaScript suite runner with four concurrent workers and a deadline per
  suite. Browser suites are opt-in and run sequentially.
- Add GitHub Actions checks for Python 3.10/3.12 and Node 22. The workflow has been
  added locally; hosted execution has not been observed. Existing line-length
  violations are excluded explicitly in CI, without changing project lint rules.

## Verification

- Python tests with disposable Chrome integration: 155 passed.
- Non-browser extension suites: 24 passed in the final runner invocation.
- Three Playwright sidebar UI suites passed with installed Chrome.
- Python formatting and lint excluding existing E501 violations pass.
- One MCP SDK transport deprecation warning remains.

No runtime browser speedup has been measured. The parallel runner reduces local
verification time; the bridge changes improve recovery and connection reliability.

## Remaining priorities

The existing checkup describes larger unfinished features: durable background
execution/restoration, navigation-safe element identity, a unified dispatch policy,
and real provider acceptance evaluations. These remain unfinished. Resolve these
before adding more browser adapters, recording/replay, or model routing, which
would expand the maintenance surface. Remove or integrate unused parallel policy
and runner paths only after confirming their callers and migration behavior.
