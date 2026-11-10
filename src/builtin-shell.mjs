// A small POSIX-subset interpreter: no system shell or bash installation required.
// Deliberately narrow: pipes, &&/||/;, redirects, variables, $(), and core builtins.
// Paths from builtin commands stay inside the project root; external programs run
// with the user's permissions, like the other shell backends.
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { WorkspaceError } from './workspace.mjs';

const MAX_OUTPUT = 64 * 1024;
const MAX_DEPTH = 6;
const MAX_STEPS = 400;
const BUILTIN_LABEL = '内置 Bash';

function fail(message, code = 'INVALID_ARGUMENTS') {
  return new WorkspaceError(code, message);
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function resolvePath(state, value) {
  const target = path.resolve(state.cwd, value);
  if (!contained(state.root, target)) throw fail('路径超出项目目录：' + value, 'OUTSIDE_WORKSPACE');
  const realRoot = state.realRoot || await fs.realpath(state.root);
  state.realRoot = realRoot;
  let probe = target;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!contained(realRoot, real)) throw fail('路径经符号链接超出项目目录：' + value, 'OUTSIDE_WORKSPACE');
      return target;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw fail('路径超出项目目录：' + value, 'OUTSIDE_WORKSPACE');
      probe = parent;
    }
  }
}

function maxCollector(limit) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (size >= limit) { truncated = true; return; }
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = limit - size;
      if (value.length > remaining) { chunks.push(value.subarray(0, remaining)); size = limit; truncated = true; }
      else { chunks.push(value); size += value.length; }
    },
    read() {
      let text = Buffer.concat(chunks).toString('utf8');
      if (truncated) text += '\n…[truncated]';
      return { text, truncated };
    },
  };
}

function capText(text) {
  const buffer = Buffer.from(String(text));
  if (buffer.length <= MAX_OUTPUT) return { text: String(text), truncated: false };
  return { text: buffer.subarray(0, MAX_OUTPUT).toString('utf8') + '\n…[truncated]', truncated: true };
}

function createState(spec) {
  return {
    root: path.resolve(spec.root),
    cwd: path.resolve(spec.cwd),
    env: { ...spec.env },
    deadline: spec.deadline,
    signal: spec.signal,
    depth: 0,
    steps: 0,
    realRoot: '',
    timedOut: false,
  };
}

function remainingMs(state) {
  return state.deadline - Date.now();
}

function checkAlive(state) {
  if (state.signal?.aborted) throw new WorkspaceError('ABORTED', 'Operation cancelled.');
  if (remainingMs(state) <= 0) { state.timedOut = true; return false; }
  return true;
}

function lex(line) {
  const tokens = [];
  let segments = [];
  let quoted = false;
  let has = false;
  let index = 0;
  const addText = value => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && Object.hasOwn(last, 'text')) last.text += value;
    else segments.push({ text: value });
    has = true;
  };
  const addSegment = segment => { segments.push(segment); has = true; };
  const flush = () => {
    if (has) tokens.push({ type: 'word', segments, quoted });
    segments = [];
    quoted = false;
    has = false;
  };
  while (index < line.length) {
    const char = line[index];
    if (char === ' ' || char === '\t' || char === '\r') { flush(); index += 1; continue; }
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) throw fail('语法错误：单引号未闭合');
      addText(line.slice(index + 1, end));
      quoted = true;
      has = true;
      index = end + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      let closed = false;
      while (index < line.length) {
        const inner = line[index];
        if (inner === '"') { closed = true; index += 1; break; }
        if (inner === '\\' && index + 1 < line.length) { addText(line[index + 1]); index += 2; continue; }
        if (inner === '$') { const part = dollarSegment(line, index); addSegment(part.segment); index = part.next; continue; }
        if (inner === '\u0060') { const part = backtickSegment(line, index); addSegment(part.segment); index = part.next; continue; }
        addText(inner);
        index += 1;
      }
      if (!closed) throw fail('语法错误：双引号未闭合');
      quoted = true;
      has = true;
      continue;
    }
    if (char === '\\') {
      if (index + 1 < line.length) { addText(line[index + 1]); index += 2; }
      else { addText(char); index += 1; }
      continue;
    }
    if (char === '$') { const part = dollarSegment(line, index); addSegment(part.segment); index = part.next; continue; }
    if (char === '\u0060') { const part = backtickSegment(line, index); addSegment(part.segment); index = part.next; continue; }
    if (char === '|') {
      flush();
      if (line[index + 1] === '|') { tokens.push({ type: 'op', value: '||' }); index += 2; }
      else { tokens.push({ type: 'op', value: '|' }); index += 1; }
      continue;
    }
    if (char === '&') {
      if (line[index + 1] === '&') { flush(); tokens.push({ type: 'op', value: '&&' }); index += 2; continue; }
      if (line[index + 1] === '>') {
        flush();
        const append = line[index + 2] === '>';
        tokens.push({ type: 'redir', fd: 'both', mode: append ? 'append' : 'write' });
        index += append ? 3 : 2;
        continue;
      }
      throw fail('内置 Shell 不支持后台执行（&）');
    }
    if (char === ';') { flush(); tokens.push({ type: 'op', value: ';' }); index += 1; continue; }
    if (char === '<') { flush(); tokens.push({ type: 'redir', fd: 0, mode: 'read' }); index += 1; continue; }
    if (char === '>') {
      const isErr = !quoted && segments.length === 1 && segments[0].text === '2';
      const isOut = !quoted && segments.length === 1 && segments[0].text === '1';
      const fd = isErr ? 2 : 1;
      if (isErr || isOut) { segments = []; has = false; }
      else flush();
      const next = line[index + 1];
      if (next === '>') { tokens.push({ type: 'redir', fd, mode: 'append' }); index += 2; continue; }
      if (next === '&') {
        const target = line[index + 2];
        if (fd === 2 && target === '1') { tokens.push({ type: 'redir', fd: 2, dup: 1 }); index += 3; continue; }
        if (fd === 1 && target === '2') { tokens.push({ type: 'redir', fd: 1, dup: 2 }); index += 3; continue; }
        throw fail('语法错误：无法识别重定向目标');
      }
      tokens.push({ type: 'redir', fd, mode: 'write' });
      index += 1;
      continue;
    }
    addText(char);
    index += 1;
  }
  flush();
  return tokens;
}

function dollarSegment(line, start) {
  const next = line[start + 1];
  if (next === '(') {
    let depth = 1;
    let index = start + 2;
    while (index < line.length && depth > 0) {
      const char = line[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      if (depth > 0) index += 1;
    }
    if (depth !== 0) throw fail('语法错误：$(' + ' 未闭合');
    return { segment: { sub: line.slice(start + 2, index) }, next: index + 1 };
  }
  if (next === '{') {
    const end = line.indexOf('}', start + 2);
    if (end < 0) throw fail('语法错误：$' + '{ 未闭合');
    return { segment: { braced: line.slice(start + 2, end) }, next: end + 1 };
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(start + 1));
  if (!match) return { segment: { text: '$' }, next: start + 1 };
  return { segment: { var: match[0] }, next: start + 1 + match[0].length };
}

function backtickSegment(line, start) {
  const end = line.indexOf('\u0060', start + 1);
  if (end < 0) throw fail('语法错误：反引号未闭合');
  return { segment: { sub: line.slice(start + 1, end) }, next: end + 1 };
}

// Windows environment blocks often spell PATH as Path; process.env hides that,
// but spreading it does not. Look names up case-insensitively on Windows.
function envGet(state, name) {
  if (Object.hasOwn(state.env, name)) return state.env[name];
  if (process.platform !== 'win32') return undefined;
  const upper = name.toUpperCase();
  const key = Object.keys(state.env).find(candidate => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : state.env[key];
}

function expandBraced(expression, state) {
  const separator = expression.indexOf(':-');
  if (separator >= 0) {
    const name = expression.slice(0, separator);
    const value = envGet(state, name);
    return value === undefined || value === '' ? expression.slice(separator + 2) : value;
  }
  return envGet(state, expression) ?? '';
}

async function wordValue(token, state) {
  let text = '';
  for (const segment of token.segments) {
    if (segment.text !== undefined) text += segment.text;
    else if (segment.var !== undefined) text += envGet(state, segment.var) ?? '';
    else if (segment.braced !== undefined) text += expandBraced(segment.braced, state);
    else if (segment.sub !== undefined) text += await runSubstitution(segment.sub, state);
  }
  return text;
}

async function runSubstitution(command, state) {
  if (state.depth >= MAX_DEPTH) throw fail('命令替换嵌套过深');
  const child = Object.assign({}, state, { depth: state.depth + 1 });
  const result = await runCommandLine(command, child);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split('\n')[0] || '退出码 ' + result.exitCode;
    throw fail('命令替换失败：' + detail);
  }
  return result.stdout.replace(/\n+$/, '');
}

function parse(tokens) {
  const list = [];
  let operator = null;
  let commands = [];
  let current = { args: [], redirs: [] };
  const pushCommand = () => {
    if (current.args.length || current.redirs.length) {
      commands.push(current);
      current = { args: [], redirs: [] };
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'word') { current.args.push(token); continue; }
    if (token.type === 'redir') {
      if (token.dup) { current.redirs.push({ fd: token.fd, dup: token.dup }); continue; }
      const target = tokens[index + 1];
      if (!target || target.type !== 'word') throw fail('语法错误：重定向缺少目标');
      index += 1;
      current.redirs.push({ fd: token.fd, mode: token.mode, target });
      continue;
    }
    if (token.value === '|') { pushCommand(); continue; }
    pushCommand();
    if (commands.length) list.push({ operator, commands });
    operator = token.value;
    commands = [];
  }
  pushCommand();
  if (commands.length) list.push({ operator, commands });
  return list;
}

async function executeList(state, list) {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  for (const entry of list) {
    if (!checkAlive(state)) break;
    if (entry.operator === '&&' && exitCode !== 0) continue;
    if (entry.operator === '||' && exitCode === 0) continue;
    const result = await runPipeline(state, entry.commands, '');
    stdout += result.stdout;
    stderr += result.stderr;
    exitCode = result.exitCode;
  }
  return { stdout, stderr, exitCode };
}

async function runPipeline(state, commands, stdin) {
  let input = stdin;
  let stderr = '';
  let exitCode = 0;
  for (const command of commands) {
    if (!checkAlive(state)) break;
    const result = await runCommand(state, command, input);
    input = result.stdout;
    stderr += result.stderr;
    exitCode = result.exitCode;
  }
  return { stdout: input, stderr, exitCode };
}

async function expandGlob(state, pattern) {
  const absolute = path.isAbsolute(pattern);
  const segments = pattern.split(/[\\/]+/).filter(Boolean);
  let bases = [absolute ? path.parse(state.root).root : state.cwd];
  for (const segment of segments) {
    if (!/[*?]/.test(segment)) {
      bases = bases.map(base => path.join(base, segment));
      continue;
    }
    const matcher = globMatcher(segment);
    const next = [];
    for (const base of bases) {
      let entries;
      try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) if (matcher.test(entry.name)) next.push(path.join(base, entry.name));
    }
    bases = next;
  }
  const matches = bases.filter(base => contained(state.root, path.resolve(base)));
  if (!matches.length) return [pattern];
  return matches.map(base => path.relative(state.cwd, base) || '.');
}

function globMatcher(segment) {
  const escaped = segment.replace(/[.+^$|()[\]{}\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'i' : '');
}

async function runCommand(state, command, stdin) {
  if (!checkAlive(state)) return { stdout: '', stderr: '', exitCode: 130 };
  state.steps += 1;
  if (state.steps > MAX_STEPS) throw fail('命令数量超出限制');
  const words = [];
  for (const token of command.args) words.push({ value: await wordValue(token, state), quoted: token.quoted });
  const args = [];
  const assignments = [];
  for (const word of words) {
    if (!word.quoted && args.length === 0) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word.value);
      if (match) { assignments.push([match[1], match[2]]); continue; }
    }
    args.push(word);
  }
  if (!args.length) {
    for (const [name, value] of assignments) state.env[name] = value;
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  const expanded = [];
  for (const arg of args) {
    if (!arg.quoted && /[*?]/.test(arg.value)) expanded.push(...await expandGlob(state, arg.value));
    else expanded.push(arg.value);
  }
  const name = expanded[0];
  const rest = expanded.slice(1);
  let fileIn = null;
  let stderrToFile = null;
  let stderrMerge = false;
  let stdoutToStderr = false;
  const writes = [];
  for (const redirect of command.redirs) {
    if (redirect.dup === 1) { stderrMerge = true; continue; }
    if (redirect.dup === 2) { stdoutToStderr = true; continue; }
    const target = await resolvePath(state, await wordValue(redirect.target, state));
    if (redirect.fd === 'both') { writes.push({ file: target, append: redirect.mode === 'append', both: true }); continue; }
    if (redirect.fd === 0) { fileIn = target; continue; }
    if (redirect.fd === 2) { stderrToFile = { file: target, append: redirect.mode === 'append' }; continue; }
    writes.push({ file: target, append: redirect.mode === 'append' });
  }
  let input = stdin;
  if (fileIn) {
    try { input = await fs.readFile(fileIn, 'utf8'); }
    catch { return { stdout: '', stderr: 'builtin-shell: ' + path.relative(state.cwd, fileIn) + ': No such file or directory\n', exitCode: 1 }; }
  }
  const saved = new Map();
  for (const [key, value] of assignments) {
    saved.set(key, Object.hasOwn(state.env, key) ? state.env[key] : undefined);
    state.env[key] = value;
  }
  let result;
  try {
    result = Object.hasOwn(BUILTINS, name)
      ? await BUILTINS[name](state, rest, input)
      : await runExternal(state, name, rest, input);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'ABORTED') throw error;
    result = { stdout: '', stderr: 'builtin-shell: ' + name + ': ' + (error instanceof Error ? error.message : String(error)) + '\n', exitCode: 1 };
  } finally {
    for (const [key] of assignments) {
      const previous = saved.get(key);
      if (previous === undefined) delete state.env[key];
      else state.env[key] = previous;
    }
  }
  let stdout = result.stdout;
  let stderr = result.stderr;
  if (stderrMerge) { stdout += stderr; stderr = ''; }
  if (stderrToFile) {
    try { await writeOutput(stderrToFile, stderr); } catch (error) { return { stdout: '', stderr: 'builtin-shell: ' + error.message + '\n', exitCode: 1 }; }
    stderr = '';
  }
  for (const write of writes) {
    try { await writeOutput(write, stdout + (write.both ? stderr : '')); }
    catch (error) { return { stdout: '', stderr: 'builtin-shell: ' + error.message + '\n', exitCode: 1 }; }
    if (write.both) stderr = '';
    stdout = '';
  }
  if (stdoutToStderr) { stderr += stdout; stdout = ''; }
  return { stdout, stderr, exitCode: result.exitCode };
}

async function writeOutput(target, text) {
  if (target.append) await fs.appendFile(target.file, text);
  else await fs.writeFile(target.file, text);
}

async function findExecutable(state, name) {
  const hasSeparator = name.includes('/') || name.includes('\\');
  if (hasSeparator) {
    const file = await resolvePath(state, name);
    return existsSync(file) ? file : null;
  }
  const extensions = process.platform === 'win32'
    ? (envGet(state, 'PATHEXT') || '.EXE;.COM').split(';').filter(value => value && !/\.(BAT|CMD)$/i.test(value))
    : [''];
  const directories = (envGet(state, 'PATH') || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function runExternal(state, name, args, input) {
  const executable = await findExecutable(state, name);
  if (!executable) return { stdout: '', stderr: 'builtin-shell: ' + name + ': command not found\n', exitCode: 127 };
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: state.cwd, env: { ...state.env, PWD: state.cwd }, stdio: ['pipe', 'pipe', 'pipe'],
        shell: false, windowsHide: true,
      });
    } catch (error) {
      resolve({ stdout: '', stderr: 'builtin-shell: ' + name + ': ' + error.message + '\n', exitCode: 126 });
      return;
    }
    const out = maxCollector(MAX_OUTPUT);
    const err = maxCollector(MAX_OUTPUT);
    let settled = false;
    const timer = setTimeout(() => {
      state.timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, Math.max(1, remainingMs(state)));
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} };
    state.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.signal?.removeEventListener('abort', onAbort);
      const stdout = out.read();
      const stderr = err.read();
      const message = error ? 'builtin-shell: ' + name + ': ' + error.message + '\n' : '';
      resolve({ stdout: stdout.text, stderr: stderr.text + message, exitCode: signal ? 143 : (code ?? 1) });
    };
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
function splitLines(text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function parseCount(values, index, fallback) {
  const value = values[index];
  if (value === undefined) return { count: fallback, index };
  if (/^\d+$/.test(value)) return { count: Number(value), index: index + 1 };
  if (/^-\d+$/.test(value)) return { count: Number(value.slice(1)), index: index + 1 };
  return { count: fallback, index };
}

async function readInputs(state, files, input, toolName) {
  if (!files.length) return { text: input, label: '', exitCode: 0 };
  let text = '';
  for (const file of files) {
    const target = await resolvePath(state, file);
    try { text += await fs.readFile(target, 'utf8'); }
    catch { return { text: '', label: file, exitCode: 1, error: toolName + ': ' + file + ': No such file or directory\n' }; }
  }
  return { text, label: files.length === 1 ? files[0] : '', exitCode: 0 };
}

const BUILTINS = Object.create(null);

BUILTINS['true'] = async () => ({ stdout: '', stderr: '', exitCode: 0 });
BUILTINS['false'] = async () => ({ stdout: '', stderr: '', exitCode: 1 });
BUILTINS[':'] = async () => ({ stdout: '', stderr: '', exitCode: 0 });

BUILTINS.pwd = async state => ({ stdout: state.cwd + '\n', stderr: '', exitCode: 0 });

BUILTINS.cd = async (state, args) => {
  const target = args[0] === undefined || args[0] === '-' ? state.root : args[0].replace(/^~($|\/)/, (state.env.HOME || state.root) + '$1');
  const resolved = await resolvePath(state, target);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) return { stdout: '', stderr: 'cd: ' + target + ': Not a directory\n', exitCode: 1 };
  state.cwd = resolved;
  return { stdout: '', stderr: '', exitCode: 0 };
};

BUILTINS.echo = async (state, args) => {
  let newline = true;
  let escapes = false;
  let index = 0;
  while (index < args.length && /^-[neE]+$/.test(args[index])) {
    if (args[index].includes('n')) newline = false;
    if (args[index].includes('e')) escapes = true;
    index += 1;
  }
  let text = args.slice(index).join(' ');
  if (escapes) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  return { stdout: text + (newline ? '\n' : ''), stderr: '', exitCode: 0 };
};

BUILTINS.ls = async (state, args) => {
  const flags = new Set();
  const targets = [];
  for (const arg of args) {
    if (arg.startsWith('-') && arg.length > 1) for (const flag of arg.slice(1)) flags.add(flag);
    else targets.push(arg);
  }
  const list = targets.length ? targets : ['.'];
  let stdout = '';
  for (const target of list) {
    const resolved = await resolvePath(state, target);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat) return { stdout: '', stderr: 'ls: ' + target + ': No such file or directory\n', exitCode: 2 };
    if (!stat.isDirectory()) { stdout += await formatEntry(resolved, target, flags); continue; }
    if (list.length > 1) stdout += target + ':\n';
    let entries = await fs.readdir(resolved, { withFileTypes: true });
    if (!flags.has('a')) entries = entries.filter(entry => !entry.name.startsWith('.'));
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(resolved, entry.name);
      stdout += await formatEntry(full, entry.name, flags);
    }
    if (list.length > 1) stdout += '\n';
  }
  return { stdout, stderr: '', exitCode: 0 };
};

async function formatEntry(full, label, flags) {
  if (!flags.has('l')) return label + '\n';
  let stat;
  try { stat = await fs.lstat(full); } catch { return label + '\n'; }
  const mode = stat.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--';
  return mode + ' ' + String(stat.size).padStart(8) + ' ' + label + '\n';
}

BUILTINS.cat = async (state, args, input) => {
  if (!args.length) return { stdout: input, stderr: '', exitCode: 0 };
  let stdout = '';
  let stderr = '';
  for (const file of args) {
    const target = await resolvePath(state, file);
    try { stdout += await fs.readFile(target, 'utf8'); }
    catch { stderr += 'cat: ' + file + ': No such file or directory\n'; }
  }
  return { stdout, stderr, exitCode: stderr ? 1 : 0 };
};

BUILTINS.head = async (state, args, input) => {
  let count = 10;
  let index = 0;
  if (args[0] === '-n') { const parsed = parseCount(args, 1, 10); count = parsed.count; index = parsed.index; }
  else if (/^-\d+$/.test(args[0] || '')) { count = Number(args[0].slice(1)); index = 1; }
  const source = await readInputs(state, args.slice(index), input, 'head');
  if (source.error) return { stdout: '', stderr: source.error, exitCode: 1 };
  return { stdout: splitLines(source.text).slice(0, count).join('\n') + '\n', stderr: '', exitCode: 0 };
};

BUILTINS.tail = async (state, args, input) => {
  let count = 10;
  let index = 0;
  if (args[0] === '-n') { const parsed = parseCount(args, 1, 10); count = parsed.count; index = parsed.index; }
  else if (/^-\d+$/.test(args[0] || '')) { count = Number(args[0].slice(1)); index = 1; }
  const source = await readInputs(state, args.slice(index), input, 'tail');
  if (source.error) return { stdout: '', stderr: source.error, exitCode: 1 };
  const lines = splitLines(source.text);
  return { stdout: lines.slice(Math.max(0, lines.length - count)).join('\n') + (lines.length ? '\n' : ''), stderr: '', exitCode: 0 };
};

BUILTINS.grep = async (state, args, input) => {
  const flags = new Set();
  let index = 0;
  while (index < args.length && /^-[a-zA-Z]+$/.test(args[index])) {
    for (const flag of args[index].slice(1)) flags.add(flag);
    index += 1;
  }
  const pattern = args[index];
  index += 1;
  if (!pattern) return { stdout: '', stderr: '用法: grep [-i] [-n] [-v] [-c] pattern [file...]\n', exitCode: 2 };
  const files = args.slice(index);
  let matcher;
  try { matcher = new RegExp(flags.has('F') ? pattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&') : pattern, flags.has('i') ? 'i' : ''); }
  catch (error) { return { stdout: '', stderr: 'grep: ' + error.message + '\n', exitCode: 2 }; }
  let source = input;
  if (files.length) {
    source = '';
    for (const file of files) {
      const target = await resolvePath(state, file);
      try { source += await fs.readFile(target, 'utf8'); }
      catch { return { stdout: '', stderr: 'grep: ' + file + ': No such file or directory\n', exitCode: 2 }; }
    }
  }
  let matches = 0;
  let stdout = '';
  for (const line of splitLines(source)) {
    const hit = matcher.test(line);
    if (hit !== flags.has('v')) {
      matches += 1;
      if (!flags.has('c')) stdout += (flags.has('n') ? matches + ':' : '') + line + '\n';
    }
  }
  if (flags.has('c')) stdout = String(matches) + '\n';
  return { stdout, stderr: '', exitCode: flags.has('c') ? 0 : matches ? 0 : 1 };
};

BUILTINS.wc = async (state, args, input) => {
  const flags = new Set();
  const files = [];
  for (const arg of args) {
    if (/^-[lwc]+$/.test(arg)) for (const flag of arg.slice(1)) flags.add(flag);
    else files.push(arg);
  }
  const source = await readInputs(state, files, input, 'wc');
  if (source.error) return { stdout: '', stderr: source.error, exitCode: 1 };
  const lines = splitLines(source.text).length;
  const words = source.text.split(/\s+/).filter(Boolean).length;
  const bytes = Buffer.byteLength(source.text);
  const parts = [];
  if (!flags.size || flags.has('l')) parts.push(String(lines).padStart(7));
  if (!flags.size || flags.has('w')) parts.push(String(words).padStart(7));
  if (!flags.size || flags.has('c')) parts.push(String(bytes).padStart(7));
  return { stdout: parts.join('') + (files[0] ? ' ' + files[0] : '') + '\n', stderr: '', exitCode: 0 };
};

function expandSet(value) {
  const chars = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\' && index + 1 < value.length) {
      const next = value[index + 1];
      chars.push(next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next);
      index += 1;
      continue;
    }
    if (value[index + 1] === '-' && index + 2 < value.length) {
      const start = char.codePointAt(0);
      const end = value.codePointAt(index + 2);
      if (start <= end) {
        for (let code = start; code <= end; code += 1) chars.push(String.fromCodePoint(code));
        index += 2;
        continue;
      }
    }
    chars.push(char);
  }
  return chars;
}

BUILTINS.sort = async (state, args, input) => {
  const flags = new Set();
  const files = [];
  for (const arg of args) {
    if (/^-[rnu]+$/.test(arg)) for (const flag of arg.slice(1)) flags.add(flag);
    else files.push(arg);
  }
  const source = await readInputs(state, files, input, 'sort');
  if (source.error) return { stdout: '', stderr: source.error, exitCode: 1 };
  let lines = splitLines(source.text).map((value, index) => ({ value, index }));
  const numeric = flags.has('n');
  lines.sort((left, right) => {
    let order;
    if (numeric) {
      const a = Number.parseFloat(left.value);
      const b = Number.parseFloat(right.value);
      order = (Number.isNaN(a) ? 0 : a) - (Number.isNaN(b) ? 0 : b);
    } else order = left.value.localeCompare(right.value);
    return order || left.index - right.index;
  });
  if (flags.has('r')) lines.reverse();
  if (flags.has('u')) {
    const seen = new Set();
    lines = lines.filter(item => {
      const key = numeric ? String(Number.parseFloat(item.value) || 0) : item.value;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const values = lines.map(item => item.value);
  return { stdout: values.join('\n') + (values.length ? '\n' : ''), stderr: '', exitCode: 0 };
};

BUILTINS.uniq = async (state, args, input) => {
  const flags = new Set();
  const files = [];
  for (const arg of args) {
    if (/^-[cdui]+$/.test(arg)) for (const flag of arg.slice(1)) flags.add(flag);
    else files.push(arg);
  }
  const source = await readInputs(state, files, input, 'uniq');
  if (source.error) return { stdout: '', stderr: source.error, exitCode: 1 };
  const groups = [];
  for (const line of splitLines(source.text)) {
    const key = flags.has('i') ? line.toLowerCase() : line;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.count += 1;
    else groups.push({ key, line, count: 1 });
  }
  let stdout = '';
  for (const group of groups) {
    if (flags.has('d') && group.count < 2) continue;
    if (flags.has('u') && group.count !== 1) continue;
    stdout += (flags.has('c') ? String(group.count).padStart(7) + ' ' : '') + group.line + '\n';
  }
  return { stdout, stderr: '', exitCode: 0 };
};

BUILTINS.tr = async (state, args, input) => {
  const deleteSet = args.includes('-d');
  const squeeze = args.includes('-s');
  const values = args.filter(arg => arg !== '-d' && arg !== '-s');
  const set1 = expandSet(values[0] ?? '');
  const set2 = expandSet(values[1] ?? '');
  if (!set1.length) return { stdout: '', stderr: '用法: tr [-d] [-s] set1 [set2]\n', exitCode: 2 };
  if (!deleteSet && !set2.length) return { stdout: '', stderr: 'tr: 缺少 set2\n', exitCode: 2 };
  const map = new Map();
  if (!deleteSet) set1.forEach((char, index) => map.set(char, set2[Math.min(index, set2.length - 1)]));
  let stdout = '';
  let previous = '';
  for (const char of String(input)) {
    if (deleteSet && set1.includes(char)) continue;
    const value = deleteSet ? char : map.get(char) ?? char;
    if (squeeze && value === previous && set2.includes(value)) continue;
    stdout += value;
    previous = value;
  }
  return { stdout, stderr: '', exitCode: 0 };
};

BUILTINS.cut = async (state, args, input) => {
  let delimiter = '\t';
  let fields = '';
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-d' || arg === '--delimiter') { delimiter = args[index + 1] ?? delimiter; index += 1; }
    else if (arg.startsWith('--delimiter=')) delimiter = arg.slice('--delimiter='.length);
    else if (arg.startsWith('-d') && arg.length > 2) delimiter = arg.slice(2);
    else if (arg === '-f' || arg === '--fields') { fields = args[index + 1] ?? ''; index += 1; }
    else if (arg.startsWith('--fields=')) fields = arg.slice('--fields='.length);
    else if (arg.startsWith('-f') && arg.length > 2) fields = arg.slice(2);
    else files.push(arg);
  }
  if (!fields) return { stdout: '', stderr: '用法: cut -d 分隔符 -f 1,2-3 [file...]\n', exitCode: 2 };
  const ranges = fields.split(',').flatMap(part => {
    const match = /^(\d+)(?:-(\d*))?$/.exec(part.trim());
    if (!match) return [];
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[2] === '' ? Number.MAX_SAFE_INTEGER : Number(match[2]);
    return [[start, end]];
  });
  const source = await readInputs(state, files, input, 'cut');
  if (source.error) return { stdout: '', stderr: source.error, exitCode: 1 };
  const lines = splitLines(source.text).map(line => {
    if (!line.includes(delimiter)) return line;
    const parts = line.split(delimiter);
    return ranges.flatMap(([start, end]) => parts.slice(start - 1, end)).join(delimiter);
  });
  return { stdout: lines.join('\n') + (lines.length ? '\n' : ''), stderr: '', exitCode: 0 };
};

BUILTINS.mkdir = async (state, args) => {
  const parents = args.includes('-p');
  const targets = args.filter(arg => arg !== '-p');
  if (!targets.length) return { stdout: '', stderr: 'mkdir: 缺少目录名\n', exitCode: 1 };
  for (const target of targets) {
    const resolved = await resolvePath(state, target);
    try { await fs.mkdir(resolved, { recursive: parents }); }
    catch (error) { return { stdout: '', stderr: 'mkdir: ' + target + ': ' + error.code + '\n', exitCode: 1 }; }
  }
  return { stdout: '', stderr: '', exitCode: 0 };
};

BUILTINS.rmdir = async (state, args) => {
  for (const target of args) {
    try { await fs.rmdir(await resolvePath(state, target)); }
    catch { return { stdout: '', stderr: 'rmdir: ' + target + ': Directory not empty or missing\n', exitCode: 1 }; }
  }
  return { stdout: '', stderr: '', exitCode: 0 };
};

BUILTINS.touch = async (state, args) => {
  for (const target of args) {
    const resolved = await resolvePath(state, target);
    try { await fs.utimes(resolved, new Date(), new Date()); }
    catch { await fs.writeFile(resolved, ''); }
  }
  return { stdout: '', stderr: '', exitCode: 0 };
};

BUILTINS.rm = async (state, args) => {
  const flags = args.filter(arg => /^-[rf]+$/.test(arg)).join('');
  const force = flags.includes('f');
  const recursive = flags.includes('r');
  const targets = args.filter(arg => !/^-[rf]+$/.test(arg));
  let stderr = '';
  for (const target of targets) {
    const resolved = await resolvePath(state, target);
    try { await fs.rm(resolved, { recursive, force }); }
    catch (error) { if (!force) stderr += 'rm: ' + target + ': ' + (error.code || error.message) + '\n'; }
  }
  return { stdout: '', stderr, exitCode: stderr ? 1 : 0 };
};

BUILTINS.cp = async (state, args) => {
  const recursive = args.some(arg => /^-[rR]+$/.test(arg));
  const targets = args.filter(arg => !/^-[rR]+$/.test(arg));
  if (targets.length !== 2) return { stdout: '', stderr: '用法: cp [-r] source target\n', exitCode: 1 };
  try {
    const source = await resolvePath(state, targets[0]);
    const destination = await resolvePath(state, targets[1]);
    const stat = await fs.stat(source);
    if (stat.isDirectory()) {
      if (!recursive) return { stdout: '', stderr: 'cp: ' + targets[0] + ' is a directory (use -r)\n', exitCode: 1 };
      await fs.cp(source, destination, { recursive: true });
    } else await fs.copyFile(source, destination);
  } catch (error) { return { stdout: '', stderr: 'cp: ' + error.message + '\n', exitCode: 1 }; }
  return { stdout: '', stderr: '', exitCode: 0 };
};

BUILTINS.mv = async (state, args) => {
  const targets = args.filter(arg => !arg.startsWith('-'));
  if (targets.length !== 2) return { stdout: '', stderr: '用法: mv source target\n', exitCode: 1 };
  try { await fs.rename(await resolvePath(state, targets[0]), await resolvePath(state, targets[1])); }
  catch (error) { return { stdout: '', stderr: 'mv: ' + error.message + '\n', exitCode: 1 }; }
  return { stdout: '', stderr: '', exitCode: 0 };
};

BUILTINS.test = async (state, args, input, name = 'test') => {
  const values = name === '[' ? args.filter(arg => arg !== ']') : args;
  const result = await evaluateTest(state, values);
  return { stdout: '', stderr: '', exitCode: result ? 0 : 1 };
};
BUILTINS['['] = async (state, args, input) => {
  if (args[args.length - 1] !== ']') return { stdout: '', stderr: '[: 缺少 ]\n', exitCode: 2 };
  return BUILTINS.test(state, args, input, '[');
};

async function evaluateTest(state, args) {
  if (!args.length) return false;
  if (args.length === 1) return Boolean(args[0]);
  if (args.length === 2) {
    const [flag, value] = args;
    if (flag === '-e') return existsSync(await resolvePath(state, value));
    if (flag === '-f') { const stat = await fs.stat(await resolvePath(state, value)).catch(() => null); return Boolean(stat && stat.isFile()); }
    if (flag === '-d') { const stat = await fs.stat(await resolvePath(state, value)).catch(() => null); return Boolean(stat && stat.isDirectory()); }
    if (flag === '-z') return value === '';
    if (flag === '-n') return value !== '';
    return false;
  }
  const [left, operator, right] = args;
  if (operator === '=' || operator === '==') return left === right;
  if (operator === '!=') return left !== right;
  const numeric = { '-eq': (a, b) => a === b, '-ne': (a, b) => a !== b, '-lt': (a, b) => a < b, '-le': (a, b) => a <= b, '-gt': (a, b) => a > b, '-ge': (a, b) => a >= b };
  if (Object.hasOwn(numeric, operator)) {
    const a = Number(left);
    const b = Number(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return numeric[operator](a, b);
  }
  return false;
}

BUILTINS.env = async state => ({ stdout: Object.keys(state.env).sort().map(key => key + '=' + state.env[key]).join('\n') + '\n', stderr: '', exitCode: 0 });
BUILTINS.export = async (state, args) => {
  if (!args.length) return BUILTINS.env(state);
  for (const arg of args) {
    const index = arg.indexOf('=');
    if (index > 0) state.env[arg.slice(0, index)] = arg.slice(index + 1);
  }
  return { stdout: '', stderr: '', exitCode: 0 };
};
BUILTINS.unset = async (state, args) => {
  for (const name of args) delete state.env[name];
  return { stdout: '', stderr: '', exitCode: 0 };
};

BUILTINS.sleep = async (state, args) => {
  const seconds = Number(args[0] ?? 1);
  if (!Number.isFinite(seconds) || seconds < 0) return { stdout: '', stderr: 'sleep: 无效时长\n', exitCode: 1 };
  const requested = seconds * 1000;
  const remaining = Math.max(0, remainingMs(state));
  if (requested >= remaining) {
    await new Promise(resolve => setTimeout(resolve, remaining));
    state.timedOut = true;
    return { stdout: '', stderr: '', exitCode: 124 };
  }
  await new Promise(resolve => setTimeout(resolve, requested));
  return { stdout: '', stderr: '', exitCode: 0 };
};

BUILTINS.which = async (state, args) => {
  let stdout = '';
  let stderr = '';
  let code = 0;
  for (const name of args) {
    if (Object.hasOwn(BUILTINS, name)) { stdout += name + ': shell builtin\n'; continue; }
    const found = await findExecutable(state, name);
    if (found) stdout += found + '\n';
    else { stderr += 'which: no ' + name + ' in PATH\n'; code = 1; }
  }
  return { stdout, stderr, exitCode: code };
};

BUILTINS.basename = async (state, args) => ({ stdout: path.basename(args[0] ?? '') + '\n', stderr: '', exitCode: 0 });
BUILTINS.dirname = async (state, args) => ({ stdout: path.dirname(args[0] ?? '.') + '\n', stderr: '', exitCode: 0 });

async function runCommandLine(command, state) {
  if (!command.trim()) return { stdout: '', stderr: '', exitCode: 0 };
  const tokens = lex(command);
  return executeList(state, parse(tokens));
}

export async function runBuiltinShell({ command, cwd, root, cwdLabel = '.', timeoutMs = 60000, signal, env = {} } = {}) {
  const started = Date.now();
  signal?.throwIfAborted();
  const state = createState({
    root, cwd, signal,
    deadline: started + timeoutMs,
    env: { ...env, PWD: path.resolve(cwd) },
  });
  let result = { stdout: '', stderr: '', exitCode: 0 };
  try {
    result = await runCommandLine(command, state);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'ABORTED') throw error;
    if (error instanceof WorkspaceError) result = { stdout: '', stderr: 'builtin-shell: ' + error.message + '\n', exitCode: 1 };
    else throw new WorkspaceError('BUILTIN_SHELL_FAILED', error instanceof Error ? error.message : String(error));
  }
  signal?.throwIfAborted();
  const timedOut = state.timedOut || Date.now() - started >= timeoutMs;
  const stdout = capText(result.stdout);
  const stderr = capText(result.stderr);
  return {
    shell: { backend: 'builtin', label: BUILTIN_LABEL, executable: 'builtin' },
    cwd: cwdLabel,
    command, timeoutMs,
    exitCode: timedOut ? 124 : result.exitCode,
    signal: null,
    timedOut,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    truncated: stdout.truncated || stderr.truncated,
    durationMs: Date.now() - started,
  };
}
