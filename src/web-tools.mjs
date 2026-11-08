import { WorkspaceError } from './workspace.mjs';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_LIMIT = 10;

export const WEB_SEARCH_LIMIT = 10;

export const WEB_TOOL = Object.freeze({
  name: 'strong_web',
  description: '联网查资料，不启动浏览器：search 返回 JSON 结果列表（id、标题、网址、摘要）；open 用 id 或网址读正文。',
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

function remember(root, query, results) {
  const key = cacheKey(root);
  if (!key) return;
  const store = cache.get(key) ?? new Map();
  store.set(query, { at: Date.now(), results });
  for (const [entryQuery, entry] of store) {
    if (Date.now() - entry.at > CACHE_TTL) store.delete(entryQuery);
  }
  while (store.size > CACHE_LIMIT) store.delete(store.keys().next().value);
  cache.set(key, store);
}

function recall(root, query) {
  const store = cache.get(cacheKey(root));
  if (!store) return null;
  const entry = store.get(query);
  if (!entry || Date.now() - entry.at > CACHE_TTL) return null;
  return entry.results;
}

function findByAlias(root, alias) {
  const store = cache.get(cacheKey(root));
  if (!store) return null;
  for (const entry of store.values()) {
    const hit = entry.results.find(item => item.id === alias);
    if (hit) return hit;
  }
  return null;
}

export function clearWebCache() {
  cache.clear();
}

function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
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

async function request(url, { method = 'GET', body = null, signal } = {}) {
  const timeout = AbortSignal.timeout(15000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    method,
    signal: combined,
    redirect: 'follow',
    headers: {
      'user-agent': USER_AGENT,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  if (!response.ok) throw new WorkspaceError('WEB_HTTP_FAILED', '请求失败：' + response.status + ' ' + url);
  return response;
}

async function readText(response) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new WorkspaceError('WEB_TOO_LARGE', '页面超过 2 MB，已停止读取。');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new WorkspaceError('WEB_TOO_LARGE', '页面超过 2 MB，已停止读取。');
  return buffer.toString('utf8');
}

function parseDuckDuckGo(html) {
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

function parseBing(html) {
  const results = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = absolute(link[1], 'https://www.bing.com');
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

async function search(query, limit, signal) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new WorkspaceError('INVALID_ARGUMENTS', 'search 需要 query。');
  const cached = recall('', trimmed);
  if (cached) return cached.slice(0, limit);
  const errors = [];
  let raw = [];
  try {
    const response = await request('https://html.duckduckgo.com/html/', { method: 'POST', body: new URLSearchParams({ q: trimmed }).toString(), signal });
    raw = parseDuckDuckGo(await readText(response));
  } catch (error) {
    errors.push('duckduckgo: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (!raw.length) {
    try {
      const response = await request('https://www.bing.com/search?q=' + encodeURIComponent(trimmed) + '&setlang=zh-Hans', { signal });
      raw = parseBing(await readText(response));
    } catch (error) {
      errors.push('bing: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (!raw.length) {
    throw new WorkspaceError('WEB_SEARCH_FAILED', '搜索没有拿到结果。' + (errors.length ? ' ' + errors.join('; ') : ''));
  }
  const results = raw.slice(0, WEB_SEARCH_LIMIT).map((item, index) => ({
    id: 'r' + (index + 1),
    title: item.title.slice(0, 200),
    url: item.url,
    domain: domainOf(item.url),
    snippet: item.snippet.slice(0, 400),
  }));
  remember('(default)', trimmed, results);
  return results.slice(0, Math.min(limit, results.length));
}

function extractPage(html, base) {
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

async function open(target, maxChars, signal) {
  const value = String(target ?? '').trim();
  if (!value) throw new WorkspaceError('INVALID_ARGUMENTS', 'open 需要 target（结果 id 或网址）。');
  let url = value;
  if (/^r\d+$/.test(value)) {
    const hit = findByAlias('', value);
    if (!hit) throw new WorkspaceError('WEB_UNKNOWN_ALIAS', '找不到结果 ' + value + '，请先 search 或直接给出完整网址。');
    url = hit.url;
  }
  if (!/^https?:\/\//i.test(url)) throw new WorkspaceError('INVALID_ARGUMENTS', 'open 的 target 必须是 http(s) 网址或结果 id。');
  const response = await request(url, { signal });
  const contentType = response.headers.get('content-type') ?? '';
  const body = await readText(response);
  if (!/html|xml|text/i.test(contentType)) throw new WorkspaceError('WEB_NOT_HTML', '该地址不是网页文本：' + contentType);
  const page = extractPage(body, response.url || url);
  return {
    url: response.url || url,
    title: page.title,
    description: page.description,
    text: lines(page.text, maxChars),
    links: page.links,
    truncated: page.text.length > maxChars,
  };
}

export async function runWebTool(args = {}, { signal, root = '' } = {}) {
  const action = args.action;
  if (action === 'search') {
    const results = await search(args.query, Math.min(Number(args.limit ?? 5) || 5, WEB_SEARCH_LIMIT), signal);
    remember(root, String(args.query ?? '').trim(), results);
    return { action, query: args.query, results, hint: '挑一条用 action=open, target=r几；也可以直接给网址。' };
  }
  if (action === 'open') {
    const resolution = /^r\d+$/.test(String(args.target ?? '').trim()) ? findByAlias(root, String(args.target).trim()) : null;
    if (resolution) remember(root, resolution.url, [resolution]);
    const page = await open(args.target, Math.min(Math.max(Number(args.maxChars ?? 4000) || 4000, 500), 20000), signal);
    return { action, ...page, hint: '需要更多正文时加大 maxChars。' };
  }
  throw new WorkspaceError('INVALID_ARGUMENTS', 'action 只能是 search 或 open。');
}
