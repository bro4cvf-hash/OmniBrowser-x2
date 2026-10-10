Official configuration and MIT license copied from https://github.com/parallel-web/search-mcp
at commit ac8e207b9fb1d5febb95d95b90c3a107ebdbdcbc (2026-10-10).

The upstream repository distributes configuration, not the hosted search engine.
OmniBrowser's `parallel-search.js` is our adapter to that official endpoint.
The extension calls `web_search` and `web_fetch` directly over Streamable HTTP,
without the native Python bridge, API keys, or browser tabs. Each request has
a 25-second total deadline, including initialization and reading the response.
Hosted usage remains subject to Parallel's terms and anonymous rate limits.
