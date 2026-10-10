# GitHub code we can reuse in OmniBrowser

Reviewed 10 October 2026 against current upstream source and this checkout.

Implementation follow-up: the selected adaptations are now integrated. See the
[feature and validation guide](github-reuse-implementation-2026-10-10.md).
This report describes the original source review and downloaded reference kit.

**Best fit:** agent-browser for compact observations and stable target identity; Chrome DevTools MCP for console/network diagnostics; Browser Use for downloads and task evaluation; Stagehand for observe/execute and reusable action recipes. Playwright supplies the most useful reference implementation for actionability and accessibility semantics.

The concrete deliverable is [a local source kit](upstream-browser-kit/README.md): 36 unmodified files, including licenses, a notice where upstream supplies one, source modules and regression tests. Each file has a pinned commit, original URL and SHA-256 in [the manifest](upstream-browser-kit/manifest.json). Two small functions have also been adapted into dependency-free JavaScript and checked with 12 regression assertions. The source kit is reference material and is not loaded by the extension.

## Why these repositories

These are actively maintained upstream projects with published releases and checked-in tests. That makes them credible engineering references; it does not establish that their default branches or our adaptations are production-ready. Stars are recorded in the manifest as discovery context, not used as a reliability score. No upstream test suite or live model benchmark was run in this review.

| Project | Release reported by GitHub when checked | Source inspected | Reuse license |
| --- | --- | --- | --- |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | v0.39.0 | `44af39842650` | Apache-2.0 |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | v1.10.1 | `f08dbe152502` | Apache-2.0 |
| [Browser Use](https://github.com/browser-use/browser-use) | 0.13.11 | `c75e8476e26d` | MIT |
| [Stagehand](https://github.com/browserbase/stagehand) | 3.7.3 | `f261c38b4dc5` | MIT |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 0.0.83 | `b8b4183e099f` | Apache-2.0 |
| [Playwright](https://github.com/microsoft/playwright) | 1.64.0 | `d9f2fd3e2232` | Apache-2.0 |

Source commits are default-branch snapshots, not assertions that the files match those release tags. Stagehand's inspected source contains v4 development, while its latest GitHub stable release is 3.7.3. The inspected Playwright MCP package pins alpha Playwright dependencies; its implementation now lives in the Playwright monorepo. The independently inspected Playwright commit is not claimed to be that alpha dependency's exact revision. Use tested, pinned release packages for an eventual package integration.

## What our current code already does

This checkout is ahead of the earlier comparison reports. `background.js` now gives refs a random document identity plus inspection generation and checks connected nodes. It also waits for actionable targets, handles frame/shadow contexts and has a bounded console buffer. `task-coordinator.js` creates a separate extension task tab; `task-client.js` and `task-session.js` publish task state and track uncertain writes. `sidepanel.js` routes normal task starts through that client. Closing the visible sidebar is therefore different from losing the execution tab; a browser restart still requires recovery rather than guaranteed continuous execution.

Provider retries, completion checks, context archives, memories, parallel tools and sub-agents are present. We should extend these implementations instead of installing another full agent loop. The manifest records hashes of ten current local files so this assessment can be distinguished from older reports.

## Exact source and integration choices

| Order | Improvement | Actual upstream source to adapt | Where it belongs here | Adaptation required |
| --- | --- | --- | --- | --- |
| 1 | Compact, scoped observations | agent-browser [`snapshot.rs`](https://github.com/vercel-labs/agent-browser/blob/44af39842650f0bb9c1afb7354df9a82921d4f09/cli/src/native/snapshot.rs) and [`snapshot.ts`](https://github.com/vercel-labs/agent-browser/blob/44af39842650f0bb9c1afb7354df9a82921d4f09/packages/@agent-browser/eve/extension/tools/snapshot.ts): interactive-only, depth, scope and compact options | `background.js` inspection and `sidebar-agent.js` tool schema | Port the filtering contract to our JSON observations; expose truncation and a full-read fallback. The TypeScript wrapper depends on Eve; the engine is Rust. |
| 2 | Page changes instead of repeated full content | agent-browser [`diff.rs`](https://github.com/vercel-labs/agent-browser/blob/44af39842650f0bb9c1afb7354df9a82921d4f09/cli/src/native/diff.rs): `diff_snapshots`, `snapshot_comparison_text` and inline tests | A new observation helper between `background.js` and `sidebar-context.js` | Keep per-tab/document baselines, ignore generated IDs only for content comparison, return fresh action refs separately, and fall back to full content if a baseline is missing or evicted. |
| 3 | Useful network and console diagnostics | Chrome DevTools MCP [`PageCollector.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/src/collectors/PageCollector.ts), [`network.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/src/tools/network.ts), [`console.ts`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/src/tools/console.ts) | Extension debugger event handler; Python CDP adapter and MCP tools | Translate Puppeteer listeners into CDP events, retain bounded resources per navigation, distinguish SPA navigation, and detach listeners. Existing extension console capture needs richer lifecycle/query support; network capture is a larger addition. |
| 4 | CDP events that survive command waits | agent-browser [`cdp/client.rs`](https://github.com/vercel-labs/agent-browser/blob/44af39842650f0bb9c1afb7354df9a82921d4f09/cli/src/native/cdp/client.rs): receive loop, pending responses, event subscriptions and cancellation cleanup | `src/omnibrowser/adapters/chrome.py` | Reimplement with asyncio: one receiver owns the socket, response futures keyed by request ID, bounded event queues, timeout/reconnect cleanup. Current `_send_command` discards nonmatching events. This must precede reliable Python network/download capture. |
| 5 | Download completion and output evidence | Browser Use [`downloads_watchdog.py`](https://github.com/browser-use/browser-use/blob/c75e8476e26d18b7617643bc2ae082fae8eae431/browser_use/browser/watchdogs/downloads_watchdog.py) and [`test_downloads_watchdog.py`](https://github.com/browser-use/browser-use/blob/c75e8476e26d18b7617643bc2ae082fae8eae431/tests/ci/test_downloads_watchdog.py) | Python browser adapter, file roots and task result tracking | Adapt download events and completion tracking, validate the actual destination against our enabled folders, distinguish cancellation/failure and retain output evidence. Its event bus, session and PDF paths prevent dropping the whole class into our adapter. |
| 6 | Reusable action recipes | Stagehand [`cacheService.ts`](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/cacheService.ts), [`observeService.ts`](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/observeService.ts), [`actService.ts`](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/extension/services/actService.ts) | New local recipe store, then existing tool dispatch | Reuse normalization, observe/execute separation and fallback design. The inspected cache authenticates to Browserbase and uses server routes; a local cache requires our own backend. Revalidate targets and task authorization before replay; do not cache our document-scoped refs as durable selectors. |
| 7 | Short refs that stay valid for the same live node | agent-browser [`element.rs`](https://github.com/vercel-labs/agent-browser/blob/44af39842650f0bb9c1afb7354df9a82921d4f09/cli/src/native/element.rs): `RefMap.observe_document`, `durable_ref`, invalidation; `snapshot.rs` iframe/session regressions | Existing reference store in `background.js` | Our document-safe refs already exist. Improve their length and stability across harmless inspections using opaque IDs mapped to live nodes; preserve document/frame identity and rejection after replacement. Never resolve an old ref by its numeric position. |
| 8 | Consistent actionability and accessibility | Playwright [`injectedScript.ts`](https://github.com/microsoft/playwright/blob/d9f2fd3e2232ace8e317a84eda6cb86e25bcf49c/packages/injected/src/injectedScript.ts): `checkElementStates`, stability and hit targeting; [`ariaSnapshotDistiller.ts`](https://github.com/microsoft/playwright/blob/d9f2fd3e2232ace8e317a84eda6cb86e25bcf49c/packages/injected/src/ariaSnapshotDistiller.ts) | Existing semantic locator/actionability helpers | Use as a correctness reference and consolidation guide. The injected engine imports Playwright internals; copying the complete class creates substantial dependency and maintenance work. Keep strict ambiguity and our existing native input paths. |
| 9 | Task-specific completion grading | Browser Use [`judge.py`](https://github.com/browser-use/browser-use/blob/c75e8476e26d18b7617643bc2ae082fae8eae431/browser_use/agent/judge.py), Stagehand [`verifier-gates.md`](https://github.com/browserbase/stagehand/blob/f261c38b4dc50c39485f924e8599c1d3c6e37dc7/packages/evals/docs/verifier-gates.md) | `completion-judge.js` and acceptance fixtures | Extend our existing checks with task rubrics and original observations. Retain self-report separately from verified evidence; mark uncertainty explicitly. An LLM judge adds inference cost and is not proof of server acceptance. |
| 10 | Stronger tab/session relay lifecycle | Playwright [`browserModel.ts`](https://github.com/microsoft/playwright/blob/d9f2fd3e2232ace8e317a84eda6cb86e25bcf49c/packages/playwright-core/src/tools/mcp/browserModel.ts) | Existing extension relay and debugger ownership | Adapt tab/session mappings, attach/detach and target event handling. Keep our authenticated native bridge and per-tab ordering. Do not assume Playwright's extension transport is interchangeable with ours. |

The first three recommendations are new capability work. Reference identity, waits, task ownership and completion grading already exist and should be improved through targeted changes.

## Code already prepared for adaptation

[reusable-kernels.cjs](upstream-browser-kit/adaptations/reusable-kernels.cjs) contains:

1. `snapshotComparisonText(tree)`: a JavaScript port of agent-browser's Rust function. Removes generated `[ref=eN]` attributes from comparison text, preserves states and quoted labels, and does not change the original actionable snapshot. Its input is agent-browser-style text; our JSON observation format needs an explicit rendering/normalization adapter.
2. `normalizeCachedActions(value)`: Stagehand's shape normalizer with TypeScript removed. Discards malformed entries and keeps string arguments. This validates shape only; tool allowlists, target freshness and permission checks are still required before execution.

Both functions have source attribution and modification notes. They have no external dependencies. Run the included regression checks with:

```powershell
node docs/upstream-browser-kit/adaptations/test-reusable-kernels.cjs
```

The checks cover ref-only changes, meaningful label/state changes, quoted ref-like text, escaped quotes, malformed attributes and corrupt cache entries. **12 assertions passed.** These checks establish the small functions' behavior; they do not establish browser integration or task reliability.

## Reuse boundaries

Keep the copied MIT copyright/license notices and Apache-2.0 license/attribution requirements. Mark modifications and retain applicable NOTICE material when distributing adapted code. The kit includes upstream licenses and the root notice discovered in the inspected trees; dependency licenses still require inspection if importing larger modules or packages.

[Skyvern](https://github.com/Skyvern-AI/skyvern) is a useful workflow/form-automation reference, but its core repository is AGPL-3.0. It was inspected for relevance and license, and no Skyvern source was copied into this kit. Its license differs from our MIT project and the permissive sources selected above.

Prefer small, attributed adaptations or pinned package integrations. Full source modules here deliberately retain their original imports and are not standalone libraries. Installing Browser Use, Stagehand and Playwright together would introduce overlapping drivers, state owners and dependencies; that is not necessary to obtain the selected improvements.

## Recommended implementation sequence

Start with scoped observations and page deltas because they fit the extension architecture without replacing execution. Measure returned characters and actual provider tokens on the same fixtures, including unchanged pages, state-only changes, navigation and baseline loss. Always provide fresh refs for the current document.

Next build the Python CDP receive loop and bounded diagnostics, then download completion. Validate events received between commands, simultaneous response/event traffic, cancellation, reconnect, tab closure and SPA navigation. Add local action recipes only after observations and target validation are stable; exercise changed forms and uncertain submissions before allowing replay.

No runtime behavior was changed by this research pass, and no improvement in speed, cost or completion rate is claimed. The source files and tested adaptations make the next implementation reviewable and reproducible.
