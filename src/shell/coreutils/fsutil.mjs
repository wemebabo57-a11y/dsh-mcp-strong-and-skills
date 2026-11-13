// Coreutils: filesystem inspection and mutation (ls/mkdir/rm/cp/mv/touch/ln/chmod/stat/readlink/du/env/uname).
// Synchronous, zero runtime dependencies.
import fsSync from 'node:fs';
import os from 'node:os';
import { formatError, usageError, parseOptions, toInt } from '../io.mjs';

export const names = [
  'ls',
  'mkdir',
  'rmdir',
  'rm',
  'cp',
  'mv',
  'touch',
  'ln',
  'chmod',
  'chown',
  'stat',
  'readlink',
  'du',
  'env',
  'uname',
  'df',
];

/* ------------------------------------------------------------------ helpers */

function cwdOf(ctx) {
  return ctx && typeof ctx.cwd === 'string' && ctx.cwd.startsWith('/') ? ctx.cwd : '/';
}

function check(ctx) {
  if (ctx && typeof ctx.check === 'function') ctx.check();
}

function joinPath(dir, name) {
  if (dir === '/' || dir === '') return '/' + name;
  return String(dir).replace(/\/+$/, '') + '/' + name;
}

function baseName(value) {
  const text = String(value).replace(/\/+$/, '');
  if (!text) return '/';
  const index = text.lastIndexOf('/');
  return index < 0 ? text : text.slice(index + 1) || '/';
}

function dirName(value) {
  const text = String(value).replace(/\/+$/, '');
  const index = text.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return text.slice(0, index);
}

function pad(text, width, left) {
  const value = String(text);
  if (value.length >= width) return value;
  const fill = ' '.repeat(width - value.length);
  return left ? fill + value : value + fill;
}

function safeLstat(ctx, target) {
  try {
    return ctx.fs.lstat(target, cwdOf(ctx));
  } catch (error) {
    if (error && error.code) return null;
    throw error;
  }
}

function safeStat(ctx, target) {
  try {
    return ctx.fs.stat(target, cwdOf(ctx));
  } catch (error) {
    if (error && error.code) return null;
    throw error;
  }
}

function statMessage(ctx, program, target, error) {
  if (error && error.code) return formatError(program, target, error.code);
  return program + ': ' + target + ': ' + (error && error.message ? error.message : String(error)) + '\n';
}

function errorText(program, target, code, note) {
  return formatError(program, target, code, note);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function lsTime(ms) {
  const date = new Date(ms);
  const sixMonths = 15552000000;
  const month = MONTHS[date.getMonth()];
  const day = pad(date.getDate(), 2, true);
  if (Math.abs(Date.now() - ms) < sixMonths) {
    return month + ' ' + day + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }
  return month + ' ' + day + '  ' + date.getFullYear();
}

function longTime(ms) {
  const date = new Date(ms);
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' +
    pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds()) + '.000000000 +0000';
}

const PERM_TABLE = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx'];

function perms(mode) {
  const bits = Number(mode) || 0;
  return PERM_TABLE[(bits >> 6) & 7] + PERM_TABLE[(bits >> 3) & 7] + PERM_TABLE[bits & 7];
}

function modeString(info) {
  let type = '-';
  if (info.isDir) type = 'd';
  else if (info.isSymlink) type = 'l';
  else if (info.isDevice) type = 'c';
  return type + perms(info.mode);
}

function suffixOf(info) {
  if (info.isDir) return '/';
  if (info.isSymlink) return '@';
  if (info.isDevice) return '=';
  if ((Number(info.mode) & 0o111) !== 0) return '*';
  return '';
}

function humanSize(bytes) {
  const units = ['', 'K', 'M', 'G', 'T', 'P'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value = value / 1024; unit++; }
  if (unit === 0) return String(Math.round(value));
  const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return text + units[unit];
}

function userNames() {
  let user = 'user';
  let uid = '1000';
  let gid = '1000';
  try {
    const info = os.userInfo();
    if (info && info.username) user = info.username;
    if (info && typeof info.uid === 'number') uid = String(info.uid);
    if (info && typeof info.gid === 'number') gid = String(info.gid);
  } catch {
    /* ignore */
  }
  return { user, uid, gid };
}

function sortEntries(items, opts) {
  const list = items.slice();
  if (opts.t) list.sort((a, b) => (b.info.mtimeMs || 0) - (a.info.mtimeMs || 0));
  else if (opts.S) list.sort((a, b) => (b.info.size || 0) - (a.info.size || 0));
  else list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (opts.r) list.reverse();
  return list;
}

/* ----------------------------------------------------------------------- ls */

function longLine(ctx, name, info, opts, linkTarget) {
  const owner = userNames();
  let label = name;
  if (opts.Q) label = '"' + name + '"';
  if (opts.F) label = label + suffixOf(info);
  if (linkTarget !== null && linkTarget !== undefined) label = label + ' -> ' + linkTarget;
  const sizeText = opts.h ? humanSize(info.size) : String(info.size || 0);
  return modeString(info) + ' ' + pad(1, 2, true) + ' ' + pad(owner.user, 8) + ' ' + pad(owner.gid, 8) +
    ' ' + pad(sizeText, 8, true) + ' ' + lsTime(info.mtimeMs || Date.now()) + ' ' + label;
}

function plainLine(name, info, opts) {
  let label = name;
  if (opts.Q) label = '"' + name + '"';
  if (opts.F) label = label + suffixOf(info);
  return label;
}

function readLinkTarget(ctx, vpath) {
  try {
    const entry = ctx.fs.resolve(vpath, cwdOf(ctx));
    if (!entry || entry.device) return null;
    return fsSync.readlinkSync(entry.host);
  } catch {
    return null;
  }
}

function entryInfo(ctx, vpath) {
  const info = safeLstat(ctx, vpath);
  if (!info) return null;
  if (info.isSymlink) {
    const followed = safeStat(ctx, vpath);
    if (followed) return { ...info, size: followed.size, mtimeMs: followed.mtimeMs, isDir: followed.isDir, isFile: followed.isFile };
  }
  return info;
}

function listDirectory(ctx, dir, opts, emit, header) {
  const items = [];
  let entries;
  try {
    entries = ctx.fs.readdir(dir, cwdOf(ctx), {});
  } catch (error) {
    emit.error(errorText('ls', dir, error.code || 'EINVAL'));
    return 1;
  }
  if (opts.a) {
    items.push({ name: '.', info: safeLstat(ctx, dir) || { isDir: true, size: 0, mtimeMs: 0, mode: 0o755 } });
    items.push({ name: '..', info: safeLstat(ctx, dirName(dir)) || { isDir: true, size: 0, mtimeMs: 0, mode: 0o755 } });
  }
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    if (!opts.a && !opts.A && entry.name.startsWith('.')) continue;
    check(ctx);
    const vpath = joinPath(dir, entry.name);
    const info = entryInfo(ctx, vpath) || { isFile: entry.isFile, isDir: entry.isDir, isSymlink: entry.isSymlink, size: 0, mtimeMs: 0, mode: 0o644 };
    items.push({ name: entry.name, info, vpath });
  }
  const sorted = sortEntries(items, opts);
  if (opts.l) {
    let total = 0;
    for (const item of sorted) total += Math.ceil((item.info.size || 0) / 1024) * 4 || 4;
    emit.out(header ? header + ':\n' : '');
    emit.out('total ' + total + '\n');
  } else if (header) {
    emit.out(header + ':\n');
  }
  for (const item of sorted) {
    check(ctx);
    if (opts.l) {
      const target = item.info.isSymlink ? readLinkTarget(ctx, item.vpath || joinPath(dir, item.name)) : null;
      emit.out(longLine(ctx, item.name, item.info, opts, target) + '\n');
    } else {
      emit.out(plainLine(item.name, item.info, opts) + '\n');
    }
  }
  if (opts.R) {
    for (const item of sorted) {
      if (!item.info.isDir || item.name === '.' || item.name === '..') continue;
      const child = joinPath(dir, item.name);
      emit.out('\n');
      listDirectory(ctx, child, opts, emit, child);
    }
  }
  return 0;
}

function lsMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    a: 'bool', A: 'bool', l: 'bool', '1': 'bool', d: 'bool', R: 'bool', t: 'bool', r: 'bool',
    S: 'bool', F: 'bool', h: 'bool', p: 'bool', Q: 'bool', i: 'bool', n: 'bool', g: 'bool', o: 'bool',
    all: 'bool', almost: 'bool', long: 'bool', directory: 'bool', recursive: 'bool', reverse: 'bool',
    human: 'bool', 'human-readable': 'bool', color: 'value', 'block-size': 'value', 'full-time': 'bool',
    'group-directories-first': 'bool', 'hide': 'value', 'ignore': 'value', 'literal': 'bool',
  });
  if (parsed.error) return usageError('ls', parsed.error);
  const opts = parsed.opts;
  const options = {
    a: !!(opts.get('a') || opts.get('all')),
    A: !!(opts.get('A') || opts.get('almost')),
    l: !!(opts.get('l') || opts.get('long')),
    d: !!(opts.get('d') || opts.get('directory')),
    R: !!(opts.get('R') || opts.get('recursive')),
    t: !!opts.get('t'),
    r: !!(opts.get('r') || opts.get('reverse')),
    S: !!opts.get('S'),
    F: !!opts.get('F'),
    h: !!(opts.get('h') || opts.get('human') || opts.get('human-readable')),
    p: !!opts.get('p'),
    Q: !!opts.get('Q') || !!opts.get('literal'),
  };
  const operands = parsed.args.length ? parsed.args : ['.'];
  const out = [];
  const errs = [];
  const emit = {
    out(text) { out.push(text); },
    error(text) { errs.push(text); },
  };
  let status = 0;
  const files = [];
  const dirs = [];
  for (const operand of operands) {
    check(ctx);
    const info = safeLstat(ctx, operand);
    if (!info) {
      errs.push(errorText('ls', operand, 'ENOENT'));
      status = 2;
      continue;
    }
    if (!options.d && info.isDir) dirs.push(operand);
    else files.push(operand);
  }
  for (const file of files) {
    const info = entryInfo(ctx, file);
    if (!info) { errs.push(errorText('ls', file, 'ENOENT')); status = 2; continue; }
    if (options.l) {
      const target = info.isSymlink ? readLinkTarget(ctx, file) : null;
      out.push(longLine(ctx, file, info, options, target) + '\n');
    } else {
      out.push(plainLine(file, info, options) + '\n');
    }
  }
  const showHeaders = dirs.length + files.length > 1;
  for (let index = 0; index < dirs.length; index++) {
    const dir = dirs[index];
    if (files.length || (showHeaders && index > 0)) out.push('\n');
    const code = listDirectory(ctx, dir, options, emit, showHeaders ? dir : null);
    if (code) status = code;
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* -------------------------------------------------------------------- mkdir */

function mkdirMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    p: 'bool', v: 'bool', m: 'value', parents: 'bool', verbose: 'bool', mode: 'value',
  });
  if (parsed.error) return usageError('mkdir', parsed.error);
  const parents = !!(parsed.opts.get('p') || parsed.opts.get('parents'));
  const verbose = !!(parsed.opts.get('v') || parsed.opts.get('verbose'));
  const modeArg = parsed.opts.get('m') || parsed.opts.get('mode');
  if (!parsed.args.length) return usageError('mkdir', 'missing operand');
  const out = [];
  const errs = [];
  let status = 0;
  for (const operand of parsed.args) {
    check(ctx);
    const existing = safeLstat(ctx, operand);
    if (existing) {
      if (existing.isDir && parents) continue;
      errs.push(errorText('mkdir', operand, 'EEXIST', 'File exists'));
      status = 1;
      continue;
    }
    if (!parents) {
      const parent = dirName(operand);
      const parentInfo = parent === '.' ? safeLstat(ctx, '.') : safeLstat(ctx, parent);
      if (!parentInfo) {
        errs.push(program(operand));
        status = 1;
        continue;
      }
      if (!parentInfo.isDir) {
        errs.push(errorText('mkdir', parent, 'ENOTDIR'));
        status = 1;
        continue;
      }
    }
    try {
      ctx.fs.mkdirp(operand, cwdOf(ctx));
    } catch (error) {
      errs.push(errorText('mkdir', operand, error.code || 'EINVAL'));
      status = 1;
      continue;
    }
    if (modeArg) {
      try { ctx.fs.chmod(operand, cwdOf(ctx), Number.parseInt(modeArg, 8) || 0o755); } catch { /* ignore */ }
    }
    if (verbose) out.push('mkdir: created directory ' + quote(operand) + '\n');
  }
  function program(name) {
    return errorText('mkdir', name, 'ENOENT');
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

function quote(value) {
  return "'" + String(value) + "'";
}

/* -------------------------------------------------------------------- rmdir */

function rmdirMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    p: 'bool', v: 'bool', ignore: 'value', parents: 'bool', verbose: 'bool', 'ignore-fail-on-non-empty': 'bool',
  });
  if (parsed.error) return usageError('rmdir', parsed.error);
  const parents = !!(parsed.opts.get('p') || parsed.opts.get('parents'));
  const verbose = !!(parsed.opts.get('v') || parsed.opts.get('verbose'));
  const ignore = !!parsed.opts.get('ignore-fail-on-non-empty');
  if (!parsed.args.length) return usageError('rmdir', 'missing operand');
  const out = [];
  const errs = [];
  let status = 0;
  for (const operand of parsed.args) {
    let current = operand;
    for (;;) {
      check(ctx);
      const info = safeLstat(ctx, current);
      if (!info) { errs.push(errorText('rmdir', current, 'ENOENT')); status = 1; break; }
      if (!info.isDir) { errs.push(errorText('rmdir', current, 'ENOTDIR')); status = 1; break; }
      let entries;
      try { entries = ctx.fs.readdir(current, cwdOf(ctx), {}); } catch (error) { errs.push(errorText('rmdir', current, error.code || 'EINVAL')); status = 1; break; }
      if (entries.length) {
        if (!ignore) { errs.push(errorText('rmdir', current, 'ENOTEMPTY')); status = 1; }
        break;
      }
      try { ctx.fs.rmdir(current, cwdOf(ctx)); } catch (error) { errs.push(errorText('rmdir', current, error.code || 'EINVAL')); status = 1; break; }
      if (verbose) out.push('rmdir: removing directory, ' + quote(current) + '\n');
      if (!parents) break;
      const parent = dirName(current);
      if (parent === '.' || parent === '/' || parent === current) break;
      current = parent;
    }
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* ----------------------------------------------------------------------- rm */

function collectRemovals(ctx, target, into) {
  const info = safeLstat(ctx, target);
  if (!info) return;
  if (info.isDir) {
    let entries = [];
    try { entries = ctx.fs.readdir(target, cwdOf(ctx), {}); } catch { entries = []; }
    for (const entry of entries) {
      check(ctx);
      collectRemovals(ctx, joinPath(target, entry.name), into);
    }
    into.push(target);
    return;
  }
  into.push(target);
}

function rmMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    r: 'bool', R: 'bool', f: 'bool', v: 'bool', d: 'bool', i: 'bool', I: 'bool', 'recursive': 'bool',
    force: 'bool', verbose: 'bool', dir: 'bool', interactive: 'bool', 'one-file-system': 'bool',
    preserve: 'bool', 'no-preserve-root': 'bool',
  });
  if (parsed.error) return usageError('rm', parsed.error);
  const recursive = !!(parsed.opts.get('r') || parsed.opts.get('R') || parsed.opts.get('recursive'));
  const force = !!(parsed.opts.get('f') || parsed.opts.get('force'));
  const verbose = !!(parsed.opts.get('v') || parsed.opts.get('verbose'));
  const allowEmptyDir = !!(parsed.opts.get('d') || parsed.opts.get('dir'));
  if (!parsed.args.length) {
    if (force) return { code: 0, out: '', err: '' };
    return usageError('rm', 'missing operand');
  }
  const out = [];
  const errs = [];
  let status = 0;
  for (const operand of parsed.args) {
    check(ctx);
    const info = safeLstat(ctx, operand);
    if (!info) {
      if (force) continue;
      errs.push(errorText('rm', operand, 'ENOENT'));
      status = 1;
      continue;
    }
    if (info.isDir && !recursive) {
      if (allowEmptyDir) {
        let entries = [];
        try { entries = ctx.fs.readdir(operand, cwdOf(ctx), {}); } catch { entries = [null]; }
        if (entries.length) { errs.push(errorText('rm', operand, 'EISDIR', 'Is a directory')); status = 1; continue; }
        try { ctx.fs.rmdir(operand, cwdOf(ctx)); } catch (error) { errs.push(errorText('rm', operand, error.code || 'EINVAL')); status = 1; continue; }
        if (verbose) out.push('removed directory ' + quote(operand) + '\n');
        continue;
      }
      errs.push(errorText('rm', operand, 'EISDIR', 'Is a directory'));
      status = 1;
      continue;
    }
    let victims = [];
    if (recursive && info.isDir) {
      collectRemovals(ctx, operand, victims);
    } else {
      victims = [operand];
    }
    for (const victim of victims) {
      check(ctx);
      try {
        ctx.fs.remove(victim, cwdOf(ctx), { recursive: true, force: force });
      } catch (error) {
        if (force && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY')) continue;
        errs.push(errorText('rm', victim, error.code || 'EINVAL'));
        status = 1;
        continue;
      }
      if (verbose) {
        const info2 = safeLstat(ctx, victim);
        out.push('removed ' + (info2 && info2.isDir ? 'directory ' : '') + quote(victim) + '\n');
      }
    }
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* ----------------------------------------------------------------------- cp */

function cpMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    r: 'bool', R: 'bool', a: 'bool', p: 'bool', v: 'bool', n: 'bool', f: 'bool', t: 'value', i: 'bool',
    L: 'bool', P: 'bool', d: 'bool', u: 'bool', l: 'bool', s: 'bool',
    recursive: 'bool', archive: 'bool', preserve: 'bool', verbose: 'bool', 'no-clobber': 'bool',
    'target-directory': 'value', 'no-target-directory': 'bool', 'update': 'bool',
  });
  const errs = [];
  const out = [];
  if (parsed.error) return usageError('cp', parsed.error);
  const recursive = !!(parsed.opts.get('r') || parsed.opts.get('R') || parsed.opts.get('recursive') ||
    parsed.opts.get('a') || parsed.opts.get('archive'));
  const verbose = !!(parsed.opts.get('v') || parsed.opts.get('verbose'));
  const noClobber = !!(parsed.opts.get('n') || parsed.opts.get('no-clobber'));
  const targetDir = parsed.opts.get('t') || parsed.opts.get('target-directory');
  let sources = parsed.args.slice();
  let dest = targetDir || null;
  if (!dest) {
    if (sources.length < 2) return usageError('cp', 'missing destination file operand after ' + quote(sources[0] || '') );
    dest = sources.pop();
  }
  const destInfo = safeStat(ctx, dest);
  const destIsDir = !!(destInfo && destInfo.isDir);
  if (!destIsDir && sources.length > 1) {
    return failCopy('target ' + quote(dest) + ' is not a directory');
  }
  if (targetDir && !destIsDir) return failCopy('target directory ' + quote(dest) + ' is not a directory');
  let status = 0;
  function failCopy(message) {
    return { code: 1, out: out.join(''), err: errs.join('') + 'cp: ' + message + '\n' };
  }
  for (const source of sources) {
    check(ctx);
    const info = safeLstat(ctx, source);
    if (!info) { errs.push(errorText('cp', source, 'ENOENT')); status = 1; continue; }
    if (info.isDir && !recursive) {
      errs.push('cp: -r not specified; omitting directory ' + quote(source) + '\n');
      status = 1;
      continue;
    }
    const target = destIsDir ? joinPath(dest, baseName(source)) : dest;
    if (noClobber && safeLstat(ctx, target)) continue;
    const sourceResolved = safeStat(ctx, source);
    const targetParent = dirName(target);
    const parentInfo = safeStat(ctx, targetParent === '.' ? '.' : targetParent);
    if (!parentInfo) { errs.push(errorText('cp', target, 'ENOENT', 'No such file or directory')); status = 1; continue; }
    if (info.isDir && (target === source || target.startsWith(source.replace(/\/+$/, '') + '/'))) {
      errs.push('cp: cannot copy a directory, ' + quote(source) + ', into itself, ' + quote(target) + '\n');
      status = 1;
      continue;
    }
    try {
      ctx.fs.copy(source, target, cwdOf(ctx), { recursive: true });
    } catch (error) {
      errs.push(errorText('cp', source, error.code || 'EINVAL'));
      status = 1;
      continue;
    }
    if (verbose) out.push(quote(source) + ' -> ' + quote(target) + '\n');
    void sourceResolved;
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* ----------------------------------------------------------------------- mv */

function mvMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    v: 'bool', n: 'bool', f: 'bool', u: 'bool', t: 'value', i: 'bool',
    verbose: 'bool', 'no-clobber': 'bool', force: 'bool', 'target-directory': 'value', 'no-target-directory': 'bool',
  });
  if (parsed.error) return usageError('mv', parsed.error);
  const verbose = !!(parsed.opts.get('v') || parsed.opts.get('verbose'));
  const noClobber = !!(parsed.opts.get('n') || parsed.opts.get('no-clobber'));
  const targetDir = parsed.opts.get('t') || parsed.opts.get('target-directory');
  const sources = parsed.args.slice();
  let dest = targetDir || null;
  if (!dest) {
    if (sources.length < 2) return usageError('mv', 'missing destination file operand after ' + quote(sources[0] || ''));
    dest = sources.pop();
  }
  const destInfo = safeStat(ctx, dest);
  const destIsDir = !!(destInfo && destInfo.isDir);
  const out = [];
  const errs = [];
  let status = 0;
  if (!destIsDir && sources.length > 1) return usageError('mv', 'target ' + quote(dest) + ' is not a directory');
  for (const source of sources) {
    check(ctx);
    if (!safeLstat(ctx, source)) { errs.push(errorText('mv', source, 'ENOENT')); status = 1; continue; }
    const target = destIsDir ? joinPath(dest, baseName(source)) : dest;
    if (noClobber && safeLstat(ctx, target)) continue;
    if (source === target) continue;
    let moved = false;
    try {
      ctx.fs.rename(source, target, cwdOf(ctx));
      moved = true;
    } catch (error) {
      const code = error && error.code ? error.code : 'EINVAL';
      if (code === 'EXDEV' || code === 'EEXIST' || code === 'EPERM') {
        try {
          if (safeLstat(ctx, target)) ctx.fs.remove(target, cwdOf(ctx), { recursive: true, force: true });
          ctx.fs.copy(source, target, cwdOf(ctx), { recursive: true });
          ctx.fs.remove(source, cwdOf(ctx), { recursive: true, force: true });
          moved = true;
        } catch (inner) {
          errs.push(errorText('mv', source, inner.code || 'EINVAL'));
          status = 1;
          continue;
        }
      } else {
        errs.push(errorText('mv', source, code));
        status = 1;
        continue;
      }
    }
    if (moved && verbose) out.push(quote(source) + ' -> ' + quote(target) + '\n');
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* -------------------------------------------------------------------- touch */

function touchMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    a: 'bool', m: 'bool', c: 'bool', t: 'value', d: 'value', r: 'value',
    'no-create': 'bool', date: 'value', reference: 'value', 'no-dereference': 'bool',
  });
  if (parsed.error) return usageError('touch', parsed.error);
  const noCreate = !!(parsed.opts.get('c') || parsed.opts.get('no-create'));
  const onlyAtime = !!parsed.opts.get('a') && !parsed.opts.get('m');
  const onlyMtime = !!parsed.opts.get('m') && !parsed.opts.get('a');
  if (!parsed.args.length) return usageError('touch', 'missing file operand');
  const errs = [];
  let status = 0;
  const now = Date.now();
  for (const operand of parsed.args) {
    check(ctx);
    const info = safeLstat(ctx, operand);
    if (!info) {
      if (noCreate) continue;
      try {
        ctx.fs.writeText(operand, cwdOf(ctx), '', { append: true });
      } catch (error) {
        errs.push(errorText('touch', operand, error.code || 'EINVAL'));
        status = 1;
        continue;
      }
    }
    try {
      const entry = ctx.fs.resolve(operand, cwdOf(ctx));
      if (entry && entry.host) {
        const stamp = new Date(now);
        const atime = onlyMtime ? undefined : stamp;
        const mtime = onlyAtime ? undefined : stamp;
        if (atime && mtime) fsSync.utimesSync(entry.host, atime, mtime);
        else fsSync.utimesSync(entry.host, atime || undefined, mtime || undefined);
      }
    } catch (error) {
      errs.push(errorText('touch', operand, error.code || 'EINVAL'));
      status = 1;
    }
  }
  return { code: status, out: '', err: errs.join('') };
}

/* ----------------------------------------------------------------------- ln */

function lnMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    s: 'bool', f: 'bool', v: 'bool', n: 'bool', T: 'bool', t: 'value', r: 'bool',
    symbolic: 'bool', force: 'bool', verbose: 'bool', 'no-dereference': 'bool',
    'target-directory': 'value', 'no-target-directory': 'bool', relative: 'bool',
  });
  if (parsed.error) return usageError('ln', parsed.error);
  const symbolic = !!(parsed.opts.get('s') || parsed.opts.get('symbolic'));
  const force = !!(parsed.opts.get('f') || parsed.opts.get('force'));
  const verbose = !!(parsed.opts.get('v') || parsed.opts.get('verbose'));
  const sources = parsed.args.slice();
  let dest = parsed.opts.get('t') || parsed.opts.get('target-directory') || null;
  if (!dest) {
    if (sources.length < 2) return usageError('ln', 'missing file operand');
    dest = sources.pop();
  }
  const destInfo = safeStat(ctx, dest);
  const destIsDir = !!(destInfo && destInfo.isDir) && !parsed.opts.get('T') && !parsed.opts.get('no-target-directory');
  const out = [];
  const errs = [];
  let status = 0;
  for (const source of sources) {
    check(ctx);
    const target = destIsDir ? joinPath(dest, baseName(source)) : dest;
    if (force && safeLstat(ctx, target)) {
      try { ctx.fs.remove(target, cwdOf(ctx), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try {
      const from = ctx.fs.resolve(source, cwdOf(ctx));
      const to = ctx.fs.resolve(target, cwdOf(ctx));
      if (!from || from.device || !to || to.device) throw Object.assign(new Error('invalid path'), { code: 'EINVAL' });
      if (symbolic) {
        const info = safeStat(ctx, source);
        fsSync.symlinkSync(from.host, to.host, info && info.isDir ? 'dir' : 'file');
      } else {
        fsSync.linkSync(from.host, to.host);
      }
    } catch (error) {
      errs.push(errorText('ln', target, error.code || 'EPERM', error.code === 'EEXIST' ? 'File exists' : undefined));
      status = 1;
      continue;
    }
    if (verbose) out.push(quote(target) + ' -> ' + quote(source) + '\n');
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* -------------------------------------------------------------------- chmod */

function parseSymbolicMode(spec, currentMode) {
  let mode = currentMode;
  for (const clause of String(spec).split(',')) {
    const match = /^([ugoa]*)([+\-=])([rwxXst]*)$/.exec(clause);
    if (!match) return null;
    const who = match[1] || 'a';
    const operation = match[2];
    const permsText = match[3] || '';
    let bits = 0;
    if (permsText.includes('r')) bits |= 4;
    if (permsText.includes('w')) bits |= 2;
    if (permsText.includes('x') || permsText.includes('X')) bits |= 1;
    if (who === 'a') {
      const full = bits * 0o111;
      mode = operation === '+' ? mode | full : operation === '-' ? mode & ~full : (mode & ~0o777) | full;
      continue;
    }
    const shifts = { u: 6, g: 3, o: 0 };
    let mask = 0;
    for (const flag of who) {
      if (!(flag in shifts)) continue;
      mask |= bits << shifts[flag];
    }
    if (operation === '+') mode |= mask;
    else if (operation === '-') mode &= ~mask;
    else {
      let clear = 0;
      for (const flag of who) if (flag in shifts) clear |= 7 << shifts[flag];
      mode = (mode & ~clear) | mask;
    }
  }
  return mode & 0o7777;
}

function chmodMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    R: 'bool', v: 'bool', c: 'bool', f: 'bool', reference: 'value',
    recursive: 'bool', verbose: 'bool', changes: 'bool', silent: 'bool', quiet: 'bool',
  });
  if (parsed.error) return usageError('chmod', parsed.error);
  const recursive = !!(parsed.opts.get('R') || parsed.opts.get('recursive'));
  const verbose = !!(parsed.opts.get('v') || parsed.opts.get('verbose'));
  if (parsed.args.length < 2) return usageError('chmod', 'missing operand');
  const spec = parsed.args.shift();
  const errs = [];
  const out = [];
  let status = 0;
  const numeric = /^[0-7]{1,5}$/.test(spec) ? Number.parseInt(spec, 8) : null;
  for (const operand of parsed.args) {
    const targets = [];
    if (recursive) collectRemovals(ctx, operand, targets);
    else targets.push(operand);
    for (const target of targets) {
      check(ctx);
      const info = safeLstat(ctx, target);
      if (!info) { errs.push(errorText('chmod', target, 'ENOENT')); status = 1; continue; }
      const mode = numeric === null ? parseSymbolicMode(spec, info.mode || 0o644) : numeric;
      if (mode === null) return usageError('chmod', 'invalid mode: ' + spec);
      try {
        ctx.fs.chmod(target, cwdOf(ctx), mode);
      } catch (error) {
        errs.push(errorText('chmod', target, error.code || 'EPERM'));
        status = 1;
        continue;
      }
      if (verbose) out.push('mode of ' + quote(target) + ' changed to ' + mode.toString(8) + '\n');
    }
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

function chownMain(ctx, argv) {
  const parsed = parseOptions(argv, { R: 'bool', v: 'bool', recursive: 'bool', verbose: 'bool' });
  if (parsed.error) return usageError('chown', parsed.error);
  if (parsed.args.length < 2) return usageError('chown', 'missing operand');
  return { code: 0, out: '', err: '' };
}

/* --------------------------------------------------------------------- stat */

function statFormat(template, info, name) {
  let output = '';
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    if (char === '\\' && index + 1 < template.length) {
      const next = template[++index];
      output += next === 'n' ? '\n' : next === 't' ? '\t' : next === '\\' ? '\\' : '\\' + next;
      continue;
    }
    if (char !== '%') { output += char; continue; }
    const directive = template[++index];
    if (directive === undefined) { output += '%'; break; }
    switch (directive) {
      case 'n': output += name; break;
      case 'N': output += quote(name); break;
      case 's': output += String(info.size || 0); break;
      case 'b': output += String(Math.ceil((info.size || 0) / 512)); break;
      case 'a': output += (info.mode & 0o7777).toString(8).padStart(4, '0'); break;
      case 'A': output += modeString(info); break;
      case 'F': output += info.isDir ? 'directory' : info.isSymlink ? 'symbolic link' : info.isDevice ? 'character special file' : 'regular file'; break;
      case 'h': output += '1'; break;
      case 'y': output += longTime(info.mtimeMs || 0); break;
      case 'Y': output += String(Math.floor((info.mtimeMs || 0) / 1000)); break;
      case 'x': output += longTime(info.mtimeMs || 0); break;
      case 'X': output += String(Math.floor((info.mtimeMs || 0) / 1000)); break;
      case 'z': output += longTime(info.mtimeMs || 0); break;
      case 'u': output += userNames().uid; break;
      case 'g': output += userNames().gid; break;
      case 'U': output += userNames().user; break;
      case 'G': output += userNames().user; break;
      case 'i': output += '1'; break;
      case 'd': output += '0'; break;
      case 't': output += '0'; break;
      case 'o': output += '4096'; break;
      case '%': output += '%'; break;
      default: output += '%' + directive; break;
    }
  }
  return output;
}

function statMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    c: 'value', L: 'bool', f: 'bool', t: 'bool', printf: 'value', dereference: 'bool', format: 'value',
  });
  if (parsed.error) return usageError('stat', parsed.error);
  const template = parsed.opts.get('c') || parsed.opts.get('printf') || parsed.opts.get('format') || null;
  const follow = !!parsed.opts.get('L') || !!parsed.opts.get('dereference');
  if (!parsed.args.length) return usageError('stat', 'missing operand');
  const out = [];
  const errs = [];
  let status = 0;
  for (const operand of parsed.args) {
    check(ctx);
    const info = follow ? safeStat(ctx, operand) : safeLstat(ctx, operand);
    if (!info) { errs.push(errorText('stat', operand, 'ENOENT')); status = 1; continue; }
    if (template) {
      out.push(statFormat(template, info, operand));
      if (!template.endsWith('\n') && parsed.opts.get('printf') === undefined) out.push('\n');
      if (parsed.opts.get('printf') !== undefined) continue;
      continue;
    }
    const owner = userNames();
    out.push('  File: ' + operand + '\n');
    out.push('  Size: ' + String(info.size || 0).padEnd(12) + 'Blocks: ' + String(Math.ceil((info.size || 0) / 512)).padEnd(10) +
      'IO Block: 4096   ' + (info.isDir ? 'directory' : info.isSymlink ? 'symbolic link' : 'regular file') + '\n');
    out.push('Access: (' + (info.mode & 0o7777).toString(8).padStart(4, '0') + '/' + modeString(info) + ')  Uid: (' +
      String(owner.uid).padStart(6, ' ') + '/  ' + pad(owner.user, 8) + ')   Gid: (' + String(owner.gid).padStart(6, ' ') + '/  ' + pad(owner.user, 8) + ')\n');
    out.push('Modify: ' + longTime(info.mtimeMs || 0) + '\n');
    out.push('Change: ' + longTime(info.mtimeMs || 0) + '\n');
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* ----------------------------------------------------------------- readlink */

function readlinkMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    f: 'bool', e: 'bool', m: 'bool', n: 'bool', v: 'bool', q: 'bool', s: 'bool',
    canonicalize: 'bool', 'canonicalize-existing': 'bool', 'canonicalize-missing': 'bool', 'no-newline': 'bool', verbose: 'bool', silent: 'bool', quiet: 'bool',
  });
  if (parsed.error) return usageError('readlink', parsed.error);
  const canonical = !!(parsed.opts.get('f') || parsed.opts.get('canonicalize') || parsed.opts.get('e') ||
    parsed.opts.get('canonicalize-existing') || parsed.opts.get('m') || parsed.opts.get('canonicalize-missing'));
  const noNewline = !!(parsed.opts.get('n') || parsed.opts.get('no-newline'));
  if (!parsed.args.length) return usageError('readlink', 'missing operand');
  const out = [];
  const errs = [];
  let status = 0;
  for (const operand of parsed.args) {
    check(ctx);
    let value = null;
    try {
      if (canonical) value = ctx.fs.realpath(operand, cwdOf(ctx));
      else {
        const info = safeLstat(ctx, operand);
        if (!info) { errs.push(errorText('readlink', operand, 'ENOENT')); status = 1; continue; }
        if (!info.isSymlink) { status = 1; continue; }
        const entry = ctx.fs.resolve(operand, cwdOf(ctx));
        value = fsSync.readlinkSync(entry.host);
      }
    } catch (error) {
      errs.push(errorText('readlink', operand, error.code || 'EINVAL'));
      status = 1;
      continue;
    }
    out.push(value + (noNewline ? '' : '\n'));
  }
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* ----------------------------------------------------------------------- du */

function duMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    s: 'bool', a: 'bool', c: 'bool', h: 'bool', k: 'bool', m: 'bool', b: 'bool', x: 'bool', d: 'value',
    summarize: 'bool', all: 'bool', total: 'bool', 'human-readable': 'bool', 'max-depth': 'value', 'apparent-size': 'bool',
  });
  if (parsed.error) return usageError('du', parsed.error);
  const summarize = !!(parsed.opts.get('s') || parsed.opts.get('summarize'));
  const all = !!(parsed.opts.get('a') || parsed.opts.get('all'));
  const total = !!(parsed.opts.get('c') || parsed.opts.get('total'));
  const human = !!(parsed.opts.get('h') || parsed.opts.get('human-readable'));
  const operands = parsed.args.length ? parsed.args : ['.'];
  const out = [];
  const errs = [];
  let status = 0;
  let grand = 0;
  const limit = toInt(parsed.opts.get('d') || parsed.opts.get('max-depth'));

  function sizeOfTree(target, depth) {
    const info = safeLstat(ctx, target);
    if (!info) {
      errs.push(errorText('du', target, 'ENOENT'));
      status = 1;
      return 0;
    }
    if (!info.isDir) {
      const size = info.size || 0;
      if (all && !summarize) out.push(formatSize(size) + '\t' + target + '\n');
      return size;
    }
    let entries = [];
    try { entries = ctx.fs.readdir(target, cwdOf(ctx), {}); } catch (error) { errs.push(errorText('du', target, error.code || 'EINVAL')); status = 1; return 4096; }
    let bytes = 4096;
    for (const entry of entries) {
      check(ctx);
      bytes += sizeOfTree(joinPath(target, entry.name), depth + 1);
    }
    if (summarize) {
      if (depth === 0) out.push(formatSize(bytes) + '\t' + target + '\n');
    } else if (limit === null || depth <= limit) {
      out.push(formatSize(bytes) + '\t' + target + '\n');
    }
    return bytes;
  }

  function formatSize(bytes) {
    const kb = Math.ceil(bytes / 1024);
    if (human) return humanSize(bytes);
    return String(kb);
  }

  for (const operand of operands) {
    check(ctx);
    grand += sizeOfTree(operand, 0);
  }
  if (total) out.push(formatSize(grand) + '\ttotal\n');
  return { code: status, out: out.join(''), err: errs.join('') };
}

/* ---------------------------------------------------------------------- env */

function envMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    i: 'bool', u: 'value', v: 'bool', '0': 'bool', C: 'value', S: 'value',
    'ignore-environment': 'bool', unset: 'value', null: 'bool', chdir: 'value', split: 'value',
  });
  if (parsed.error) return usageError('env', parsed.error);
  const ignore = !!(parsed.opts.get('i') || parsed.opts.get('ignore-environment'));
  const env = {};
  if (!ignore && ctx.env && typeof ctx.env === 'object') {
    for (const key of Object.keys(ctx.env)) env[key] = String(ctx.env[key]);
  }
  const args = parsed.args.slice();
  const unsetName = parsed.opts.get('u') || parsed.opts.get('unset');
  if (unsetName) delete env[unsetName];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (!match) break;
    env[match[1]] = match[2];
    index++;
  }
  const command = args.slice(index);
  if (!command.length) {
    const keys = Object.keys(env).sort();
    return { code: 0, out: keys.map((key) => key + '=' + env[key] + '\n').join(''), err: '' };
  }
  if (typeof ctx.runCommand !== 'function') return usageError('env', 'cannot execute commands in this context');
  return ctx.runCommand(command);
}

/* -------------------------------------------------------------------- uname */

function unameMain(ctx, argv) {
  const parsed = parseOptions(argv, {
    a: 'bool', s: 'bool', r: 'bool', n: 'bool', v: 'bool', m: 'bool', p: 'bool', i: 'bool', o: 'bool',
    all: 'bool', 'kernel-name': 'bool', 'kernel-release': 'bool', nodename: 'bool', 'kernel-version': 'bool',
    machine: 'bool', processor: 'bool', 'hardware-platform': 'bool', 'operating-system': 'bool',
  });
  if (parsed.error) return usageError('uname', parsed.error);
  const arch = os.arch() === 'x64' ? 'x86_64' : os.arch() === 'arm64' ? 'aarch64' : os.arch();
  const values = {
    s: 'MINGW64_NT-10.0',
    r: os.release(),
    n: os.hostname(),
    v: 'unknown',
    m: arch,
    p: 'unknown',
    i: 'unknown',
    o: 'Msys',
  };
  const opts = parsed.opts;
  const all = !!opts.get('a') || !!opts.get('all');
  const selected = [];
  if (all) selected.push('s', 'n', 'r', 'v', 'm', 'o');
  else {
    for (const flag of ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o']) {
      if (!opts.get(flag)) continue;
      selected.push(flag);
    }
    const longs = {
      'kernel-name': 's', nodename: 'n', 'kernel-release': 'r', 'kernel-version': 'v',
      machine: 'm', processor: 'p', 'hardware-platform': 'i', 'operating-system': 'o',
    };
    for (const long of Object.keys(longs)) if (opts.get(long) && !selected.includes(longs[long])) selected.push(longs[long]);
    if (!selected.length) selected.push('s');
  }
  const order = ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'];
  selected.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { code: 0, out: selected.map((flag) => values[flag]).join(' ') + '\n', err: '' };
}

/* ----------------------------------------------------------------------- df */

function dfMain(ctx, argv) {
  const parsed = parseOptions(argv, { h: 'bool', k: 'bool', 'human-readable': 'bool', P: 'bool', a: 'bool' });
  if (parsed.error) return usageError('df', parsed.error);
  const human = !!(parsed.opts.get('h') || parsed.opts.get('human-readable'));
  const lines = ['Filesystem      Size  Used Avail Use% Mounted on'];
  lines.push(pad('dshell', 14) + ' ' + pad(human ? '10G' : '10485760', 5, true) + ' 0% /\n');
  return { code: 0, out: lines.join('\n'), err: '' };
}

/* ---------------------------------------------------------------- dispatcher */

const TABLE = {
  ls: lsMain,
  mkdir: mkdirMain,
  rmdir: rmdirMain,
  rm: rmMain,
  cp: cpMain,
  mv: mvMain,
  touch: touchMain,
  ln: lnMain,
  chmod: chmodMain,
  chown: chownMain,
  stat: statMain,
  readlink: readlinkMain,
  du: duMain,
  env: envMain,
  uname: unameMain,
  df: dfMain,
};

export function main(prog, argv, ctx) {
  const handler = TABLE[prog];
  if (!handler) return usageError(prog, 'not implemented');
  return handler(ctx, argv.slice());
}
