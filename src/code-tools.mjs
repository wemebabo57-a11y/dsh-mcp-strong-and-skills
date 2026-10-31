import path from 'node:path';
import { WorkspaceError } from './workspace.mjs';

export const EXTRA_TOOLS = Object.freeze([
  { name: 'strong_code', description: '只读代码定位：symbols 声明；imports 静态 JS/TS 导入图；diagnostics 解析 text 中的报错并安全补充源码。启发式，有扫描上限。', inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['symbols', 'imports', 'diagnostics'] }, path: { type: 'string', maxLength: 1000 }, text: { type: 'string', maxLength: 5000 }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '普通模式最多 80；无限 token 模式最多 500' },
  }, required: ['action'], additionalProperties: false } },
  { name: 'strong_review', description: '只读审查实际 diff：变更文件、风险位置、相关测试及已有验证脚本。仅建议，不运行命令。', inputSchema: { type: 'object', properties: {
    path: { type: 'string', maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 500, description: '普通模式最多 80；无限 token 模式最多 500' },
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
  if (!args || typeof args !== 'object' || Array.isArray(args) || ![null, Object.prototype].includes(Object.getPrototypeOf(args))) throw new WorkspaceError('INVALID_ARGUMENTS', 'Arguments must be a plain object.');
  const schema = tool.inputSchema;
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw new WorkspaceError('INVALID_ARGUMENTS', `Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new WorkspaceError('INVALID_ARGUMENTS', `Unknown argument: ${key}`);
    const rule = schema.properties[key];
    if ((rule.type === 'string' && (typeof value !== 'string' || value.length > rule.maxLength)) ||
        (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) ||
        (rule.enum && !rule.enum.includes(value))) throw new WorkspaceError('INVALID_ARGUMENTS', `Invalid argument: ${key}`);
  }
  if (name === 'strong_code' && args.action === 'diagnostics' && (typeof args.text !== 'string' || !args.text.trim())) throw new WorkspaceError('INVALID_ARGUMENTS', 'diagnostics requires nonempty text.');
}

// Reduce complete JSON values; output is never a sliced JSON string.
function fit(result, maxChars) {
  if (maxChars === Number.POSITIVE_INFINITY) { result.truncated = Boolean(result.truncated); return result; }
  const budget = Number.isInteger(maxChars) ? Math.max(1000, Math.min(20000, maxChars)) : 6000;
  result.truncated = Boolean(result.truncated);
  while (JSON.stringify(result).length > budget) {
    let candidate;
    let fallback;
    const visit = (object) => {
      for (const [key, value] of Object.entries(object)) {
        if (Array.isArray(value) && value.length) {
          const size = JSON.stringify(value).length;
          const option = { parent: object, key, size, array: true };
          if (value.length > 1 && (!candidate || size > candidate.size)) candidate = option;
          if (!fallback || size > fallback.size) fallback = option;
          for (const entry of value) if (entry && typeof entry === 'object') visit(entry);
        } else if (typeof value === 'string' && value.length > 160) {
          if (!candidate || value.length > candidate.size) candidate = { parent: object, key, size: value.length };
        } else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(result);
    candidate ??= fallback;
    if (!candidate) return { action: result.action, truncated: true, note: 'Output budget reached; narrow the path.' };
    if (candidate.array) { candidate.parent[candidate.key].pop(); result.omittedItems = (result.omittedItems ?? 0) + 1; }
    else candidate.parent[candidate.key] = clipped(candidate.parent[candidate.key], Math.max(120, Math.floor(candidate.size / 2)));
    result.truncated = true;
  }
  return result;
}

// Preserve offsets/newlines while excluding comments and optionally literals.
// Template interpolations and multiline Python strings are intentionally opaque.
function mask(source, { strings = true, hash = false } = {}) {
  const output = [];
  let quote = '';
  let triple = false;
  let comment = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (comment) {
      if ((comment === 'line' && char === '\n') || (comment === 'block' && char === '*' && next === '/')) {
        if (comment === 'block') { output.push(' ', ' '); index++; } else output.push('\n');
        comment = '';
      } else output.push(char === '\n' ? '\n' : ' ');
    } else if (quote) {
      if (char === '\\') {
        output.push(strings ? ' ' : char);
        if (next !== undefined) { output.push(next === '\n' ? '\n' : strings ? ' ' : next); index++; }
      } else if (char === quote && (!triple || source.slice(index, index + 3) === quote.repeat(3))) {
        const length = triple ? 3 : 1;
        output.push(strings ? ' '.repeat(length) : quote.repeat(length));
        index += length - 1;
        quote = '';
        triple = false;
      } else output.push(char === '\n' ? '\n' : strings ? ' ' : char);
    } else if ((char === '/' && next === '/') || (hash && char === '#')) {
      comment = 'line';
      output.push(' ');
      if (char === '/') { output.push(' '); index++; }
    } else if (char === '/' && next === '*') {
      comment = 'block'; output.push(' ', ' '); index++;
    } else if (['"', "'", '`'].includes(char)) {
      quote = char;
      triple = hash && source.slice(index, index + 3) === char.repeat(3);
      const length = triple ? 3 : 1;
      output.push(strings ? ' '.repeat(length) : char.repeat(length));
      index += length - 1;
    } else output.push(char);
  }
  return output.join('');
}

async function inventory(workspace, selected, signal) {
  return workspace.run({ action: 'map', path: selected, limit: 200 }, { signal });
}

async function sourceFiles(workspace, selected, signal, includeRootInventory = false, limits = CODE_LIMITS.normal) {
  const { reads: MAX_READS, lines: MAX_LINES, chars: MAX_CHARS, files: MAX_SOURCE_FILES } = limits;
  const map = await inventory(workspace, selected, signal);
  cancelled(signal);
  const roots = includeRootInventory && selected !== '.' ? await inventory(workspace, '.', signal) : map;
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
  return { sources, inventory: roots.files ?? [], truncated: Boolean(truncated), scannedFiles: sources.length, scannedLines: lineCount, skipped: map.skipped ?? {} };
}

function symbols(scan, limit, signal) {
  const items = [];
  let more = false;
  for (const file of scan.sources) {
    const clean = mask(file.source, { hash: /\.(?:py|rb)$/i.test(file.path) });
    for (const [index, line] of clean.split('\n').entries()) {
      cancelled(signal);
      const declarations = [
        ['function', /\b(?:function\s*\*?\s+|(?:async\s+)?def\s+|fn\s+)([A-Za-z_$][\w$]*)/g],
        ['function', /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g],
        ['class', /\bclass\s+([A-Za-z_$][\w$]*)/g],
        ['interface', /\binterface\s+([A-Za-z_$][\w$]*)/g],
        ['type', /\b(?:type|enum|struct|trait)\s+([A-Za-z_$][\w$]*)/g],
        ['function', /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^;]*\)|[A-Za-z_$][\w$]*)\s*=>/g],
        ['export', /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g],
      ];
      const seen = new Set();
      for (const [kind, regex] of declarations) for (const match of line.matchAll(regex)) {
        const key = match[1];
        if (seen.has(key)) continue;
        seen.add(key);
        if (items.length >= limit) { more = true; continue; }
        items.push({ path: file.path, line: index + 1, name: match[1], kind, exported: /\bexport\b/.test(line) });
      }
      const exports = line.match(/\bexport\s*\{([^}]+)\}/);
      if (exports) for (const entry of exports[1].split(',')) {
        const name = entry.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!name) continue;
        if (items.length >= limit) { more = true; continue; }
        items.push({ path: file.path, line: index + 1, name: name[2] ?? name[1], kind: 'export', exported: true });
      }
    }
  }
  return { action: 'symbols', items, scannedFiles: scan.scannedFiles, scannedLines: scan.scannedLines, skipped: scan.skipped, truncated: scan.truncated || more,
    note: 'Heuristic declarations, not an AST or reference index; JS/TS plus basic Python/Go/Rust declarations. Comments/literals excluded; multiline, Unicode names and template interpolations may be missed. At most 32 files, 800 lines/file, 2400 lines and 40 reads.' };
}

function resolveImport(from, specifier, inventorySet) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base) || /^[a-z]:/i.test(base) || base.includes('\\')) return { to: null, status: 'outside-workspace' };
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json'];
  const candidates = [base, ...extensions.map((ext) => base + ext), ...extensions.map((ext) => `${base}/index${ext}`)];
  if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/\.[cm]?js$/, '.ts'), base.replace(/\.[cm]?js$/, '.tsx'));
  const to = candidates.find((candidate) => inventorySet.has(candidate)) ?? null;
  return { to, status: to ? 'resolved' : 'unresolved' };
}

function imports(scan, limit, signal) {
  const edges = [];
  const packages = new Map();
  const files = new Set(scan.inventory);
  let dynamicImports = 0;
  let count = 0;
  let localCount = 0;
  for (const file of scan.sources) {
    if (!SCRIPT_EXTENSIONS.test(file.path)) continue;
    const clean = mask(file.source, { strings: false });
    const tokens = mask(file.source);
    dynamicImports += (tokens.match(/\b(?:import|require)\s*\(/g) ?? []).length;
    const found = [];
    for (const regex of [/\b(?:import|export)\s+(?:type\s+)?(?:\*\s*(?:as\s+[\w$]+)?|\{[^}]{0,1000}\}|[\w$]+(?:\s*,\s*(?:\*\s+as\s+[\w$]+|\{[^}]{0,1000}\}))?)\s+from\s*(['"])([^'"\r\n]+)\1/g, /\bimport\s*(['"])([^'"\r\n]+)\1/g, /\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g]) {
      for (const match of clean.matchAll(regex)) {
        cancelled(signal);
        if (!/^(?:import|export|require)\b/.test(tokens.slice(match.index))) continue;
        found.push({ offset: match.index, specifier: match[2], require: match[0].startsWith('require') });
      }
    }
    found.sort((a, b) => a.offset - b.offset);
    for (const entry of found) {
      if (entry.require) dynamicImports--;
      count++;
      if (entry.specifier.startsWith('.')) {
        localCount++;
        if (edges.length < limit) edges.push({ from: file.path, line: clean.slice(0, entry.offset).split('\n').length, specifier: clipped(entry.specifier), ...resolveImport(file.path, entry.specifier, files) });
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

function diffPath(value) {
  if (value === '/dev/null') return null;
  if (value.startsWith('"')) {
    try { value = JSON.parse(value); } catch { return null; }
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
    const patterns = added ? RISKS.filter(([, regex]) => regex.test(code)) : [];
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
  const diff = await workspace.run({ action: 'diff', path: selected }, { signal });
  const parsed = reviewDiff(diff.diff ?? '', limit, signal);
  if (!diff.available) return { action: 'review', available: false, executed: false, reason: diff.reason, scope: diff.scope, files: [], findings: [] };
  // Discover existing scripts/tests once. Their text is data, never executed.
  const map = await inventory(workspace, '.', signal);
  const checks = await workspace.run({ action: 'checks' }, { signal });
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
