# GitHub source reuse implemented

OmniBrowser now integrates the small reusable pieces from the downloaded
[source kit](upstream-browser-kit/manifest.json). See the
[research report](github-code-reuse-2026-10-10.md) for upstream selection and
the [runtime attribution](../extensions/chrome/vendor/browser-reuse/NOTICE.md)
for licenses, pinned commits and modifications. The complete upstream frameworks
are not dependencies of these features.

| Feature | Sidebar | Python MCP |
| --- | --- | --- |
| Scoped, paginated reads | `read_page`: selector, frame, depth, control/text offsets, limits | `read_page`: selector, text offset, text limit |
| Compact controls | `interactiveOnly`, current actionable references | `interactive_only`, bounded control names/roles; use `elements_list` for targets |
| Observation deltas | `sinceSnapshotId` | `since_snapshot_id` |
| Console/network diagnostics | `diagnostics_start/read/stop` | Same tool names |
| Download evidence | `download_file`, `downloads_status` | `downloads_start/status/stop` |
| Reusable field recipes | `recipe_save/list/run` | Not exposed |
| Explicit completion checklist | `verify_task` | Not exposed |

## Observations and targets

Read responses contain a `snapshotId`. Supply it on the next read with the same
scope to receive a `textPatch` with `start`, `deleteCount`, and `insert`. Apply
the patch to the previous text. Navigation, scope changes, missing document
identity, or an evicted baseline return full content with `baselineMissing`.
Baselines are limited to 32 bounded observations. Delta responses retain current
controls; a text delta does not authorize reusing an old action target.

Sidebar references stay stable for the same live node across inspections, and
reject replaced nodes or another document. Scoped reads require one matching
container; specify a frame when the selector is ambiguous between frames.
`aria-labelledby` is considered before fallback control labels.

## Diagnostics and downloads

Start diagnostics before reproducing a problem. Both transports collect up to
200 requests and 200 console messages. Main-document navigation clears old
evidence while retaining requests for the new document loader; history-only
navigation retains evidence. URLs omit credentials, queries and fragments.
Request headers, cookies and bodies are not collected. Site console messages
are retained as text and can include whatever the site logs.

The CDP client has one response/event reader, so diagnostics and download events
remain available while no command is executing. Responses are matched by command
ID; commands remain ordered and interrupted writes are not automatically retried.

Sidebar downloads must use a currently observed link or page URL. Chrome writes
to a unique subfolder and the status tool only reads downloads started by this
extension for that tab. Completion is based on Chrome's download metadata, not
a fresh filesystem check. To inspect content, enable its containing folder.

Direct MCP download capture requires an enabled destination folder and a dedicated
debugging profile. It temporarily sets browser-wide download behavior to unique
GUID filenames and only attributes downloads from the selected page's frames.
Completed files must exist as regular files within the enabled output folder.
Connection loss or missing files yield an unknown outcome. Stop tracking to
restore Chrome's default download behavior. Only one capture is active at a time.

## Recipes and completion

Recipes store page origin/path, durable selectors, field actions and `{{variable}}`
placeholders. They do not store filled values. Replay validates current enabled,
non-sensitive targets, obtains fresh references and uses the sidebar's existing
batch-action permission and approval flow. Recipes support fill, select and
checkbox edits; clicks and submission are excluded.

`verify_task` checks explicit page text, field values, checkbox states or tracked
download completion against current evidence. Its verified/failed/unknown result
does not infer server acceptance from field contents.

## Activation and validation

Reload the unpacked Chrome extension to load the new scripts and the `downloads`
permission. Restart/reconnect the MCP server to load its Python changes.

Tests include response/event routing, document-bound deltas, bounded diagnostics,
recipe input and target validation, completion evidence, and download containment.
Disposable real-browser acceptance tests exercise the loaded extension and direct
MCP on local fixtures, including recipe replay, failed requests and actual downloads.
No paid model calls are needed by these features or tests. No quantified speed or
token reduction is claimed.

Polish follow-up: compact MCP reads include the selected control itself, identify
native button/radio/slider roles, and respect disabled fieldsets. Recipe replay
derives required inputs from the stored actions and rejects damaged entries and
reserved recipe names. Completion checks compare each expected field value
separately, even when multiple requirements use the same selector. Sidebar
activity labels and checklist summaries use plain language.

Final validation on 10 October 2026: 162 Python tests passed with live Chrome
enabled (one existing MCP transport deprecation warning); all 36 Node extension
suites passed with browser tests enabled. All 36 pinned upstream source files
passed their SHA-256 checks. Targeted Python lint checks passed, excluding the
existing long-line rule violations in the integration module.
