import test from 'node:test';
import assert from 'node:assert/strict';
import { SEARCH_BUDGET_MS, SEARCH_ENGINE_TIMEOUT_MS, WEB_TOOL, WEB_SEARCH_LIMIT, clearWebCache, decodeEntities, extractPage, parseBing, parseDuckDuckGo, raceEngines, runWebTool, unwrapBingUrl } from '../src/web-tools.mjs';

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
    // Both engines start together, so look the POST up by engine instead of by order.
    assert.equal(calls.find(call => call.url.includes('duckduckgo')).method, 'POST');

    const opened = await runWebTool({ action: 'open', target: 'r1', maxChars: 500 });
    assert.equal(opened.action, 'open');
    assert.equal(opened.url, 'https://example.com/alpha');
    assert.equal(opened.title, 'Alpha Page');
    assert.equal(opened.description, 'Alpha desc');
    assert.match(opened.text, /Alpha body text/);
    assert.ok(opened.text.length <= 500);
    assert.ok(opened.links.some(link => link.url === 'https://example.com/next'));
    assert.match(opened.hint, /maxChars/);

    const callsBeforeCache = calls.length;
    const cached = await runWebTool({ action: 'search', query: 'alpha', limit: 1 });
    assert.equal(cached.results.length, 1);
    // A cache hit does no network work, and the winning engine was asked exactly once
    // (the losing engine is cancelled as soon as the winner answers).
    assert.equal(calls.length, callsBeforeCache);
    assert.equal(calls.filter(call => call.url.includes('duckduckgo')).length, 1);
    assert.equal(WEB_SEARCH_LIMIT, 10);
  });
});

test('strong_web takes Bing results when DuckDuckGo fails and clamps maxChars', async () => {
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

const BING = '<html><body><li class="b_algo"><h2><a href="https://bing.example/one">Bing One</a></h2><p>Bing snippet</p></li></body></html>';

function fakeEngine(name, { parse } = {}) {
  return {
    name,
    url: () => 'https://engine.test/' + name,
    init: () => ({}),
    parse: parse ?? (text => text ? [{ title: text, url: 'https://example.com/' + text, snippet: '' }] : []),
  };
}

function rejectOnAbort(signal) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
}

test('strong_web search races both engines and cancels the slow one', async () => {
  const started = [];
  let duckAborted = false;
  await withFetch(async (url, options = {}) => {
    const engine = String(url).includes('duckduckgo') ? 'duckduckgo' : 'bing';
    started.push(engine);
    if (engine === 'duckduckgo') {
      return new Promise((resolve, reject) => {
        const fail = () => { duckAborted = true; reject(new Error('aborted')); };
        if (options.signal?.aborted) fail();
        else options.signal?.addEventListener('abort', fail, { once: true });
      });
    }
    return htmlResponse(BING);
  }, async () => {
    const startedAt = Date.now();
    const searched = await runWebTool({ action: 'search', query: 'raced' }, { config: { webAllowPrivate: true } });
    // Both engines were asked before either answered.
    assert.deepEqual(started.slice().sort(), ['bing', 'duckduckgo']);
    assert.equal(searched.results.length, 1);
    assert.equal(searched.results[0].id, 'r1');
    assert.equal(searched.results[0].title, 'Bing One');
    assert.equal(duckAborted, true);
    assert.ok(Date.now() - startedAt < 1000, 'a dead engine must not delay the answer');
    assert.ok(SEARCH_ENGINE_TIMEOUT_MS < SEARCH_BUDGET_MS);
    assert.ok(SEARCH_BUDGET_MS <= 8000);
  });
});

test('strong_web keeps DuckDuckGo results when it answers first', async () => {
  let bingAborted = false;
  await withFetch(async (url, options = {}) => {
    if (String(url).includes('duckduckgo')) return htmlResponse(DDG);
    return new Promise((resolve, reject) => {
      const fail = () => { bingAborted = true; reject(new Error('aborted')); };
      if (options.signal?.aborted) fail();
      else options.signal?.addEventListener('abort', fail, { once: true });
    });
  }, async () => {
    const searched = await runWebTool({ action: 'search', query: 'duck-first' }, { config: { webAllowPrivate: true } });
    assert.equal(searched.results.length, 2);
    assert.equal(searched.results[0].title, 'Alpha Guide');
    assert.equal(bingAborted, true);
  });
});

test('strong_web reports every engine failure when nothing answers', async () => {
  await withFetch(async () => new Response('blocked', { status: 503 }), async () => {
    await assert.rejects(() => runWebTool({ action: 'search', query: 'down' }, { config: { webAllowPrivate: true } }), error => {
      assert.equal(error.code, 'WEB_SEARCH_FAILED');
      assert.match(error.message, /duckduckgo: 请求失败：503/);
      assert.match(error.message, /bing: 请求失败：503/);
      assert.doesNotMatch(error.message, /毫秒预算/);
      return true;
    });
  });
});

test('strong_web search failure message stays stable when engines return empty pages', async () => {
  await withFetch(async () => htmlResponse('<html><body>no parsed results</body></html>'), async () => {
    await assert.rejects(() => runWebTool({ action: 'search', query: 'empty' }, { config: { webAllowPrivate: true } }), error => {
      assert.equal(error.code, 'WEB_SEARCH_FAILED');
      assert.equal(error.message, '搜索没有拿到结果。');
      return true;
    });
  });
});

test('raceEngines keeps the first non-empty parse and aborts the rest', async () => {
  const aborted = [];
  await withFetch(async (url, options = {}) => {
    const name = String(url).split('/').pop();
    if (name === 'slow') return rejectOnAbort(options.signal).catch(error => { aborted.push(name); throw error; });
    return htmlResponse('fast');
  }, async () => {
    const outcome = await raceEngines([fakeEngine('slow'), fakeEngine('fast')], 'q', { allowPrivate: true, engineTimeoutMs: 500, budgetMs: 2000 });
    assert.deepEqual(outcome.results.map(item => item.title), ['fast']);
    assert.deepEqual(outcome.errors, []);
    assert.deepEqual(aborted, ['slow']);
    assert.equal(outcome.timedOut, false);
  });
});

test('raceEngines bounds an engine that never answers', async () => {
  const startedAt = Date.now();
  await withFetch(async (url, options = {}) => rejectOnAbort(options.signal), async () => {
    const outcome = await raceEngines([fakeEngine('wedged')], 'q', { allowPrivate: true, engineTimeoutMs: 60, budgetMs: 5000 });
    assert.deepEqual(outcome.results, []);
    assert.equal(outcome.timedOut, false);
    assert.match(outcome.errors[0], /^wedged: /);
    assert.ok(Date.now() - startedAt < 1000, 'per-engine timeout should settle the race');
  });
});

test('raceEngines returns at the budget even when an engine ignores aborts', async () => {
  const startedAt = Date.now();
  await withFetch(async () => new Promise(() => {}), async () => {
    // The stub never settles and never observes its abort signal: only the budget can end the race.
    const outcome = await raceEngines([fakeEngine('stuck')], 'q', { allowPrivate: true, engineTimeoutMs: 5000, budgetMs: 80 });
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(outcome.results, []);
    assert.equal(outcome.timedOut, true);
    assert.ok(elapsed >= 60 && elapsed < 1000, 'elapsed ' + elapsed);
  });
});

test('raceEngines never leaks a late loser rejection', async () => {
  const leaked = [];
  const onUnhandled = reason => { leaked.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await withFetch(async (url) => {
      if (String(url).includes('late')) return new Promise((resolve, reject) => setTimeout(() => reject(new Error('late boom')), 30));
      return htmlResponse('winner');
    }, async () => {
      const outcome = await raceEngines([fakeEngine('late'), fakeEngine('winner')], 'q', { allowPrivate: true, engineTimeoutMs: 500, budgetMs: 2000 });
      assert.deepEqual(outcome.results.map(item => item.title), ['winner']);
      await new Promise(resolve => setTimeout(resolve, 80));
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(leaked, []);
});

test('caller aborts cancel both engines instead of waiting for the budget', async () => {
  const aborted = [];
  await withFetch(async (url, options = {}) => {
    const name = String(url).includes('duckduckgo') ? 'duckduckgo' : 'bing';
    return rejectOnAbort(options.signal).catch(error => { aborted.push(name); throw error; });
  }, async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();
    await assert.rejects(
      () => runWebTool({ action: 'search', query: 'cancelled' }, { signal: controller.signal, config: { webAllowPrivate: true } }),
      error => error.name === 'AbortError',
    );
    assert.ok(Date.now() - startedAt < 1000, 'abort must not wait for the search budget');
    assert.deepEqual(aborted.sort(), ['bing', 'duckduckgo']);
  });
});
