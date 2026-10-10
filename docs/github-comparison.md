# GitHub comparison and improvement priorities

Reviewed 10 October 2026 against the repositories' published documentation.
This is a capability comparison, not a measured speed or reliability benchmark.
Repository default branches change; these links are not pinned revisions.

## Closest projects

| Project | Relevant capabilities in its documentation | Implication for OmniBrowser |
| --- | --- | --- |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | Accessibility snapshots, referenced targets, several browser engines, profile/configuration options, console output | Improve semantic inspection now; referenced actions and multiple browsers remain gaps |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md) | Hover, dialogs, history/reload, emulation, console/network inspection and performance tracing | Add everyday browser controls now; diagnostics need a dedicated event collection design |
| [Browser Use](https://github.com/browser-use/browser-use) | Python agent loop, model integrations, local/cloud browser access | Useful direction if OmniBrowser later runs agents itself; its existing MCP clients already supply the reasoning loop |

OmniBrowser's current strengths are direct CDP attachment to existing Chrome
sessions, cached connections, batched DOM actions, bounded local document access,
and the file-to-form inspection/verification workflow. These are implemented
capabilities, not claims of superiority over the compared projects.

## Implemented in this comparison pass

| Addition | Benefit | Current scope |
| --- | --- | --- |
| `page_snapshot` | Agents can inspect roles, accessible names, hierarchy and states | Main-frame computed Chrome accessibility tree; bounded response, omitted raw values; diagnostic IDs only |
| `history_navigate` | Return to previous steps or advance through tab history | One entry at a time; reports boundaries; caller verifies destination |
| `reload` | Retry a page with optional cache bypass | Initiates reload; caller waits for a meaningful element |
| `hover` | Open hover-driven menus and tooltips | CSS selector, native mouse movement, shared visibility/coverage checks with click |
| `viewport_set` | Check responsive desktop layouts | Desktop CSS dimensions and reset; connection-scoped, no mobile/touch emulation |
| `handle_dialog` | Accept/dismiss JavaScript dialogs or answer prompts | An already-open dialog; explicit acceptance, dismissal by default |

No new runtime dependency is required. Regression coverage includes snapshot
hierarchy/truncation, argument validation, and disposable real-Chrome checks for
roles, password value omission, hover effects, viewport changes, history, prompt
handling, and reload.

## Remaining priorities

1. **Referenced actions and richer targeting:** let agents act directly on
   snapshot nodes, reject stale references, and support frame/shadow-root contexts.
   Currently agents still locate actionable elements with CSS selectors.
2. **Console and network diagnostics:** a continuous CDP receive loop with bounded
   per-tab event buffers, filtering, reconnect handling and explicit capture scope.
   The current command/response loop discards events; adding list tools alone
   would produce incomplete diagnostics.
3. **Downloads and browser output:** bounded download destinations, completion
   tracking, full-page captures and PDF output with existing file-access rules.
4. **Connection/configuration improvements:** named instance configuration,
   reconnect behavior and an actual extension relay. The native host currently
   offers a handshake, not an automation transport.
5. **Broader automation:** multi-browser adapters, workflow recording/replay,
   performance tracing and stronger readiness checks. Model orchestration should
   be a separate optional layer if users need it.

The six additions close practical gaps while retaining the current Chrome/MCP
architecture. They do not establish full feature parity with these projects.
