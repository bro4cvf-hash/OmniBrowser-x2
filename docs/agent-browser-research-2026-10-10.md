# OmniBrowser: project-backed improvement backlog

Research date: 10 October 2026. This is a research and design proposal, not an implementation or a performance benchmark.

[Evidence manifest](<G:/AI/ai/Super Browser/docs/agent-browser-research-evidence-2026-10-10.json>) records repository commits and hashes of the local files used for the comparison.

I inspected the eight repositories below at pinned commits, selected source files and READMEs, official product documentation, and a snapshot of 15 local OmniBrowser files. The backlog contains 56 distinct candidates. Priorities and the proposed browser adaptations are my assessment; upstream evidence establishes the underlying pattern, not that our proposed implementation already exists or will produce a particular speedup.

**Repository snapshots**

| Project | Commit inspected | Relevant material |
|---|---|---|
| [Claude Code](https://github.com/anthropics/claude-code) | [2301018b1f61](https://github.com/anthropics/claude-code/tree/2301018b1f61073c501a8e7a4813ef48c239163b) | README, changelog, plugin examples, license; official hooks, skills, memory, permissions, MCP, SDK and checkpoint docs |
| [Codex CLI](https://github.com/openai/codex) | [806d9732c974](https://github.com/openai/codex/tree/806d9732c974bc8a51b8317c1bd8985544fe627c) | App-server README; agent budget and instruction-loading source; official app-server protocol |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | [b8b4183e099f](https://github.com/microsoft/playwright-mcp/tree/b8b4183e099f136cbec0388a6088d4aa2f6b9685) | Tool catalogue, capabilities, profile modes, output controls and security limitations |
| [browser-use](https://github.com/browser-use/browser-use) | [c75e8476e26d](https://github.com/browser-use/browser-use/tree/c75e8476e26d18b7617643bc2ae082fae8eae431) | Agent implementation, completion judge, agent/browser references and monitoring reference |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | [44af39842650](https://github.com/vercel-labs/agent-browser/tree/44af39842650f0bb9c1afb7354df9a82921d4f09) | Snapshot references, diffing, security, sessions, CLI tools and evaluation harness |
| [Stagehand](https://github.com/browserbase/stagehand) | [1fc884992b68](https://github.com/browserbase/stagehand/tree/1fc884992b68a0196ea5c6e96cc29924b0922ef4) | Current README and eval harness; v4 act/observe/extract/caching documentation |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | [f08dbe152502](https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/f08dbe152502d66e75fa07fb2588dc0feb42bc20) | Tool reference, text snapshot implementation and snapshot tool |
| [OpenCode](https://github.com/anomalyco/opencode) | [055d95bb7e27](https://github.com/anomalyco/opencode/tree/055d95bb7e278c94baf06235a52cac79dd13ba67) | Provider transforms, compaction, retry implementation, permissions, skills and provider documentation |

GitHub default-branch commits can include unreleased work. Official documentation establishes supported integration surfaces; source snapshots establish what was inspected. Claude Code's public repository supplies examples, documentation and release information, not a permissively licensed copy of the complete product runtime. Its [license](https://github.com/anthropics/claude-code/blob/2301018b1f61073c501a8e7a4813ef48c239163b/LICENSE.md) differs from Codex's Apache-2.0 license. Adopt documented patterns or supported SDKs, and check individual licenses before copying code.

**What is already built**

| Capability | Local evidence | Assessment |
|---|---|---|
| Streaming, provider HTTP retries, configurable rounds, parallel execution and per-tab ordering | [Agent runner][L1] | Present. Improve control and failure handling rather than adding another basic loop. |
| Context usage, automatic compaction and exact archived-output retrieval | [Context manager][L2] | Present. Protect task facts and reduce observation size before summarizing. |
| Saved chats, compaction state, task checklists and result cards | [Sidebar][L3] | Present. They do not constitute a service-owned, durable running task. |
| Embedded frames and open shadow roots in sidebar inspection/actions | [Extension background][L4] | Present. Support depth, stale targets and unsupported contexts need clearer contracts. |
| Batching, combined browser steps and form verification | [Agent tools][L1], [MCP tools][L6] | Present. Source mapping and server acceptance still depend substantially on model interpretation. |
| Existing Chrome profile relay, dedicated CDP profile and reconnection paths | [Background][L4], [Chrome adapter][L5] | Present. Shared profile reuse is not independent cookie/account isolation. |
| MCP client connections, paginated tool discovery and lazy tool search | [MCP clients][L7], [Agent runner][L1] | Present. Integrated OAuth, resources/prompts and richer lifecycle support were not found in reviewed code. |
| Bounded document reading and local folder access | [File reader][L8] | Present. PDF text extraction does not supply OCR. |
| Hover, keyboard, waits, uploads, dialogs, accessibility snapshots and CAPTCHA handoff | [MCP catalogue][L6] | Many exist in the external MCP path but are absent from the sidebar's built-in model tool catalogue. |
| Model-routing and reusable-skill modules | [Models module][L9], [Skills module][L10] | Empty placeholders in the reviewed snapshot. |

The local checkout changed during research. The snapshot used for this report already preserves completed tool results when queued work is canceled; the earlier conversation's cancellation diagnosis is therefore superseded. The remaining recovery proposals concern durable execution, partial-progress persistence and reconciliation. The sidebar snapshot still assigns a generic `Finished` label in its final cleanup, including after error/stop paths.

**Reading the backlog**

- P0: first implementation batch; P1: next capability/reliability work; P2: later or conditional work.
- Add: not found in the reviewed implementation. Extend: an existing capability needs a concrete extension. Optional: an architectural alternative, not a mandatory dependency.
- Source links identify real upstream patterns. Acceptance criteria below define our proposed behavior.

**A. Agent execution and recovery**

| # | Priority / status | Concrete improvement | Evidence |
|---|---|---|---|
| 1 | P0 · Add | Move task execution out of the sidebar page into a durable service. Give each run an ID, persisted status and reconnectable event stream so closing the UI does not own the run's lifetime. | [Codex app-server][C1]; local loop lives in [sidebar runner][L1]. |
| 2 | P0 · Extend | Persist an action ledger as each tool settles: proposed, approved, started, completed, failed, skipped or outcome unknown. Preserve partial progress before an entire parallel batch finishes. | [Codex lifecycle][C1], [browser-use history][U1]; existing checkpoints are in [runner][L1]. |
| 3 | P0 · Add | Resume by reconciling live tabs, document state and earlier action results. Rebind targets and check uncertain submissions before allowing a retry. Never promise exactly-once execution on third-party sites. | [Codex resume][C1], [agent-browser sessions][B3]; [local chat persistence][L3]. |
| 4 | P1 · Add | Accept user corrections while a run is active. Queue or deliver steering at a safe boundary; distinguish changing the task from canceling it. | [Codex turn/steer][C1]; [sidebar][L3] currently rejects another submission while busy. |
| 5 | P1 · Add | Fork a task from an earlier checkpoint to compare another strategy while keeping its history and provenance. Fork conversation state; do not describe it as undoing browser side effects. | [Codex thread/fork][C1], [Claude checkpoint boundaries][A6]. |
| 6 | P0 · Extend | Add elapsed-time, token and optional monetary budgets, plus repeated-error/no-progress detection. Stop with an explicit reason and a recoverable checkpoint rather than only exhausting tool rounds. | [Codex budget implementation][C2], [browser-use failure limits][U1]; [local round limits][L1]. |
| 7 | P0 · Extend | Require evidence for completion: verified fields, confirmation text, output records or a completed download. A model-written status must not alone establish success. | [browser-use completion judge][U2]; local [record_result][L1] validates shape but accepts model status. |
| 8 | P1 · Add | Separate worker tasks for independent research tabs, with bounded budgets and explicit ownership. Parallel tool calls already exist; workers would add separate context and accountable subtasks. | [Claude subagents][A3]; [local scheduler][L1]. |

Acceptance: close/reopen the sidebar during a read; disconnect after a submit click; stop after one successful action in a batch; send a correction mid-run. The system must show accurate run states, retain known outcomes and avoid automatically repeating uncertain writes.

**B. Browser targeting and observation**

| # | Priority / status | Concrete improvement | Evidence |
|---|---|---|---|
| 9 | P0 · Add | Return short actionable element references from observations and accept them in click/fill tools. Keep selectors as a compatibility path. | [agent-browser refs][B1]; [local sidebar targets][L4] use CSS strings. |
| 10 | P0 · Add | Bind references to tab, frame and document generation. Invalidate replaced nodes and navigated documents; reject stale references instead of matching a new element at the same position. | [agent-browser ref lifecycle][B1]; [local inspection][L4] builds positional selectors. |
| 11 | P1 · Add | Provide targeting by accessible role/name, label, placeholder and visible text, with strict ambiguity handling. | [agent-browser commands][B5], [Playwright locators][P2]. |
| 12 | P0 · Extend | Automatically wait for a unique, visible, stable, enabled and unobstructed target; return the blocking condition on timeout. The sidebar currently checks several conditions once. | [Playwright actionability][P3]; [local actions][L4]. |
| 13 | P0 · Extend | Add browser mouse and keyboard events to the sidebar action path, with explicit handling for hover, typing sequences, key combinations and custom widgets. | [DevTools tools][D1]; sidebar [actions][L4] use `element.click()` and synthetic input/change events. |
| 14 | P1 · Extend | Normalize nested frame/shadow targeting and explain inaccessible contexts. Offer a supported deeper-targeting backend rather than claiming that every closed shadow root is available. | [Stagehand deep targeting][S1], [agent-browser iframe limitations][B1]; [local frame support][L4]. |
| 15 | P1 · Add | Offer vision only when useful: annotated screenshots with references and a controlled coordinate fallback for unlabeled icons/canvas UI. | [agent-browser annotated screenshots][B1], [browser-use vision mode][U1]; screenshots exist in [MCP][L6] but not the built-in sidebar catalogue. |
| 16 | P0 · Extend | Add section-scoped inspection, interactive-only mode, configurable limits and continuation cursors. Detect truncation and let the agent retrieve omitted controls. | [agent-browser snapshot filters][B1], [Stagehand trimming][S6]; [local read_page][L4] caps text and controls. |

Acceptance: targets survive harmless same-document changes, fail safely after replacement/navigation, and work on delayed forms, overlays, custom comboboxes and nested frame fixtures. Truncated pages must expose a retrieval path.

**C. Efficiency, models and structured output**

| # | Priority / status | Concrete improvement | Evidence |
|---|---|---|---|
| 17 | P1 · Add | Return page deltas after actions, with an explicit baseline ID and full-snapshot fallback, instead of repeatedly sending unchanged page content. | [agent-browser diffing][B4]; [local action snapshots][L4]. |
| 18 | P1 · Add | Split action discovery from execution: observe a candidate, validate it, then execute a concrete action. Re-infer only if its target contract fails. | [Stagehand observe][S2], [act][S1]. |
| 19 | P1 · Add | Cache validated action recipes for repeated workflows, keyed by page structure and relevant inputs. Recheck preconditions and never treat a cached prior success as proof of a new submission. | [Stagehand caching][S4]. Current v4 built-in caching requires Browserbase; local caching would be our implementation. |
| 20 | P0 · Extend | Add schema-validated research and task results with explicit unknown values, provenance and validation errors. Preserve current result cards as the UI. | [Stagehand extract][S3], [browser-use structured output][U1]; [local result schema][L1]. |
| 21 | P1 · Extend | Make concurrency responsive to provider limits, tab ownership and observed latency. Keep same-tab ordering and user-configured ceilings; reduce concurrency after throttling. | [Stagehand multiple tabs][S7], [OpenCode retries][O4]; [local scheduler][L1] already permits bounded parallel calls. |
| 22 | P1 · Add | Implement native provider adapters and a capability matrix for tools, streaming, images, structured output, context and reasoning options. Avoid treating every endpoint as identical chat-completions. | [OpenCode providers][O1]; [local model module][L9] is empty and [runner][L1] uses chat-completions. |
| 23 | P1 · Extend | Track actual input/output/cache token usage per request, tool latency, and task totals. Display estimated cost only when a known price configuration exists. | [browser-use monitoring][U3], [Claude costs][A7]; [local context meter][L2] is not a task cost ledger. |
| 24 | P1 · Extend | Add provider-aware backoff with jitter and supported Retry-After forms, plus an explicitly configured fallback model. Retry inference failures separately from uncertain browser/MCP writes. | [OpenCode retry source][O4], [browser-use fallback][U1]; [local HTTP retry][L1] already handles selected status codes. |

Acceptance: compare baseline and new implementations on the same task set, including failed runs. Report completion rate, model calls, actual tokens, latency and retries. Do not import upstream speedup claims as OmniBrowser results.

**D. Skills, memory and integrations**

| # | Priority / status | Concrete improvement | Evidence |
|---|---|---|---|
| 25 | P1 · Add | Implement reusable `SKILL.md` workflows for research, document mapping, applications and website checks, with declared inputs, tools and verification requirements. | [Claude skills][A2], [OpenCode skills][O5]; [local skill module][L10] is empty. |
| 26 | P1 · Extend | Load skill/tool descriptions first and full instructions only when selected. Extend existing lazy MCP search with categories, relevance and predictable invocation. | [Claude skills][A2], [Claude MCP discovery][A5]; [local mcp_search][L1] is present. |
| 27 | P0 · Add | Introduce deterministic lifecycle hooks around tool execution, errors, compaction and completion. Use them for validation, checkpointing, policy and audit events. | [Claude hooks][A1]; [local events][L1] currently primarily drive UI and history. |
| 28 | P1 · Add | Support user-authored global, workspace and site rules, with visible precedence and clear separation from webpage text. Rules guide the model; tool policy enforces access. | [Claude memory/rules][A4], [Codex instruction source][C4]. |
| 29 | P1 · Add | Add editable persistent memory for approved preferences and recurring task facts. Expose where each memory came from, its scope, and deletion controls. | [Claude auto memory][A4]; [local chats][L3] save transcripts rather than a governed fact store. |
| 30 | P1 · Extend | Preserve exact facts, permissions, unresolved errors and source pointers independently of prose compaction. Prune superseded observations before summarizing task state. | [OpenCode compaction source][O3]; [local compaction][L2] already archives originals. |
| 31 | P1 · Extend | Add MCP OAuth login/status, resources and prompts, refreshable catalogues and clearer per-server availability. Keep unknown-outcome writes out of automatic replay. | [Claude MCP][A5]; [local MCP client][L7] currently concentrates on tools and configured credentials. |
| 32 | P2 · Optional | Add a selectable Codex app-server engine or a supported Claude Agent SDK engine behind our browser tools. Prototype one engine against the same task suite before deciding on migration. | [Codex harness integration][C3], [Claude Agent SDK][A9]. This supplements or replaces the loop, not the browser transport. |

Acceptance: a selected skill uses only authorized tools, rule precedence is inspectable, memory can be edited/deleted, compaction preserves exact cited facts, and an authenticated MCP server reports its actual connection state.

**E. Permissions, data and human control**

| # | Priority / status | Concrete improvement | Evidence |
|---|---|---|---|
| 33 | P0 · Extend | Replace the coarse ask/full choice with enforceable allow/ask/deny policies by tool, action, domain, folder and MCP server. Enforce at the execution boundary rather than relying only on a prompt. | [OpenCode permissions][O2], [agent-browser policy][B2]; [local approvals][L3]. |
| 34 | P0 · Extend | Grant access for a specific task/site and expire or revoke it visibly. Separate browser grants from folder grants and avoid repeatedly asking for already scoped actions. | [Claude permissions][A10], [OpenCode permissions][O2]; [local access mode][L3] spans browser and files. |
| 35 | P1 · Add | Add a true read-only research mode that disables browser writes, including through external MCP tools. Explain unsupported/unknown tool classifications. | [Claude subagent tool scopes][A3], [OpenCode agents][O6]; local browser toggle is all tools on/off. |
| 36 | P0 · Extend | Mark webpage/document/tool content as untrusted structured observations and keep host metadata, user authorization and action policy separate. Add adversarial cases to verify the separation. | [agent-browser content boundaries][B2]; [local prompt][L1] already states an untrusted-data rule. |
| 37 | P0 · Add | Redact configured secrets and sensitive fields before provider requests, saved transcripts and diagnostic exports. Apply redaction consistently across paths, not only the UI. | [agent-browser security][B2], [Claude redaction fixes][A8]; local field filtering omits some sensitive controls but is not general redaction. |
| 38 | P2 · Optional | Add an OS-backed secret vault and credential handles for authorized login workflows, with origin checks and no model-visible password. Keep manual login available. | [agent-browser vault][B2], [Stagehand observe example][S6]. Would be a deliberate expansion of our current password-entry limitation. |
| 39 | P0 · Extend | Present consequential actions with destination, affected records, actual field values and sources. After execution, show confirmed, failed or unknown outcome. Do not describe restoring a draft as undoing a submission. | [Stagehand form approval][S8], [Claude rewind limits][A6]; [local approval strings][L3] mostly show tool names/selectors. |
| 40 | P1 · Extend | Make account/profile boundaries explicit: identify the controlled profile and tabs, offer dedicated contexts for isolation, and release owned tabs cleanly. Do not impose a claimed whole-browser network sandbox on a shared everyday profile. | [agent-browser session limitations][B3], [Playwright profile modes][P1]; [local profile reuse][L4]. |

Acceptance: scoped grants survive only their intended task; denied tools cannot run via another route; malicious page text cannot grant access; secrets are absent from provider payloads and exported traces; ambiguous submission outcomes stay unknown.

**F. Missing tools and outputs**

| # | Priority / status | Concrete improvement | Evidence |
|---|---|---|---|
| 41 | P0 · Extend | Bring existing MCP capabilities into the sidebar: keyboard, hover, explicit waits, dialogs, screenshots, uploads and CAPTCHA handoff. Expose a capability catalogue so models know which route supports which action. | [Playwright MCP catalogue][P1], [local MCP tools][L6], [sidebar catalogue][L1]. |
| 42 | P1 · Add | Add download initiation, progress/completion tracking, destination validation and bounded access to downloaded results. Completion must depend on the actual file outcome. | [agent-browser commands][B5], [Playwright MCP output support][P1]. |
| 43 | P1 · Extend | Support prompt attachments and optional OCR for scanned files, preserving filename/page provenance. Keep extraction limits and enabled-folder boundaries. | [Codex input items][C1]; [local file extraction][L8] supports text documents, not OCR. |
| 44 | P1 · Extend | Add direct research search/fetch tools returning source URLs and scoped readable content, while retaining live-tab reads for authenticated or dynamic pages. | [Stagehand search/fetch][S6], [agent-browser read][B5]; local search currently opens a browser search page. |
| 45 | P1 · Add | Export verified task results as JSON, CSV and a readable report, including sources and unknown/blocked statuses. Treat generated files as task artifacts with retention controls. | [browser-use structured history][U1], [Stagehand extract][S3]; [local result cards][L3] have no task-export workflow. |
| 46 | P1 · Extend | Add scoped console and network diagnostics with bounded event buffers. The Python CDP client needs a receive loop that dispatches events separately from command responses. | [DevTools diagnostic tools][D1]; [local CDP receive loop][L5] ignores unrelated protocol messages, while the extension has a limited console buffer. |
| 47 | P2 · Add | Offer optional screenshots, video/trace artifacts and performance analysis for debugging browser tasks. Capture only the task's scope with bounded retention. | [DevTools performance tools][D1], [agent-browser commands][B5]. |
| 48 | P2 · Add | Detect and expose site-provided WebMCP tools as an experimental capability. Apply host permissions and origin scope regardless of page-provided tool annotations. | [agent-browser WebMCP][B6], [Playwright WebMCP configuration][P1]. Page registration is not a grant of trust. |

Acceptance: sidebar and external-client tool capabilities are explicit; uploads/downloads obey filesystem scope; outputs have provenance; diagnostic tools see real events; unavailable capabilities fail with useful recovery instructions.

**G. Validation, release quality and usability**

| # | Priority / status | Concrete improvement | Evidence |
|---|---|---|---|
| 49 | P0 · Extend | Add task fixtures for delayed forms, overlays, custom widgets, nested frames, shadow roots and ambiguous confirmation. Assert final observable outcomes, not only tool invocation. | [Stagehand eval harness][S5]; local [live browser test][L11] is a useful existing foundation. |
| 50 | P0 · Add | Build a repeatable agent evaluation suite with fixed tasks and recorded success criteria. Compare models and runtime strategies on success, interventions, time and actual tokens. | [Stagehand evals][S5], [agent-browser evals][B7]. |
| 51 | P0 · Extend | Fault-test stops, reloads, bridge disconnects, provider throttling, partial streams and unknown-outcome actions. Include Windows-specific lifecycle cases. | [Claude changelog][A8], [OpenCode retry implementation][O4]; local unit tests need service-level recovery coverage for the proposed runtime. |
| 52 | P0 · Add | Add adversarial tests where page/document/MCP output asks for unrelated navigation, file reads or submissions. Test policy enforcement and disclosure boundaries. | [agent-browser threat model][B2], [Claude hook controls][A1]. |
| 53 | P1 · Extend | Export a redacted reproducible diagnostic bundle: run ID, versions, model/provider, selected observations, tool inputs/outcomes and timestamps. Omit unnecessary personal browser activity. | [browser-use monitoring][U3], [DevTools tools][D1]; existing activity rows are not a reproducibility bundle. |
| 54 | P1 · Add | Add automated release checks for Python and extension code plus disposable browser integration. Establish latency/token baselines and require evidence before publishing improvement claims. | [agent-browser evaluation harness][B7], [Stagehand eval harness][S5]. No `.github` CI directory was present in the reviewed checkout. |
| 55 | P0 · Extend | Show accurate running, waiting, stopped, failed, completed and outcome-unknown states. Offer resume/retry/take-over controls tied to run state, not generic chat text. | [Codex lifecycle statuses][C1], [browser-use pause/resume][U1]; [sidebar cleanup][L3] currently sets `Finished` generically. |
| 56 | P1 · Extend | Add a connection/setup health check and generate the README capability matrix from current tool registrations. Diagnose model/tool support, bridge status, protected pages and document dependencies. | [agent-browser doctor implementation][B8], [local catalogues][L1], [MCP client][L7]. Current README contains older limits than the code. |

Acceptance: CI runs deterministic checks without a paid model dependency; optional agent evaluations report their cost; a failed task is never labeled completed; support bundles are redacted; setup diagnostics correspond to the installed build.

**Recommended first implementation batch**

1. Implement run state and an action ledger before adding automatic resume: items 1–3 and 55.
2. Implement element references, invalidation and readiness: items 9, 10, 12, 13 and 16.
3. Implement completion evidence, structured results and enforceable scoped policy: items 7, 20, 27, 33, 34 and 39.
4. Expose existing tools in the sidebar: item 41.
5. Establish fixtures, fault tests, injection tests and the evaluation baseline: items 49–52.

Dependencies matter: resume without an action ledger risks duplicate side effects; caching without target invalidation replays stale actions; extra workers without tab ownership and shared budgets create conflicts. These are design conclusions from the comparison, not published upstream performance results.

**Architecture choice to test separately**

Keep browser transport behind one interface. Allow a generic provider loop and, optionally, a Codex app-server or Claude Agent SDK adapter to use that interface. OmniBrowser should own browser/profile scope, action policy, source provenance, output files and the user-facing task view. A selected runtime may own conversation lifecycle, tool dispatch and compaction. Choose using evaluation results rather than assuming a coding-agent runtime is automatically better at browser tasks. [Codex integration guide][C3], [Claude Agent SDK][A9].

Stagehand v4's managed cache has no effect on local-browser calls; do not use the older v3 local-cache instructions as the current integration contract. [Current caching docs][S4]. Likewise, Claude's rewind does not undo third-party website operations. [Checkpoint limitations][A6]. Existing-profile tab separation does not create independent cookies or storage. [Session isolation][B3].

**Sources and local evidence**

[C1]: https://learn.chatgpt.com/docs/app-server
[C2]: https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/core/src/agent/control/budget.rs
[C3]: https://developers.openai.com/blog/codex-as-a-platform
[C4]: https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/core/src/agents_md.rs
[A1]: https://code.claude.com/docs/en/hooks
[A2]: https://code.claude.com/docs/en/skills
[A3]: https://code.claude.com/docs/en/sub-agents
[A4]: https://code.claude.com/docs/en/memory
[A5]: https://code.claude.com/docs/en/mcp
[A6]: https://code.claude.com/docs/en/checkpointing
[A7]: https://code.claude.com/docs/en/costs
[A8]: https://github.com/anthropics/claude-code/blob/2301018b1f61073c501a8e7a4813ef48c239163b/CHANGELOG.md
[A9]: https://code.claude.com/docs/en/agent-sdk/overview
[A10]: https://code.claude.com/docs/en/permissions
[B1]: https://agent-browser.dev/snapshots
[B2]: https://agent-browser.dev/security
[B3]: https://agent-browser.dev/sessions
[B4]: https://agent-browser.dev/diffing
[B5]: https://agent-browser.dev/commands
[B6]: https://agent-browser.dev/webmcp
[B7]: https://github.com/vercel-labs/agent-browser/blob/44af39842650f0bb9c1afb7354df9a82921d4f09/evals/README.md
[B8]: https://github.com/vercel-labs/agent-browser/blob/44af39842650f0bb9c1afb7354df9a82921d4f09/cli/src/doctor/security.rs
[P1]: https://github.com/microsoft/playwright-mcp/blob/b8b4183e099f136cbec0388a6088d4aa2f6b9685/README.md
[P2]: https://playwright.dev/docs/locators
[P3]: https://playwright.dev/docs/actionability
[U1]: https://github.com/browser-use/browser-use/blob/c75e8476e26d18b7617643bc2ae082fae8eae431/skills/open-source/references/agent.md
[U2]: https://github.com/browser-use/browser-use/blob/c75e8476e26d18b7617643bc2ae082fae8eae431/browser_use/agent/judge.py
[U3]: https://github.com/browser-use/browser-use/blob/c75e8476e26d18b7617643bc2ae082fae8eae431/skills/open-source/references/monitoring.md
[S1]: https://docs.stagehand.dev/v4/basics/act
[S2]: https://docs.stagehand.dev/v4/basics/observe
[S3]: https://docs.stagehand.dev/v4/basics/extract
[S4]: https://docs.stagehand.dev/v4/best-practices/caching
[S5]: https://github.com/browserbase/stagehand/blob/1fc884992b68a0196ea5c6e96cc29924b0922ef4/packages/evals/README.md
[S6]: https://github.com/browserbase/stagehand/blob/1fc884992b68a0196ea5c6e96cc29924b0922ef4/README.md
[S7]: https://docs.stagehand.dev/v4/best-practices/using-multiple-tabs
[S8]: https://docs.stagehand.dev/v4/cookbooks/approve-form-submission
[D1]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/f08dbe152502d66e75fa07fb2588dc0feb42bc20/docs/tool-reference.md
[O1]: https://opencode.ai/docs/providers/
[O2]: https://opencode.ai/docs/permissions/
[O3]: https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/opencode/src/session/compaction.ts
[O4]: https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/opencode/src/session/retry.ts
[O5]: https://opencode.ai/docs/skills/
[O6]: https://opencode.ai/docs/agents/
[L1]: <G:/AI/ai/Super Browser/extensions/chrome/sidebar-agent.js>
[L2]: <G:/AI/ai/Super Browser/extensions/chrome/sidebar-context.js>
[L3]: <G:/AI/ai/Super Browser/extensions/chrome/sidepanel.js>
[L4]: <G:/AI/ai/Super Browser/extensions/chrome/background.js>
[L5]: <G:/AI/ai/Super Browser/src/omnibrowser/adapters/chrome.py>
[L6]: <G:/AI/ai/Super Browser/src/omnibrowser/mcp/server.py>
[L7]: <G:/AI/ai/Super Browser/src/omnibrowser/sidebar_mcp.py>
[L8]: <G:/AI/ai/Super Browser/src/omnibrowser/files.py>
[L9]: <G:/AI/ai/Super Browser/src/omnibrowser/models/__init__.py>
[L10]: <G:/AI/ai/Super Browser/src/omnibrowser/skills/__init__.py>
[L11]: <G:/AI/ai/Super Browser/tests/test_browser_live.py>
