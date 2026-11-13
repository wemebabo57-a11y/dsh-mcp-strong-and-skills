import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fitResult } from './budget.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.npm-cache', '.turbo', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.7z', '.exe', '.dll', '.so', '.woff', '.woff2', '.ttf', '.mp4', '.mp3', '.sqlite', '.db', '.lockb']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.html', '.vue', '.svelte']);
const ACTIONS = new Set(['map', 'search', 'read', 'diff', 'checks', 'style']);
const DEFAULT_OUTPUT = 6000;
const DENIED_NAMES = new Set(['.git', '.ssh', '.aws', '.npmrc', '.netrc']);

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

function bounded(value, fallback, min, max) {
  return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new WorkspaceError('ABORTED', 'Operation cancelled.');
}

function portable(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function deniedSegment(segment) {
  const name = segment.toLowerCase();
  return DENIED_NAMES.has(name) || name.startsWith('.credentials') || (name.startsWith('.env') && name !== '.env.example') ||
    /^\.?(?:credentials?|secrets?)(?:[._-]|$)/.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/.test(name) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name);
}

/** Same path exclusions for remote knowledge; Git symlinks are rejected separately. */
export function isKnowledgePath(value) {
  if (typeof value !== 'string' || !value || /[\0\\:]/.test(value) || value.startsWith('/')) return false;
  const parts = value.split('/');
  return !parts.some(part => !part || part === '.' || part === '..' || deniedSegment(part) || SKIP_DIRS.has(part.toLowerCase())) && !BINARY_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function clip(text, max = 500) {
  if (text.length <= max) return text;
  let end = max;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + '…';
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, 8192);
  let controls = 0;
  for (let index = 0; index < sample.length; index++) {
    const value = sample[index];
    if (value === 0) return true;
    if (value < 32 && value !== 9 && value !== 10 && value !== 12 && value !== 13) controls++;
  }
  return controls > Math.max(2, sample.length * 0.01);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function recordSkip(stats, reason, count = 1) {
  stats.skipped[reason] = (stats.skipped[reason] || 0) + count;
}

// Always return a JSON object, even when output must be reduced. Keep metadata
// instead of slicing serialized JSON, which can break Unicode and JSON syntax.
function fitOutput(result, budget) {
  result.truncated = Boolean(result.truncated);
  return fitResult(result, budget, { hint: 'Output capped; narrow the path/query or request a smaller range.' });
}
async function runGit(root, args, { signal, maxBytes = 1024 * 1024, timeoutMs = 10000 } = {}) {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.quotePath=false', '-C', root, ...args], {
        shell: false,
        windowsHide: true,
        // Ambient Git variables can redirect work trees/indexes, execute helper
        // programs, or write trace logs. Inherit ordinary process variables only.
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))), GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message, truncated: false });
      return;
    }
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on('data', (chunk) => {
      if (aborted) return;
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const part = chunk.subarray(0, remaining);
        chunks.push(part);
        bytes += part.length;
      }
      if (chunk.length > remaining) { truncated = true; child.kill(); }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 1000) stderr = clip(stderr + chunk.toString('utf8'), 1000); });
    child.on('error', (error) => finish({ code: -1, stdout: '', stderr: error.message, truncated }, aborted ? new WorkspaceError('ABORTED', 'Operation cancelled.') : undefined));
    // Do not report cancellation until the child has stopped; callers can then
    // safely release concurrency slots and start another operation.
    child.on('close', (code) => finish({ code: timedOut ? -1 : code, stdout: Buffer.concat(chunks).toString('utf8'), stderr, truncated, timedOut }, aborted ? new WorkspaceError('ABORTED', 'Operation cancelled.') : undefined));
  });
}

// Repo discovery only looks at ancestors, so a missing .git entry proves that
// spawning Git cannot succeed. This keeps non-Git workspaces off the ~50ms
// process startup path without changing any result.
async function hasGitAncestor(root) {
  let directory = root;
  for (;;) {
    try {
      await fs.lstat(path.join(directory, '.git'));
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return true;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

async function gitContainsRoot(root, signal) {
  if (!(await hasGitAncestor(root))) return false;
  const result = await runGit(root, ['rev-parse', '--show-toplevel'], { signal, maxBytes: 16384 });
  if (result.code !== 0 || result.truncated) return false;
  try {
    const top = await fs.realpath(result.stdout.replace(/\r?\n$/, ''));
    return inside(top, root);
  } catch { return false; }
}

async function disabledGitFilters(root, signal) {
  // Git's clean/process filters can run during diff even with --no-textconv.
  // Enumerate their config keys (without executing them), then disable every
  // driver for the diff command. Reject oversized/unreadable configuration.
  const result = await runGit(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\..*\.(clean|smudge|process|required)$'], { signal, maxBytes: 32768 });
  if (result.truncated || ![0, 1].includes(result.code)) return null;
  const keys = result.stdout.split('\0').filter(Boolean);
  const overrides = [];
  for (const key of keys) {
    overrides.push('-c', key + '=' + (key.endsWith('.required') ? 'false' : ''));
    if (!key.endsWith('.required')) overrides.push('-c', key.replace(/\.[^.]+$/, '.required') + '=false');
  }
  return overrides.join('').length < 10000 ? overrides : null;
}

/** Bounded, read-only workspace inspection. No task commands are executed. */
export class Workspace {
  constructor(root, config = {}) {
    if (typeof root !== 'string' || !root) throw new WorkspaceError('INVALID_ROOT', 'A workspace root is required.');
    this.root = path.resolve(root);
    const unlimited = config.unlimitedTokens === true;
    this.unlimitedTokens = unlimited;
    this.maxFiles = unlimited ? 5000 : bounded(config.maxFiles, 800, 1, 5000);
    this.maxFileBytes = unlimited ? 262144 : bounded(config.maxFileBytes, 262144, 1024, 262144);
    this.maxOutputChars = unlimited ? Number.POSITIVE_INFINITY : bounded(config.maxOutputChars, DEFAULT_OUTPUT, 1000, 20000);
    this.brandIntent = typeof config.brandIntent === 'string' ? clip(config.brandIntent, 300) : '';
    this.allowBrandColors = config.allowBrandColors === true;
  }

  async _root(signal) {
    abortIfNeeded(signal);
    const stat = await fs.lstat(this.root);
    if (stat.isSymbolicLink()) throw new WorkspaceError('DISALLOWED_SYMLINK', 'Workspace roots cannot be symbolic links or junctions.');
    if (!stat.isDirectory()) throw new WorkspaceError('INVALID_ROOT', 'Workspace root must be a directory.');
    return fs.realpath(this.root);
  }

  // One operation resolves the same directory prefixes for every file it visits.
  // A per-operation memo of already-verified paths removes the repeated
  // lstat/realpath syscalls without caching across calls, because files change
  // between operations and each call must observe the current tree.
  async _resolve(root, input = '.', { signal, allowMissing = false, cache = null } = {}) {
    abortIfNeeded(signal);
    if (typeof input !== 'string' || input.includes('\0') || path.isAbsolute(input) || /^[a-z]:/i.test(input) || /^[/\\]/.test(input)) {
      throw new WorkspaceError('INVALID_PATH', 'Use a relative path inside the workspace.');
    }
    // Treat either separator as a separator, including when inspecting on Linux.
    const segments = input.split(/[/\\]+/).filter((part) => part && part !== '.');
    if (segments.includes('..')) throw new WorkspaceError('PATH_ESCAPE', 'Parent traversal is not allowed.');
    if (segments.some(deniedSegment)) throw new WorkspaceError('SECRET_PATH', 'Secret and Git metadata paths are excluded.');
    const target = path.resolve(root, ...segments);
    if (!inside(root, target)) throw new WorkspaceError('PATH_ESCAPE', 'Path is outside the workspace.');
    const relative = portable(path.relative(root, target));
    const settled = cache?.get(relative);
    if (settled) return settled;
    let cursor = root;
    let prefix = '';
    let stat = null;
    for (let index = 0; index < segments.length; index++) {
      abortIfNeeded(signal);
      cursor = path.join(cursor, segments[index]);
      prefix = prefix ? prefix + '/' + segments[index] : segments[index];
      let entry = cache?.get(prefix);
      if (!entry) {
        let current;
        try { current = await fs.lstat(cursor); } catch (error) {
          if (allowMissing && error.code === 'ENOENT') return { absolute: target, relative, stat: null };
          throw error;
        }
        if (current.isSymbolicLink()) throw new WorkspaceError('DISALLOWED_SYMLINK', 'Symbolic links and junctions are excluded.');
        // Every component so far is a verified non-symlink under an already
        // resolved root, so an escaping component can only appear here.
        const actual = await fs.realpath(cursor);
        if (!inside(root, actual)) throw new WorkspaceError('PATH_ESCAPE', 'Resolved path is outside the workspace.');
        entry = { absolute: cursor, relative: prefix, stat: current };
        cache?.set(prefix, entry);
      }
      stat = entry.stat;
      if (index < segments.length - 1 && !stat.isDirectory()) throw new WorkspaceError('INVALID_PATH', 'A parent path is not a directory.');
    }
    // The walk above already lstat'ed the final segment; only the bare root
    // needs its own stat when no segment ran.
    if (stat === null) stat = await fs.lstat(target);
    const resolved = { absolute: target, relative, stat };
    cache?.set(relative, resolved);
    return resolved;
  }

  // Streams file names so callers that only need the first matches can stop
  // early instead of materialising and then re-reading the whole tree. Skip
  // counters therefore describe the part of the tree an operation visited.
  async * _files(root, selected, stats, signal, cache) {
    if (selected.stat.isFile()) { yield selected.relative; return; }
    if (!selected.stat.isDirectory()) throw new WorkspaceError('INVALID_PATH', 'Expected a file or directory.');
    const listing = await gitContainsRoot(root, signal) ? await runGit(root, ['--literal-pathspecs', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', selected.relative || '.'], {
      signal, maxBytes: Math.min(4 * 1024 * 1024, this.maxFiles * 1024),
    }) : { code: -1, stdout: '', truncated: false };
    if (listing.code === 0 || listing.truncated) {
      stats.ignoreSource = 'git';
      const entries = listing.stdout.split('\0');
      if (listing.truncated) { entries.pop(); stats.scanLimitReached = true; }
      let emitted = 0;
      for (const name of [...new Set(entries.filter(Boolean))].sort()) {
        abortIfNeeded(signal);
        const segments = name.split('/');
        if (segments.some(deniedSegment)) { recordSkip(stats, 'secret'); continue; }
        if (segments.slice(0, -1).some((part) => SKIP_DIRS.has(part.toLowerCase()))) { recordSkip(stats, 'excludedDirectory'); continue; }
        if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) { recordSkip(stats, 'binary'); continue; }
        if (emitted >= this.maxFiles) { stats.scanLimitReached = true; break; }
        try {
          const resolved = await this._resolve(root, name, { signal, cache });
          if (resolved.stat.isFile()) { emitted++; yield name; }
          else recordSkip(stats, 'nonFile');
        } catch (error) {
          if (error.code === 'ABORTED') throw error;
          recordSkip(stats, error.code === 'DISALLOWED_SYMLINK' ? 'symlink' : 'unavailable');
        }
      }
      return;
    }
    stats.ignoreSource = 'built-in';
    stats.ignoreLimitation = 'Git ignore rules could not be evaluated; only built-in exclusions are applied.';
    const workspace = this;
    const maxFiles = this.maxFiles;
    let visitedEntries = 0;
    let emitted = 0;
    const maxEntries = Math.max(100, maxFiles * 8);
    const visit = async function* (directory, directoryPath) {
      abortIfNeeded(signal);
      const entries = [];
      try {
        const directoryHandle = await fs.opendir(directory);
        for await (const entry of directoryHandle) {
          abortIfNeeded(signal);
          if (visitedEntries >= maxEntries) { stats.scanLimitReached = true; break; }
          visitedEntries++;
          entries.push(entry);
        }
      } catch (error) {
        if (error.code === 'ABORTED') throw error;
        recordSkip(stats, 'unavailable');
        return;
      }
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        abortIfNeeded(signal);
        if (emitted >= maxFiles) { stats.scanLimitReached = true; return; }
        if (entry.isSymbolicLink()) { recordSkip(stats, 'symlink'); continue; }
        if (deniedSegment(entry.name)) { recordSkip(stats, 'secret'); continue; }
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name.toLowerCase())) { recordSkip(stats, 'excludedDirectory'); continue; }
        const relative = directoryPath ? directoryPath + '/' + entry.name : entry.name;
        try {
          const resolved = await workspace._resolve(root, relative, { signal, cache });
          if (resolved.stat.isDirectory()) yield* visit(resolved.absolute, relative);
          else if (resolved.stat.isFile()) {
            if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) recordSkip(stats, 'binary');
            else { emitted++; yield relative; }
          } else recordSkip(stats, 'nonFile');
        } catch (error) {
          if (error.code === 'ABORTED') throw error;
          recordSkip(stats, error.code === 'DISALLOWED_SYMLINK' ? 'symlink' : 'unavailable');
        }
      }
    };
    yield* visit(selected.absolute, selected.relative);
  }

  async _inventory(root, selected, stats, signal, cache) {
    const files = [];
    for await (const name of this._files(root, selected, stats, signal, cache)) files.push(name);
    return files;
  }

  async _sample(root, name, stats, signal, cache) {
    abortIfNeeded(signal);
    try {
      const checked = await this._resolve(root, name, { signal, cache });
      if (!checked.stat.isFile()) { recordSkip(stats, 'nonFile'); return false; }
      if (checked.stat.size > this.maxFileBytes) { recordSkip(stats, 'largeFile'); return false; }
      const handle = await fs.open(checked.absolute, 'r');
      try {
        const opened = await handle.stat();
        if (!sameFile(opened, checked.stat)) { recordSkip(stats, 'changedDuringRead'); return false; }
        const buffer = Buffer.alloc(Math.min(8192, opened.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (isBinary(buffer.subarray(0, bytesRead))) { recordSkip(stats, 'binary'); return false; }
        stats.scannedFiles++;
        return true;
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ABORTED') throw error;
      recordSkip(stats, error.code === 'DISALLOWED_SYMLINK' ? 'symlink' : 'unavailable');
      return false;
    }
  }

  async list(selected = '.', { signal } = {}) {
    const root = await this._root(signal);
    const cache = new Map();
    const resolved = await this._resolve(root, selected, { signal, cache });
    const stats = { scannedFiles: 0, skipped: {}, scanLimitReached: false };
    const files = await this._inventory(root, resolved, stats, signal, cache);
    return { files, stats, truncated: Boolean(stats.scanLimitReached) };
  }

  async _text(root, name, stats, signal, cache) {
    abortIfNeeded(signal);
    try {
      const checked = await this._resolve(root, name, { signal, cache });
      if (!checked.stat.isFile()) { recordSkip(stats, 'nonFile'); return null; }
      if (checked.stat.size > this.maxFileBytes) { recordSkip(stats, 'largeFile'); return null; }
      const handle = await fs.open(checked.absolute, 'r');
      try {
        // Recheck after opening to reject replaced paths before reading content.
        const afterOpen = await fs.lstat(checked.absolute);
        if (afterOpen.isSymbolicLink()) { recordSkip(stats, 'symlink'); return null; }
        const openedStat = await handle.stat();
        if (!sameFile(openedStat, checked.stat) || !sameFile(openedStat, afterOpen)) {
          recordSkip(stats, 'changedDuringRead');
          return null;
        }
        if (!openedStat.isFile() || openedStat.size > this.maxFileBytes) { recordSkip(stats, 'largeFile'); return null; }
        const buffer = Buffer.alloc(Math.min(this.maxFileBytes + 1, openedStat.size + 1));
        let offset = 0;
        while (offset < buffer.length) {
          abortIfNeeded(signal);
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset > this.maxFileBytes) { recordSkip(stats, 'largeFile'); return null; }
        const bytes = buffer.subarray(0, offset);
        if (isBinary(bytes)) { recordSkip(stats, 'binary'); return null; }
        stats.scannedFiles++;
        const content = bytes.toString('utf8');
        return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ABORTED') throw error;
      recordSkip(stats, error.code === 'DISALLOWED_SYMLINK' ? 'symlink' : 'unavailable');
      return null;
    }
  }

  async run(args = {}, { signal } = {}) {
    abortIfNeeded(signal);
    if (!args || typeof args !== 'object' || !ACTIONS.has(args.action)) throw new WorkspaceError('INVALID_ACTION', 'Choose map, search, read, diff, checks, or style.');
    const root = await this._root(signal);
    const cache = new Map();
    const selected = await this._resolve(root, args.path ?? '.', { signal, cache, allowMissing: args.action === 'diff' });
    const limit = this.unlimitedTokens ? bounded(args.limit, 5000, 1, 5000) : bounded(args.limit, 80, 1, 200);
    const start = bounded(args.start, 1, 1, Number.MAX_SAFE_INTEGER);
    const stats = { scannedFiles: 0, skipped: {}, scanLimitReached: false };
    const result = { action: args.action, path: selected.relative || '.', ...stats };
    let truncated = false;

    if (args.action === 'diff') {
      const scope = args.scope ?? 'unstaged';
      if (!['unstaged', 'staged', 'all'].includes(scope)) throw new WorkspaceError('INVALID_ARGUMENTS', 'Diff scope must be unstaged, staged, or all.');
      // Disable user-configured external diff and text conversion executables.
      const base = ['--literal-pathspecs', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--relative', ...(scope === 'staged' ? ['--cached'] : scope === 'all' ? ['HEAD'] : [])];
      const gitAllowed = await gitContainsRoot(root, signal);
      const filterOverrides = gitAllowed ? await disabledGitFilters(root, signal) : null;
      const names = filterOverrides !== null ? await runGit(root, [...filterOverrides, ...base, '--name-only', '-z', '--', selected.relative || '.'], { signal, maxBytes: Math.min(4 * 1024 * 1024, this.maxFiles * 1024) }) : { code: -1, stdout: '', truncated: false };
      result.available = names.code === 0 || names.truncated;
      result.diff = '';
      result.scope = scope === 'staged' ? 'Staged tracked changes; unstaged and untracked content are not included.' : scope === 'all' ? 'Tracked changes against HEAD; untracked content is not included.' : 'Unstaged tracked changes; staged and untracked content are not included.';
      if (!result.available) result.reason = gitAllowed && filterOverrides === null ? 'Git filter configuration could not be safely inspected.' : names.timedOut ? 'Git diff timed out.' : 'Git diff is unavailable for this workspace.';
      else {
        const changed = names.stdout.split('\0');
        if (names.truncated) changed.pop();
        const safe = [];
        // Windows command lines are limited to roughly 32K characters. Count
        // conservative quoting overhead as well as the filter overrides.
        let argumentChars = root.length * 2 + filterOverrides.join('').length * 2 + 1024;
        for (const name of changed.filter(Boolean)) {
          abortIfNeeded(signal);
          const segments = name.split('/');
          if (segments.some(deniedSegment)) { recordSkip(stats, 'secret'); continue; }
          if (segments.slice(0, -1).some((part) => SKIP_DIRS.has(part.toLowerCase()))) { recordSkip(stats, 'excludedDirectory'); continue; }
          if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) { recordSkip(stats, 'binary'); continue; }
          if (safe.length >= this.maxFiles || argumentChars + name.length * 2 + 3 > 28000) { stats.scanLimitReached = true; break; }
          try {
            const checked = await this._resolve(root, name, { signal, cache, allowMissing: true });
            if (checked.stat && (!checked.stat.isFile() || checked.stat.size > this.maxFileBytes)) { recordSkip(stats, 'largeFile'); continue; }
            safe.push(name);
            argumentChars += name.length * 2 + 3;
          } catch (error) {
            if (error.code === 'ABORTED') throw error;
            recordSkip(stats, error.code === 'DISALLOWED_SYMLINK' ? 'symlink' : 'unavailable');
          }
        }
        if (safe.length) {
          const diff = await runGit(root, [...filterOverrides, ...base, '--', ...safe], { signal, maxBytes: this.maxOutputChars * 4 });
          result.available = diff.code === 0 || diff.truncated;
          result.diff = diff.stdout;
          stats.scannedFiles = safe.length;
          truncated = diff.truncated;
          if (!result.available) result.reason = 'Git diff could not be read.';
        }
        truncated ||= names.truncated;
      }
    } else if (args.action === 'read') {
      if (!selected.stat.isFile()) throw new WorkspaceError('INVALID_PATH', 'Read requires a file path.');
      const content = await this._text(root, selected.relative, stats, signal, cache);
      result.lines = [];
      if (content !== null) {
        const lines = content.split(/\r?\n/);
        result.totalLines = lines.length;
        for (let index = start - 1; index < Math.min(lines.length, start - 1 + limit); index++) {
          result.lines.push({ line: index + 1, text: this.unlimitedTokens ? lines[index] : clip(lines[index], 1200) });
          if (!this.unlimitedTokens && lines[index].length > 1200) truncated = true;
        }
        truncated ||= start - 1 + limit < lines.length;
      }
    } else {
      if (args.action === 'search' && (typeof args.query !== 'string' || !args.query || args.query.length > 1000)) {
        throw new WorkspaceError('INVALID_QUERY', 'Search requires a nonempty literal query of at most 1000 characters.');
      }
      if (args.action === 'map') {
        result.files = [];
        result.counts = {};
        for (const name of await this._inventory(root, selected, stats, signal, cache)) {
          if (!(await this._sample(root, name, stats, signal, cache))) continue;
          const extension = path.extname(name).toLowerCase() || '(none)';
          result.counts[extension] = (result.counts[extension] || 0) + 1;
          if (result.files.length < limit) result.files.push(name); else truncated = true;
        }
      } else if (args.action === 'checks') {
        result.packages = [];
        result.configs = [];
        result.executed = false;
        const configPattern = /^(?:tsconfig(?:\.[^.]+)?\.json|(?:vite|vitest|jest|webpack|rollup|eslint|playwright|cypress)\.config\.[cm]?[jt]s|\.eslintrc(?:\..+)?|pyproject\.toml|pytest\.ini|tox\.ini|Cargo\.toml|go\.mod|Makefile|CMakeLists\.txt|pom\.xml|build\.gradle(?:\.kts)?|deno\.jsonc?)$/i;
        for (const name of await this._inventory(root, selected, stats, signal, cache)) {
          abortIfNeeded(signal);
          const basename = path.posix.basename(name);
          if (basename === 'package.json') {
            const content = await this._text(root, name, stats, signal, cache);
            if (content === null) continue;
            try {
              const parsed = JSON.parse(content);
              const scripts = parsed?.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts) ? parsed.scripts : {};
              const names = Object.keys(scripts).sort().filter((key) => typeof scripts[key] === 'string');
              const selectedNames = this.unlimitedTokens ? names : names.slice(0, 40);
              result.packages.push({ path: name, scripts: Object.fromEntries(selectedNames.map((key) => [clip(key, 100), this.unlimitedTokens ? scripts[key] : clip(scripts[key], 300)])) });
            } catch { recordSkip(stats, 'invalidJson'); }
          } else if (configPattern.test(basename) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)) {
            result.configs.push(name);
          }
        }
      } else {
        const style = args.action === 'style';
        const entries = style ? (result.warnings = []) : (result.matches = []);
        const query = !style ? String(args.query) : '';
        const caseSensitive = args.caseSensitive === true;
        const terms = !style && args.mode === 'terms' ? query.trim().split(/\s+/).filter(Boolean) : [];
        const brandIntent = typeof args.brandIntent === 'string' ? clip(args.brandIntent, 300) : this.brandIntent;
        const allowBrandColors = args.allowBrandColors === true || this.allowBrandColors || Boolean(brandIntent);
        const unlimited = this.unlimitedTokens;
        // Literal queries need one normalised copy of the file: per-line
        // lowercasing and per-line query normalisation are pure overhead.
        const needle = caseSensitive ? query : query.toLowerCase();
        const loweredTerms = caseSensitive ? terms : terms.map((term) => term.toLowerCase());
        const literalScan = !style && !terms.length && !/[\r\n]/.test(needle);
        const patterns = [];
        if (!allowBrandColors) patterns.push({ kind: 'generic-palette', regex: /#(?:0f172a|1e293b|172554|1e3a8a|1d4ed8|2563eb|3b82f6|4f46e5|6366f1|7c3aed|8b5cf6)\b|\b(?:bg|from|via|to)-(?:blue|indigo|violet|purple)-(?:[1-9]00|950)\b|\bnavy\b/gi, message: 'Common navy/blue/purple default palette; confirm that this choice fits the requested visual direction.' });
        patterns.push({ kind: 'gradient', regex: /(?:linear|radial|conic)-gradient\s*\(|\bbg-gradient-to-[a-z]+\b|\bbg-linear-to-[a-z]+\b/gi, message: 'Gradient detected; confirm it serves a deliberate visual purpose.' });
        if (style) {
          result.advisory = true;
          result.brandIntent = brandIntent || null;
          result.note = 'Heuristic suggestions only. Preserve colors and gradients when they express an intentional brand or user request.';
        }
        outer: for await (const name of this._files(root, selected, stats, signal, cache)) {
          if (style && !STYLE_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
          const content = await this._text(root, name, stats, signal, cache);
          if (content === null) continue;
          if (style) {
            const lines = content.split(/\r?\n/);
            for (let index = 0; index < lines.length; index++) {
              abortIfNeeded(signal);
              const line = lines[index];
              for (const pattern of patterns) {
                pattern.regex.lastIndex = 0;
                const match = pattern.regex.exec(line);
                if (match) entries.push({ path: name, line: index + 1, column: match.index + 1, kind: pattern.kind, token: match[0], message: pattern.message });
                if (entries.length >= limit) { truncated = true; break outer; }
              }
            }
            continue;
          }
          if (literalScan) {
            // Case-insensitive literal search: normalise the whole file once and
            // map each match back to its line. The length check keeps offsets
            // exact when a case mapping would change character counts.
            const lowered = caseSensitive ? content : content.toLowerCase();
            if (lowered.length === content.length) {
              let lineStart = 0;
              let lineNumber = 1;
              let newline = lowered.indexOf('\n', 0);
              let position = lowered.indexOf(needle);
              while (position !== -1) {
                abortIfNeeded(signal);
                while (newline !== -1 && newline < position) {
                  lineStart = newline + 1;
                  lineNumber++;
                  newline = lowered.indexOf('\n', lineStart);
                }
                const lineEnd = newline === -1 ? content.length : newline > lineStart && content.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
                const line = content.slice(lineStart, lineEnd);
                const column = position - lineStart;
                const offset = unlimited ? 0 : Math.max(0, column - 200);
                entries.push({ path: name, line: lineNumber, column: column + 1, text: (offset ? '…' : '') + (unlimited ? line : clip(line.slice(offset), 700)) });
                if (!unlimited && (offset || line.length > 700)) truncated = true;
                if (entries.length >= limit) { truncated = true; break outer; }
                if (newline === -1) break;
                lineStart = newline + 1;
                lineNumber++;
                newline = lowered.indexOf('\n', lineStart);
                position = lowered.indexOf(needle, lineStart);
              }
              continue;
            }
          }
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++) {
            abortIfNeeded(signal);
            const line = lines[index];
            const haystack = caseSensitive ? line : line.toLowerCase();
            const column = terms.length ? (terms.every((term, termIndex) => haystack.includes(caseSensitive ? term : loweredTerms[termIndex])) ? haystack.indexOf(caseSensitive ? terms[0] : loweredTerms[0]) : -1) : haystack.indexOf(needle);
            if (column !== -1) {
              const offset = unlimited ? 0 : Math.max(0, column - 200);
              entries.push({ path: name, line: index + 1, column: column + 1, text: (offset ? '…' : '') + (unlimited ? line : clip(line.slice(offset), 700)) });
              if (!unlimited && (offset || line.length > 700)) truncated = true;
            }
            if (entries.length >= limit) { truncated = true; break outer; }
          }
        }
      }
    }
    Object.assign(result, stats);
    result.truncated = truncated || stats.scanLimitReached;
    abortIfNeeded(signal);
    return fitOutput(result, this.maxOutputChars);
  }
}
