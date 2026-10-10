# OmniBrowser upstream source kit

Start with [the integration report](../github-code-reuse-2026-10-10.md).

This directory contains 36 unmodified source, test and license/notice files from six permissively licensed repositories at fixed Git commits. They are reference excerpts, not complete packages or runtime dependencies. Each original path, commit, URL and SHA-256 is recorded in [manifest.json](manifest.json). Repository release metadata and the local comparison's source hashes are included.

| Directory | Useful code |
| --- | --- |
| `vercel-labs--agent-browser` | Snapshot filtering, stable refs, snapshot differences and asynchronous CDP transport |
| `ChromeDevTools--chrome-devtools-mcp` | Navigation-aware console/network collectors, tool contracts and collector tests |
| `browser-use--browser-use` | Download tracking and tests, trace-based completion judge, session identity tests |
| `browserbase--stagehand` | Cache normalization/fallback, observation and action services, cache tests and evidence gates |
| `microsoft--playwright-mcp` | Source relocation note, package dependency pins and click regression examples |
| `microsoft--playwright` | Real extension relay model, accessibility generation/distillation and actionability engine |
| `adaptations` | Two dependency-free JavaScript adaptations with source attribution and regression checks |

Upstream `.ts`, `.rs` and `.py` files retain their dependencies. Use them with their complete upstream package or adapt selected logic to our extension/Python interfaces. The two small adaptations are runnable locally but are not connected to the product.

Verify the pinned source files or restore missing files:

```powershell
.omnibrowser-venv\Scripts\python.exe scripts/fetch-browser-source-kit.py
node docs/upstream-browser-kit/adaptations/test-reusable-kernels.cjs
```

The fetch script checks existing files offline, verifies downloaded files before saving them, and refuses to overwrite changed local source. Retain upstream licenses, copyright notices and applicable attribution when reusing code. See each repository's copied license and the integration report for boundaries.
