# Context and connected tools

The earlier sidebar condensed history after 120,000 serialized characters,
regardless of model capacity. This could happen within a short browser task;
it was a size threshold, not a timer. It truncated user and assistant messages,
and a provider error could lower the threshold to 40,000 characters.

## Context management

In AI settings, **Model context window (tokens)** overrides automatic metadata
detection. Model lists that expose context or input limits (including
`context_length`, `context_window`, `max_context_length`, `inputTokenLimit`,
or `top_provider.context_length`) supply the limit. Output limits are never
treated as context limits. If metadata is absent, recognized Gemini aliases
use their published 1,048,576-token input window. Antigravity-owned models also
use the exact limits in its published model catalog, checked on 2026-10-10:
[Antigravity model catalog](https://github.com/lbjlaq/Antigravity-Manager/blob/main/src-tauri/resources/official_models.json).
The proxy's OpenAI model-list endpoint currently exposes IDs and ownership
without context metadata. Unknown models still fall back to 128,000 tokens.
Provider metadata and manual overrides take priority over the catalog, so a
model is not universally capped at one million tokens. Enter the limit supported
by your provider and account if it differs from the published maximum.

The selected model's detected limit survives reopening the sidebar, even if
model discovery fails. Changing the API URL or key clears cached metadata.
Hover over the context indicator to see the exact token limit and its source
(provider, published model limit, manual setting, or default fallback).

The context indicator shows input usage against that window. Token estimates
use serialized UTF-8 size until the provider supplies prompt usage; estimates
are marked `~`. Output space and a safety margin are reserved. This is an
approximation, not a provider tokenizer or a guarantee of maximum output size.

Older tool results longer than 12,000 characters are paged before each request,
while the four newest tool results remain in full. This reduces accumulation
without generating extra summaries. Near the input budget, large observations
are paged further. The model can recover
their complete text through `context_read`, using the archive index and character
offset. If more space is needed, the configured model creates a checkpoint of
older, complete exchanges. It preserves goals, corrections, permissions,
constraints, important values and paths, failures, verified actions and next
steps. The latest user request stays verbatim, including its original browser
tab. Summaries are inherently lossy; the full original messages remain available.

The saved transcript remains separate from the working context. Checkpoints and
retrieval references are saved with the chat when **Save chat history** is on.
Chrome's unlimited local storage permission prevents its ordinary storage quota
from forcing transcript truncation; disk space and the existing 50-chat retention
policy still apply. With history saving off, closing the sidebar discards the
in-memory conversation. A failed summary leaves original messages intact.

Disable **Create checkpoints near the context limit** to stop with a clear
message when the budget is reached. Verified provider context errors get one
recovery attempt only when compaction actually reduces the payload. Unrelated
HTTP 400 errors do not trigger compaction. Temporary rate-limit/server errors get
two bounded retries; completed tools are not replayed by the client. Stopping a
run drains active tools and checkpoints completed results before reporting stop.

## MCP connections

Reload the extension and reconnect its installed native bridge after updating.
In AI settings, expand **Connected tools (MCP)**, add a preset or paste a
`mcpServers` JSON configuration, and click **Connect servers**. Each server has
its own status. Tool schemas load on demand through `mcp_search`. Connections
remain alive across model rounds, checkpoints and prompts; configuration changes
or **Disconnect** close them. A failed server does not hide healthy servers.

Supported transports are local processes (`command`, `args`, optional `env` and
`cwd`), Streamable HTTP (`url`, optional `headers`), and legacy SSE (`type: "sse"`).
Remote endpoints require HTTPS; localhost may use HTTP. OAuth sign-in is not
implemented; use the server's anonymous endpoint or configured authentication
headers/environment. Settings, including credentials, stay in Chrome's session
storage and clear when Chrome closes. They are not saved with chats or sent as
configuration to the model. Only sidebar settings can configure a process.

The built-in `search_web` and `fetch_web` tools automatically connect to the public
Parallel Search MCP through the installed native helper. Research runs entirely
in the background, with concurrent requests sharing a persistent connection.
No tab is opened or navigated, including when the service is unavailable.
Each chat supplies its own research session ID. Public source reading returns
relevant excerpts; tasks needing login, interaction or forms use browser tools.
An authenticated Parallel connection configured below is reused when available.

**Add web search** uses the public [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
endpoint, which supports anonymous searches with lower limits. Its preset marks
`web_search` and `web_fetch` as independent reads. Add an Authorization header
if you want to use your own account. Anonymous availability and limits are
controlled by the service.

**Add Scrapling** runs `scrapling mcp`. Install
[Scrapling with MCP support](https://github.com/D4Vinci/Scrapling/blob/main/docs/ai/mcp-server.md)
in your chosen Python environment first:

```powershell
python -m pip install "scrapling[ai]"
scrapling install
```

Use the full executable path in `command` when Chrome's bridge cannot find it
on PATH. Browser-based scraping needs Scrapling's browser dependencies; basic
HTTP scraping uses its HTTP client. Server tools are discovered dynamically,
so the integration does not assume a particular version's tool names or schemas.

Independent read-only MCP tools use the sidebar's concurrency limit (4–16;
default 12). Unannotated or mutating tools serialize per server. Calls sharing
a session ID serialize by default, suitable for Scrapling browser sessions.
`readOnlyTools` can explicitly mark trusted tool names as independent reads;
`sessionTools` can restrict which tools need session ordering. The Parallel
preset uses `sessionTools: []` because its ID is for correlation rather than
shared browser state. Browser operations on the same tab still preserve order.
The existing **Ask for approval / Full access** setting applies to external calls.

Example:

```json
{
  "mcpServers": {
    "Parallel Search": {
      "url": "https://search.parallel.ai/mcp",
      "readOnlyTools": ["web_search", "web_fetch"],
      "sessionTools": []
    },
    "Scrapling": {
      "command": "C:\\path\\to\\venv\\Scripts\\scrapling.exe",
      "args": ["mcp"]
    }
  }
}
```

## Reference and validation

The implementation follows published patterns in
[Claude Code's repository](https://github.com/anthropics/claude-code),
[context documentation](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up),
and [MCP tool search documentation](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search).
This does not claim equivalent reliability or copy a complete internal runtime.

Regression checks cover large context below the previous cap, recoverable
observations, summary failure, chat restoration, model metadata, deferred tool
discovery, concurrency, session ordering, cancellation, real stdio/HTTP MCP
sessions, failing server isolation, and Chrome settings. Local fixtures do not
need paid APIs. An anonymous Parallel MCP connection, concurrent searches and source reading were also
verified on 10 October 2026; no Scrapling installation or live scraping was
performed as part of that verification.
