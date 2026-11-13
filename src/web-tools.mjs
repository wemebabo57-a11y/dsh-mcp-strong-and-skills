import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WorkspaceError } from './workspace.mjs';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_LIMIT = 10;
const CACHE_ROOTS = 32;
// Open results are far larger than search rows, so they get their own byte-bounded
// LRU instead of sharing the per-root search maps: at most OPEN_CACHE_LIMIT pages and
// never more than OPEN_CACHE_BYTES of decoded text held in memory.
const OPEN_CACHE_LIMIT = 20;
const OPEN_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TRACKING = /^(utm_|fbclid$|gclid$|spm$|ref$|source$)/i;

// Network budgets. `open` keeps the historical 15s per request chain. Search engines
// run concurrently, so each engine gets a shorter cap while the whole search keeps a
// hard budget that a stalled engine cannot exceed.
const REQUEST_TIMEOUT_MS = 15000;
export const SEARCH_ENGINE_TIMEOUT_MS = 4000;
export const SEARCH_BUDGET_MS = 8000;

export const WEB_SEARCH_LIMIT = 10;
export const WEB_CACHE_TTL_MS = CACHE_TTL;
export const WEB_OPEN_CACHE_LIMIT = OPEN_CACHE_LIMIT;
export const WEB_OPEN_CACHE_BYTES = OPEN_CACHE_BYTES;

export const WEB_TOOL = Object.freeze({
  name: 'strong_web',
  description: '联网查资料，不启动浏览器：search 返回结果列表（id、标题、网址、摘要）；open 用 id 或网址读正文。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'open'] },
      query: { type: 'string', maxLength: 500 },
      target: { type: 'string', maxLength: 2000 },
      limit: { type: 'integer', minimum: 1, maximum: WEB_SEARCH_LIMIT },
      maxChars: { type: 'integer', minimum: 500, maximum: 20000 },
    },
    required: ['action'],
    additionalProperties: false,
  },
});

const cache = new Map();
const openCache = new Map();
let openCacheBytes = 0;

function cacheKey(root) {
  return typeof root === 'string' && root ? root : '(default)';
}

function rootEntry(root, create = false) {
  const key = cacheKey(root);
  let entry = cache.get(key);
  if (!entry && !create) return null;
  if (!entry) {
    entry = { at: Date.now(), searches: new Map(), latest: new Map(), latestAt: 0 };
    cache.set(key, entry);
  }
  entry.at = Date.now();
  if (cache.size > CACHE_ROOTS) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest && oldest[0] !== key) cache.delete(oldest[0]);
  }
  return entry;
}

// Search engines ignore letter case and collapse whitespace, and NFKC folds
// full-width characters typed through an IME, so every such variant of a query
// shares one cache row. Plain multi-word queries (no quotes, operators or field
// prefixes) are also matched as a term bag: engines score "alpha beta" and
// "beta alpha" the same way, so sorting the terms lets either order hit.
// Quoted phrases and operators stay exact because their order changes meaning.
const QUERY_SYNTAX = /["'`()|+\-*:]|\b(?:and|or|not|site|filetype|intitle|inurl)\b/i;

function searchCacheKey(query) {
  const normalized = String(query).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized.includes(' ') && !QUERY_SYNTAX.test(normalized)) return normalized.split(' ').sort().join(' ');
  return normalized;
}

function rememberSearch(root, query, results) {
  const entry = rootEntry(root, true);
  const now = Date.now();
  entry.searches.set(searchCacheKey(query), { at: now, results });
  entry.latest = new Map(results.map(item => [item.id, item]));
  entry.latestAt = now;
  for (const [key, value] of entry.searches) if (now - value.at > CACHE_TTL) entry.searches.delete(key);
  while (entry.searches.size > CACHE_LIMIT) entry.searches.delete(entry.searches.keys().next().value);
}

function recallSearch(root, query) {
  const entry = rootEntry(root);
  const hit = entry?.searches.get(searchCacheKey(query));
  if (!hit || Date.now() - hit.at > CACHE_TTL) return null;
  return hit.results;
}

// A cached page is keyed by its canonical URL: tracking parameters and fragments
// are dropped (canonicalUrl) and the remaining parameters are sorted, because
// servers treat ?a=1&b=2 and ?b=2&a=1 as the same resource.
function canonicalOpenUrl(value) {
  const canonical = canonicalUrl(value);
  if (!canonical) return '';
  const url = new URL(canonical);
  url.searchParams.sort();
  return url.toString();
}

function openCacheKey(url, allowPrivate) {
  // Private-mode pages must never satisfy a later public-mode open: the SSRF guard
  // lives inside request(), which a cache hit skips entirely.
  return (allowPrivate ? 'private|' : 'public|') + (canonicalOpenUrl(url) || url);
}

function recallOpen(url, allowPrivate) {
  const key = openCacheKey(url, allowPrivate);
  const entry = openCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL) {
    openCache.delete(key);
    openCacheBytes -= entry.bytes;
    return null;
  }
  // Refresh LRU recency but keep `at`: a hit must not extend the page lifetime.
  openCache.delete(key);
  openCache.set(key, entry);
  return entry;
}

function rememberOpen(url, allowPrivate, page) {
  const key = openCacheKey(url, allowPrivate);
  const bytes = Buffer.byteLength(page.text, 'utf8');
  const previous = openCache.get(key);
  if (previous) openCacheBytes -= previous.bytes;
  openCache.delete(key);
  openCache.set(key, { at: Date.now(), bytes, ...page });
  openCacheBytes += bytes;
  for (const [other, entry] of openCache) {
    if (openCache.size <= OPEN_CACHE_LIMIT && openCacheBytes <= OPEN_CACHE_BYTES) break;
    if (other === key) break; // keep the fresh entry even if it alone exceeds the budget
    openCache.delete(other);
    openCacheBytes -= entry.bytes;
  }
}

function findByAlias(root, alias) {
  const entry = rootEntry(root);
  if (!entry || Date.now() - entry.latestAt > CACHE_TTL) return null;
  return entry.latest.get(alias) ?? null;
}

export function clearWebCache() {
  cache.clear();
  openCache.clear();
  openCacheBytes = 0;
}

function safeCodePoint(value) {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : '\uFFFD';
}

export function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/&[a-zA-Z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function absolute(href, base) {
  try {
    const url = new URL(decodeEntities(href), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function privateIpv4(value) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || a >= 224;
}

function privateIpv6(value) {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (address === '::' || address === '::1') return true;
  // IPv4-compatible IPv6 (::/96) can encode loopback or private IPv4.
  if (address.startsWith('::')) return true;
  const compatible = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (compatible) return privateIpv4(compatible[1]);
  const mapped = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/.exec(address);
  if (mapped) {
    if (mapped[3]) return privateIpv4(mapped[3]);
    return privateIpv4([mapped[1], mapped[2]].map(part => parseInt(part, 16)).flatMap(number => [number >> 8, number & 255]).join('.'));
  }
  return address.startsWith('fc') || address.startsWith('fd') || /^fe[89ab]/.test(address) || address.startsWith('ff');
}

async function assertPublicUrl(url, allowPrivate) {
  if (allowPrivate) return;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') {
    throw new WorkspaceError('WEB_BLOCKED_URL', '默认拒绝本机、内网和元数据地址：' + url.hostname);
  }
  const bare = host.replace(/^\[|\]$/g, '');
  const version = isIP(bare);
  if (version === 4 && privateIpv4(bare)) throw new WorkspaceError('WEB_BLOCKED_URL', '默认拒绝内网地址：' + url.hostname);
  if (version === 6 && privateIpv6(bare)) throw new WorkspaceError('WEB_BLOCKED_URL', '默认拒绝内网地址：' + url.hostname);
  if (version) return;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    for (const item of addresses) {
      if ((item.family === 4 && privateIpv4(item.address)) || (item.family === 6 && privateIpv6(item.address))) {
        throw new WorkspaceError('WEB_BLOCKED_URL', '默认拒绝解析到内网的地址：' + url.hostname);
      }
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    // DNS failures surface through fetch; do not turn temporary resolver issues into SSRF bypass logic.
  }
}

async function request(url, { method = 'GET', body = null, signal, allowPrivate = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = new URL(url);
  let currentMethod = method;
  let currentBody = body;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertPublicUrl(current, allowPrivate);
    combined.throwIfAborted();
    const response = await fetch(current, {
      method: currentMethod,
      signal: combined,
      redirect: 'manual',
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(currentBody ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: currentBody,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new WorkspaceError('WEB_HTTP_FAILED', '重定向缺少 Location：' + current);
      const next = new URL(location, current);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== 'GET')) {
        currentMethod = 'GET';
        currentBody = null;
      }
      current = next;
      continue;
    }
    if (!response.ok) throw new WorkspaceError('WEB_HTTP_FAILED', '请求失败：' + response.status + ' ' + current);
    return response;
  }
  throw new WorkspaceError('WEB_HTTP_FAILED', '重定向次数过多：' + url);
}

function charsetOf(response, buffer) {
  const contentType = response.headers.get('content-type') ?? '';
  const fromHeader = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const head = buffer.subarray(0, 2048).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i.exec(head)?.[1] ?? 'utf-8';
}

async function readText(response) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new WorkspaceError('WEB_TOO_LARGE', '页面超过 2 MB，已停止读取。');
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new WorkspaceError('WEB_TOO_LARGE', '页面超过 2 MB，已停止读取。');
    return new TextDecoder('utf-8').decode(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new WorkspaceError('WEB_TOO_LARGE', '页面超过 2 MB，已停止读取。');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  const buffer = Buffer.concat(chunks);
  try { return new TextDecoder(charsetOf(response, buffer), { fatal: false }).decode(buffer); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(buffer); }
}

export function parseDuckDuckGo(html) {
  const results = [];
  const pattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,600}?)(?=<a[^>]*class="[^"]*result__a|<\/body|$)/g;
  for (const match of html.matchAll(pattern)) {
    const url = match[1].includes('uddg=')
      ? decodeEntities(new URL(match[1], 'https://duckduckgo.com').searchParams.get('uddg') ?? '')
      : absolute(match[1], 'https://duckduckgo.com');
    if (!url) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(match[3]);
    results.push({ title: stripTags(match[2]), url, snippet: snippet ? stripTags(snippet[1]) : '' });
    if (results.length >= WEB_SEARCH_LIMIT) break;
  }
  return results;
}

export function unwrapBingUrl(value) {
  let redirect;
  try { redirect = new URL(value); } catch { return ''; }
  if (!/(^|\.)bing\.com$/i.test(redirect.hostname) || !redirect.pathname.startsWith('/ck/a')) return redirect.toString();
  const encoded = redirect.searchParams.get('u');
  if (!encoded) return redirect.toString();
  let target = encoded;
  if (/^a1/i.test(encoded)) {
    try { target = Buffer.from(encoded.slice(2).replace(/\+/g, '-').replace(/\//g, '_'), 'base64url').toString('utf8'); }
    catch { return redirect.toString(); }
  }
  target = decodeEntities(target);
  if (!/^https?:\/\//i.test(target)) return redirect.toString();
  try { return new URL(target).toString(); } catch { return redirect.toString(); }
}

export function parseBing(html) {
  const results = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const raw = absolute(link[1], 'https://www.bing.com');
    if (!raw) continue;
    const url = unwrapBingUrl(raw);
    if (!url) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    results.push({ title: stripTags(link[2]), url, snippet: snippet ? stripTags(snippet[1]) : '' });
    if (results.length >= WEB_SEARCH_LIMIT) break;
  }
  return results;
}

// Interchangeable HTML SERPs: run them at once, keep the first one that parses a
// result and abort the rest. Trying them one after another meant a dead or throttled
// DuckDuckGo spent its whole connect timeout (~10.5s here) before Bing was even asked.
const SEARCH_ENGINES = Object.freeze([
  Object.freeze({
    name: 'duckduckgo',
    url: () => 'https://html.duckduckgo.com/html/',
    init: query => ({ method: 'POST', body: new URLSearchParams({ q: query }).toString() }),
    parse: parseDuckDuckGo,
  }),
  Object.freeze({
    name: 'bing',
    url: query => 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-Hans',
    init: () => ({}),
    parse: parseBing,
  }),
]);

async function runSearchEngine(engine, query, { signal, allowPrivate, timeoutMs }) {
  const response = await request(engine.url(query), { ...engine.init(query), signal, allowPrivate, timeoutMs });
  return engine.parse(await readText(response));
}

// Start every engine at once and settle with the first engine that parsed at least one
// result, aborting the losers. Each attempt carries a rejection handler and the race
// always settles, so late failures never surface as unhandled rejections.
// `engineTimeoutMs` bounds one engine request; `budgetMs` is the hard backstop for
// work AbortSignal cannot interrupt (a wedged DNS lookup).
export async function raceEngines(engines, query, { signal, allowPrivate = false, engineTimeoutMs = SEARCH_ENGINE_TIMEOUT_MS, budgetMs = SEARCH_BUDGET_MS } = {}) {
  const controllers = engines.map(() => new AbortController());
  const errors = new Array(engines.length).fill('');
  let winner = null;
  let remaining = engines.length;
  let timedOut = false;
  let settleRace;
  const raced = new Promise(resolve => { settleRace = resolve; });
  const cancelAll = () => { for (const controller of controllers) controller.abort(); };
  const onCallerAbort = () => { cancelAll(); settleRace(); };
  const timer = setTimeout(() => { timedOut = true; cancelAll(); settleRace(); }, budgetMs);
  timer.unref?.();
  try {
    if (signal?.aborted) onCallerAbort();
    else signal?.addEventListener('abort', onCallerAbort, { once: true });
    engines.forEach((engine, index) => {
      runSearchEngine(engine, query, { signal: controllers[index].signal, allowPrivate, timeoutMs: engineTimeoutMs }).then(results => {
        if (winner || results.length === 0) return;
        winner = results;
        controllers.forEach((controller, other) => { if (other !== index) controller.abort(); });
        settleRace();
      }, error => {
        errors[index] = engine.name + ': ' + (error instanceof Error ? error.message : String(error));
      }).finally(() => {
        remaining -= 1;
        if (remaining === 0) settleRace();
      });
    });
    if (remaining === 0) settleRace();
    await raced;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
  // Cancellation is not a search failure: preserve the caller's AbortError so the
  // host can report an interrupted call instead of a network error.
  signal?.throwIfAborted();
  return { results: winner ?? [], errors: errors.filter(Boolean), timedOut };
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const url = canonicalUrl(item.url);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    item.url = url;
    return true;
  });
}

async function search(query, limit, signal, { root = '', allowPrivate = false } = {}) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new WorkspaceError('INVALID_ARGUMENTS', 'search 需要 query。');
  const cached = recallSearch(root, trimmed);
  if (cached) return cached.slice(0, limit);
  const { results: raw, errors, timedOut } = await raceEngines(SEARCH_ENGINES, trimmed, { signal, allowPrivate });
  if (!raw.length) {
    throw new WorkspaceError('WEB_SEARCH_FAILED', '搜索没有拿到结果。'
      + (errors.length ? ' ' + errors.join('; ') : '')
      + (timedOut ? ' 搜索超过 ' + SEARCH_BUDGET_MS + ' 毫秒预算。' : ''));
  }
  const results = dedupe(raw).slice(0, WEB_SEARCH_LIMIT).map((item, index) => ({
    id: 'r' + (index + 1),
    title: item.title.slice(0, 200),
    url: item.url,
    domain: domainOf(item.url),
    snippet: item.snippet.slice(0, 400),
  }));
  rememberSearch(root, trimmed, results);
  return results.slice(0, Math.min(limit, results.length));
}

export function extractPage(html, base) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? '';
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = stripTags(cleaned);
  const links = [];
  for (const match of cleaned.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(match[1], base);
    const label = stripTags(match[2]);
    if (!url || !label || label.length > 120) continue;
    if (links.some(item => item.url === url)) continue;
    links.push({ text: label, url });
    if (links.length >= 40) break;
  }
  return { title: stripTags(title), description: stripTags(description).slice(0, 400), text, links };
}

function lines(text, maxChars) {
  return String(text)
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .join('\n\n')
    .slice(0, maxChars);
}

// The cached page keeps the full extracted text, so one entry serves every maxChars
// window and each caller still gets its own links array to mutate safely.
function pageResult(page, maxChars) {
  return {
    url: page.url,
    title: page.title,
    description: page.description,
    text: lines(page.text, maxChars),
    links: page.links.map(link => ({ ...link })),
    truncated: page.text.length > maxChars,
  };
}

async function open(target, maxChars, signal, allowPrivate) {
  const value = String(target ?? '').trim();
  if (!value) throw new WorkspaceError('INVALID_ARGUMENTS', 'open 需要 target（结果 id 或网址）。');
  if (!/^https?:\/\//i.test(value)) throw new WorkspaceError('INVALID_ARGUMENTS', 'open 的 target 必须是 http(s) 网址或结果 id。');
  signal?.throwIfAborted();
  const cached = recallOpen(value, allowPrivate);
  if (cached) return pageResult(cached, maxChars);
  const response = await request(value, { signal, allowPrivate });
  const contentType = response.headers.get('content-type') ?? '';
  if (!/html|xml|text/i.test(contentType)) throw new WorkspaceError('WEB_NOT_HTML', '该地址不是网页文本：' + contentType);
  const body = await readText(response);
  const page = extractPage(body, response.url || value);
  const stored = {
    url: response.url || value,
    title: page.title,
    description: page.description,
    text: page.text,
    links: page.links,
  };
  rememberOpen(value, allowPrivate, stored);
  return pageResult(stored, maxChars);
}

export async function runWebTool(args = {}, { signal, root = '', config = {} } = {}) {
  const action = args.action;
  const allowPrivate = config?.webAllowPrivate === true;
  if (action === 'search') {
    const results = await search(args.query, Math.min(Number(args.limit ?? 5) || 5, WEB_SEARCH_LIMIT), signal, { root, allowPrivate });
    return { action, query: args.query, results, hint: '挑一条用 action=open, target=r几；也可以直接给网址。' };
  }
  if (action === 'open') {
    const alias = /^r\d+$/.test(String(args.target ?? '').trim()) ? findByAlias(root, String(args.target).trim()) : null;
    if (/^r\d+$/.test(String(args.target ?? '').trim()) && !alias) {
      throw new WorkspaceError('WEB_UNKNOWN_ALIAS', '找不到结果 ' + args.target + '，请先 search 或直接给出完整网址。');
    }
    const page = await open(alias ? alias.url : args.target, Math.min(Math.max(Number(args.maxChars ?? 4000) || 4000, 500), 20000), signal, allowPrivate);
    return { action, ...page, hint: '需要更多正文时加大 maxChars。' };
  }
  throw new WorkspaceError('INVALID_ARGUMENTS', 'action 只能是 search 或 open。');
}
