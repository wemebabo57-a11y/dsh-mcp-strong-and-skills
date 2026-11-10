import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { WorkspaceError } from './workspace.mjs';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_LIMIT = 10;
const CACHE_ROOTS = 32;
const MAX_REDIRECTS = 5;
const TRACKING = /^(utm_|fbclid$|gclid$|spm$|ref$|source$)/i;

export const WEB_SEARCH_LIMIT = 10;

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

function rememberSearch(root, query, results) {
  const entry = rootEntry(root, true);
  const now = Date.now();
  entry.searches.set(query, { at: now, results });
  entry.latest = new Map(results.map(item => [item.id, item]));
  entry.latestAt = now;
  for (const [key, value] of entry.searches) if (now - value.at > CACHE_TTL) entry.searches.delete(key);
  while (entry.searches.size > CACHE_LIMIT) entry.searches.delete(entry.searches.keys().next().value);
}

function recallSearch(root, query) {
  const entry = rootEntry(root);
  const hit = entry?.searches.get(query);
  if (!hit || Date.now() - hit.at > CACHE_TTL) return null;
  return hit.results;
}

function findByAlias(root, alias) {
  const entry = rootEntry(root);
  if (!entry || Date.now() - entry.latestAt > CACHE_TTL) return null;
  return entry.latest.get(alias) ?? null;
}

export function clearWebCache() {
  cache.clear();
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

async function request(url, { method = 'GET', body = null, signal, allowPrivate = false } = {}) {
  const timeout = AbortSignal.timeout(15000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = new URL(url);
  let currentMethod = method;
  let currentBody = body;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertPublicUrl(current, allowPrivate);
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
  const errors = [];
  let raw = [];
  try {
    const response = await request('https://html.duckduckgo.com/html/', { method: 'POST', body: new URLSearchParams({ q: trimmed }).toString(), signal, allowPrivate });
    raw = parseDuckDuckGo(await readText(response));
  } catch (error) {
    errors.push('duckduckgo: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (!raw.length) {
    try {
      const response = await request('https://www.bing.com/search?q=' + encodeURIComponent(trimmed) + '&setlang=zh-Hans', { signal, allowPrivate });
      raw = parseBing(await readText(response));
    } catch (error) {
      errors.push('bing: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (!raw.length) throw new WorkspaceError('WEB_SEARCH_FAILED', '搜索没有拿到结果。' + (errors.length ? ' ' + errors.join('; ') : ''));
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

async function open(target, maxChars, signal, allowPrivate) {
  const value = String(target ?? '').trim();
  if (!value) throw new WorkspaceError('INVALID_ARGUMENTS', 'open 需要 target（结果 id 或网址）。');
  if (!/^https?:\/\//i.test(value)) throw new WorkspaceError('INVALID_ARGUMENTS', 'open 的 target 必须是 http(s) 网址或结果 id。');
  const response = await request(value, { signal, allowPrivate });
  const contentType = response.headers.get('content-type') ?? '';
  if (!/html|xml|text/i.test(contentType)) throw new WorkspaceError('WEB_NOT_HTML', '该地址不是网页文本：' + contentType);
  const body = await readText(response);
  const page = extractPage(body, response.url || value);
  return {
    url: response.url || value,
    title: page.title,
    description: page.description,
    text: lines(page.text, maxChars),
    links: page.links,
    truncated: page.text.length > maxChars,
  };
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
