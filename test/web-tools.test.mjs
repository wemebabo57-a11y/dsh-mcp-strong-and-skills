import test from 'node:test';
import assert from 'node:assert/strict';
import { WEB_TOOL, WEB_SEARCH_LIMIT, clearWebCache, decodeEntities, extractPage, parseBing, parseDuckDuckGo, runWebTool, unwrapBingUrl } from '../src/web-tools.mjs';

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



const BETA = [
  '<html><body>',
  '<a class="result__a" href="https://example.net/beta">Beta</a>',
  '<a class="result__snippet" href="https://example.net/beta">Beta snippet</a>',
  '</body></html>',
].join('');

test('strong_web aliases stay scoped to the latest search in each project root', async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).includes('duckduckgo')) {
      return htmlResponse(String(options.body).includes('q=beta') ? BETA : DDG);
    }
    if (String(url).includes('example.com/alpha')) return htmlResponse(PAGE, { url: 'https://example.com/alpha' });
    if (String(url).includes('example.net/beta')) return htmlResponse('<html><head><title>Beta Page</title></head><body>Beta body</body></html>', { url: 'https://example.net/beta' });
    return htmlResponse('<html><body>unknown</body></html>');
  }, async () => {
    await runWebTool({ action: 'search', query: 'alpha' }, { root: 'C:/project-a' });
    await runWebTool({ action: 'search', query: 'beta' }, { root: 'C:/project-b' });
    const isolated = await runWebTool({ action: 'open', target: 'r1' }, { root: 'C:/project-a' });
    assert.equal(isolated.url, 'https://example.com/alpha');
    await runWebTool({ action: 'search', query: 'beta' }, { root: 'C:/project-a' });
    const latest = await runWebTool({ action: 'open', target: 'r1' }, { root: 'C:/project-a' });
    assert.equal(latest.url, 'https://example.net/beta');
    assert.ok(calls.length >= 5);
  });
});

test('strong_web entity decoding never throws on invalid code points', () => {
  assert.equal(decodeEntities('&#x110000; &#999999999; &#xD800;'), '\uFFFD \uFFFD \uFFFD');
  assert.equal(decodeEntities('&#x1F600; &amp; &lt;tag&gt;'), '😀 & <tag>');
});

test('strong_web blocks loopback, metadata and private targets unless explicitly allowed', async () => {
  const calls = [];
  await withFetch(async url => {
    calls.push(String(url));
    return htmlResponse(PAGE, { url: String(url) });
  }, async () => {
    for (const target of ['http://localhost/secret', 'http://127.0.0.1/secret', 'http://[::127.0.0.1]/secret', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.8/private']) {
      await assert.rejects(() => runWebTool({ action: 'open', target }), error => error.code === 'WEB_BLOCKED_URL', target);
    }
    assert.equal(calls.length, 0);
    const allowed = await runWebTool({ action: 'open', target: 'http://127.0.0.1/private' }, { config: { webAllowPrivate: true } });
    assert.equal(allowed.url, 'http://127.0.0.1/private');
    assert.equal(calls.length, 1);
  });
});

test('search and page parsers handle fixture markup without leaking scripts', () => {
  const ddg = '<a class="result__a" href="//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://example.com/a?x=1&utm_source=test') + '">Title <b>One</b></a><a class="result__snippet">Snippet &amp; more</a>';
  const duck = parseDuckDuckGo(ddg);
  assert.equal(duck[0].title, 'Title One');
  assert.equal(duck[0].snippet, 'Snippet & more');
  assert.match(duck[0].url, /^https:\/\/example\.com\/a/);
  const bing = parseBing('<li class="b_algo"><h2><a href="/x">Bing <b>One</b></a></h2><p>Snippet</p></li>');
  assert.deepEqual(bing[0], { title: 'Bing One', url: 'https://www.bing.com/x', snippet: 'Snippet' });
  const page = extractPage('<title>Page</title><meta name="description" content="Desc"><script>secret()</script><style>.x{}</style><p>Hello &amp; world</p><a href="/next">Next</a>', 'https://example.com/base');
  assert.equal(page.title, 'Page');
  assert.equal(page.description, 'Desc');
  assert.equal(page.text.includes('secret'), false);
  assert.equal(page.text.includes('Hello & world'), true);
  assert.deepEqual(page.links, [{ text: 'Next', url: 'https://example.com/next' }]);
});

test('Bing ck/a redirects are unwrapped and deduped after canonicalization', async () => {
  const target = 'https://example.com/story?utm_source=bing&id=7';
  const encoded = 'a1' + Buffer.from(target).toString('base64url');
  const make = p => '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=' + p + '&amp;u=' + encoded + '&amp;ntb=1">Bing</a></h2><p>s</p></li>';
  assert.equal(unwrapBingUrl('https://www.bing.com/ck/a?u=' + encoded), target);
  assert.equal(unwrapBingUrl('https://www.bing.com/ck/a?u=a1bad&ntb=1'), 'https://www.bing.com/ck/a?u=a1bad&ntb=1');
  assert.equal(unwrapBingUrl('https://example.com/ck/a?u=' + encoded), 'https://example.com/ck/a?u=' + encoded);
  assert.equal(unwrapBingUrl('not a url'), '');
  await withFetch(async url => {
    if (String(url).includes('duckduckgo')) return new Response('blocked', { status: 500 });
    if (String(url).includes('bing.com/search')) return htmlResponse(make('p1') + make('p2'));
    return htmlResponse('<html><body>unknown</body></html>');
  }, async () => {
    const searched = await runWebTool({ action: 'search', query: 'bing-unwrap' });
    assert.equal(searched.results.length, 1);
    assert.equal(searched.results[0].url, 'https://example.com/story?id=7');
    assert.equal(searched.results[0].domain, 'example.com');
  });
});
