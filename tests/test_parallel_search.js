const assert = require('node:assert/strict');
const {call, readReply, endpoint} = require('../extensions/chrome/parallel-search.js');
const config = require('../extensions/chrome/vendor/parallel-search/mcp.json');
const jsonResponse = (id, result, headers = {}) => new Response(JSON.stringify({jsonrpc:'2.0', id, result}),
  {headers: {'Content-Type':'application/json', ...headers}});
(async () => {
  assert.equal(endpoint, config.mcpServers['parallel-search'].url);
  const requests = [];
  const result = await call('web_search', {objective:'games', search_queries:['digital goods']}, {
    fetchImpl: async (url, options) => {
      assert.equal(url, endpoint);
      assert.equal(options.credentials, 'omit');
      const body = JSON.parse(options.body); requests.push(body);
      if (body.method === 'initialize') return jsonResponse(body.id, {protocolVersion:'2025-03-26'}, {'Mcp-Session-Id':'test-session'});
      assert.equal(options.headers['Mcp-Session-Id'], 'test-session');
      if (body.method === 'notifications/initialized') return new Response(null, {status:202});
      assert.deepEqual(body.params.arguments, {objective:'games', search_queries:['digital goods']});
      return jsonResponse(body.id, {content:[{type:'text',text:JSON.stringify({results:[{url:'https://example.com/goods'}]})}]});
    }
  });
  assert.equal(requests.length, 3);
  assert.deepEqual(result.sources, ['https://example.com/goods']);
  assert.equal(result.provider, 'Parallel Search');
  const sse = new Response('data: {"method":"notifications/progress"}\r\n\r\ndata: {"id":3,"result":{"content":[]}}\r\n\r\n', {headers:{'Content-Type':'text/event-stream'}});
  assert.deepEqual((await readReply(sse, 3)).result, {content:[]});
  await assert.rejects(call('web_search', {}, {fetchImpl: async () => new Response(null,{status:429})}), /rate limit/);
  await assert.rejects(call('web_search', {}, {timeoutMs:10, fetchImpl: async (_, options) =>
    new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))))}), /timed out/);
  await assert.rejects(call('delete', {}), /Unsupported/);
  console.log('Parallel direct MCP: initialization, sessions, JSON/SSE, sources, rate limits and deadline passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
