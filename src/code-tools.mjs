import path from 'node:path';
import { WorkspaceError } from './workspace.mjs';
import { validateArguments as validateSchema } from './validation.mjs';
import { fitResult } from './budget.mjs';

export const EXTRA_TOOLS = Object.freeze([
  { name: 'strong_code', description: '只读代码定位：symbols 声明；imports 静态 JS/TS 导入图；diagnostics 解析 text 中的报错并安全补充源码。启发式，有扫描上限。', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['symbols', 'imports', 'diagnostics'] }, path: { type: 'string', maxLength: 1000 }, text: { type: 'string', maxLength: 5000 }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '普通模式最多 80；无限 token 模式最多 500' },
  }, required: ['action'], additionalProperties: false } },
  { name: 'strong_review', description: '只读审查实际 diff：变更文件、风险位置、相关测试及已有验证脚本。仅建议，不运行命令。', inputSchema: { type: 'object', properties: {
    path: { type: 'string', maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '普通模式最多 80；无限 token 模式最多 500' },
    scope: { type: 'string', enum: ['unstaged', 'staged', 'all'] },
  }, additionalProperties: false } },
]);

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|php|rb)$/i;
const SCRIPT_EXTENSIONS = /\.[cm]?[jt]sx?$/i;
const CODE_LIMITS = Object.freeze({
  normal: Object.freeze({ reads: 40, lines: 2400, chars: 160000, files: 32 }),
  unlimited: Object.freeze({ reads: 120, lines: 8000, chars: 640000, files: 128 }),
});
const own = (object, key, fallback) => Object.hasOwn(object, key) ? object[key] : fallback;
const clipped = (value, max = 200) => {
  if (value.length <= max) return value;
  const end = /[\uD800-\uDBFF]/.test(value[max - 1]) ? max - 1 : max;
  return value.slice(0, end) + '…';
};

function cancelled(signal) {
  if (signal?.aborted) throw new WorkspaceError('ABORTED', 'Operation cancelled.');
}

function validate(name, args) {
  const tool = EXTRA_TOOLS.find((item) => item.name === name);
  if (!tool) throw new WorkspaceError('INVALID_TOOL', 'Unknown code tool.');
  try { validateSchema(tool.inputSchema, args); }
  catch (error) { throw new WorkspaceError('INVALID_ARGUMENTS', error.message); }
  if (name === 'strong_code' && args.action === 'diagnostics' && (typeof args.text !== 'string' || !args.text.trim())) throw new WorkspaceError('INVALID_ARGUMENTS', 'diagnostics requires nonempty text.');
}

// Reduce complete JSON values; output is never a sliced JSON string.
function fit(result, maxChars) {
  if (maxChars === Number.POSITIVE_INFINITY) { result.truncated = Boolean(result.truncated); return result; }
  const budget = Number.isInteger(maxChars) ? Math.max(1000, Math.min(20000, maxChars)) : 6000;
  return fitResult(result, budget, { hint: 'Output capped; narrow the path or request fewer items.' });
}

// Preserve offsets/newlines while excluding comments and optionally literals.
// Template interpolations and multiline Python strings are intentionally opaque.
const NON_NEWLINE = /[^\n]/g;

function blank(text) {
  return text.includes('\n') ? text.replace(NON_NEWLINE, ' ') : ' '.repeat(text.length);
}

// End offset of a literal that starts at `index`; escapes skip the next character
// and triple-quoted literals only close on three identical quotes.
function stringEnd(source, index, quote, triple) {
  const length = source.length;
  let cursor = index + (triple ? 3 : 1);
  while (cursor < length) {
    const char = source[cursor];
    if (char === '\\') { cursor += 2; continue; }
    if (char === quote) {
      if (!triple) return cursor + 1;
      if (source[cursor + 1] === quote && source[cursor + 2] === quote) return cursor + 3;
    }
    cursor++;
  }
  return length;
}

// One lexical pass yields both views: `clean` keeps literal text with comments
// blanked, `tokens` blanks literal text too. Callers needing both avoid a
// second scan of the same source.
function masks(source, { hash = false } = {}) {
  const length = source.length;
  const clean = [];
  const tokens = [];
  let runStart = 0;
  let index = 0;
  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    let end;
    let plain;
    let blanked;
    if ((char === '/' && next === '/') || (hash && char === '#')) {
      end = source.indexOf('\n', index);
      if (end === -1) end = length;
      plain = blanked = ' '.repeat(end - index);
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      end = close === -1 ? length : close + 2;
      plain = blanked = blank(source.slice(index, end));
    } else if (char === '"' || char === "'" || char === '`') {
      const triple = hash && source[index + 1] === char && source[index + 2] === char;
      end = stringEnd(source, index, char, triple);
      plain = source.slice(index, end);
      blanked = blank(plain);
    } else { index++; continue; }
    if (index > runStart) { const run = source.slice(runStart, index); clean.push(run); tokens.push(run); }
    clean.push(plain);
    tokens.push(blanked);
    index = end;
    runStart = end;
  }
  if (runStart < length) { const run = source.slice(runStart); clean.push(run); tokens.push(run); }
  return { clean: clean.join(''), tokens: tokens.join('') };
}

function mask(source, { strings = true, hash = false } = {}) {
  const views = masks(source, { hash });
  return strings ? views.tokens : views.clean;
}

async function inventory(workspace, selected, signal) {
  if (typeof workspace.list === 'function') {
    const listed = await workspace.list(selected, { signal });
    return { action: 'map', files: listed.files, ...listed.stats, truncated: Boolean(listed.truncated ?? listed.stats?.scanLimitReached) };
  }
  return workspace.run({ action: 'map', path: selected, limit: 200 }, { signal });
}

async function sourceFiles(workspace, selected, signal, includeRootInventory = false, limits = CODE_LIMITS.normal) {
  const { reads: MAX_READS, lines: MAX_LINES, chars: MAX_CHARS, files: MAX_SOURCE_FILES } = limits;
  // The selected subtree and the root inventory are independent listings; overlap them.
  const [map, rootMap] = await Promise.all([inventory(workspace, selected, signal), includeRootInventory && selected !== '.' ? inventory(workspace, '.', signal) : null]);
  cancelled(signal);
  const roots = rootMap ?? map;
  const sources = [];
  let reads = 0;
  let lineCount = 0;
  let charCount = 0;
  let truncated = map.truncated || roots.truncated;
  let charLimitReached = false;
  const names = (map.files ?? []).filter((name) => SOURCE_EXTENSIONS.test(name));
  for (const name of names.slice(0, MAX_SOURCE_FILES)) {
    cancelled(signal);
    let start = 1;
    const lines = [];
    let total = 0;
    const perFileLines = limits === CODE_LIMITS.unlimited ? 8000 : 800;
    const readLimit = limits === CODE_LIMITS.unlimited ? 1000 : 200;
    while (start <= perFileLines && reads < MAX_READS && lineCount < MAX_LINES && charCount < MAX_CHARS) {
      const read = await workspace.run({ action: 'read', path: name, start, limit: Math.min(readLimit, MAX_LINES - lineCount, perFileLines + 1 - start) }, { signal });
      reads++;
      total = read.totalLines ?? 0;
      if (!read.lines?.length) { truncated ||= total >= start; break; }
      for (const line of read.lines) {
        if (charCount + line.text.length + 1 > MAX_CHARS) { truncated = true; charLimitReached = true; break; }
        lines.push(line.text);
        lineCount++;
        charCount += line.text.length + 1;
        if (line.text.length > 1200) truncated = true;
      }
      const next = (read.lines.at(-1)?.line ?? start) + 1;
      if (next <= start) { truncated = true; break; }
      start = next;
      if (start > total) break;
      if (charLimitReached || charCount >= MAX_CHARS || lineCount >= MAX_LINES) break;
    }
    if (start <= total) truncated = true;
    sources.push({ path: name, source: lines.join('\n') });
    if (charLimitReached || reads >= MAX_READS || lineCount >= MAX_LINES || charCount >= MAX_CHARS) break;
  }
  truncated ||= sources.length < names.length;
  return { sources, inventory: roots.files ?? [], truncated: Boolean(truncated), scannedFiles: sources.length, scannedLines: lineCount, skipped: map.skipped ?? {}, limits };
}

const DECLARATIONS = Object.freeze([
  ['function', /\b(?:function\s*\*?\s+|(?:async\s+)?def\s+|fn\s+)([A-Za-z_$][\w$]*)/g],
  ['function', /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g],
  ['class', /\bclass\s+([A-Za-z_$][\w$]*)/g],
  ['interface', /\binterface\s+([A-Za-z_$][\w$]*)/g],
  ['type', /\b(?:type|enum|struct|trait)\s+([A-Za-z_$][\w$]*)/g],
  ['function', /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^;]*\)|[A-Za-z_$][\w$]*)\s*=>/g],
  ['export', /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g],
  ['method', /^\s*(?!(?:if|for|while|switch|catch|with|return|function|class)\b)(?:(?:async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g],
]);

function symbols(scan, limit, signal) {
  const items = [];
  let more = false;
  outer: for (const file of scan.sources) {
    const clean = mask(file.source, { hash: /\.(?:py|rb)$/i.test(file.path) });
    const lines = clean.split('\n');
    for (let index = 0; index < lines.length; index++) {
      cancelled(signal);
      const line = lines[index];
      if (line === '') continue;
      const seen = new Set();
      for (const [kind, regex] of DECLARATIONS) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(line)) !== null) {
          const name = match[1];
          if (seen.has(name)) continue;
          seen.add(name);
          if (items.length >= limit) { more = true; break outer; }
          items.push({ path: file.path, line: index + 1, name, kind, exported: /\bexport\b/.test(line) });
        }
      }
      if (!line.includes('export')) continue;
      const exports = line.match(/\bexport\s*\{([^}]+)\}/);
      if (exports) for (const entry of exports[1].split(',')) {
        const name = entry.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!name) continue;
        if (items.length >= limit) { more = true; break outer; }
        items.push({ path: file.path, line: index + 1, name: name[2] ?? name[1], kind: 'export', exported: true });
      }
    }
  }
  return { action: 'symbols', items, scannedFiles: scan.scannedFiles, scannedLines: scan.scannedLines, skipped: scan.skipped, truncated: scan.truncated || more,
    note: 'Heuristic declarations, not an AST or reference index; JS/TS plus basic Python/Go/Rust declarations. Comments/literals excluded; multiline, Unicode names and template interpolations may be missed. At most ' + scan.limits.files + ' files, ' + scan.limits.lines + ' lines and ' + scan.limits.reads + ' reads.' };
}

const IMPORT_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json']);
const IMPORT_EXTENSION_PATTERN = /(\.[cm]?[jt]sx?|\.json)$/;
const EXTENSION_RANK = new Map(IMPORT_EXTENSIONS.map((extension, position) => [extension, position]));

// Rank every resolvable base once: exact path, then base+extension in probe
// order, then base/index+extension. One map lookup replaces the per-specifier
// candidate array and its repeated inventory probes.
function resolutionIndex(files) {
  const index = new Map();
  const consider = (key, name, rank) => {
    const current = index.get(key);
    if (current !== undefined && current.rank <= rank) return;
    index.set(key, { path: name, rank });
  };
  for (const name of files) {
    consider(name, name, 0);
    const found = IMPORT_EXTENSION_PATTERN.exec(name);
    if (!found) continue;
    const extension = found[1];
    const rank = EXTENSION_RANK.get(extension);
    const base = name.slice(0, name.length - extension.length);
    consider(base, name, 1 + rank);
    if (base.endsWith('/index')) consider(base.slice(0, -6), name, 1 + IMPORT_EXTENSIONS.length + rank);
  }
  return index;
}

function resolveImport(from, specifier, index, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base) || /^[a-z]:/i.test(base) || base.includes('\\')) return { to: null, status: 'outside-workspace' };
  let to = index.get(base)?.path ?? null;
  if (to === null && /\.[cm]?js$/.test(base)) {
    const stem = base.slice(0, base.lastIndexOf('.'));
    to = files.has(stem + '.ts') ? stem + '.ts' : files.has(stem + '.tsx') ? stem + '.tsx' : null;
  }
  return { to, status: to ? 'resolved' : 'unresolved' };
}

const IMPORT_PATTERNS = Object.freeze([
  /\b(?:import|export)\s+(?:type\s+)?(?:\*\s*(?:as\s+[\w$]+)?|\{[^}]{0,1000}\}|[\w$]+(?:\s*,\s*(?:\*\s+as\s+[\w$]+|\{[^}]{0,1000}\}))?)\s+from\s*(['"])([^'"\r\n]+)\1/g,
  /\bimport\s*(['"])([^'"\r\n]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
]);

function imports(scan, limit, signal) {
  const edges = [];
  const packages = new Map();
  const files = new Set(scan.inventory);
  const index = resolutionIndex(scan.inventory);
  let dynamicImports = 0;
  let count = 0;
  let localCount = 0;
  for (const file of scan.sources) {
    if (!SCRIPT_EXTENSIONS.test(file.path)) continue;
    const { clean, tokens } = masks(file.source);
    dynamicImports += (tokens.match(/\b(?:import|require)\s*\(/g) ?? []).length;
    const found = [];
    for (const regex of IMPORT_PATTERNS) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(clean)) !== null) {
        cancelled(signal);
        // Literal text is blanked in `tokens`, so equal characters mean the
        // match starts in code rather than inside a string.
        if (tokens.charCodeAt(match.index) !== clean.charCodeAt(match.index)) continue;
        found.push({ offset: match.index, specifier: match[2], require: match[0].startsWith('require') });
      }
    }
    found.sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    let line = 1;
    const advanceTo = (target) => {
      while (true) {
        const newline = clean.indexOf('\n', cursor);
        if (newline === -1) { cursor = target; return; }
        if (newline >= target) return;
        line++;
        cursor = newline + 1;
      }
    };
    for (const entry of found) {
      if (entry.require) dynamicImports--;
      count++;
      if (entry.specifier.startsWith('.')) {
        localCount++;
        if (edges.length < limit) {
          advanceTo(entry.offset);
          edges.push({ from: file.path, line, specifier: clipped(entry.specifier), ...resolveImport(file.path, entry.specifier, index, files) });
        }
      } else {
        const dependency = entry.specifier.startsWith('@') ? entry.specifier.split('/').slice(0, 2).join('/') : entry.specifier.startsWith('node:') ? entry.specifier : entry.specifier.split('/')[0];
        packages.set(dependency, (packages.get(dependency) ?? 0) + 1);
      }
    }
  }
  const external = [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, references]) => ({ name: clipped(name), references }));
  return { action: 'imports', edges, external: external.slice(0, limit), staticImports: count, dynamicImportsExcluded: dynamicImports, scannedFiles: scan.scannedFiles, scannedLines: scan.scannedLines,
    truncated: scan.truncated || edges.length < localCount || external.length > limit, note: 'Heuristic static JS/TS import/export-from and literal require only. Dynamic imports excluded. Local resolution uses the bounded workspace inventory; aliases, package exports and project resolver settings are not evaluated.' };
}

function diagnosticLines(text) {
  const records = [];
  let eslintPath = '';
  for (const raw of text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    let match = line.match(/^(\d+):(\d+)\s+(error|warning)\s+(.+)$/);
    if (match && eslintPath) { records.push({ path: eslintPath, line: Number(match[1]), column: Number(match[2]), message: clipped(`${match[3]} ${match[4]}`, 500) }); continue; }
    match = line.match(/^(.+?)\((\d+),(\d+)\)\s*:\s*(.+)$/) ?? line.match(/^(.+?):(\d+)(?::(\d+))?\s*:?\s+(.+)$/);
    if (match) {
      records.push({ path: match[1].replace(/^['"]|['"]$/g, ''), line: Number(match[2]), column: match[3] ? Number(match[3]) : 1, message: clipped(match[4], 500) });
      continue;
    }
    const python = line.match(/^File ["'](.+)["'], line (\d+)/);
    if (python) { records.push({ path: python[1], line: Number(python[2]), column: 1, message: 'Python traceback location' }); continue; }
    if (/^(?:\.?\.?[/\\]|[A-Za-z]:[/\\]|[/\\])?.+\.[cm]?[jt]sx?$/.test(line) && !/\s{2}/.test(line)) { eslintPath = line; continue; }
  }
  return records;
}

function diagnosticPath(input, workspace) {
  // Relative paths are still checked by Workspace; absolute diagnostics can be
  // converted only when lexically inside this exact workspace root.
  const name = input.replace(/\\/g, '/');
  if (path.isAbsolute(input) || /^[a-z]:[/\\]/i.test(input) || name.startsWith('/')) {
    const root = workspace.root.replace(/\\/g, '/').replace(/\/$/, '');
    const windows = /^[a-z]:/i.test(root);
    const left = windows ? name.toLowerCase() : name;
    const right = windows ? root.toLowerCase() : root;
    if (!left.startsWith(right + '/')) return null;
    return name.slice(root.length + 1);
  }
  return name;
}

async function diagnostics(workspace, args, signal) {
  const limit = own(args, 'limit', 40);
  const parsed = diagnosticLines(args.text);
  const items = [];
  let excluded = 0;
  for (const entry of parsed.slice(0, limit)) {
    cancelled(signal);
    const name = diagnosticPath(entry.path, workspace);
    if (!name || !Number.isSafeInteger(entry.line) || entry.line < 1 || !Number.isSafeInteger(entry.column) || entry.column < 1) { excluded++; continue; }
    try {
      const read = await workspace.run({ action: 'read', path: name, start: Math.max(1, entry.line - 1), limit: 3 }, { signal });
      items.push({ path: read.path, line: entry.line, column: entry.column, message: entry.message, context: read.lines ?? [] });
    } catch (error) {
      if (error.code === 'ABORTED' || signal?.aborted) throw error;
      excluded++;
    }
  }
  return { action: 'diagnostics', items, parsed: parsed.length, excluded, truncated: parsed.length > limit, executed: false,
    note: 'Parses common path:line:column, TypeScript, ESLint stylish and Python traceback locations. Messages are pasted data, not verified failures; inaccessible, secret and outside-workspace paths are excluded.' };
}

const RISKS = [
  ['process-execution', /\b(?:eval|exec|execSync|execFile|spawn|spawnSync|Function)\s*\(/, 'Check input trust, argument boundaries and cancellation before executing code or processes.'],
  ['destructive-operation', /\b(?:rm|unlink|rmdir|deleteMany|dropDatabase|dropTable)\s*\(|\b(?:DELETE\s+FROM|DROP\s+TABLE)\b/i, 'Check target containment, authorization and failure recovery for destructive operations.'],
  ['html-injection', /dangerouslySetInnerHTML|\.innerHTML\s*=/, 'Verify untrusted content is sanitized before HTML insertion.'],
  ['network-boundary', /\b(?:fetch|axios(?:\.\w+)?|https?\.(?:request|get))\s*\(/, 'Check timeouts, response validation and handling of failed or cancelled requests.'],
  ['concurrency', /\b(?:Promise\.all|setTimeout|setInterval|AbortController|AbortSignal)\b/, 'Check cleanup, cancellation and shared-state behavior under concurrent work.'],
  ['input-parsing', /\b(?:JSON\.parse|parseInt|parseFloat|Number)\s*\(/, 'Check malformed input, boundary values and failure handling.'],
];

export function gitQuoted(value) {
  const bytes = [];
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];
    if (char !== '\\') { bytes.push(...Buffer.from(char, 'utf8')); continue; }
    const next = value[++index];
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1])) octal += value[++index];
      bytes.push(parseInt(octal, 8) & 0xff);
    } else if (next === 'n') bytes.push(10);
    else if (next === 't') bytes.push(9);
    else if (next === 'r') bytes.push(13);
    else if (next === 'b') bytes.push(8);
    else if (next !== undefined) bytes.push(...Buffer.from(next, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function diffPath(value) {
  if (value === '/dev/null') return null;
  if (value.startsWith('"')) {
    try { value = JSON.parse(value); } catch { value = gitQuoted(value); }
  }
  return /^[ab]\//.test(value) ? value.slice(2) : null;
}

function diffHeaderPath(raw) {
  const body = raw.slice('diff --git '.length);
  const quoted = body.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
  if (quoted) return diffPath(quoted[2]);
  // --no-renames makes both names identical, including embedded spaces.
  const half = (body.length - 1) / 2;
  if (!Number.isInteger(half) || body[half] !== ' ') return null;
  const first = diffPath(body.slice(0, half));
  const second = diffPath(body.slice(half + 1));
  return first === second ? first : null;
}

function reviewDiff(diff, limit, signal) {
  const files = [];
  const findings = [];
  let file;
  let oldPath;
  let oldLine = 0;
  let newLine = 0;
  let omitted = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    cancelled(signal);
    if (raw.startsWith('diff --git ')) {
      const name = diffHeaderPath(raw);
      file = name ? { path: name, added: 0, removed: 0 } : null;
      if (file) files.push(file); else omitted++;
      oldPath = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith('--- ')) { oldPath = diffPath(raw.slice(4)); continue; }
    if (!inHunk && raw.startsWith('+++ ')) {
      const name = diffPath(raw.slice(4)) ?? oldPath;
      if (name && !file) { file = { path: name, added: 0, removed: 0 }; files.push(file); }
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; continue; }
    if (!file || !inHunk || raw.startsWith('\\')) continue;
    const added = raw.startsWith('+');
    const removed = raw.startsWith('-');
    if (!added && !removed) { oldLine++; newLine++; continue; }
    const code = raw.slice(1);
    const line = added ? newLine++ : oldLine++;
    file[added ? 'added' : 'removed']++;
    const patterns = [];
    if (added) for (const risk of RISKS) if (risk[1].test(code)) patterns.push(risk);
    if (/^\s*export\b/.test(code)) patterns.push(['public-interface', null, 'Check callers and compatibility for a changed exported interface.']);
    if (/(?:^|\/)(?:package\.json|Cargo\.toml|go\.mod|requirements[^/]*\.txt|pyproject\.toml)$/.test(file.path)) patterns.push(['dependency-manifest', null, 'Check dependency and lockfile consistency, supported versions and install reproducibility.']);
    for (const [kind, , message] of patterns) {
      if (findings.length >= limit) { omitted++; continue; }
      if (findings.some((item) => item.path === file.path && item.kind === kind && item.side === (added ? 'right' : 'left'))) continue;
      findings.push({ path: file.path, line, side: added ? 'right' : 'left', kind, evidence: clipped(code.trim(), 160), message });
    }
  }
  return { files, findings, omitted };
}

function relatedTests(changed, inventoryFiles, limit) {
  const tests = inventoryFiles.filter((name) => /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(name));
  const stems = new Set(changed.filter((file) => !tests.includes(file.path)).map((file) => path.posix.basename(file.path).replace(/\.[^.]+$/, '')).filter((stem) => !['index', 'main', 'mod', 'lib'].includes(stem)));
  return tests.filter((name) => changed.some((file) => file.path === name) || stems.has(path.posix.basename(name).replace(/\.(?:test|spec)(?=\.)/i, '').replace(/\.[^.]+$/, ''))).slice(0, limit);
}

async function review(workspace, args, signal) {
  const selected = own(args, 'path', '.');
  const limit = own(args, 'limit', 40);
  const diff = await workspace.run({ action: 'diff', path: selected, scope: own(args, 'scope', 'unstaged') }, { signal });
  const parsed = reviewDiff(diff.diff ?? '', limit, signal);
  if (!diff.available) return { action: 'review', available: false, executed: false, reason: diff.reason, scope: diff.scope, files: [], findings: [] };
  // Discover existing scripts/tests once. Their text is data, never executed.
  // Both are independent read-only listings, so overlap their git round trips.
  const [map, checks] = await Promise.all([inventory(workspace, '.', signal), workspace.run({ action: 'checks' }, { signal })]);
  const suggestedChecks = [];
  for (const pkg of checks.packages ?? []) for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (/^(?:test(?::|$)|lint(?::|$)|typecheck(?::|$)|check(?::|$)|build$)/i.test(name) && suggestedChecks.length < limit) suggestedChecks.push({ package: pkg.path, script: name, command });
  }
  return { action: 'review', available: true, executed: false, advisory: true, scope: diff.scope, files: parsed.files.slice(0, limit), findings: parsed.findings,
    relatedTests: relatedTests(parsed.files, map.files ?? [], limit), suggestedChecks, configs: (checks.configs ?? []).slice(0, limit),
    truncated: diff.truncated || map.truncated || checks.truncated || parsed.omitted > 0 || parsed.files.length > limit,
    note: 'Potential review points from changed lines, not confirmed defects. Diff scope and truncation limit coverage; filename matching may miss affected tests. No test, build or lint command was run.' };
}

export async function runCodeTool(name, args = {}, { workspace, config = {}, signal } = {}) {
  cancelled(signal);
  validate(name, args);
  const limits = config.unlimitedTokens === true ? CODE_LIMITS.unlimited : CODE_LIMITS.normal;
  const maxItems = limits === CODE_LIMITS.unlimited ? 500 : 80;
  const itemLimit = Math.min(own(args, 'limit', limits === CODE_LIMITS.unlimited ? 500 : 40), maxItems);
  const normalized = { ...args, limit: itemLimit };
  let result;
  if (name === 'strong_review') result = await review(workspace, normalized, signal);
  else if (args.action === 'diagnostics') result = await diagnostics(workspace, normalized, signal);
  else {
    const scan = await sourceFiles(workspace, own(args, 'path', '.'), signal, args.action === 'imports', limits);
    result = args.action === 'symbols' ? symbols(scan, itemLimit, signal) : imports(scan, itemLimit, signal);
  }
  cancelled(signal);
  return fit(result, config.unlimitedTokens === true ? Number.POSITIVE_INFINITY : config.maxOutputChars ?? workspace.maxOutputChars);
}
