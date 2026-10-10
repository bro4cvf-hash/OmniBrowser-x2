# Reused browser automation source

OmniBrowser retains its project license. These attributed source adaptations have
their respective upstream licenses; retain these files with distributions.

* `kernels.js`: `snapshot_comparison_text` port from
  vercel-labs/agent-browser `44af39842650f0bb9c1afb7354df9a82921d4f09`,
  `cli/src/native/diff.rs`, Apache-2.0 (`LICENSE-agent-browser`). Rust iteration
  changed to JavaScript indexing; CommonJS/browser exports added.
* `kernels.js`: `normalizeCachedActions` from browserbase/stagehand
  `f261c38b4dc50c39485f924e8599c1d3c6e37dc7`,
  `packages/extension/services/cacheService.ts`, MIT (`LICENSE-stagehand`).
  Copyright (c) 2024 Browserbase Inc. TypeScript annotations removed; exports added.
* `browser-diagnostics.js` and Python `diagnostics.py`: raw CDP adaptations of the
  bounded navigation-aware collection design in ChromeDevTools/chrome-devtools-mcp
  `f08dbe152502d66e75fa07fb2588dc0feb42bc20`, `src/collectors/PageCollector.ts`.
  Copyright 2025 Google LLC. Apache-2.0 (`LICENSE-devtools`). Puppeteer-specific
  listeners replaced with plain event records; query strings, bodies and headers omitted.

Source URLs, unmodified reference files and SHA-256 hashes are recorded in
`docs/upstream-browser-kit/manifest.json` in the project checkout. The reference
kit also includes Playwright's upstream NOTICE for its copied reference source.
No complete Playwright or Browser Use runtime module is vendored here.

`action-recipes.js` builds on the Stagehand normalizer with local storage and
live validation. Observation transport, asyncio response/event routing and
GUID download containment are OmniBrowser implementations informed by the
reviewed upstream contracts. They do not include upstream services or credentials.
