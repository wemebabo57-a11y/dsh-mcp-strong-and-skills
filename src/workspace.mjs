import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.npm-cache', '.turbo', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'target']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.7z', '.exe', '.dll', '.so', '.woff', '.woff2', '.ttf', '.mp4', '.mp3', '.sqlite', '.db', '.lockb']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.html', '.vue', '.svelte']);
const ACTIONS = new Set(['map', 'search', 'read', 'diff', 'checks', 'style']);
const DEFAULT_OUTPUT = 6000;

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
  return ['.git', '.ssh', '.aws', '.npmrc', '.netrc'].includes(name) || name.startsWith('.credentials') || (name.startsWith('.env') && name !== '.env.example') ||
    /^\.?(?:credentials?|secrets?)(?:[._-]|$)/.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/.test(name) ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/.test(name);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
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
  for (const value of sample) {
    if (value === 0) return true;
    if (value < 32 && ![9, 10, 12, 13].includes(value)) controls++;
  }
  return controls > Math.max(2, sample.length * 0.01);
}

function recordSkip(stats, reason, count = 1) {
  stats.skipped[reason] = (stats.skipped[reason] || 0) + count;
}

// Always return a JSON object, even when output must be reduced. Keep metadata
// instead of slicing serialized JSON, which can break Unicode and JSON syntax.
function fitOutput(result, budget) {
  result.truncated = Boolean(result.truncated);
  let serialized = JSON.stringify(result);
  const arrays = ['matches', 'warnings', 'files', 'lines', 'packages', 'configs'];
  while (serialized.length > budget) {
    let changed = false;
    for (const key of arrays) {
      if (Array.isArray(result[key]) && result[key].length > 1) {
        result[key].pop();
        result.omittedItems = (result.omittedItems || 0) + 1;
        changed = true;
        break;
      }
    }
    if (!changed) {
      const candidates = [];
      const findStrings = (object, scripts = false) => {
        if (!object || typeof object !== 'object') return;
        for (const [key, value] of Object.entries(object)) {
          if (typeof value === 'string' && value.length > 80 && (scripts || ['text', 'diff', 'message', 'note', 'scope', 'brandIntent', 'reason'].includes(key))) candidates.push({ object, key, value });
          else if (value && typeof value === 'object') findStrings(value, key === 'scripts');
        }
      };
      findStrings(result);
      const candidate = candidates.sort((a, b) => b.value.length - a.value.length)[0];
      if (candidate) {
        const excess = serialized.length - budget;
        candidate.object[candidate.key] = clip(candidate.value, Math.max(40, candidate.value.length - excess - 40));
        changed = true;
      }
    }
    if (!changed) {
      const pkg = result.packages?.find((item) => Object.keys(item.scripts || {}).length > 1);
      if (pkg) {
        delete pkg.scripts[Object.keys(pkg.scripts).at(-1)];
        pkg.omittedScripts = (pkg.omittedScripts || 0) + 1;
        changed = true;
      }
    }
    if (!changed) {
      const key = arrays.find((key) => result[key]?.length);
      if (key) { result[key].pop(); result.omittedItems = (result.omittedItems || 0) + 1; changed = true; }
    }
    result.truncated = true;
    if (!changed) return { action: result.action, truncated: true, reason: 'Output metadata exceeded the configured budget.' };
    serialized = JSON.stringify(result);
  }
  return result;
}

async function runGit(root, args, { signal, maxBytes = 1024 * 1024, timeoutMs = 10000 } = {}) {
  abortIfNeeded(signal);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], {
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

async function gitContainsRoot(root, signal) {
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
  const result = await runGit(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { signal, maxBytes: 32768 });
  if (result.truncated || ![0, 1].includes(result.code)) return null;
  const keys = result.stdout.split('\0').filter(Boolean);
  const overrides = [];
  for (const key of keys) {
    overrides.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    if (!key.endsWith('.required')) overrides.push('-c', `${key.replace(/\.[^.]+$/, '.required')}=false`);
  }
  return overrides.join('').length < 10000 ? overrides : null;
}

/** Bounded, read-only workspace inspection. No task commands are executed. */
export class Workspace {
  constructor(root, config = {}) {
    if (typeof root !== 'string' || !root) throw new WorkspaceError('INVALID_ROOT', 'A workspace root is required.');
    this.root = path.resolve(root);
    this.maxFiles = bounded(config.maxFiles, 800, 1, 5000);
    this.maxFileBytes = bounded(config.maxFileBytes, 262144, 1024, 262144);
    this.maxOutputChars = bounded(config.maxOutputChars, DEFAULT_OUTPUT, 1000, 20000);
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

  async _resolve(root, input = '.', { signal, allowMissing = false } = {}) {
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
    let cursor = root;
    for (let index = 0; index < segments.length; index++) {
      abortIfNeeded(signal);
      cursor = path.join(cursor, segments[index]);
      let stat;
      try { stat = await fs.lstat(cursor); } catch (error) {
        if (allowMissing && error.code === 'ENOENT') return { absolute: target, relative: portable(path.relative(root, target)), stat: null };
        throw error;
      }
      if (stat.isSymbolicLink()) throw new WorkspaceError('DISALLOWED_SYMLINK', 'Symbolic links and junctions are excluded.');
      const actual = await fs.realpath(cursor);
      if (!inside(root, actual)) throw new WorkspaceError('PATH_ESCAPE', 'Resolved path is outside the workspace.');
      if (index < segments.length - 1 && !stat.isDirectory()) throw new WorkspaceError('INVALID_PATH', 'A parent path is not a directory.');
    }
    const stat = await fs.lstat(target);
    return { absolute: target, relative: portable(path.relative(root, target)), stat };
  }

  async _inventory(root, selected, stats, signal) {
    if (selected.stat.isFile()) return [selected.relative];
    if (!selected.stat.isDirectory()) throw new WorkspaceError('INVALID_PATH', 'Expected a file or directory.');
    const list = await gitContainsRoot(root, signal) ? await runGit(root, ['--literal-pathspecs', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', selected.relative || '.'], {
      signal, maxBytes: Math.min(4 * 1024 * 1024, this.maxFiles * 1024),
    }) : { code: -1, stdout: '', truncated: false };
    const files = [];
    if (list.code === 0 || list.truncated) {
      stats.ignoreSource = 'git';
      const entries = list.stdout.split('\0');
      if (list.truncated) { entries.pop(); stats.scanLimitReached = true; }
      for (const name of [...new Set(entries.filter(Boolean))].sort()) {
        abortIfNeeded(signal);
        const segments = name.split('/');
        if (segments.some(deniedSegment)) { recordSkip(stats, 'secret'); continue; }
        if (segments.slice(0, -1).some((part) => SKIP_DIRS.has(part.toLowerCase()))) { recordSkip(stats, 'excludedDirectory'); continue; }
        if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) { recordSkip(stats, 'binary'); continue; }
        if (files.length >= this.maxFiles) { stats.scanLimitReached = true; break; }
        try {
          const resolved = await this._resolve(root, name, { signal });
          if (resolved.stat.isFile()) files.push(name);
          else recordSkip(stats, 'nonFile');
        } catch (error) {
          if (error.code === 'ABORTED') throw error;
          recordSkip(stats, error.code === 'DISALLOWED_SYMLINK' ? 'symlink' : 'unavailable');
        }
      }
      return files;
    }
    stats.ignoreSource = 'built-in';
    stats.ignoreLimitation = 'Git ignore rules could not be evaluated; only built-in exclusions are applied.';
    let visitedEntries = 0;
    const maxEntries = Math.max(100, this.maxFiles * 8);
    const visit = async (directory) => {
      abortIfNeeded(signal);
      const entries = [];
      try {
        const checked = await this._resolve(root, portable(path.relative(root, directory)), { signal });
        const directoryHandle = await fs.opendir(checked.absolute);
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
        if (files.length >= this.maxFiles) { stats.scanLimitReached = true; return; }
        if (entry.isSymbolicLink()) { recordSkip(stats, 'symlink'); continue; }
        if (deniedSegment(entry.name)) { recordSkip(stats, 'secret'); continue; }
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name.toLowerCase())) { recordSkip(stats, 'excludedDirectory'); continue; }
        const absolute = path.join(directory, entry.name);
        const relative = portable(path.relative(root, absolute));
        try {
          const resolved = await this._resolve(root, relative, { signal });
          if (resolved.stat.isDirectory()) await visit(resolved.absolute);
          else if (resolved.stat.isFile()) {
            if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) recordSkip(stats, 'binary');
            else files.push(relative);
          } else recordSkip(stats, 'nonFile');
        } catch (error) {
          if (error.code === 'ABORTED') throw error;
          recordSkip(stats, error.code === 'DISALLOWED_SYMLINK' ? 'symlink' : 'unavailable');
        }
      }
    };
    await visit(selected.absolute);
    return files;
  }

  async _text(root, name, stats, signal) {
    abortIfNeeded(signal);
    try {
      const checked = await this._resolve(root, name, { signal });
      if (!checked.stat.isFile()) { recordSkip(stats, 'nonFile'); return null; }
      if (checked.stat.size > this.maxFileBytes) { recordSkip(stats, 'largeFile'); return null; }
      const handle = await fs.open(checked.absolute, 'r');
      try {
        // Recheck after opening to reject replaced paths before reading content.
        const afterOpen = await this._resolve(root, name, { signal });
        const openedStat = await handle.stat();
        if (openedStat.dev !== checked.stat.dev || openedStat.ino !== checked.stat.ino || openedStat.dev !== afterOpen.stat.dev || openedStat.ino !== afterOpen.stat.ino) {
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
        return bytes.toString('utf8').replace(/^\uFEFF/, '');
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
    const selected = await this._resolve(root, args.path ?? '.', { signal, allowMissing: args.action === 'diff' });
    const limit = bounded(args.limit, 80, 1, 200);
    const start = bounded(args.start, 1, 1, Number.MAX_SAFE_INTEGER);
    const stats = { scannedFiles: 0, skipped: {}, scanLimitReached: false };
    const result = { action: args.action, path: selected.relative || '.', ...stats };
    let truncated = false;

    if (args.action === 'diff') {
      // Disable user-configured external diff and text conversion executables.
      const base = ['--literal-pathspecs', '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--relative'];
      const gitAllowed = await gitContainsRoot(root, signal);
      const filterOverrides = gitAllowed ? await disabledGitFilters(root, signal) : null;
      const names = filterOverrides !== null ? await runGit(root, [...filterOverrides, ...base, '--name-only', '-z', '--', selected.relative || '.'], { signal, maxBytes: Math.min(4 * 1024 * 1024, this.maxFiles * 1024) }) : { code: -1, stdout: '', truncated: false };
      result.available = names.code === 0 || names.truncated;
      result.diff = '';
      result.scope = 'Unstaged tracked changes; staged and untracked content are not included.';
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
            const checked = await this._resolve(root, name, { signal, allowMissing: true });
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
      const content = await this._text(root, selected.relative, stats, signal);
      result.lines = [];
      if (content !== null) {
        const lines = content.split(/\r?\n/);
        result.totalLines = lines.length;
        for (let index = start - 1; index < Math.min(lines.length, start - 1 + limit); index++) {
          result.lines.push({ line: index + 1, text: clip(lines[index], 1200) });
          if (lines[index].length > 1200) truncated = true;
        }
        truncated ||= start - 1 + limit < lines.length;
      }
    } else {
      if (args.action === 'search' && (typeof args.query !== 'string' || !args.query || args.query.length > 1000)) {
        throw new WorkspaceError('INVALID_QUERY', 'Search requires a nonempty literal query of at most 1000 characters.');
      }
      const files = await this._inventory(root, selected, stats, signal);
      if (args.action === 'map') {
        result.files = [];
        result.counts = {};
        for (const name of files) {
          const content = await this._text(root, name, stats, signal);
          if (content === null) continue;
          const extension = path.extname(name).toLowerCase() || '(none)';
          result.counts[extension] = (result.counts[extension] || 0) + 1;
          if (result.files.length < limit) result.files.push(name); else truncated = true;
        }
      } else if (args.action === 'checks') {
        result.packages = [];
        result.configs = [];
        result.executed = false;
        const configPattern = /^(?:tsconfig(?:\.[^.]+)?\.json|(?:vite|vitest|jest|webpack|rollup|eslint|playwright|cypress)\.config\.[cm]?[jt]s|\.eslintrc(?:\..+)?|pyproject\.toml|pytest\.ini|tox\.ini|Cargo\.toml|go\.mod|Makefile|CMakeLists\.txt|pom\.xml|build\.gradle(?:\.kts)?|deno\.jsonc?)$/i;
        for (const name of files) {
          abortIfNeeded(signal);
          const basename = path.posix.basename(name);
          if (basename === 'package.json') {
            const content = await this._text(root, name, stats, signal);
            if (content === null) continue;
            try {
              const parsed = JSON.parse(content);
              const scripts = parsed?.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts) ? parsed.scripts : {};
              result.packages.push({ path: name, scripts: Object.fromEntries(Object.keys(scripts).sort().filter((key) => typeof scripts[key] === 'string').slice(0, 40).map((key) => [clip(key, 100), clip(scripts[key], 300)])) });
            } catch { recordSkip(stats, 'invalidJson'); }
          } else if (configPattern.test(basename) || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(name)) {
            result.configs.push(name);
          }
        }
      } else {
        const style = args.action === 'style';
        const entries = style ? (result.warnings = []) : (result.matches = []);
        const query = !style ? args.query.toLowerCase() : '';
        const brandIntent = typeof args.brandIntent === 'string' ? clip(args.brandIntent, 300) : this.brandIntent;
        const allowBrandColors = args.allowBrandColors === true || this.allowBrandColors || Boolean(brandIntent);
        if (style) {
          result.advisory = true;
          result.brandIntent = brandIntent || null;
          result.note = 'Heuristic suggestions only. Preserve colors and gradients when they express an intentional brand or user request.';
        }
        outer: for (const name of files) {
          if (style && !STYLE_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
          const content = await this._text(root, name, stats, signal);
          if (content === null) continue;
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++) {
            abortIfNeeded(signal);
            const line = lines[index];
            if (style) {
              const patterns = [];
              if (!allowBrandColors) patterns.push({ kind: 'generic-palette', regex: /#(?:0f172a|1e293b|172554|1e3a8a|1d4ed8|2563eb|3b82f6|4f46e5|6366f1|7c3aed|8b5cf6)\b|\b(?:bg|from|via|to)-(?:blue|indigo|violet|purple)-(?:[1-9]00|950)\b|\bnavy\b/gi, message: 'Common navy/blue/purple default palette; confirm that this choice fits the requested visual direction.' });
              patterns.push({ kind: 'gradient', regex: /(?:linear|radial|conic)-gradient\s*\(|\bbg-gradient-to-[a-z]+\b|\bbg-linear-to-[a-z]+\b/gi, message: 'Gradient detected; confirm it serves a deliberate visual purpose.' });
              for (const pattern of patterns) {
                pattern.regex.lastIndex = 0;
                const match = pattern.regex.exec(line);
                if (match) entries.push({ path: name, line: index + 1, column: match.index + 1, kind: pattern.kind, token: match[0], message: pattern.message });
                if (entries.length >= limit) { truncated = true; break outer; }
              }
            } else {
              const column = line.toLowerCase().indexOf(query);
              if (column !== -1) {
                const offset = Math.max(0, column - 200);
                entries.push({ path: name, line: index + 1, column: column + 1, text: (offset ? '…' : '') + clip(line.slice(offset), 700) });
                if (offset || line.length > 700) truncated = true;
              }
              if (entries.length >= limit) { truncated = true; break outer; }
            }
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
