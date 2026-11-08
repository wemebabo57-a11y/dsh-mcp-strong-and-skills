import test from 'node:test';
import assert from 'node:assert/strict';
import { WEB_TOOL, WEB_SEARCH_LIMIT, clearWebCache, runWebTool } from '../src/web-tools.mjs';

function htmlResponse(html, { url = '', type = 'text/html; charset=utf-8' } = {}) {
  const response = new Response(html, { status: 200, headers: { 'content-type': type } });
  if (url) Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
}

const DDG = [
  '<html><body>',
  '<a class="result__a" href="https://example.com/alpha">Alpha <b>Guide</b></a>',
  '<a class="result__snippet" href="https://example.com/alpha">Alpha snippet &amp; more</a>',
  '<a class="result__a" href="https://example.org/beta">Beta</a>',
  '<a class="result__snippet" href="https://example.org/beta">Beta snippet</a>',
  '</body></html>',
].join('');

const PAGE = [
  '<html><head><title>Alpha Page</title>',
  '<meta name="description" content="Alpha desc">',
  '</head><body><h1>Alpha</h1>',
  '<p>Alpha body text with enough words to read back from the tool result.</p>',
  '<a href="https://example.com/next">Next</a>',
  '</body></html>',
].join('');

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  clearWebCache();
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    clearWebCache();
  }
}

test('strong_web search returns JSON ids and open follows the alias', async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' });
    if (String(url).includes('duckduckgo')) return htmlResponse(DDG);
    if (String(url).includes('example.com/alpha')) return htmlResponse(PAGE, { url: 'https://example.com/alpha' });
    return htmlResponse('<html><body>unknown</body></html>');
  }, async () => {
    const searched = await runWebTool({ action: 'search', query: 'alpha', limit: 1 });
    assert.equal(searched.action, 'search');
    assert.equal(searched.query, 'alpha');
    assert.equal(searched.results.length, 1);
    const first = searched.results[0];
    assert.equal(first.id, 'r1');
    assert.equal(first.url, 'https://example.com/alpha');
    assert.equal(first.domain, 'example.com');
    assert.equal(first.title, 'Alpha Guide');
    assert.equal(first.snippet, 'Alpha snippet & more');
    assert.match(searched.hint, /action=open/);
    assert.equal(calls[0].method, 'POST');

    const opened = await runWebTool({ action: 'open', target: 'r1', maxChars: 500 });
    assert.equal(opened.action, 'open');
    assert.equal(opened.url, 'https://example.com/alpha');
    assert.equal(opened.title, 'Alpha Page');
    assert.equal(opened.description, 'Alpha desc');
    assert.match(opened.text, /Alpha body text/);
    assert.ok(opened.text.length <= 500);
    assert.ok(opened.links.some(link => link.url === 'https://example.com/next'));
    assert.match(opened.hint, /maxChars/);

    const cached = await runWebTool({ action: 'search', query: 'alpha', limit: 1 });
    assert.equal(cached.results.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(WEB_SEARCH_LIMIT, 10);
  });
});

test('strong_web falls back to Bing and clamps maxChars', async () => {
  await withFetch(async (url) => {
    if (String(url).includes('duckduckgo')) return new Response('blocked', { status: 500 });
    if (String(url).includes('bing.com/search')) {
      return htmlResponse('<html><body><li class="b_algo"><h2><a href="https://bing.example/one">Bing One</a></h2><p>Bing snippet</p></li></body></html>');
    }
    return htmlResponse('<html><head><title>Long</title></head><body>' + 'word '.repeat(400) + '</body></html>');
  }, async () => {
    const searched = await runWebTool({ action: 'search', query: 'fallback' });
    assert.equal(searched.results.length, 1);
    assert.equal(searched.results[0].title, 'Bing One');
    assert.equal(searched.results[0].domain, 'bing.example');
    const opened = await runWebTool({ action: 'open', target: 'https://bing.example/one', maxChars: 10 });
    assert.ok(opened.text.length <= 500);
    assert.equal(typeof opened.truncated, 'boolean');
  });
});

test('strong_web rejects bad input and non-HTML responses', async () => {
  await withFetch(async () => htmlResponse('%%PDF-1.7', { type: 'application/pdf' }), async () => {
    await assert.rejects(() => runWebTool({ action: 'search', query: '   ' }), /search 需要 query/);
    await assert.rejects(() => runWebTool({ action: 'open', target: 'r99' }), /找不到结果 r99/);
    await assert.rejects(() => runWebTool({ action: 'open', target: 'ftp://example.com' }), /http\(s\)/);
    await assert.rejects(() => runWebTool({ action: 'open', target: 'https://example.com/file.pdf' }), /不是网页文本/);
    await assert.rejects(() => runWebTool({ action: 'nope' }), /search 或 open/);
  });
});

test('strong_web schema stays small and complete', () => {
  assert.equal(WEB_TOOL.name, 'strong_web');
  assert.deepEqual(WEB_TOOL.inputSchema.required, ['action']);
  assert.deepEqual(WEB_TOOL.inputSchema.properties.action.enum, ['search', 'open']);
  assert.equal(WEB_TOOL.inputSchema.additionalProperties, false);
  assert.equal(WEB_TOOL.inputSchema.properties.limit.maximum, WEB_SEARCH_LIMIT);
  for (const key of Object.values(WEB_TOOL.inputSchema.properties)) {
    assert.equal(key.description, undefined);
  }
});
