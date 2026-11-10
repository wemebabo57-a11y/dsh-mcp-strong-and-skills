import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { WorkspaceError } from './workspace.mjs';

const IDLE_MS = 3 * 60 * 1000;
const NAV_TIMEOUT = 20000;
const VIEWPORT = { width: 1280, height: 900 };

export const BROWSE_TOOL = Object.freeze({
  name: 'strong_browse',
  description: '后台无窗口的真实 Chrome/Edge 浏览器：open、snapshot 读正文、screenshot 截图（视觉模型可直接看）、click/type/press、scroll、wait、close。文本模型改用 strong_web。',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'snapshot', 'screenshot', 'click', 'type', 'press', 'scroll', 'wait', 'close'] },
      url: { type: 'string', maxLength: 2000 },
      selector: { type: 'string', maxLength: 500 },
      text: { type: 'string', maxLength: 2000 },
      key: { type: 'string', maxLength: 20 },
      y: { type: 'number' },
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

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    socket.addEventListener('message', event => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      if (!payload.id) return;
      const entry = this.pending.get(payload.id);
      if (!entry) return;
      this.pending.delete(payload.id);
      if (payload.error) entry.reject(new WorkspaceError('BROWSER_CDP_FAILED', payload.error.message || 'CDP 调用失败'));
      else entry.resolve(payload.result);
    });
    socket.addEventListener('close', () => this.closeAll());
    socket.addEventListener('error', () => this.closeAll());
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

async function startSession(executable) {
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
    return { executable, cdp, ...launched, queue: Promise.resolve(), pending: 0, lastUsed: Date.now(), shotSeq: 0, shotDir: path.join(launched.profile, 'shots') };
  } catch (error) {
    try { launched.child.kill('SIGKILL'); } catch {}
    children.delete(launched.child);
    await fs.rm(launched.profile, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function closeSession(session) {
  if (session.closing) return session.closing;
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
  if (existing && !existing.cdp.closed) { existing.lastUsed = Date.now(); return existing; }
  if (existing) sessions.delete(root);
  const pending = pendingSessions.get(root);
  if (pending) return pending;
  const promise = (async () => {
    const executable = options.browserPath || findBrowser();
    if (!executable) throw new WorkspaceError('BROWSER_NOT_FOUND', '没有找到 Chrome、Edge 或 Brave。请安装其中之一，或在设置里填写浏览器路径。');
    const session = await startSession(executable);
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

async function shot(cdp, session, fullPage = false) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(fullPage) });
  await fs.mkdir(session.shotDir, { recursive: true });
  session.shotSeq += 1;
  const file = path.join(session.shotDir, 'shot-' + session.shotSeq + '.png');
  await fs.writeFile(file, Buffer.from(result.data, 'base64'));
  let width = VIEWPORT.width;
  let height = VIEWPORT.height;
  if (fullPage) {
    const metrics = await cdp.send('Page.getLayoutMetrics').catch(() => null);
    const size = metrics?.cssContentSize;
    if (size) { width = Math.round(size.width); height = Math.round(size.height); }
  }
  return { path: file, mediaType: 'image/png', width, height, fullPage: Boolean(fullPage) };
}

const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, PageUp: 33, PageDown: 34, Home: 36, End: 35, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };

async function pressKey(cdp, key) {
  const code = KEY_CODES[key];
  if (!code) throw new WorkspaceError('INVALID_ARGUMENTS', 'press 只支持：' + Object.keys(KEY_CODES).join('、'));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}

function selectorExpression(selector, text, mode) {
  const find = selector
    ? 'document.querySelector(' + JSON.stringify(selector) + ')'
    : '[...document.querySelectorAll("a,button,input,textarea,[role=button]")].find(el => (el.innerText || el.value || el.getAttribute("aria-label") || "").includes(' + JSON.stringify(text ?? '') + '))';
  if (mode === 'click') return '(' + find + ')?.click(), true';
  return '(el => { if (!el) return false; el.focus(); if (el.select) el.select(); return true; })(' + find + ')';
}

async function typeText(cdp, selector, text) {
  const focus = selectorExpression(selector, text, 'focus');
  const found = await evaluate(cdp, focus);
  if (!found) return false;
  const value = String(text ?? '');
  try {
    await cdp.send('Input.insertText', { text: value });
  } catch {
    await evaluate(cdp, '(el => { if (!el) return false; const setter = Object.getOwnPropertyDescriptor(el.__proto__, "value")?.set; if (setter) setter.call(el, ' + JSON.stringify(value) + '); else el.value = ' + JSON.stringify(value) + '; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })(document.activeElement)');
  }
  await evaluate(cdp, '(() => { const el = document.activeElement; if (el) el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()').catch(() => {});
  return true;
}

async function runAction(session, args) {
  const action = args.action;
  const maxChars = Math.min(Math.max(Number(args.maxChars ?? 4000) || 4000, 500), 20000);
  if (action === 'close') {
    return { action, closed: true };
  }
  if (action === 'open') {
    const url = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw new WorkspaceError('INVALID_ARGUMENTS', 'open 需要 http(s) 网址。');
    await session.cdp.send('Page.navigate', { url });
    await waitReady(session.cdp);
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated };
  }
  if (action === 'snapshot') {
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated };
  }
  if (action === 'screenshot') {
    const state = await evaluate(session.cdp, PAGE_STATE);
    const image = await shot(session.cdp, session, args.fullPage === true);
    return { action, url: state.url, title: state.title, screenshot: image, note: '截图已保存：' + image.path };
  }
  if (action === 'click') {
    const done = await evaluate(session.cdp, selectorExpression(args.selector, args.text, 'click'));
    if (!done) throw new WorkspaceError('BROWSER_TARGET_MISSING', '没找到要点击的元素，请给出 selector 或可见文字。');
    await delay(200);
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated };
  }
  if (action === 'type') {
    const done = await typeText(session.cdp, args.selector, args.text);
    if (!done) throw new WorkspaceError('BROWSER_TARGET_MISSING', '没找到输入框，请给出 selector。');
    return { action, typed: String(args.text ?? '').length };
  }
  if (action === 'press') {
    await pressKey(session.cdp, String(args.key ?? 'Enter'));
    await delay(200);
    const state = await evaluate(session.cdp, PAGE_STATE);
    const body = clip(state.text, maxChars);
    return { action, url: state.url, title: state.title, text: body.text, truncated: body.truncated };
  }
  if (action === 'scroll') {
    const offset = Number.isFinite(Number(args.y ?? 600)) ? Number(args.y ?? 600) : 600;
    const position = await evaluate(session.cdp, 'window.scrollBy(0, ' + offset + '), window.scrollY');
    return { action, scrollY: position };
  }
  if (action === 'wait') {
    const requested = Math.min(Math.max(Number(args.ms ?? 1000) || 0, 0), 30000);
    const started = Date.now();
    await delay(requested);
    return { action, waitedMs: Date.now() - started };
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
    await closeQueued(session);
    return { action, closed: true };
  }
  const session = await sessionFor(key, config);
  session.lastUsed = Date.now();
  session.pending += 1;
  const work = session.queue.then(async () => {
    signal?.throwIfAborted();
    const result = await runAction(session, args);
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
    clearInterval(session.timer);
    await closeSession(session).catch(() => {});
  }
}

process.once('exit', () => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
});
