import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { braceExpand, compileSegment, hasMagic, matchSegment } from './glob.mjs';

export class ShellError extends Error {
  constructor(code, vpath, note) {
    const text = note ?? ERRNO_TEXT[code];
    super(text ? text + (vpath ? ': ' + vpath : '') : code);
    this.name = 'ShellError';
    this.code = code;
    this.vpath = vpath ?? '';
    this.note = note ?? null;
  }
}

export const ERRNO_TEXT = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EOUTSIDE: '路径超出项目目录或经符号链接逃逸（Permission denied）',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  EEXIST: 'File exists',
  EROFS: '沙箱为 read-only，禁止写入（Read-only file system）',
  EFBIG: 'File too large',
  EINVAL: 'Invalid argument',
  EBUSY: 'Device or resource busy',
  ELOOP: 'Too many levels of symbolic links',
  ENOSPC: 'No space left on device',
  EXDEV: 'Invalid cross-device link',
  ENOTEMPTY: 'Directory not empty',
};

const DEVICES = new Map([
  ['/dev/null', 'null'],
  ['/dev/stdout', 'stdout'],
  ['/dev/stderr', 'stderr'],
  ['/dev/tty', 'stdout'],
  ['/dev/zero', 'zero'],
]);

const isWindows = process.platform === 'win32';
const MAX_READ = 256 * 1024;

function toSlash(value) {
  return value.replace(/\\/g, '/');
}

function inside(root, target) {
  const a = isWindows ? root.toLowerCase() : root;
  const b = isWindows ? target.toLowerCase() : target;
  if (b === a) return true;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

function splitPath(value) {
  return toSlash(value).split('/').filter(segment => segment.length && segment !== '.');
}

export function joinVirtual(base, name) {
  if (!base || base === '/') return '/' + name;
  return base.replace(/\/+$/, '') + '/' + name;
}

export function dirVirtual(vpath) {
  const at = vpath.lastIndexOf('/');
  if (at <= 0) return '/';
  return vpath.slice(0, at);
}

export function baseVirtual(vpath) {
  const trimmed = vpath.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

export function normalizeVirtual(vpath) {
  const out = [];
  for (const segment of splitPath(vpath)) {
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return '/' + out.join('/');
}

export function createFs(options = {}) {
  const rootHost = path.resolve(options.root ?? process.cwd());
  let rootReal = rootHost;
  try { rootReal = fsSync.realpathSync.native(rootHost); } catch { rootReal = rootHost; }
  const mode = options.mode ?? 'unconfined';
  const readOnly = mode === 'read-only';
  const realCache = new Map();

  function realOf(host) {
    const cached = realCache.get(host);
    if (cached !== undefined) return cached;
    let value = null;
    try { value = fsSync.realpathSync.native(host); } catch { value = null; }
    if (realCache.size < 4096) realCache.set(host, value);
    return value;
  }

  function assertWritable(vpath) {
    if (readOnly) throw new ShellError('EROFS', vpath);
  }

  /** Resolve a user path to {device} or {host, vpath}. Throws on escape. */
  function resolve(input, cwd = '/') {
    let value = String(input ?? '');
    if (!value) throw new ShellError('ENOENT', '');
    value = toSlash(value);
    const device = DEVICES.get(normalizeVirtual(value));
    if (device) return { device, vpath: normalizeVirtual(value) };
    let absolute = false;
    let relative = value;
    if (value.startsWith('/')) {
      absolute = true;
      relative = value.slice(1);
    } else if (/^[A-Za-z]:\//.test(value)) {
      const host = path.resolve(value);
      const real = realOf(host) ?? realOf(path.dirname(host));
      const target = real ?? host;
      if (!inside(rootReal, target) && !inside(rootHost, target)) throw new ShellError('EOUTSIDE', host);
      return { host, vpath: virtual(host) };
    }
    const base = absolute ? [] : splitPath(cwd);
    const parts = absolute ? splitPath(relative) : splitPath(relative);
    const segments = absolute ? [] : base;
    for (const segment of parts) {
      if (segment === '..') {
        if (!segments.length) throw new ShellError('EOUTSIDE', value);
        segments.pop();
      } else segments.push(segment);
    }
    const host = path.join(rootHost, ...segments);
    const vpath = '/' + segments.join('/');
    const real = realOf(host);
    if (real) {
      if (!inside(rootReal, real)) throw new ShellError('EOUTSIDE', vpath);
    } else {
      const parentReal = realOf(path.dirname(host));
      if (parentReal && !inside(rootReal, parentReal)) throw new ShellError('EOUTSIDE', vpath);
    }
    return { host, vpath };
  }

  function virtual(host) {
    const relative = path.relative(rootHost, path.resolve(host));
    if (!relative) return '/';
    const segments = toSlash(relative).split('/').filter(Boolean);
    return '/' + segments.join('/');
  }

  function target(input, cwd) {
    const entry = resolve(input, cwd);
    if (entry.device) throw new ShellError('EINVAL', entry.vpath, 'not a regular file');
    return entry;
  }

  function lstat(input, cwd) {
    const entry = resolve(input, cwd);
    if (entry.device) return { isFile: entry.device !== 'stdout' && entry.device !== 'stderr', isDir: false, isSymlink: false, isDevice: entry.device, size: 0, mtimeMs: 0, mode: 0o666 };
    try {
      const info = fsSync.lstatSync(entry.host);
      return { isFile: info.isFile(), isDir: info.isDirectory(), isSymlink: info.isSymbolicLink(), isDevice: null, size: info.size, mtimeMs: info.mtimeMs, mode: info.mode };
    } catch (error) {
      const code = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'ENOENT' : error.code === 'EACCES' ? 'EACCES' : 'EINVAL';
      throw new ShellError(code, entry.vpath);
    }
  }

  function stat(input, cwd) {
    const info = lstat(input, cwd);
    if (info.isSymlink) {
      const entry = resolve(input, cwd);
      try {
        const real = fsSync.statSync(entry.host);
        return { ...info, isFile: real.isFile(), isDir: real.isDirectory(), size: real.size, mode: real.mode, mtimeMs: real.mtimeMs };
      } catch {
        throw new ShellError('ENOENT', entry.vpath);
      }
    }
    return info;
  }

  function exists(input, cwd) {
    try { lstat(input, cwd); return true; } catch { return false; }
  }

  function readdir(input, cwd, opts = {}) {
    const entry = resolve(input, cwd);
    if (entry.device) throw new ShellError('ENOTDIR', entry.vpath);
    let list;
    try {
      list = fsSync.readdirSync(entry.host, { withFileTypes: true });
    } catch (error) {
      const code = error.code === 'ENOENT' ? 'ENOENT' : error.code === 'ENOTDIR' ? 'ENOTDIR' : error.code === 'EACCES' ? 'EACCES' : 'EINVAL';
      throw new ShellError(code, entry.vpath);
    }
    const out = list.map(item => ({ name: item.name, isDir: item.isDirectory(), isSymlink: item.isSymbolicLink(), isFile: item.isFile() }));
    if (!opts.all) out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  function readBuffer(input, cwd, opts = {}) {
    const entry = resolve(input, cwd);
    if (entry.device) {
      if (entry.device === 'null' || entry.device === 'stdout' || entry.device === 'stderr') return Buffer.alloc(0);
      if (entry.device === 'zero') return Buffer.alloc(Math.min(opts.maxBytes ?? MAX_READ, 8192));
    }
    const maxBytes = opts.maxBytes ?? MAX_READ;
    try {
      const info = fsSync.statSync(entry.host);
      if (info.isDirectory()) throw new ShellError('EISDIR', entry.vpath);
      if (info.size > maxBytes) throw new ShellError('EFBIG', entry.vpath);
      return fsSync.readFileSync(entry.host);
    } catch (error) {
      if (error instanceof ShellError) throw error;
      const code = error.code === 'ENOENT' ? 'ENOENT' : error.code === 'EISDIR' ? 'EISDIR' : error.code === 'EACCES' ? 'EACCES' : 'EINVAL';
      throw new ShellError(code, entry.vpath);
    }
  }

  function readText(input, cwd, opts = {}) {
    return readBuffer(input, cwd, opts).toString('utf8');
  }

  function writeText(input, cwd, text, opts = {}) {
    const entry = resolve(input, cwd);
    if (entry.device) {
      if (entry.device === 'null' || entry.device === 'zero') return { bytes: 0, device: entry.device };
      return { bytes: 0, device: entry.device };
    }
    assertWritable(entry.vpath);
    try {
      if (opts.append) fsSync.appendFileSync(entry.host, text, 'utf8');
      else fsSync.writeFileSync(entry.host, text, 'utf8');
      return { bytes: Buffer.byteLength(text) };
    } catch (error) {
      const code = error.code === 'ENOENT' ? 'ENOENT' : error.code === 'EISDIR' ? 'EISDIR' : error.code === 'EACCES' ? 'EACCES' : 'EINVAL';
      throw new ShellError(code, entry.vpath);
    }
  }

  function mkdirp(input, cwd) {
    const entry = resolve(input, cwd);
    assertWritable(entry.vpath);
    try { fsSync.mkdirSync(entry.host, { recursive: true }); }
    catch (error) { throw new ShellError(error.code === 'EEXIST' ? 'EEXIST' : 'EACCES', entry.vpath); }
  }

  function remove(input, cwd, opts = {}) {
    const entry = resolve(input, cwd);
    assertWritable(entry.vpath);
    const info = (() => { try { return fsSync.lstatSync(entry.host); } catch { return null; } })();
    if (!info) {
      if (opts.force) return false;
      throw new ShellError('ENOENT', entry.vpath);
    }
    try {
      fsSync.rmSync(entry.host, { recursive: Boolean(opts.recursive), force: Boolean(opts.force), maxRetries: 2 });
      return true;
    } catch (error) {
      if (error.code === 'ENOTEMPTY' || error.code === 'EISDIR') throw new ShellError('EISDIR', entry.vpath);
      if (error.code === 'ENOENT' && opts.force) return false;
      throw new ShellError(error.code === 'EACCES' ? 'EACCES' : 'EINVAL', entry.vpath);
    }
  }

  function rmdir(input, cwd) {
    const entry = resolve(input, cwd);
    assertWritable(entry.vpath);
    try { fsSync.rmdirSync(entry.host); }
    catch (error) {
      const code = error.code === 'ENOENT' ? 'ENOENT' : error.code === 'ENOTEMPTY' ? 'ENOTEMPTY' : error.code === 'ENOTDIR' ? 'ENOTDIR' : 'EACCES';
      throw new ShellError(code, entry.vpath);
    }
  }

  function rename(from, to, cwd) {
    const a = target(from, cwd);
    const b = resolve(to, cwd);
    if (b.device) throw new ShellError('EINVAL', b.vpath);
    assertWritable(a.vpath);
    assertWritable(b.vpath);
    try { fsSync.renameSync(a.host, b.host); }
    catch (error) { throw new ShellError(error.code === 'ENOENT' ? 'ENOENT' : 'EXDEV', a.vpath); }
  }

  function copy(from, to, cwd, opts = {}) {
    const a = resolve(from, cwd);
    const b = resolve(to, cwd);
    if (b.device) return;
    assertWritable(b.vpath);
    const info = (() => { try { return fsSync.statSync(a.host); } catch { return null; } })();
    if (!info) throw new ShellError('ENOENT', a.vpath);
    try {
      fsSync.cpSync(a.host, b.host, { recursive: opts.recursive !== false, force: true, errorOnExist: false, dereference: false });
    } catch (error) {
      throw new ShellError(error.code === 'ENOENT' ? 'ENOENT' : 'EACCES', b.vpath);
    }
  }

  function chmod(input, cwd, mode) {
    const entry = resolve(input, cwd);
    assertWritable(entry.vpath);
    try { fsSync.chmodSync(entry.host, mode); }
    catch { throw new ShellError('EPERM', entry.vpath); }
  }

  function realpath(input, cwd) {
    const entry = resolve(input, cwd);
    if (entry.device) return entry.vpath;
    const real = realOf(entry.host);
    if (!real) throw new ShellError('ENOENT', entry.vpath);
    return virtual(real);
  }

  /** Depth-first walk; yields {vpath, isDir, isSymlink}. */
  function* walk(input, cwd, opts = {}) {
    const maxDepth = opts.maxDepth ?? Infinity;
    const start = resolve(input, cwd);
    if (start.device) return;
    const stack = [{ hostPath: start.host, vpath: start.vpath, depth: 0 }];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = fsSync.readdirSync(current.hostPath, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        const childHost = path.join(current.hostPath, entry.name);
        const childVpath = joinVirtual(current.vpath, entry.name);
        const isDir = entry.isDirectory();
        yield { vpath: childVpath, isDir, isSymlink: entry.isSymbolicLink(), host: childHost };
        if (isDir && current.depth + 1 <= maxDepth) stack.push({ hostPath: childHost, vpath: childVpath, depth: current.depth + 1 });
      }
    }
  }

  /** Expand a glob pattern into virtual paths, sorted. */
  function glob(pattern, cwd = '/', opts = {}) {
    const out = [];
    for (const expanded of braceExpand(pattern)) out.push(...expandOne(expanded, cwd, opts));
    const unique = [...new Set(out)];
    unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return unique;
  }

  function expandOne(pattern, cwd, opts) {
    const absolute = pattern.startsWith('/');
    const prefix = absolute ? '/' : /^\.\//.test(pattern) ? './' : '';
    const body = absolute ? pattern.slice(1) : prefix === './' ? pattern.slice(2) : pattern;
    const segments = body.split('/').filter(segment => segment.length > 0 && segment !== '.');
    if (!segments.length) return absolute ? ['/'] : [];
    const globstar = Boolean(opts.globstar);
    let frontier = [{ vpath: absolute ? '/' : cwd, hostReady: true }];
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const last = index === segments.length - 1;
      const next = [];
      for (const node of frontier) {
        if (segment === '**' && globstar) {
          const base = node.vpath;
          next.push({ vpath: base });
          for (const entry of walk(base === '/' ? '' : base, '/')) {
            if (entry.isDir) next.push({ vpath: entry.vpath });
          }
          continue;
        }
        if (!hasMagic(segment)) {
          const candidate = joinVirtual(node.vpath, segment);
          if (exists(candidate, '/')) next.push({ vpath: candidate });
          continue;
        }
        let entries;
        try { entries = readdir(node.vpath, '/'); }
        catch { continue; }
        for (const entry of entries) {
          if (!matchSegment(segment, entry.name, segment.startsWith('.'))) continue;
          if (last && entry.isDir) continue;
          next.push({ vpath: joinVirtual(node.vpath, entry.name) });
        }
      }
      frontier = next;
      if (!frontier.length) return [];
    }
    return frontier.map(node => (prefix === './' ? './' + node.vpath.replace(/^\//, '') : prefix === '/' ? node.vpath : node.vpath.replace(/^\//, '')));
  }

  function sizeOf(input, cwd) {
    const info = stat(input, cwd);
    return info.size;
  }

  function deviceFor(input, cwd) {
    const entry = resolve(input, cwd);
    return entry.device ?? null;
  }

  return {
    root: rootHost,
    rootReal,
    mode,
    readOnly,
    resolve,
    virtual,
    host: (input, cwd) => target(input, cwd).host,
    vpath: (input, cwd) => resolve(input, cwd).vpath,
    stat, lstat, exists, readdir, readBuffer, readText, writeText,
    mkdirp, remove, rmdir, rename, copy, chmod, realpath, walk, glob, sizeOf, deviceFor,
    isDevice: (input, cwd) => Boolean(resolve(input, cwd).device),
    tempDir: () => os.tmpdir(),
  };
}
