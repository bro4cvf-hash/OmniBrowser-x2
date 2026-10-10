/* OmniBrowser adapter for parallel-web/search-mcp's hosted Streamable HTTP service. */
(function(root) {
  const endpoint = 'https://search.parallel.ai/mcp';
  async function readReply(response, id) {
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const reply = await response.json();
      if (reply.id !== id) throw new Error('Background research returned an invalid response');
      return reply;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', size = 0;
    function parse(block) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      const reply = JSON.parse(data);
      if (reply.id === id && ('result' in reply || 'error' in reply)) return reply;
    }
    try {
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), {stream: !chunk.done});
        size += chunk.value?.length || 0;
        if (size > 800000) throw new Error('Background research response is too large');
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const reply = parse(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
          if (reply) return reply;
        }
        if (chunk.done) {
          const reply = parse(buffer);
          if (reply) return reply;
          throw new Error('Background research connection closed before results arrived');
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function call(name, args, {fetchImpl = fetch, timeoutMs = 25000, signal} = {}) {
    if (!['web_search', 'web_fetch'].includes(name)) throw new Error('Unsupported research tool');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    let session, version = '2025-03-26', counter = 0;
    async function rpc(method, params, notification = false) {
      const id = ++counter;
      const headers = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream'};
      if (session) headers['Mcp-Session-Id'] = session;
      if (method !== 'initialize') headers['MCP-Protocol-Version'] = version;
      const response = await fetchImpl(endpoint, {method: 'POST', headers,
        body: JSON.stringify({jsonrpc: '2.0', ...(notification ? {} : {id}), method, ...(params ? {params} : {})}),
        signal: controller.signal, credentials: 'omit', redirect: 'error'});
      if (!response.ok) throw new Error(response.status === 429
        ? 'Background research rate limit reached. Try again later.'
        : `Background research unavailable (HTTP ${response.status}).`);
      if (notification) { await response.body?.cancel(); return; }
      if (method === 'initialize') session = response.headers.get('mcp-session-id');
      const reply = await readReply(response, id);
      if (reply.error) throw new Error('Background research service rejected the request');
      return reply.result;
    }
    try {
      const init = await rpc('initialize', {protocolVersion: version, capabilities: {},
        clientInfo: {name: 'OmniBrowser', version: '0.1.0'}});
      version = init.protocolVersion;
      await rpc('notifications/initialized', undefined, true);
      const result = await rpc('tools/call', {name, arguments: args});
      if (!result || !Array.isArray(result.content)) throw new Error('Background research returned invalid tool results');
      const sources = new Set();
      for (const item of result.content) {
        if (item.type !== 'text') continue;
        try {
          const collect = value => {
            if (Array.isArray(value)) value.forEach(collect);
            else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
              if (['url', 'source_url'].includes(key) && typeof child === 'string' && /^https?:\/\//.test(child)) sources.add(child);
              else collect(child);
            }
          };
          collect(JSON.parse(item.text));
        } catch { /* Text excerpts need not be JSON. */ }
      }
      return {...result, ...(result.isError ? {error: 'Background research service reported a tool error'} : {}),
        mode: 'headless', provider: 'Parallel Search', sources: [...sources].slice(0, 100)};
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? 'Stopped' : 'Background research timed out after 25 seconds. Try again.');
      if (error instanceof TypeError) throw new Error('Background research could not connect. Check your network and retry.');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  const api = {endpoint, call, readReply};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmniParallelSearch = api;
})(globalThis);
