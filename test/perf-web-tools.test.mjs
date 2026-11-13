import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_CACHE_TTL_MS,
  WEB_OPEN_CACHE_BYTES,
  WEB_OPEN_CACHE_LIMIT,
  clearWebCache,
  runWebTool,
} from '../src/web-tools.mjs';

const DDG = [
  '<html><body>',
  '<a class="result__a" href="https://example.com/alpha">Alpha <b>Guide</b></a>',
  '<a class="result__snippet" href="https://example.com/alpha">Alpha snippet</a>',
  '</body></html>',
].join('');

const ALLOW = { config: { webAllowPrivate: true } };

function htmlResponse(html, { url = '', type = 'text/html; charset=utf-8' } = {}) {
  const response = new Response(html, { status: 200, headers: { 'content-type': type } });
  if (url) Object.defineProperty(response, 'url', { value: url, configurable: true });
  return response;
}

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

// ~300 KB of markup: big enough that fetching plus extractPage dominates a cache hit,
// so the measured miss/hit ratio reflects real work instead of timer noise.
function bigPage(label, paragraphs = 3000) {
  const body = [];
  for (let index = 0; index < paragraphs; index++) {
    body.push('<p>' + label + ' paragraph ' + index + ' with enough words to exercise the extractor and the tag stripper.</p>');
    if (index % 20 === 0) body.push('<a href="/' + label + '/' + index + '">link ' + index + '</a>');
  }
  return '<html><head><title>' + label + ' page</title><meta name="description" content="' + label + ' desc"></head>'
    + '<body><script>var secret = 1;</script><style>.a{color:red}</style>' + body.join('') + '</body></html>';
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function timeOpen(target, options = ALLOW) {
  const started = performance.now();
  const result = await runWebTool({ action: 'open', target, maxChars: 4000 }, options);
  return { result, elapsed: performance.now() - started };
}

test('cache policy stays bounded and documented', () => {
  assert.equal(WEB_CACHE_TTL_MS, 10 * 60 * 1000);
  assert.ok(WEB_OPEN_CACHE_LIMIT >= 1 && WEB_OPEN_CACHE_LIMIT <= 64, 'entry cap ' + WEB_OPEN_CACHE_LIMIT);
  assert.ok(WEB_OPEN_CACHE_BYTES >= 4 * 1024 * 1024, 'byte cap ' + WEB_OPEN_CACHE_BYTES);
  // A single page is capped at 2 MB by readText, so one entry can never exceed the budget.
  assert.ok(WEB_OPEN_CACHE_BYTES > 2 * 1024 * 1024);
});

test('a cached open skips the network and the HTML parse', async (t) => {
  const page = bigPage('alpha');
  const fetched = [];
  await withFetch(async url => {
    fetched.push(String(url));
    return htmlResponse(page, { url: String(url) });
  }, async () => {
    const misses = [];
    for (let index = 0; index < 5; index++) misses.push((await timeOpen('http://127.0.0.1/big-' + index)).elapsed);
    const missAvg = average(misses);

    const first = (await timeOpen('http://127.0.0.1/big-0')).result;
    assert.equal(fetched.length, 5, 'big-0 is already cached from the miss loop');
    const hits = [];
    for (let index = 0; index < 100; index++) hits.push((await timeOpen('http://127.0.0.1/big-0')).elapsed);
    const hitAvg = average(hits);

    assert.equal(fetched.length, 5, 'a cache hit must not touch the network');
    assert.deepEqual((await timeOpen('http://127.0.0.1/big-0')).result, first, 'hit output equals miss output');
    assert.ok(hitAvg * 10 < missAvg, 'hit ' + hitAvg.toFixed(3) + 'ms vs miss ' + missAvg.toFixed(2) + 'ms');
    assert.ok(hitAvg < 1, 'hit must stay sub-millisecond, took ' + hitAvg.toFixed(3) + 'ms');
    t.diagnostic('open 300KB: miss ' + missAvg.toFixed(2) + 'ms, hit ' + hitAvg.toFixed(3) + 'ms (' + (missAvg / hitAvg).toFixed(0) + 'x)');
  });
});

test('one cached page serves every maxChars window without refetching', async () => {
  let calls = 0;
  const html = '<html><head><title>Window</title></head><body><p>' + 'word '.repeat(3000) + '</p></body></html>';
  await withFetch(async url => {
    calls++;
    return htmlResponse(html, { url: String(url) });
  }, async () => {
    const small = (await timeOpen('http://127.0.0.1/window', { config: { webAllowPrivate: true } })).result;
    const large = await runWebTool({ action: 'open', target: 'http://127.0.0.1/window', maxChars: 20000 }, ALLOW);
    assert.equal(calls, 1);
    assert.ok(small.text.length <= 4000);
    assert.equal(small.truncated, true);
    assert.ok(large.text.length > small.text.length);
    assert.equal(large.truncated, false);
    assert.ok(large.text.startsWith(small.text), 'a wider window extends the narrower one');
  });
});

test('open cache keys ignore tracking params, fragments and parameter order', async () => {
  let calls = 0;
  await withFetch(async url => {
    calls++;
    return htmlResponse('<html><head><title>Canon</title></head><body>canon body</body></html>', { url: String(url) });
  }, async () => {
    await timeOpen('http://127.0.0.1/canon?b=2&a=1&utm_source=feed#top');
    await timeOpen('http://127.0.0.1/canon?a=1&b=2');
    await timeOpen('http://127.0.0.1/canon?a=1&b=2&fbclid=abc');
    assert.equal(calls, 1);
  });
});

test('private-mode pages never satisfy a public-mode open', async () => {
  let calls = 0;
  await withFetch(async url => {
    calls++;
    return htmlResponse('<html><head><title>Local</title></head><body>local</body></html>', { url: String(url) });
  }, async () => {
    const allowed = await runWebTool({ action: 'open', target: 'http://127.0.0.1/local' }, ALLOW);
    assert.equal(allowed.title, 'Local');
    await assert.rejects(() => runWebTool({ action: 'open', target: 'http://127.0.0.1/local' }), error => error.code === 'WEB_BLOCKED_URL');
    assert.equal(calls, 1, 'the blocked public open never reached fetch');
  });
});

test('failed opens are never cached', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return htmlResponse('%%PDF-1.7', { type: 'application/pdf' });
  }, async () => {
    for (let index = 0; index < 2; index++) {
      await assert.rejects(() => runWebTool({ action: 'open', target: 'http://127.0.0.1/file.pdf' }, ALLOW), /不是网页文本/);
    }
    assert.equal(calls, 2);
  });
});

test('search cache keys ignore case, whitespace, full-width input and plain term order', async (t) => {
  let engineCalls = 0;
  await withFetch(async url => {
    if (String(url).includes('duckduckgo')) {
      engineCalls++;
      return htmlResponse(DDG);
    }
    return htmlResponse('<html><body></body></html>');
  }, async () => {
    const first = await runWebTool({ action: 'search', query: 'Alpha   Guide', limit: 1 }, ALLOW);
    assert.equal(engineCalls, 1);
    for (const query of ['alpha guide', '  ALPHA GUIDE  ', 'guide alpha', 'ＧＵＩＤＥ　ａｌｐｈａ']) {
      const again = await runWebTool({ action: 'search', query, limit: 1 }, ALLOW);
      assert.equal(again.query, query, 'the response still echoes the caller query');
      assert.deepEqual(again.results, first.results);
    }
    assert.equal(engineCalls, 1, 'normalized variants share one cache row');

    // Quoted phrases keep their exact order, so these two are distinct queries.
    await runWebTool({ action: 'search', query: '"alpha guide"' }, ALLOW);
    await runWebTool({ action: 'search', query: '"guide alpha"' }, ALLOW);
    assert.equal(engineCalls, 3, 'quoted phrases must not share an entry');
    t.diagnostic('5 normalized variants + 2 quoted phrases: ' + engineCalls + ' engine calls');
  });
});

test('a normalized search cache hit skips the engines', async (t) => {
  await withFetch(async url => {
    if (String(url).includes('duckduckgo')) {
      await new Promise(resolve => setTimeout(resolve, 20));
      return htmlResponse(DDG);
    }
    return htmlResponse('<html><body></body></html>');
  }, async () => {
    const missStart = performance.now();
    await runWebTool({ action: 'search', query: 'Slow  Probe' }, ALLOW);
    const missMs = performance.now() - missStart;
    const hits = [];
    for (let index = 0; index < 50; index++) {
      const started = performance.now();
      await runWebTool({ action: 'search', query: 'slow probe' }, ALLOW);
      hits.push(performance.now() - started);
    }
    const hitAvg = average(hits);
    assert.ok(hitAvg * 5 < missMs, 'hit ' + hitAvg.toFixed(3) + 'ms vs miss ' + missMs.toFixed(2) + 'ms');
    t.diagnostic('search 20ms engine: miss ' + missMs.toFixed(2) + 'ms, hit ' + hitAvg.toFixed(3) + 'ms (' + (missMs / hitAvg).toFixed(0) + 'x)');
  });
});

test('open and search entries expire after the TTL and hits do not extend it', async () => {
  const realNow = Date.now;
  let skew = 0;
  let version = 'v1';
  let openCalls = 0;
  let searchCalls = 0;
  Date.now = () => realNow() + skew;
  try {
    await withFetch(async url => {
      if (String(url).includes('duckduckgo')) {
        searchCalls++;
        return htmlResponse(DDG);
      }
      openCalls++;
      return htmlResponse('<html><head><title>' + version + '</title></head><body>' + version + ' body</body></html>', { url: String(url) });
    }, async () => {
      assert.equal((await timeOpen('http://127.0.0.1/ttl')).result.title, 'v1');
      skew = WEB_CACHE_TTL_MS - 1;
      assert.equal((await timeOpen('http://127.0.0.1/ttl')).result.title, 'v1');
      assert.equal(openCalls, 1, 'still inside the TTL');
      // A hit at TTL-1 must not have refreshed the timestamp: at TTL+1 the page is stale.
      skew = WEB_CACHE_TTL_MS + 1;
      version = 'v2';
      assert.equal((await timeOpen('http://127.0.0.1/ttl')).result.title, 'v2');
      assert.equal(openCalls, 2, 'expired entries are refetched');

      await runWebTool({ action: 'search', query: 'ttl search' }, ALLOW);
      assert.equal(searchCalls, 1);
      await runWebTool({ action: 'search', query: 'TTL  search' }, ALLOW);
      assert.equal(searchCalls, 1, 'normalized hit inside the TTL');
      skew = 2 * WEB_CACHE_TTL_MS + 2;
      await runWebTool({ action: 'search', query: 'ttl search' }, ALLOW);
      assert.equal(searchCalls, 2, 'search entries expire too');
    });
  } finally {
    Date.now = realNow;
  }
});

test('open cache evicts the least recently used entry at its entry cap', async () => {
  const fetched = [];
  await withFetch(async url => {
    fetched.push(new URL(String(url)).pathname);
    return htmlResponse('<html><head><title>' + String(url) + '</title></head><body>lru</body></html>', { url: String(url) });
  }, async () => {
    const total = WEB_OPEN_CACHE_LIMIT + 2;
    for (let index = 0; index < total; index++) await timeOpen('http://127.0.0.1/lru-' + index);
    assert.equal(fetched.length, total);

    await timeOpen('http://127.0.0.1/lru-' + (total - 1));
    assert.equal(fetched.length, total, 'the newest entry is still cached');
    await timeOpen('http://127.0.0.1/lru-0');
    assert.equal(fetched.length, total + 1, 'the oldest entry was evicted');
    assert.equal(fetched.filter(path => path === '/lru-0').length, 2);
  });
});
