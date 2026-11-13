// Command execution: AST evaluation, redirections, pipelines, functions,
// builtins, coreutils and external processes.
import { spawn, spawnSync } from 'node:child_process';
import fsNode from 'node:fs';
import pathNode from 'node:path';
import processNode from 'node:process';

import { createFs, ShellError } from './fs.mjs';
import { ShellExit, ShellBreak, ShellContinue, ShellReturn, ShellAbort } from './errors.mjs';
import * as expand from './expand.mjs';
import { evalArith } from './arith.mjs';
import { lex } from './lexer.mjs';
import { parseScript } from './parser.mjs';

function parse(tokens) {
  return { body: parseScript(tokens) };
}
import { createBuiltins } from './builtins.mjs';

export { ShellExit, ShellBreak, ShellContinue, ShellReturn, ShellAbort };

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

function now() { return Date.now(); }

function envObject() {
  const out = {};
  try {
    for (const key of Object.keys(processNode.env)) out[key] = processNode.env[key];
  } catch { /* ignore */ }
  return out;
}

export function cloneScope(scope) {
  const copy = Object.create(Object.getPrototypeOf(scope));
  Object.assign(copy, scope);
  copy.vars = new Map(scope.vars);
  copy.exported = new Set(scope.exported);
  copy.readonly = new Set(scope.readonly);
  copy.frames = scope.frames.map((frame) => new Map(frame));
  copy.opts = Object.assign({}, scope.opts);
  copy.positional = scope.positional.slice();
  return copy;
}

export function createScope(options) {
  const env = options.env || envObject();
  const vars = new Map();
  for (const key of Object.keys(env)) {
    if (env[key] === undefined || env[key] === null) continue;
    vars.set(key, String(env[key]));
  }
  if (!vars.has('PATH')) {
    let inherited;
    for (const key of vars.keys()) {
      if (key.toUpperCase() === 'PATH') { inherited = vars.get(key); break; }
    }
    if (inherited !== undefined) vars.set('PATH', inherited);
    else vars.set('PATH', DEFAULT_PATH);
  }
  if (!vars.has('IFS')) vars.delete('IFS');
  vars.set('SHELL', vars.get('SHELL') || 'dsh-shell');
  vars.set('PS1', vars.get('PS1') || '$ ');

  const scope = {
    name: 'dsh-shell',
    vars,
    exported: new Set(Object.keys(env).filter((key) => env[key] !== undefined)),
    readonly: new Set(),
    funcs: new Map(),
    frames: [],
    positional: [],
    cwd: options.cwdV || '/',
    opts: {
      errexit: false,
      nounset: false,
      xtrace: false,
      pipefail: false,
      globstar: false,
      nullglob: false,
      failglob: false,
      dotglob: false,
      extglob: false,
      noglob: false,
      noexec: false,
      allexport: false,
      expandAliases: false,
    },
    lastStatus: 0,
    lastBgPid: 0,
    pid: 4242,
    depth: 0,
    fs: options.fs,
    hostCwd: options.cwdHost || processNode.cwd(),
    shell: null,
    getVar(name) {
      for (let index = this.frames.length - 1; index >= 0; index--) {
        const frame = this.frames[index];
        if (frame.has(name)) return frame.get(name);
      }
      if (name === 'PWD') return this.cwd;
      if (name === 'OLDPWD') return this.vars.get('OLDPWD');
      if (this.vars.has(name)) return this.vars.get(name);
      return undefined;
    },
    setVar(name, value) {
      if (this.readonly.has(name)) throw new ShellError('EREADONLY', name + ': readonly variable');
      const stored = Array.isArray(value) ? value.slice() : String(value);
      for (let index = this.frames.length - 1; index >= 0; index--) {
        const frame = this.frames[index];
        if (frame.has(name)) { frame.set(name, Array.isArray(stored) ? stored.slice() : stored); return; }
      }
      this.vars.set(name, Array.isArray(stored) ? stored.slice() : stored);
      if (this.opts.allexport) this.exported.add(name);
    },
    unsetVar(name) {
      for (let index = this.frames.length - 1; index >= 0; index--) {
        const frame = this.frames[index];
        if (frame.has(name)) { frame.delete(name); return; }
      }
      this.vars.delete(name);
    },
    defineLocal(name, value) {
      if (!this.frames.length) return false;
      const frame = this.frames[this.frames.length - 1];
      frame.set(name, value === undefined ? '' : String(value));
      return true;
    },
    setPositional(args) { this.positional = args.slice(); },
  };
  if (!scope.vars.has('HOME')) scope.vars.set('HOME', '/');
  return scope;
}

function exportEnv(scope) {
  const env = envObject();
  for (const name of scope.exported) {
    const value = scope.vars.get(name);
    if (value !== undefined) env[name] = String(value);
  }
  env.PWD = scope.cwd;
  return env;
}

function pathEntries(scope) {
  const raw = scope.vars.get('PATH') || DEFAULT_PATH;
  return String(raw).split(pathNode.delimiter === ';' ? ';' : ':').filter((entry) => entry.length > 0);
}

function hostCandidates(scope, program) {
  const candidates = [];
  const extensions = processNode.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  const hasDir = program.indexOf('/') !== -1 || program.indexOf('\\') !== -1;
  const roots = hasDir ? ['.'] : pathEntries(scope);
  for (const root of roots) {
    for (const ext of extensions) {
      const candidate = hasDir
        ? pathNode.resolve(scope.hostCwd, program + ext)
        : pathNode.join(root, program + ext);
      candidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    try {
      const stat = fsNode.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

export function resolveExternal(scope, program) {
  const file = hostCandidates(scope, program);
  if (!file) return null;
  const lower = file.toLowerCase();
  const kind = lower.endsWith('.cmd') || lower.endsWith('.bat') ? 'cmd' : 'exe';
  return { file, kind };
}

function quoteWindowsArg(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '\\"') + '"';
}

export function spawnArguments(resolved, program, args) {
  if (resolved.kind === 'cmd') {
    const comspec = processNode.env.ComSpec || 'cmd.exe';
    const line = [resolved.file].concat(args).map(quoteWindowsArg).join(' ');
    return { file: comspec, args: ['/d', '/s', '/c', '"' + line + '"'], options: { windowsVerbatimArguments: true } };
  }
  return { file: resolved.file, args, options: {} };
}

function truncateText(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n... [truncated ' + (text.length - limit) + ' chars]\n';
}

class Sink {
  constructor(limit) {
    this.chunks = [];
    this.size = 0;
    this.limit = limit;
    this.truncated = false;
  }
  write(text) {
    const value = String(text);
    if (this.size >= this.limit) { this.truncated = true; return; }
    const room = this.limit - this.size;
    if (value.length > room) { this.chunks.push(value.slice(0, room)); this.size = this.limit; this.truncated = true; return; }
    this.chunks.push(value);
    this.size += value.length;
  }
  text() { return this.chunks.join(''); }
}

class FileSink {
  constructor(fs, file, append, cwd) {
    this.fs = fs;
    this.file = file;
    this.append = append;
    this.cwd = cwd || '/';
    this.chunks = [];
  }
  write(text) { this.chunks.push(String(text)); }
  close() {
    const data = this.chunks.join('');
    this.fs.writeText(this.file, this.cwd, data, { append: this.append });
  }
}

function devNullSink() {
  return { write() {}, close() {} };
}

export function createIo(scope, outSink, errSink, stdinText, inputSource) {
  const text = stdinText === undefined ? '' : String(stdinText);
  const input = inputSource && inputSource.text === text ? inputSource : { text, pos: 0 };
  return {
    scope,
    outSink,
    errSink,
    stdinText: text,
    input,
    readLine() {
      const source = this.input;
      if (source.pos >= source.text.length) return null;
      let line = '';
      while (source.pos < source.text.length) {
        const ch = source.text[source.pos];
        source.pos++;
        if (ch === '\n') return line;
        line += ch;
      }
      return line;
    },
    write(text) { outSink.write(text); },
    error(text) { errSink.write(text); },
    exit(code) { throw new ShellExit(code); },
    check() { if (scope.shell) scope.shell.check(); },
  };
}

export function attachShell(scope, shell) {
  scope.shell = shell;
  return scope;
}

export function createShell(options) {
  const fs = options.fs;
  const scope = createScope(Object.assign({}, options, { fs }));
  const maxOutput = options.maxOutput || 512 * 1024;
  const deadline = options.timeoutMs ? now() + options.timeoutMs : 0;
  const shell = {
    fs,
    scope,
    options,
    mainOut: new Sink(maxOutput),
    mainErr: new Sink(maxOutput),
    deadline,
    signal: options.signal || null,
    lastCmdStatus: null,
    depth: 0,
    aborted: null,
    check() {
      if (this.aborted) throw new ShellAbort(this.aborted);
      if (this.signal && this.signal.aborted) { this.aborted = 'aborted'; throw new ShellAbort('aborted'); }
      if (this.deadline && now() > this.deadline) { this.aborted = 'timeout'; throw new ShellAbort('timeout'); }
    },
    outputTruncated() { return this.mainOut.truncated || this.mainErr.truncated; },
  };
  shell.prepareExternal = typeof options.prepareExternal === 'function' ? options.prepareExternal : null;
  scope.shell = shell;

  shell.runScriptText = async function runScriptText(text, targetScope, io) {
    const target = targetScope || scope;
    const program = parse(lex(String(text)));
    return execNodes(program.body || [program], target, io);
  };

  shell.runSubstitution = async function runSubstitution(ast, parentScope) {
    const childScope = cloneScope(parentScope || scope);
    const sink = new Sink(Math.min(maxOutput, 64 * 1024));
    const errSink = new Sink(Math.min(maxOutput, 64 * 1024));
    const childIo = createIo(childScope, sink, errSink, '');
    const saved = childScope.shell;
    let substitutedStatus = 0;
    try {
      substitutedStatus = await execNodes(ast, childScope, childIo);
    } catch (error) {
      if (error instanceof ShellExit) { substitutedStatus = error.code; }
      else if (error instanceof ShellBreak || error instanceof ShellContinue || error instanceof ShellReturn) { /* ignore */ }
      else if (error instanceof ShellAbort) throw error;
      else if (error instanceof ShellError) errSink.write(error.message + '\n');
      else if (error instanceof Error) errSink.write(error.message + '\n');
    } finally {
      childScope.shell = saved;
    }
    if (saved) saved.lastCmdStatus = substitutedStatus;
    return sink.text().replace(/\n+$/, '');
  };

  shell.execSync = function execSyncExternal(argv, inputText, extraEnv) {
    const resolved = resolveExternal(scope, argv[0]);
    if (!resolved) return { code: 127, stdout: '', stderr: argv[0] + ': command not found\n' };
    const spawned = spawnArguments(resolved, argv[0], argv.slice(1));
    const env = Object.assign(exportEnv(scope), extraEnv || {});
    const result = spawnSync(spawned.file, spawned.args, Object.assign({
      cwd: scope.hostCwd,
      env,
      input: inputText === undefined ? '' : String(inputText),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, spawned.options));
    if (result.error) return { code: 127, stdout: '', stderr: argv[0] + ': ' + result.error.message + '\n' };
    return { code: result.status === null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
  };

  shell.coreutils = options.coreutils || new Map();
  shell.resolve = (program) => resolveExternal(scope, program);
  shell.coreutilsContext = (targetScope, targetIo) => ({
    fs: targetScope.fs,
    scope: targetScope,
    cwd: targetScope.cwd,
    env: exportEnv(targetScope),
    stdin: targetIo.input ? targetIo.input.text.slice(targetIo.input.pos) : targetIo.stdinText,
    out(target) { targetIo.write(target); },
    err(target) { targetIo.error(target); },
    check() { targetIo.check(); },
    getVar(name) { return targetScope.getVar(name); },
    runCommand(commandArgv, restArgs, stdinText) {
      const argv = Array.isArray(commandArgv) ? commandArgv : [commandArgv].concat(restArgs || []);
      const result = runCommandSync(targetScope, argv);
      return { code: result.code, out: result.stdout, err: result.stderr };
    },
    shell,
  });
  shell.builtins = createBuiltins(shell);
  return shell;
}

async function applyRedirections(redirs, scope, io) {
  const channels = { 0: { kind: 'text', text: io.stdinText, source: io.input }, 1: io.outSink, 2: io.errSink };
  const originalOut = io.outSink;
  const originalErr = io.errSink;
  const closers = [];
  for (const redir of redirs || []) {
    const op = redir.op;
    const fd = redir.fd === null || redir.fd === undefined ? null : Number(redir.fd);
    if (op === '<<' || op === '<<<') {
      let text = '';
      if (redir.here) text = redir.here.body === undefined ? '' : String(redir.here.body);
      else if (redir.body !== undefined) text = String(redir.body);
      else if (redir.target) text = await expand.expandSingle(redir.target, scope);
      if (op === '<<<' && redir.target) text = await expand.expandSingle(redir.target, scope);
      const quoted = !!(redir.here && redir.here.quoted) || !!redir.quoted;
      if (!quoted && op === '<<') text = await expandHereDoc(text, scope);
      if (op === '<<<') text = text + '\n';
      channels[0] = { kind: 'text', text, source: { text, pos: 0 } };
      continue;
    }
    if (op === '>&' || op === '<&') {
      const target = String(await expand.expandSingle(redir.target, scope)).trim();
      const source = fd === null ? 1 : fd;
      if (target === '-' ) { continue; }
      const want = Number(target);
      if (Number.isFinite(want)) {
        channels[source] = channels[want] || channels[source];
        if (source === 1) io.outSink = channels[1];
        if (source === 2) io.errSink = channels[2];
        continue;
      }
      if (op === '<&' && target === '0') { continue; }
      const sink = new FileSink(scope.fs, target, false, scope.cwd);
      channels[source] = sink;
      if (source === 1) io.outSink = sink;
      if (source === 2) io.errSink = sink;
      closers.push(sink);
      continue;
    }
    if (op === '&>' || op === '&>>') {
      const file = await expand.expandSingle(redir.target, scope);
      const sink = new FileSink(scope.fs, file, op === '&>>', scope.cwd);
      channels[1] = sink;
      channels[2] = sink;
      io.outSink = sink;
      io.errSink = sink;
      closers.push(sink);
      continue;
    }
    const file = await expand.expandSingle(redir.target, scope);
    if (op === '<' || op === '<>') {
      let text = '';
      try { text = scope.fs.readText(file, scope.cwd); } catch (error) { throw error; }
      channels[0] = { kind: 'text', text, source: { text, pos: 0 } };
      continue;
    }
    if (op === '>') {
      const sink = new FileSink(scope.fs, file, false, scope.cwd);
      const target = fd === null ? 1 : fd;
      channels[target] = sink;
      if (target === 1) io.outSink = sink;
      if (target === 2) io.errSink = sink;
      closers.push(sink);
      continue;
    }
    if (op === '>>') {
      const sink = new FileSink(scope.fs, file, true, scope.cwd);
      const target = fd === null ? 1 : fd;
      channels[target] = sink;
      if (target === 1) io.outSink = sink;
      if (target === 2) io.errSink = sink;
      closers.push(sink);
      continue;
    }
    if (op === '2>' || op === '2>>') {
      const sink = new FileSink(scope.fs, file, op === '2>>', scope.cwd);
      channels[2] = sink;
      io.errSink = sink;
      closers.push(sink);
    }
  }
  return {
    channels,
    io,
    close() {
      io.outSink = originalOut;
      io.errSink = originalErr;
      let first = null;
      for (const closer of closers) {
        try { closer.close(); } catch (error) { if (!first) first = error; }
      }
      if (first) throw first;
    },
  };
}

async function expandHereDoc(text, scope) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch !== '$') { out += ch; index++; continue; }
    const next = text[index + 1];
    if (next === '(') {
      let depth = 0;
      let cursor = index + 1;
      for (; cursor < text.length; cursor++) {
        if (text[cursor] === '(') depth++;
        else if (text[cursor] === ')') { depth--; if (depth === 0) break; }
      }
      const inner = text.slice(index + 2, cursor);
      out += await scope.shell.runSubstitution(parse(lex(inner)).body, scope);
      index = cursor + 1;
      continue;
    }
    if (next === '{') {
      let depth = 0;
      let cursor = index + 1;
      for (; cursor < text.length; cursor++) {
        if (text[cursor] === '{') depth++;
        else if (text[cursor] === '}') { depth--; if (depth === 0) break; }
      }
      const inner = text.slice(index + 2, cursor);
      const word = { parts: lex('"' + '$' + '{' + inner + '}' + '"').length ? synthesizeParts('$' + '{' + inner + '}') : [] };
      out += await expand.expandSingle(word, scope);
      index = cursor + 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index + 1));
    if (match) { out += await expand.expandSingle(synthesizeWord('$' + match[0]), scope); index += 1 + match[0].length; continue; }
    out += ch;
    index++;
  }
  return out;
}

function synthesizeParts(text) {
  const tokens = lex('"' + text + '"');
  for (const token of tokens) {
    if (token.t === 'word' && token.parts) return token.parts;
  }
  return [{ t: 'lit', v: text, q: 0 }];
}

function synthesizeWord(text) {
  return { parts: synthesizeParts(text) };
}

async function execNodes(nodes, scope, io) {
  let status = scope.lastStatus;
  for (const node of nodes || []) {
    status = await execNode(node, scope, io);
    scope.lastStatus = status;
  }
  return status;
}

const COMPOUND_KINDS = new Set(['if', 'for', 'while', 'until', 'case', 'group']);

async function execWithRedirs(node, scope, io) {
  const copy = createIo(scope, io.outSink, io.errSink, io.stdinText, io.input);
  copy.check = () => io.check();
  const applied = await applyRedirections(node.redirs, scope, copy);
  const channel = applied.channels[0];
  if (channel && channel.kind === 'text') {
    copy.stdinText = channel.text;
    copy.input = channel.source || { text: channel.text, pos: 0 };
  }
  const stripped = Object.assign({}, node);
  delete stripped.redirs;
  try {
    return await execNode(stripped, scope, copy);
  } finally {
    applied.close();
  }
}

export async function execNode(node, scope, io) {
  if (!node) return 0;
  if (Array.isArray(node)) return execNodes(node, scope, io);
  if (scope.shell) scope.shell.check();
  if (node.redirs && node.redirs.length && COMPOUND_KINDS.has(node.k)) return execWithRedirs(node, scope, io);
  switch (node.k) {
    case 'script': return execNodes(node.body, scope, io);
    case 'list': return execList(node, scope, io);
    case 'andor': return execAndOr(node, scope, io);
    case 'pipeline': return execPipeline(node, scope, io);
    case 'simple': return execSimple(node, scope, io);
    case 'if': return execIf(node, scope, io);
    case 'for': return execFor(node, scope, io);
    case 'while': return execWhile(node, scope, io, false);
    case 'until': return execWhile(node, scope, io, true);
    case 'case': return execCase(node, scope, io);
    case 'group': return execGroup(node, scope, io);
    case 'func':
      scope.funcs.set(node.name, node.body);
      scope.lastStatus = 0;
      return 0;
    case 'arithcmd': {
      const value = evalArith(await expand.expandArithText(node.src, scope), scope);
      const status = value ? 0 : 1;
      scope.lastStatus = status;
      return status;
    }
    case 'select': return 1;
    default:
      io.error('unsupported node: ' + node.k + '\n');
      return 2;
  }
}

function errexitActive(scope) {
  return !!(scope.opts && scope.opts.errexit) && !scope.errexitSuppressed;
}

async function execList(node, scope, io) {
  let status = 0;
  for (const item of node.items || []) {
    if (item.sep === '&') {
      io.error('内置 Bash: 暂不支持后台执行（&），请改用同步命令\n');
      status = 1;
      scope.lastStatus = 1;
      continue;
    }
    status = await execNode(item.node, scope, io);
    scope.lastStatus = status;
    if (status !== 0 && errexitActive(scope)) throw new ShellExit(status);
  }
  return status;
}

async function execAndOr(node, scope, io) {
  scope.errexitSuppressed = (scope.errexitSuppressed || 0) + 1;
  let status;
  try {
    status = await execNode(node.first, scope, io);
    scope.lastStatus = status;
    for (const step of node.rest || []) {
      if (step.op === '&&' && status !== 0) continue;
      if (step.op === '||' && status === 0) continue;
      status = await execNode(step.node, scope, io);
      scope.lastStatus = status;
    }
  } finally {
    scope.errexitSuppressed -= 1;
  }
  return status;
}

async function captureStage(node, scope, inputText) {
  const sink = new Sink(Math.min(scope.shell ? 64 * 1024 * 1024 : 1024 * 1024, 64 * 1024 * 1024));
  const errSink = new Sink(1024 * 1024);
  const stageScope = cloneScope(scope);
  const io = createIo(stageScope, sink, errSink, inputText);
  let status = 1;
  try {
    status = await execNode(node, stageScope, io);
  } catch (error) {
    if (error instanceof ShellExit) status = error.code;
    else if (error instanceof ShellBreak || error instanceof ShellContinue) { /* invalid outside loop */ }
    else if (error instanceof ShellReturn) status = error.code;
    else if (error instanceof ShellAbort) throw error;
    else { errSink.write(String(error && error.message ? error.message : error) + '\n'); status = 1; }
  }
  return { status, out: sink.text(), err: errSink.text() };
}

async function execPipeline(node, scope, io) {
  const commands = node.cmds || [];
  if (!commands.length) return 0;
  if (commands.length === 1) {
    let status = await execNode(commands[0], scope, io);
    if (node.negate) status = status === 0 ? 1 : 0;
    return status;
  }
  const savedSuppress = scope.errexitSuppressed;
  scope.errexitSuppressed = (scope.errexitSuppressed || 0) + 1;
  let input = '';
  let status = 0;
  const failures = [];
  try {
    for (let index = 0; index < commands.length; index++) {
      const result = await captureStage(commands[index], scope, input);
      if (result.err) io.error(result.err);
      input = result.out;
      status = result.status;
      failures.push(result.status);
    }
  } finally {
    scope.errexitSuppressed = savedSuppress;
  }
  if (scope.opts && scope.opts.pipefail) {
    for (let index = failures.length - 1; index >= 0; index--) {
      if (failures[index] !== 0) { status = failures[index]; break; }
    }
  }
  if (node.negate) status = status === 0 ? 1 : 0;
  io.write(input);
  return status;
}

async function execIf(node, scope, io) {
  for (const branch of node.branches || []) {
    const status = await runCondition(branch.cond, scope, io);
    scope.lastStatus = status;
    if (status === 0) return execNodes(branch.body, scope, io);
  }
  if (node.elseBody) return execNodes(node.elseBody, scope, io);
  return 0;
}

async function runCondition(node, scope, io) {
  const saved = scope.errexitSuppressed;
  scope.errexitSuppressed = (scope.errexitSuppressed || 0) + 1;
  try {
    if (Array.isArray(node)) return await execNodes(node, scope, io);
    return await execNode(node, scope, io);
  } finally {
    scope.errexitSuppressed = saved;
  }
}

async function execFor(node, scope, io) {
  if (node.arith !== null && node.arith !== undefined) return execArithFor(node, scope, io);
  let items;
  if (node.words === null || node.words === undefined) items = scope.positional.slice();
  else items = await expand.expandWords(node.words, scope);
  let status = 0;
  for (const item of items) {
    scope.setVar(node.name, item);
    try {
      status = await execNodes(node.body, scope, io);
    } catch (error) {
      if (error instanceof ShellBreak) { if (error.count > 1) { error.count--; throw error; } break; }
      if (error instanceof ShellContinue) { if (error.count > 1) { error.count--; throw error; } continue; }
      throw error;
    }
    scope.lastStatus = status;
  }
  return status;
}

async function execArithFor(node, scope, io) {
  const parts = String(node.arith).split(';');
  const init = parts[0] === undefined ? '' : parts[0];
  const cond = parts[1] === undefined ? '' : parts[1];
  const step = parts[2] === undefined ? '' : parts[2];
  if (init.trim()) evalArith(await expand.expandArithText(init, scope), scope);
  let status = 0;
  for (;;) {
    if (cond.trim() && !evalArith(await expand.expandArithText(cond, scope), scope)) break;
    try {
      status = await execNodes(node.body, scope, io);
    } catch (error) {
      if (error instanceof ShellBreak) { if (error.count > 1) { error.count--; throw error; } break; }
      if (error instanceof ShellContinue) { if (error.count > 1) { error.count--; throw error; } }
      else throw error;
    }
    if (step.trim()) evalArith(await expand.expandArithText(step, scope), scope);
    scope.lastStatus = status;
    if (scope.shell) scope.shell.check();
  }
  return status;
}

async function execWhile(node, scope, io, until) {
  let status = 0;
  for (;;) {
    const condition = await runCondition(node.cond, scope, io);
    const ok = until ? condition !== 0 : condition === 0;
    if (!ok) break;
    try {
      status = await execNodes(node.body, scope, io);
    } catch (error) {
      if (error instanceof ShellBreak) { if (error.count > 1) { error.count--; throw error; } break; }
      if (error instanceof ShellContinue) { if (error.count > 1) { error.count--; throw error; } continue; }
      throw error;
    }
    scope.lastStatus = status;
    if (scope.shell) scope.shell.check();
  }
  return status;
}

async function execCase(node, scope, io) {
  const value = await expand.expandSingle(node.word, scope);
  let status = 0;
  let forced = false;
  for (const arm of node.arms || []) {
    let hit = forced;
    forced = false;
    if (!hit) {
      for (const patternWord of arm.pats || []) {
        const pattern = await expand.expandPattern(patternWord, scope);
        if (expand.matchPattern(pattern, value)) { hit = true; break; }
      }
    }
    if (!hit) continue;
    status = await execNodes(arm.body, scope, io);
    const term = arm.term || (arm.fall ? ';&' : ';;');
    if (term === ';&') { forced = true; continue; }
    if (term === ';;&') continue;
    return status;
  }
  return status;
}

async function execGroup(node, scope, io) {
  if (node.subshell) {
    const childScope = cloneScope(scope);
    try {
      return await execNodes(node.body, childScope, io);
    } catch (error) {
      if (error instanceof ShellExit && error.code === 0) return 0;
      if (error instanceof ShellBreak || error instanceof ShellContinue || error instanceof ShellReturn) return 0;
      throw error;
    }
  }
  return execNodes(node.body, scope, io);
}

async function execBuiltinOrFunction(argv, scope, io, assigns) {
  const program = argv[0];
  const args = argv.slice(1);
  if (scope.funcs.has(program)) {
    const body = scope.funcs.get(program);
    const previous = scope.positional;
    scope.positional = args;
    scope.frames.push(new Map());
    let status = 0;
    try {
      status = await execNode(body, scope, io);
    } catch (error) {
      if (error instanceof ShellReturn) status = error.code;
      else throw error;
    } finally {
      scope.frames.pop();
      scope.positional = previous;
    }
    return status;
  }
  const builtins = scope.shell ? scope.shell.builtins : null;
  if (builtins && builtins.has(program)) {
    const result = await builtins.get(program)(scope, args, io, { shell: scope.shell, argv });
    return typeof result === 'number' ? result : (result && typeof result.code === 'number' ? result.code : 0);
  }
  const registry = scope.shell ? scope.shell.coreutils : null;
  if (registry && registry.has(program)) {
    const previous = scope.cwd;
    const ctx = {
      fs: scope.fs,
      scope,
      cwd: scope.cwd,
      env: exportEnv(scope),
      stdin: io.stdinText,
      out(text) { io.write(text); },
      err(text) { io.error(text); },
      check() { io.check(); },
      getVar(name) { return scope.getVar(name); },
      runCommand(commandArgv, restArgs, stdinText) {
        const argv = Array.isArray(commandArgv) ? commandArgv : [commandArgv].concat(restArgs || []);
        const result = runCommandSync(scope, argv);
        return { code: result.code, out: result.stdout, err: result.stderr };
      },
      shell: scope.shell,
    };
    let result;
    try {
      result = registry.get(program)(program, args, ctx);
    } catch (error) {
      if (error instanceof ShellError) { io.error(program + ': ' + error.message + '\n'); return 1; }
      throw error;
    }
    if (result && typeof result === 'object') {
      if (result.out) io.write(result.out);
      if (result.err) io.error(result.err);
      return typeof result.code === 'number' ? result.code : 0;
    }
    return 0;
  }
  return null;
}

export function runCommandSync(scope, argv) {
  if (!argv.length) return { code: 0, stdout: '', stderr: '' };
  const builtins = scope.shell ? scope.shell.builtins : null;
  if (builtins && builtins.has(argv[0])) {
    const chunks = [];
    const errChunks = [];
    const io = {
      write(text) { chunks.push(String(text)); },
      error(text) { errChunks.push(String(text)); },
      exit(code) { throw new ShellExit(code); },
      check() {},
      stdinText: '',
    };
    let code = 0;
    try {
      const result = builtins.get(argv[0])(scope, argv.slice(1), io, { shell: scope.shell, argv });
      code = typeof result === 'number' ? result : 0;
    } catch (error) {
      if (error instanceof ShellExit) code = error.code;
      else { errChunks.push(String(error.message || error) + '\n'); code = 1; }
    }
    return { code, stdout: chunks.join(''), stderr: errChunks.join('') };
  }
  const registry = scope.shell ? scope.shell.coreutils : null;
  if (registry && registry.has(argv[0])) {
    const chunks = [];
    const errChunks = [];
    const ctx = {
      fs: scope.fs,
      scope,
      cwd: scope.cwd,
      env: exportEnv(scope),
      stdin: '',
      out(text) { chunks.push(String(text)); },
      err(text) { errChunks.push(String(text)); },
      check() {},
      getVar(name) { return scope.getVar(name); },
      runCommand(commandArgv, restArgs) {
        const argv = Array.isArray(commandArgv) ? commandArgv : [commandArgv].concat(restArgs || []);
        const result = runCommandSync(scope, argv);
        return { code: result.code, out: result.stdout, err: result.stderr };
      },
      shell: scope.shell,
    };
    const result = registry.get(argv[0])(argv[0], argv.slice(1), ctx);
    if (result && result.out) chunks.push(result.out);
    if (result && result.err) errChunks.push(result.err);
    return { code: result && typeof result.code === 'number' ? result.code : 0, stdout: chunks.join(''), stderr: errChunks.join('') };
  }
  if (!scope.shell) return { code: 127, stdout: '', stderr: argv[0] + ': command not found\n' };
  return scope.shell.execSync(argv, '');
}

async function expandConditionArgs(inner, scope) {
  const tokens = lex(inner);
  const out = [];
  for (const token of tokens) {
    if (!token) continue;
    if (token.t === 'word') { out.push(await expand.expandSingle(token, scope)); continue; }
    if (token.t === 'op') { if (token.v !== 'newline') out.push(token.v); continue; }
    if (token.t === 'arith') { out.push(String(evalArith(await expand.expandArithText(token.src, scope), scope))); continue; }
    if (token.t === 'redir' && (token.op === '<' || token.op === '>')) { out.push(token.op); continue; }
  }
  return out;
}

async function execSimple(node, scope, io) {
  const words = node.words || [];
  if (scope.shell) scope.shell.lastCmdStatus = null;
  const condWord = words.length === 1 && words[0] && typeof words[0].cond === 'string' ? words[0] : null;
  let argv;
  try {
    argv = condWord ? ['[[', ...(await expandConditionArgs(condWord.cond, scope))] : await expand.expandWords(words, scope);
  } catch (error) {
    if (error instanceof ShellError) { io.error(error.message + '\n'); return 1; }
    throw error;
  }
  const assignmentValues = [];
  const previousValues = [];
  for (const assign of node.assigns || []) {
    let value;
    try {
      value = assign.array ? await expand.expandWords(assign.array, scope) : await expand.expandAssignmentWord(assign.value, scope);
    } catch (error) {
      if (error instanceof ShellError) { io.error(error.message + '\n'); return 1; }
      throw error;
    }
    const name = assign.name;
    const key = scope.frames.length;
    previousValues.push({ name, existed: scope.vars.has(name), value: scope.vars.get(name), frame: key, wasExported: scope.exported.has(name) });
    if (assign.append) {
      const previous = scope.getVar(name);
      const existing = Array.isArray(previous) ? previous.slice() : (previous === undefined ? [] : [String(previous)]);
      const appended = Array.isArray(value) ? value : (value === undefined ? [] : [value]);
      value = existing.concat(appended);
    } else if (assign.index !== undefined) {
      const previous = scope.getVar(name);
      const existing = Array.isArray(previous) ? previous.slice() : [];
      existing[assign.index] = Array.isArray(value) ? value[0] : value;
      value = existing;
    }
    assignmentValues.push({ name, value });
    scope.setVar(name, value);
  }

  const restore = () => {
    for (let index = previousValues.length - 1; index >= 0; index--) {
      const entry = previousValues[index];
      if (entry.existed) scope.vars.set(entry.name, entry.value);
      else scope.vars.delete(entry.name);
      if (entry.wasExported === false) scope.exported.delete(entry.name);
    }
  };

  const redirection = await applyRedirections(node.redirs, scope, io);
  const stdinChannel = redirection.channels[0];
  const commandIo = createIo(
    scope,
    redirection.io.outSink,
    redirection.io.errSink,
    stdinChannel.kind === 'text' ? stdinChannel.text : '',
    stdinChannel.source || null,
  );
  commandIo.check = () => io.check();
  commandIo.exit = (code) => { throw new ShellExit(code); };

  if (!argv.length) {
    if (scope.opts && scope.opts.allexport) for (const entry of assignmentValues) scope.exported.add(entry.name);
    redirection.close();
    if (scope.opts && scope.opts.xtrace) io.error('+ ' + assignmentValues.map((entry) => entry.name + '=' + entry.value).join(' ') + '\n');
    const substitutionStatus = scope.shell && typeof scope.shell.lastCmdStatus === 'number' ? scope.shell.lastCmdStatus : 0;
    return substitutionStatus;
  }

  if (scope.opts && scope.opts.xtrace) io.error('+ ' + argv.map((arg) => (/[\s'"]/.test(arg) ? "'" + arg + "'" : arg)).join(' ') + '\n');
  // Prefix assignments are visible in the command environment (bash: FOO=bar cmd).
  for (const entry of assignmentValues) if (!scope.exported.has(entry.name)) scope.exported.add(entry.name);
  if (scope.opts && scope.opts.noexec) { restore(); redirection.close(); return 0; }

  let status;
  try {
    const result = await execBuiltinOrFunction(argv, scope, commandIo, assignmentValues);
    if (result !== null) status = result;
    else status = await runExternal(argv, scope, commandIo, redirection);
  } finally {
    if (!isAssignmentPersisting(scope, argv)) restore();
    redirection.close();
  }
  return status;
}

function isAssignmentPersisting(scope, argv) {
  const program = argv[0];
  return false;
}

async function runExternal(argv, scope, io, redirection) {
  const simple = resolveExternal(scope, argv[0]);
  if (!simple) {
    io.error(argv[0] + ': command not found\n');
    return 127;
  }
  const spawned = spawnArguments(simple, argv[0], argv.slice(1));
  let executable = spawned.file;
  let args = spawned.args;
  let env = exportEnv(scope);
  let spawnOptions = spawned.options || {};
  if (scope.shell && typeof scope.shell.prepareExternal === 'function') {
    try {
      const prepared = await scope.shell.prepareExternal([executable, ...args], scope.shell.signal, env);
      if (prepared && Array.isArray(prepared.argv) && prepared.argv.length) {
        executable = prepared.argv[0];
        args = prepared.argv.slice(1);
        if (prepared.env) env = prepared.env;
        spawnOptions = Object.assign({}, spawnOptions, prepared.options || {});
      }
    } catch (error) {
      if (error && (error.name === 'AbortError' || (scope.shell.signal && scope.shell.signal.aborted))) return 130;
      io.error(argv[0] + ': ' + (error && error.message ? error.message : String(error)) + '\n');
      return 126;
    }
  }
  const stdinText = io.stdinText;
  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(executable, args, Object.assign({
        cwd: scope.hostCwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }, spawnOptions));
    } catch (error) {
      io.error(argv[0] + ': ' + error.message + '\n');
      resolvePromise(127);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { try { io.write(chunk); } catch { /* sink limit */ } });
    child.stderr.on('data', (chunk) => { try { io.error(chunk); } catch { /* sink limit */ } });
    child.on('error', (error) => {
      io.error(argv[0] + ': ' + error.message + '\n');
      resolvePromise(127);
    });
    child.on('close', (code) => { resolvePromise(code === null ? 1 : code); });
    if (child.stdin) {
      try { if (stdinText) child.stdin.write(stdinText); } catch { /* ignore */ }
      try { child.stdin.end(); } catch { /* ignore */ }
    }
    if (scope.shell && scope.shell.signal) {
      const signal = scope.shell.signal;
      const onAbort = () => {
        try { spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); } catch { /* ignore */ }
      };
      if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export async function runScript(options) {
  const fs = options.fs || createFs({ root: options.root, mode: options.mode, cwd: options.cwdV || '/' });
  const shell = createShell(Object.assign({}, options, { fs }));
  const scope = shell.scope;
  const io = createIo(scope, shell.mainOut, shell.mainErr, options.stdin || '');
  let exitCode = 0;
  let aborted = null;
  try {
    const program = parse(lex(String(options.command || '')));
    exitCode = await execNodes(program.body || [], scope, io);
  } catch (error) {
    if (error instanceof ShellExit) exitCode = error.code;
    else if (error instanceof ShellReturn) exitCode = error.code;
    else if (error instanceof ShellAbort) { aborted = error.reason; exitCode = error.reason === 'timeout' ? 124 : 130; }
    else if (error instanceof ShellBreak || error instanceof ShellContinue) exitCode = 1;
    else if (error instanceof ShellError) { shell.mainErr.write(error.message + '\n'); exitCode = 1; }
    else if (error && error.code === 'SANDBOX_UNAVAILABLE') throw error;
    else if (error instanceof Error) { shell.mainErr.write((error.message || String(error)) + '\n'); exitCode = 1; }
    else { shell.mainErr.write(String(error) + '\n'); exitCode = 1; }
  }
  if (scope.opts && scope.opts.errexit && exitCode !== 0 && exitCode !== 124) { /* already literal */ }
  const exitTrap = scope.traps && scope.traps.get('EXIT');
  if (exitTrap && !aborted) {
    scope.traps.delete('EXIT');
    try {
      await shell.runScriptText(exitTrap, scope, io);
    } catch (trapError) {
      if (trapError instanceof ShellExit || trapError instanceof ShellReturn) exitCode = trapError.code;
      else if (trapError instanceof ShellAbort) { aborted = trapError.reason; exitCode = trapError.reason === 'timeout' ? 124 : 130; }
      else if (trapError instanceof ShellError) { shell.mainErr.write(trapError.message + '\n'); }
      else if (trapError instanceof Error) { shell.mainErr.write((trapError.message || String(trapError)) + '\n'); }
      else { shell.mainErr.write(String(trapError) + '\n'); }
    }
  }
  return {
    stdout: shell.mainOut.text(),
    stderr: shell.mainErr.text(),
    exitCode,
    aborted,
    truncated: shell.outputTruncated(),
    cwd: fs.vpath(scope.cwd),
  };
}
