import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { WorkspaceError } from './workspace.mjs';
import { assertPublicUrl } from './web-tools.mjs';

const IDLE_MS = 3 * 60 * 1000;
const NAV_TIMEOUT = 20000;
const VIEWPORT = { width: 1280, height: 900 };

export const BROWSE_TOOL = Object.freeze({
  name: 'strong_browse',
  description: '无窗口真实 Chrome/Edge。open 打开网址；snapshot 取正文和可交互元素；view 返回正文与截图；screenshot 保存截图；click/hover/drag/mouse 真实鼠标；type 写输入框（无 selector 写当前焦点）；press 支持组合键（Ctrl+A 等）；scroll/wait/close；多命中用 index 选第几个。只取文本优先 strong_web。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'snapshot', 'view', 'screenshot', 'click', 'hover', 'drag', 'mouse', 'type', 'press', 'scroll', 'wait', 'close'] },
      url: { type: 'string', maxLength: 2000 },
      selector: { type: 'string', maxLength: 500 },
      text: { type: 'string', maxLength: 2000 },
      index: { type: 'integer', minimum: 1 },
      key: { type: 'string', maxLength: 20 },
      x: { type: 'number' },
      y: { type: 'number' },
      toX: { type: 'number' },
      toY: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clickCount: { type: 'integer', minimum: 1, maximum: 3 },
      ms: { type: 'integer', minimum: 0, maximum: 30000 },
      fullPage: { type: 'boolean' },
      maxChars: { type: 'integer', minimum: 500, maximum: 20000 },
    },
    required: ['action'],
    additionalProperties: false,
  },
});

const sessions = new Map();
const pendingSessions = new Map();
const children = new Set();
// Roots closed by an explicit close action; actions on them must fail instead
// of silently relaunching a blank session.
const closedRoots = new Set();

function browserCandidates() {
  const env = process.env;
  const custom = String(env.DSH_STRONG_BROWSER_PATH ?? '').trim();
  const candidates = custom ? [custom] : [];
  if (process.platform === 'win32') {
    for (const base of [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (!base) continue;
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
      candidates.push(path.join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return candidates;
}

export function findBrowser() {
  for (const candidate of browserCandidates()) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return '';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new WorkspaceError('ABORTED', 'Operation cancelled.');
}

// Read-only actions that do not need an in-flight wait to run out first.
export const WAIT_SHORTCUTS = Object.freeze(['snapshot', 'view', 'screenshot']);

/**
 * One interruptible sleep per browser session. A queued snapshot, screenshot or
 * close wakes the waiter instead of sitting behind the full 30 s a model asked
 * for; a wait that runs alone still sleeps for its whole duration.
 */
export class WaitGate {
  constructor() {
    this.pending = null;
    this.revision = 0;
  }

  get active() {
    return Boolean(this.pending);
  }

  wake() {
    const waiter = this.pending;
    if (!waiter) return false;
    this.revision += 1;
    waiter.finish(true);
    return true;
  }

  wait(ms, signal) {
    const requested = Math.max(0, Number(ms) || 0);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!requested) return Promise.resolve({ waitedMs: 0, interrupted: false });
    this.wake();
    const seen = this.revision;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let onAbort = null;
      const waiter = {
        timer: null,
        finish: (interrupted, error) => {
          if (this.pending !== waiter) return;
          this.pending = null;
          clearTimeout(waiter.timer);
          if (onAbort) signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve({ waitedMs: Date.now() - started, interrupted });
        },
      };
      onAbort = () => waiter.finish(false, abortReason(signal));
      this.pending = waiter;
      waiter.timer = setTimeout(() => waiter.finish(false), requested);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) waiter.finish(false, abortReason(signal));
      else if (this.revision !== seen) waiter.finish(true);
    });
  }
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    socket.addEventListener('message', event => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      if (!payload.id) {
        const handlers = this.listeners.get(payload.method);
        if (handlers) for (const handler of handlers) { try { handler(payload.params); } catch { /* listener error is non-fatal */ } }
        return;
      }
      const entry = this.pending.get(payload.id);
      if (!entry) return;
      this.pending.delete(payload.id);
      if (payload.error) entry.reject(new WorkspaceError('BROWSER_CDP_FAILED', payload.error.message || 'CDP 调用失败'));
      else entry.resolve(payload.result);
    });
    socket.addEventListener('close', () => this.closeAll());
    socket.addEventListener('error', () => this.closeAll());
  }

  on(method, handler) {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => {
      const next = (this.listeners.get(method) ?? []).filter(item => item !== handler);
      if (next.length) this.listeners.set(method, next); else this.listeners.delete(method);
    };
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { try { socket.close(); } catch {} reject(new WorkspaceError('BROWSER_TIMEOUT', '连接浏览器调试端口超时。')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new WorkspaceError('BROWSER_CDP_FAILED', '无法连接浏览器调试端口。')); }, { once: true });
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new WorkspaceError('BROWSER_CLOSED', '浏览器会话已关闭。'));
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); reject(new WorkspaceError('BROWSER_CDP_FAILED', error.message)); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new WorkspaceError('BROWSER_TIMEOUT', method + ' 超时')); }
      }, NAV_TIMEOUT).unref?.();
    });
  }

  closeAll() {
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new WorkspaceError('BROWSER_CLOSED', '浏览器连接已断开。'));
    this.pending.clear();
  }

  close() {
    try { this.socket.close(); } catch {}
    this.closeAll();
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new WorkspaceError('BROWSER_LAUNCH_FAILED', '浏览器调试端口无响应：' + response.status);
  return response.json();
}

async function launch(executable) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-strong-browse-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=' + VIEWPORT.width + ',' + VIEWPORT.height,
    'about:blank',
  ];
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: false });
  children.add(child);
  try {
    let buffer = '';
    let port = 0;
    const wsUrl = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new WorkspaceError('BROWSER_TIMEOUT', '浏览器启动超时。')), 20000);
      const onData = chunk => {
        buffer += String(chunk);
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
        if (!match) return;
        const parsed = /:(\d+)\//.exec(match[1]);
        port = parsed ? Number(parsed[1]) : 0;
        finish(null, match[1]);
      };
      child.stderr.on('data', onData);
      child.stdout.on('data', onData);
      child.once('error', error => finish(new WorkspaceError('BROWSER_LAUNCH_FAILED', '无法启动浏览器：' + error.message)));
      child.once('close', code => finish(new WorkspaceError('BROWSER_LAUNCH_FAILED', '浏览器提前退出（' + code + '）。')));
    });
    return { child, profile, port, wsUrl };
  } catch (error) {
    try { child.kill('SIGKILL'); } catch {}
    children.delete(child);
    await delay(80);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function pageTarget(list) {
  const pages = list.filter(item => item.type === 'page' && item.webSocketDebuggerUrl);
  return pages[0] ?? null;
}

// Every HTTP(S) request the browser makes — navigation, redirect, subresource,
// fetch() from page scripts — is paused here and checked against the same
// public-address policy as strong_web. Without this, open() bypassed SSRF
// protection entirely and a public page could still reach metadata endpoints.
async function guardBrowserRequest(cdp, params, session) {
  const requestId = params?.requestId;
  const raw = params?.request?.url;
  if (!requestId || typeof raw !== 'string') return;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      await cdp.send('Fetch.continueRequest', { requestId });
      return;
    }
    await assertPublicUrl(url, session.allowPrivate === true);
    await cdp.send('Fetch.continueRequest', { requestId });
  } catch {
    // Policy denials and DNS failures both fail closed.
    await cdp.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' }).catch(() => {});
  }
}

async function startSession(executable, options = {}) {
  const launched = await launch(executable);
  try {
    let target = pageTarget(await fetchJson('http://127.0.0.1:' + launched.port + '/json/list'));
    if (!target) {
      await delay(200);
      target = pageTarget(await fetchJson('http://127.0.0.1:' + launched.port + '/json/list'));
    }
    if (!target) throw new WorkspaceError('BROWSER_LAUNCH_FAILED', '浏览器没有可用页面。');
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable').catch(() => {});
    await cdp.send('Runtime.enable').catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    const session = { executable, cdp, ...launched, queue: Promise.resolve(), gate: new WaitGate(), pending: 0, lastUsed: Date.now(), shotSeq: 0, shotDir: path.join(launched.profile, 'shots'), allowPrivate: options.webAllowPrivate === true };
    cdp.on('Fetch.requestPaused', params => { void guardBrowserRequest(cdp, params, session); });
    // Do not silently continue when the guard cannot be installed.
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*', requestStage: 'Request' }, { urlPattern: 'https://*', requestStage: 'Request' }] });
    return session;
  } catch (error) {
    try { launched.child.kill('SIGKILL'); } catch {}
    children.delete(launched.child);
    await fs.rm(launched.profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function closeSession(session) {
  if (session.closing) return session.closing;
  session.gate?.wake();
  session.closing = (async () => {
    session.cdp.close();
    try { session.child.kill('SIGKILL'); } catch {}
    children.delete(session.child);
    await delay(80);
    await fs.rm(session.profile, { recursive: true, force: true }).catch(() => {});
  })();
  return session.closing;
}

async function closeQueued(session) {
  const work = session.queue.then(() => closeSession(session));
  session.queue = work.catch(() => {});
  return work;
}

async function sessionFor(root, options) {
  const existing = sessions.get(root);
  if (existing && !existing.cdp.closed) { existing.lastUsed = Date.now(); existing.allowPrivate = options.webAllowPrivate === true; return existing; }
  if (existing) sessions.delete(root);
  const pending = pendingSessions.get(root);
  if (pending) return pending;
  const promise = (async () => {
    const executable = options.browserPath || findBrowser();
    if (!executable) throw new WorkspaceError('BROWSER_NOT_FOUND', '没有找到 Chrome、Edge 或 Brave。请安装其中之一，或在设置里填写浏览器路径。');
    const session = await startSession(executable, options);
    session.timer = setInterval(() => {
      if (session.pending > 0 || Date.now() - session.lastUsed < IDLE_MS) return;
      clearInterval(session.timer);
      sessions.delete(root);
      closeSession(session).catch(() => {});
    }, 30000);
    session.timer.unref?.();
    sessions.set(root, session);
    return session;
  })();
  pendingSessions.set(root, promise);
  try {
    return await promise;
  } finally {
    pendingSessions.delete(root);
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new WorkspaceError('BROWSER_SCRIPT_FAILED', result.exceptionDetails.text || '页面脚本出错');
  return result.result?.value;
}

const PAGE_STATE = '(() => ({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n") }))()';

async function waitReady(cdp) {
  const started = Date.now();
  while (Date.now() - started < NAV_TIMEOUT) {
    const state = await evaluate(cdp, 'document.readyState').catch(() => '');
    if (state === 'complete') { await delay(150); return; }
    await delay(200);
  }
}

function clip(text, maxChars) {
  const value = String(text ?? '');
  return { text: value.slice(0, maxChars), truncated: value.length > maxChars };
}

async function shot(cdp, session, fullPage = false, { format = 'png', quality = null } = {}) {
  const type = format === 'jpeg' ? 'jpeg' : 'png';
  const params = { format: type, captureBeyondViewport: Boolean(fullPage) };
  if (type === 'jpeg' && Number.isFinite(quality)) params.quality = Math.min(Math.max(Math.round(quality), 1), 100);
  const result = await cdp.send('Page.captureScreenshot', params);
  await fs.mkdir(session.shotDir, { recursive: true });
  session.shotSeq += 1;
  const file = path.join(session.shotDir, 'shot-' + session.shotSeq + (type === 'jpeg' ? '.jpg' : '.png'));
  await fs.writeFile(file, Buffer.from(result.data, 'base64'));
  let width = VIEWPORT.width;
  let height = VIEWPORT.height;
  if (fullPage) {
    const metrics = await cdp.send('Page.getLayoutMetrics').catch(() => null);
    const size = metrics?.cssContentSize;
    if (size) { width = Math.round(size.width); height = Math.round(size.height); }
  }
  return { path: file, mediaType: type === 'jpeg' ? 'image/jpeg' : 'image/png', width, height, fullPage: Boolean(fullPage) };
}

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, PageUp: 33, PageDown: 34, Home: 36, End: 35, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
const MODIFIER_CODES = { ctrl: 2, control: 2, alt: 1, option: 1, shift: 8, meta: 4, cmd: 4, command: 4, win: 4 };

// "Ctrl+A" / "Ctrl+Enter" / "Shift+a" → CDP key parameters: modifier mask,
// virtual key code and the character a printable key inserts. Named keys come
// from KEY_CODES; single letters and digits map to US-layout virtual keys.
export function parseKey(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) throw new WorkspaceError('INVALID_ARGUMENTS', 'press 需要 key，例如 Enter、Ctrl+A、Ctrl+Enter。');
  const tokens = raw.split('+').map((part) => part.trim());
  if (tokens.some((part) => !part)) throw new WorkspaceError('INVALID_ARGUMENTS', '无法识别按键：' + raw);
  const name = tokens[tokens.length - 1];
  let mask = 0;
  for (const token of tokens.slice(0, -1)) {
    const code = MODIFIER_CODES[token.toLowerCase()];
    if (!code) throw new WorkspaceError('INVALID_ARGUMENTS', '不支持的修饰键：只支持 Ctrl/Alt/Shift/Meta，例如 Ctrl+A、Ctrl+Enter。');
    mask |= code;
  }
  const canonical = name.length === 1 ? name : name.charAt(0).toUpperCase() + name.slice(1);
  const special = KEY_CODES[canonical];
  if (special) return { key: canonical, code: special, mask, text: undefined };
  if (/^[a-zA-Z]$/.test(name)) {
    const key = (mask & MODIFIER_CODES.shift) ? name.toUpperCase() : name.toLowerCase();
    return { key, code: key.toUpperCase().charCodeAt(0), mask, text: (mask & (MODIFIER_CODES.ctrl | MODIFIER_CODES.alt | MODIFIER_CODES.meta)) ? undefined : key };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: 48 + Number(name), mask, text: (mask & (MODIFIER_CODES.ctrl | MODIFIER_CODES.alt | MODIFIER_CODES.meta)) ? undefined : name };
  }
  throw new WorkspaceError('INVALID_ARGUMENTS', '不支持的按键：' + name + '。支持 Enter/Tab/Escape/Backspace/Delete/PageUp/PageDown/Home/End/Arrow*、单个字母或数字，可加 Ctrl/Alt/Shift/Meta。');
}

async function pressKey(cdp, parsed) {
  const down = { type: 'keyDown', key: parsed.key, windowsVirtualKeyCode: parsed.code, nativeVirtualKeyCode: parsed.code, modifiers: parsed.mask };
  if (parsed.text) down.text = parsed.text;
  await cdp.send('Input.dispatchKeyEvent', down);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: parsed.key, windowsVirtualKeyCode: parsed.code, nativeVirtualKeyCode: parsed.code, modifiers: parsed.mask });
}

const TEXT_TARGETS = 'a,button,input,textarea,select,[role=button],[role=menuitem],[role=option],[role=tab],[role=link],[contenteditable=true],li,div,span,label,p,h1,h2,h3,h4,h5,h6';

// Resolve a selector or visible text to one element. Both modes prefer visible
// matches (the first hidden duplicate must not win, e.g. an input cloned
// off-screen), support a 1-based index into the ordered matches, and the text
// search also covers plain li/div/span menus, not only buttons.
function findExpression(selector, text, index) {
  const nth = Math.max(1, Math.floor(Number(index) || 1)) - 1;
  const locate = selector
    ? 'const matches = [...document.querySelectorAll(' + JSON.stringify(selector) + ')];'
    : 'const needle = ' + JSON.stringify(text ?? '') + ';'
      + ' const matches = [...document.querySelectorAll("' + TEXT_TARGETS + '")].slice(0, 800)'
      + ' .map(el => ({ el, label: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim() }))'
      + ' .filter(item => item.label && item.label.includes(needle))'
      + ' .sort((a, b) => { const at = a.label === needle ? 0 : a.label.length; const bt = b.label === needle ? 0 : b.label.length; return at - bt; })'
      + ' .map(item => item.el);';
  return '(function () { ' + locate
    + ' const visible = matches.filter(el => { const r = el.getBoundingClientRect(); return r && r.width > 0 && r.height > 0; });'
    + ' const ordered = visible.length ? visible : matches;'
    + ' return ordered.length > ' + nth + ' ? ordered[' + nth + '] : null; })()';
}

export function selectorExpression(selector, text, mode, index) {
  const find = findExpression(selector, text, index);
  if (mode === 'click') return '(el => { if (!el) return false; el.click(); return true; })(' + find + ')';
  return '(el => { if (!el) return false; el.focus(); if (el.select) el.select(); return true; })(' + find + ')';
}

// Resolve an element to viewport CSS pixels so clicks go through the same
// hit-testing as a real pointer instead of el.click() (which bypasses overlays
// and does not fire pointer/mouse coordinates).
function targetExpression(selector, text, index) {
  const find = findExpression(selector, text, index);
  return '(() => { const el = ' + find + '; if (!el) return { found: false };'
    + ' el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });'
    + ' const r = el.getBoundingClientRect();'
    + ' if (!r || r.width < 1 || r.height < 1) return { found: true, visible: false, tag: (el.tagName || "").toLowerCase() };'
    + ' const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 100);'
    + ' return { found: true, visible: true, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, tag: (el.tagName || "").toLowerCase(), label };'
    + ' })()';
}

async function elementPoint(cdp, selector, text, index) {
  const target = await evaluate(cdp, targetExpression(selector, text, index));
  if (!target?.found) throw new WorkspaceError('BROWSER_TARGET_MISSING', '没找到目标元素，请给出 selector 或可见文字。');
  if (!target.visible) throw new WorkspaceError('BROWSER_TARGET_MISSING', '目标元素不可见（宽高为 0）。');
  if (target.x < 0 || target.y < 0 || target.x > VIEWPORT.width || target.y > VIEWPORT.height) {
    throw new WorkspaceError('BROWSER_TARGET_MISSING', '目标元素不在可视区域内。');
  }
  await delay(60);
  return target;
}

const BUTTON_MASK = { left: 1, right: 2, middle: 4 };

async function mouseClick(cdp, point, { button = 'left', clickCount = 1 } = {}) {
  const mask = BUTTON_MASK[button] ?? 1;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  for (let index = 1; index <= clickCount; index++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons: mask, clickCount: index });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: index });
    if (index < clickCount) await delay(40);
  }
}

async function mouseDrag(cdp, from, to, button = 'left') {
  const mask = BUTTON_MASK[button] ?? 1;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button, buttons: mask, clickCount: 1 });
  const steps = 12;
  for (let index = 1; index <= steps; index++) {
    const x = from.x + ((to.x - from.x) * index) / steps;
    const y = from.y + ((to.y - from.y) * index) / steps;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button, buttons: mask });
    await delay(10);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button, buttons: 0, clickCount: 1 });
}

const INTERACTIVE_STATE = '(() => { const out = []; const nodes = [...document.querySelectorAll("a,button,input,textarea,select,[role=button],[contenteditable=true]")];'
  + ' for (const el of nodes) { const r = el.getBoundingClientRect(); if (!r || r.width < 1 || r.height < 1) continue;'
  + ' out.push({ tag: (el.tagName || "").toLowerCase(), text: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80),'
  + ' id: el.id || undefined, name: el.name || undefined, type: el.type || undefined, href: el.href || undefined, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });'
  + ' if (out.length >= 40) break; } return out; })()';

// Without a selector, type into the element that currently has focus (the one
// a previous click left focused); with a selector, focus that element first.
const EDITABLE_FOCUS = '(() => { const el = document.activeElement; if (!el || el === document.body) return false;'
  + ' const tag = (el.tagName || "").toLowerCase();'
  + ' return tag === "input" || tag === "textarea" || el.isContentEditable === true; })()';

async function typeText(cdp, selector, index, text) {
  if (selector) {
    const found = await evaluate(cdp, selectorExpression(selector, '', 'focus', index));
    if (!found) throw new WorkspaceError('BROWSER_TARGET_MISSING', '没找到输入框：请给出 selector，或先用 click 聚焦输入框。');
  } else if (!(await evaluate(cdp, EDITABLE_FOCUS))) {
    throw new WorkspaceError('BROWSER_TARGET_MISSING', '当前焦点不是输入框：请先 click 输入框，或用 selector 指定目标。');
  }
  const value = String(text ?? '');
  try {
    await cdp.send('Input.insertText', { text: value });
  } catch {
    await evaluate(cdp, '(el => { if (!el) return false; const setter = Object.getOwnPropertyDescriptor(el.__proto__, "value")?.set; if (setter) setter.call(el, ' + JSON.stringify(value) + '); else el.value = ' + JSON.stringify(value) + '; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })(document.activeElement)');
  }
  await evaluate(cdp, '(() => { const el = document.activeElement; if (el) el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()').catch(() => {});
  return true;
}

async function runAction(session, args, signal) {
  const action = args.action;
  const maxChars = Math.min(Math.max(Number(args.maxChars ?? 4000) || 4000, 500), 20000);
  if (action === 'close') {
    return { action, closed: true };
  }
  if (action === 'open') {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new WorkspaceError('INVALID_ARGUMENTS', 'open 需要 http(s) 网址。');
    // Fail with a clear policy error before navigation; the Fetch guard below
    // still covers redirects and page-issued requests.
    await assertPublicUrl(new URL(url), session.allowPrivate === true);
    const navigation = await session.cdp.send('Page.navigate', { url });
    if (navigation?.errorText) throw new WorkspaceError('BROWSER_NAVIGATION_FAILED', '导航失败：' + navigation.errorText);
    await waitReady(session.cdp);
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated };
  }
  if (action === 'snapshot') {
    const state = await evaluate(session.cdp, PAGE_STATE);
    const elements = await evaluate(session.cdp, INTERACTIVE_STATE).catch(() => []);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated, elements };
  }
  if (action === 'view') {
    const state = await evaluate(session.cdp, PAGE_STATE);
    const elements = await evaluate(session.cdp, INTERACTIVE_STATE).catch(() => []);
    const image = await shot(session.cdp, session, args.fullPage === true, { format: 'jpeg', quality: 78 });
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated, elements, screenshot: image, note: '已返回页面截图：' + image.path };
  }
  if (action === 'screenshot') {
    const state = await evaluate(session.cdp, PAGE_STATE);
    const image = await shot(session.cdp, session, args.fullPage === true);
    return { action, url: state.url, title: state.title, screenshot: image, note: '截图已保存：' + image.path };
  }
  if (action === 'click') {
    const point = await elementPoint(session.cdp, args.selector, args.text, args.index);
    await mouseClick(session.cdp, point, { button: args.button ?? 'left', clickCount: args.clickCount ?? 1 });
    await delay(300);
    await waitReady(session.cdp).catch(() => {});
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated, clicked: { tag: point.tag, label: point.label, x: point.x, y: point.y } };
  }
  if (action === 'hover') {
    const point = await elementPoint(session.cdp, args.selector, args.text, args.index);
    await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
    await delay(200);
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated, hovered: { tag: point.tag, label: point.label, x: point.x, y: point.y } };
  }
  if (action === 'drag') {
    const from = await elementPoint(session.cdp, args.selector, args.text, args.index);
    const toX = Number(args.toX);
    const toY = Number(args.toY);
    if (!Number.isFinite(toX) || !Number.isFinite(toY)) throw new WorkspaceError('INVALID_ARGUMENTS', 'drag 需要 toX 和 toY（目标坐标，可先用 snapshot 的 elements 取得）。');
    await mouseDrag(session.cdp, from, { x: toX, y: toY }, args.button ?? 'left');
    await delay(200);
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated, dragged: { from: { x: from.x, y: from.y, tag: from.tag }, to: { x: toX, y: toY } } };
  }
  if (action === 'mouse') {
    let point;
    if (args.selector || args.text) point = await elementPoint(session.cdp, args.selector, args.text, args.index);
    else {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new WorkspaceError('INVALID_ARGUMENTS', 'mouse 需要 x、y 或 selector/text。');
      point = { x, y, tag: 'coordinate', label: '' };
    }
    await mouseClick(session.cdp, point, { button: args.button ?? 'left', clickCount: args.clickCount ?? 1 });
    await delay(200);
    // Coordinate clicks return the clicked point only: the full page body is
    // fetched separately via snapshot/view, not paid for on every mouse move.
    return { action, clicked: { tag: point.tag, label: point.label, x: point.x, y: point.y }, note: '坐标点击不返回页面正文；需要内容用 snapshot 或 view。' };
  }
  if (action === 'type') {
    await typeText(session.cdp, args.selector, args.index, args.text);
    return { action, typed: String(args.text ?? '').length };
  }
  if (action === 'press') {
    await pressKey(session.cdp, parseKey(args.key ?? 'Enter'));
    await delay(200);
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated };
  }
  if (action === 'scroll') {
    const offset = Number.isFinite(Number(args.y ?? 600)) ? Number(args.y ?? 600) : 600;
    const x = Number.isFinite(Number(args.x)) ? Number(args.x) : VIEWPORT.width / 2;
    const y = VIEWPORT.height / 2;
    // A real wheel event scrolls nested scroll containers and fires the same
    // listeners as user input; window.scrollBy() did neither.
    await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: offset });
    await delay(150);
    const position = await evaluate(session.cdp, 'window.scrollY');
    return { action, scrollY: position };
  }
  if (action === 'wait') {
    const requested = Math.min(Math.max(Number(args.ms ?? 1000) || 0, 0), 30000);
    const outcome = await session.gate.wait(requested, signal);
    return { action, waitedMs: outcome.waitedMs, ...(outcome.interrupted ? { interrupted: true } : {}) };
  }
  throw new WorkspaceError('INVALID_ARGUMENTS', '不支持的 action：' + action);
}

export async function runBrowseTool(args = {}, { root = '', config = {}, signal } = {}) {
  signal?.throwIfAborted();
  const action = args.action;
  if (!action) throw new WorkspaceError('INVALID_ARGUMENTS', '需要 action。');
  const key = typeof root === 'string' && root ? root : '(default)';
  if (action === 'close') {
    const launched = pendingSessions.get(key);
    if (launched) await launched.catch(() => {});
    const session = sessions.get(key);
    if (!session) return { action, closed: true, note: '当前没有运行中的浏览器。' };
    sessions.delete(key);
    clearInterval(session.timer);
    session.gate.wake();
    await closeQueued(session);
    // Remember the explicit close: later actions fail instead of silently
    // relaunching a blank session; the caller has to open a URL again.
    closedRoots.add(key);
    return { action, closed: true };
  }
  if (closedRoots.has(key)) throw new WorkspaceError('BROWSER_NOT_OPEN', '浏览器已用 close 关闭；请先用 action=open 重新打开网址。');
  const session = await sessionFor(key, config);
  closedRoots.delete(key);
  session.lastUsed = Date.now();
  session.pending += 1;
  // A read-only snapshot or screenshot does not need the page to sit still, so
  // cut an in-flight wait short instead of queueing up to 30 s behind it.
  if (WAIT_SHORTCUTS.includes(action)) session.gate.wake();
  const work = session.queue.then(async () => {
    signal?.throwIfAborted();
    const result = await runAction(session, args, signal);
    session.lastUsed = Date.now();
    return result;
  });
  session.queue = work.catch(() => {});
  try {
    return await work;
  } catch (error) {
    session.lastUsed = Date.now();
    throw error;
  } finally {
    session.pending = Math.max(0, session.pending - 1);
  }
}

export async function closeAllBrowsers() {
  for (const [key, session] of sessions) {
    sessions.delete(key);
    closedRoots.add(key);
    clearInterval(session.timer);
    await closeSession(session).catch(() => {});
  }
}

process.once('exit', () => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
});
