# Website memories with Hindsight

OmniBrowser uses the existing [Hindsight engine](https://github.com/vectorize-io/hindsight)
for AI memory retrieval. Exact website text, editable notes and image copies remain
in a browser IndexedDB archive. That archive's keyword index serves local browsing;
the assistant's natural-language recall goes through Hindsight.

## Downloaded code

Engine and official SDK: **0.10.3**, GitHub tag `v0.10.3`, commit
`eb6df499d35300e5b2f3f029b2e6adda04ed90f8`, MIT license. The source checkout on this
machine is `.omnibrowser/hindsight-upstream`; the private installed engine is
`.omnibrowser/hindsight-venv`. These local runtime directories are ignored by Git.
The SDK is included in `extensions/chrome/vendor/hindsight`, with its license,
SHA-512 package integrity and source SHA-256 in `provenance.json`.

`node scripts/vendor-hindsight-sdk.js` reproduces the SDK bundle. Published code
is unchanged inside a browser-global wrapper. The extension downloads no executable
code at runtime. `hindsight-memory.js` orchestrates capture IDs, source metadata,
indexing status and connection credentials. Extraction, embeddings, retrieval
and ranking execute in the upstream engine. See its
[retrieval code](https://github.com/vectorize-io/hindsight/blob/eb6df499d35300e5b2f3f029b2e6adda04ed90f8/hindsight-api-slim/hindsight_api/engine/search/retrieval.py).
No accuracy benchmark has been run for this integration; a universal “frontier”
claim would exceed the evidence.

## Start and connect

1. Reload the Chrome extension to load the new client and background worker.
2. Run **Install Memory.cmd** if the private engine has not already been installed.
   Python 3.11+ is required. The installer prefers the project's existing Python.
3. Run **Start Memory.cmd**. It supports `HINDSIGHT_API_LLM_API_KEY` or
   `OPENAI_API_KEY` in the process environment. Without an AI key it starts local
   semantic search using Hindsight's native `none` provider, which stores chunks
   and does not extract/consolidate facts or interpret image pixels.
4. Automatic saving connects to `http://127.0.0.1:8888` when ready and creates a
   unique memory bank. Keep a website active for 10 seconds; no save command is
   needed. Open **Memories** for pause, image and site-exclusion controls.
5. Pending captures sync automatically. In **Settings → AI settings → Advanced
   settings → Memory engine · Hindsight**, you can explicitly reconnect a paused
   service, configure a remote service, or use **Sync saved items** to retry now.

The installer uses `hindsight-api-slim[embedded-db,local-onnx]==0.10.3` and
FlashRank: official engine providers with real local ONNX embeddings/reranking,
without the full PyTorch stack. Initial startup downloads search models. The
launcher allows 30 minutes for that first download, sets UTF-8 for Windows logs,
binds to `127.0.0.1`, and names the pg0 database instance `omnibrowser-memory`.
Startup logs are under `.omnibrowser`; pg0 manages its database in its user data
directory separately from Chrome. External PostgreSQL is recommended upstream
for production. Source: [Hindsight installation](https://hindsight.vectorize.io/developer/installation).

For extracted facts, entity resolution, consolidated observations and visual
memory, configure a supported AI provider and restart the service. Defaults with
a key are OpenAI / `gpt-4o-mini`. Other providers use `HINDSIGHT_API_LLM_PROVIDER`,
`HINDSIGHT_API_LLM_MODEL`, `HINDSIGHT_API_LLM_BASE_URL` and the appropriate key.
An OpenAI-compatible local model can use its local base URL and a placeholder key.
See [upstream models](https://hindsight.vectorize.io/developer/models).
The sidebar's chat provider and Hindsight's extraction provider are independent.
Settings also supports an existing HTTPS Hindsight deployment and its service token.

The local service is currently running in native local-search mode. To force that
mode independently of inherited API keys, use `scripts/start-memory.ps1 -LocalSearch`.
The inherited provider rejected the launcher's default extraction model during
verification; full extraction needs a model supported by the configured provider.

## Save and recall

Automatic saving is enabled by default. An active website in the focused browser
window is captured after 10 seconds. Navigation, tab activation and a recurring
check schedule capture without requiring the sidebar or a chat. In-page changes
are checked again each minute. Unchanged content avoids repeat downloads and
retention calls; changed content replaces the same automatic page/document ID,
preserving pins, notes and tags. Manual captures remain independent.

Open **Memories** to pause automatic saving, turn off image copies, or exclude
domains (including their subdomains). These controls persist independently of
chat-memory access. Exclusions stop new captures and leave existing items intact.
Private windows, inactive/background windows, loading pages, sign-in/account/
payment routes, token-bearing URLs and visible password/card/one-time-code forms
are skipped. Pages shorter than 80 visible characters are skipped. This is a
bounded page archive, not a complete browsing-history log. Site exclusions remain
the control for any other private website you do not want archived.

Automatic captures keep visible page text, source, date, the website's own meta
description and image alt descriptions. They optionally save one representative
raster image up to 1 MiB without cookies or redirects; signed/token-bearing image
URLs are skipped. This description is not an AI-generated summary. Hindsight's
configured extraction model processes saved content; local-search mode cannot
produce AI summaries or interpret image pixels.

The bundled localhost service connects automatically when available. Failed
captures/indexing keep local originals and a recurring job retries indexing in
batches of five. Pending index state survives worker/browser restarts. Chrome may
delay capture alarms; the 10-second timer provides the normal foreground path,
and a persistent alarm provides recovery. Explicit **Pause recall** is respected
and remote deployments are never connected automatically.

**Memories** also offers page, selection, image, screenshot and note captures.
**Summarize & save** uses the sidebar AI to create a factual summary and keep its
original page text. Open an item to see its source/date, preview, edit, pin, export or
delete it. Original text is independent of editable metadata. JSON export includes
full text and any image bytes; import is not implemented.

Each save first gets an exact local copy. The official SDK's `retain` sends text,
summary, notes, tags, capture time and source URL, with local ID as `document_id`
and `update_mode: replace`. Confirmed synchronous retention marks that revision
indexed. Timeouts/errors leave a pending marker and local copy. Sync replaces the
same document, recovering interrupted calls without duplicate documents.

Use local word/tag search, or enable **Recall by meaning with Hindsight** in the
library. Before a chat request, Hindsight receives the prompt through `recall`,
with low effort and a 2,400-token response budget. Only facts/chunks from this
browser's confirmed current documents are accepted. Engine result order is
preserved and duplicate documents are collapsed. We request world/experience
results to preserve a direct source document per snippet; consolidated observation
results are not currently passed into the browser's context. The assistant gets
up to five snippets of 800 characters each with IDs, URLs and dates. It can recall
again or read original text in 12,000-character pages. Offline/paused engines
produce explicit errors, without a keyword fallback masquerading as semantic recall.

Images stay local by default; their titles/notes are indexed. **Send saved images
for visual memory** enables the SDK's native image content blocks, requiring a
vision-capable retain provider. Sync after changing this option; existing engine
copies remain until replacement succeeds. Image bytes do not enter recall/chat
prompts. Local search mode cannot interpret pixels.

## Consistency, privacy and limits

Deletion uses the official generated SDK delete operation against the original
bank, then removes the local copy. An unavailable engine blocks confirmed deletion
and leaves a recoverable copy and visible error. A genuine HTTP 404 means already
deleted. Deleting an automatic memory suppresses future automatic captures of
that exact source URL, even if its content changes. A manual save remains possible.
Index markers survive service-worker restarts. Failed updates are excluded
from recall until synced, avoiding outdated engine revisions.

Only settings controls can connect/sync the service; assistant tools cannot change
its address or credentials. Service tokens are stored in `chrome.storage.session`,
scoped to endpoint/bank, cleared when Chrome closes. Reconnect authenticated
services after restart. Endpoint, bank and index status persist without tokens.
A library that has sent documents stays attached to that bank so deletions cannot
silently leave orphaned remote data. **Pause recall** stops indexing/retrieval but
keeps the connection usable for requested deletion. The chat-memory toggle controls
automatic recall and assistant tools, independently of manual library captures.

Saved text is sent to Hindsight and its configured extraction provider; relevant
recalled text is sent to the sidebar's chat provider. Content is untrusted evidence,
never instructions or authorization. Verify changing facts against live websites.
Deleting a memory does not erase excerpts in older chats; delete those separately.
Uninstalling the extension removes local copies but does not erase an external bank.

Visible page extraction excludes controls, editable/hidden areas and scripts; it
covers the main document rather than cross-origin frames or closed shadow roots.
Image URLs must match fresh page observations, download without credentials or
redirects, and use supported raster MIME types. Screenshots include everything
visible in their viewport. Limits: 2,000 items/128 MiB content, 100,000 characters
per capture, 6,000 per summary/note, 12 tags and 8 MiB per image. Index overhead
and Hindsight storage/provider costs are separate. Local deduplication/writes are
transactional.

## Tools and verification

`memory_search` delegates recall to Hindsight; `memory_read` reads local originals.
`memory_save`, `memory_capture`, `memory_update`, `memory_delete` use the integrated
service. `memory_inspect` observes a website before capture. Connection/sync are
settings-only. Capture requires Browser tools; note/search/read can work in plain
chat. Read-only sub-agents cannot mutate memories. The asset reader is library-only.

`tests/test_hindsight_memory.js` exercises the actual official SDK over HTTP with
fixture engine replies: retain/recall/delete contracts, budgets, source IDs,
session secrets, stale exclusion, restart/retry recovery, visual payloads and the
vendored hash. `tests/test_sidebar_memory.js` uses real Chrome, IndexedDB and DOM
capture, including settings connection/sync through the official browser SDK,
images/export, summary saves, responsive UI and untrusted evidence boundaries.
Contract/UI tests make no paid calls and do not measure model accuracy.

`tests/test_automatic_memory.js` covers dwell, restart recovery, navigation races,
focus/private-page exclusions, image streaming limits, deduplication, local
connection retries and pause. The browser archive test also verifies atomic
automatic replacement, asset accounting, preserved annotations, and deletion
suppression with actual IndexedDB.

`node scripts/check-memory.js` checks a running engine with an isolated temporary
bank, retaining a document, recalling a differently worded query and verifying
deletion. It removes the temporary bank afterward. This passed on the installed
0.10.3 engine using real PostgreSQL, 384-dimensional ONNX embeddings and FlashRank,
with native local-search mode and no paid LLM calls.

`scripts/check-memory-extension.js` also passed against that real service from a
loaded Chrome extension in a disposable profile: automatic local connection,
live automatic capture, pause controls, repeat-visit deduplication, official SDK
indexing, semantic recall, original-text reading and deletion suppression. It
requires Playwright/Chromium and a local-search engine, creates
an isolated test bank, then removes the bank and temporary browser profile.
