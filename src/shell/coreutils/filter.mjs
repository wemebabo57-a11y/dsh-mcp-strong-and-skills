// src/shell/coreutils/filter.mjs
//
// grep, find and xargs for the builtin shell. Everything here is synchronous:
// no promises, no child processes, no third-party packages. Every filesystem
// access goes through ctx.fs (src/shell/fs.mjs), so the paths we print are POSIX
// virtual paths rooted at the project root.
//
// Behaviour was derived from GNU grep 3.8 and GNU findutils 4.9 running under
// bash 5.2 (Git for Windows). test/shell-coreutils-filter.test.mjs pins the
// interesting cases; docs/shell-design.md documents the ctx contract.
import { ShellError, ERRNO_TEXT } from '../fs.mjs';
import { formatError, splitLines, toInt } from '../io.mjs';

export const names = ['grep', 'find', 'xargs'];

/**
 * Entry point used by coreutils/registry.mjs.
 * argv[0] is the command name (per the coreutil contract); a missing or
 * different argv[0] is tolerated so direct calls stay convenient.
 */
export function main(prog, argv, ctx) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.length && args[0] === prog) args.shift();
  const context = ctx ?? {};
  if (prog === 'grep') return runGrep(args, context);
  if (prog === 'find') return runFind(args, context);
  if (prog === 'xargs') return runXargs(args, context);
  return { code: 2, out: '', err: prog + ': unsupported command\n' };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const REGEX_SPECIAL = /[.*+?^$(){}|[\]\\]/;

function escapeRegexChar(ch) {
  return REGEX_SPECIAL.test(ch) ? '\\' + ch : ch;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

// POSIX bracket-expression classes, expressed as regex class bodies.
const POSIX_CLASSES = new Map([
  ['alpha', 'A-Za-z'],
  ['alnum', 'A-Za-z0-9'],
  ['blank', ' \\t'],
  ['cntrl', '\\x00-\\x1F\\x7F'],
  ['digit', '0-9'],
  ['graph', '\\x21-\\x7E'],
  ['lower', 'a-z'],
  ['print', '\\x20-\\x7E'],
  ['punct', '\\x21-\\x2F\\x3A-\\x40\\x5B-\\x60\\x7B-\\x7E'],
  ['space', '\\s'],
  ['upper', 'A-Z'],
  ['word', 'A-Za-z0-9_'],
  ['xdigit', '0-9A-Fa-f'],
]);

/**
 * Read one bracket expression starting at pattern[start] === '['.
 * Returns { text, end } where text is a ready-to-use regex class, or null when
 * the class is unterminated. shellNegation enables the shell form [!abc]
 * (used by find/xargs globs, not by grep patterns).
 */
function readBracketClass(pattern, start, options = {}) {
  const shellNegation = options.shellNegation !== false;
  let index = start + 1;
  let negate = false;
  if (pattern[index] === '^' || (shellNegation && pattern[index] === '!')) {
    negate = true;
    index += 1;
  }
  let body = '';
  if (pattern[index] === ']') {
    body += '\\]';
    index += 1;
  }
  let closed = false;
  while (index < pattern.length) {
    const ch = pattern[index];
    if (ch === ']') {
      closed = true;
      break;
    }
    if (ch === '[' && pattern[index + 1] === ':') {
      const end = pattern.indexOf(':]', index + 2);
      if (end > 0) {
        const mapped = POSIX_CLASSES.get(pattern.slice(index + 2, end));
        if (mapped) body += mapped;
        index = end + 2;
        continue;
      }
    }
    if (ch === '\\') {
      const next = pattern[index + 1];
      if (next !== undefined) {
        body += '\\' + next;
        index += 2;
        continue;
      }
    }
    if (ch === '^' || ch === ']' || ch === '\\') {
      body += '\\' + ch;
      index += 1;
      continue;
    }
    body += ch;
    index += 1;
  }
  if (!closed) return null;
  return { text: '[' + (negate ? '^' : '') + body + ']', end: index };
}

/**
 * Compile a shell-style glob. '*' and '?' never cross '/' unless pathMode is
 * set (find -path matches the whole path with '*' spanning slashes).
 */
function compileGlob(pattern, options = {}) {
  const pathMode = Boolean(options.pathMode);
  const anyChar = pathMode ? '[\\s\\S]' : '[^/]';
  const text = String(pattern);
  let source = '';
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\\') {
      const next = text[index + 1];
      if (next !== undefined) {
        source += escapeRegexChar(next);
        index += 1;
        continue;
      }
      source += '\\\\';
      continue;
    }
    if (ch === '*') {
      source += anyChar + '*';
      continue;
    }
    if (ch === '?') {
      source += anyChar;
      continue;
    }
    if (ch === '[') {
      const cls = readBracketClass(text, index);
      if (cls) {
        source += cls.text;
        index = cls.end;
        continue;
      }
      source += '\\[';
      continue;
    }
    source += escapeRegexChar(ch);
  }
  try {
    return new RegExp('^' + source + '$', options.ignoreCase ? 'i' : '');
  } catch {
    return new RegExp('^' + escapeRegex(text) + '$', options.ignoreCase ? 'i' : '');
  }
}

function joinVirtualPath(base, name) {
  if (!base || base === '/') return '/' + name;
  return base.replace(/\/+$/, '') + '/' + name;
}

function joinDisplayPath(base, name) {
  if (!base) return name;
  if (base === '/') return '/' + name;
  return base.replace(/\/+$/, '') + '/' + name;
}

function stripTrailingSlashes(value) {
  const text = String(value);
  const trimmed = text.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function baseNameOf(value) {
  const trimmed = stripTrailingSlashes(value);
  if (trimmed === '/') return '/';
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const GREP_SHORT_VALUES = new Set(['e', 'A', 'B', 'C', 'm']);
const GREP_LONG_VALUES = new Set([
  'include', 'exclude', 'exclude-dir', 'after-context', 'before-context',
  'context', 'max-count', 'regexp', 'color', 'colour', 'binary-files',
]);

function grepOptionError(message) {
  return { code: 2, out: '', err: 'grep: ' + message + '\n' };
}

function grepUsageError() {
  return {
    code: 2,
    out: '',
    err: 'Usage: grep [OPTION]... PATTERN [FILE]...\nTry ' + "'grep --help'" + ' for more information.\n',
  };
}

function setGrepContext(kind, value, opts) {
  const number = toInt(value);
  opts.contextGiven = true;
  if (number === null || number < 0) {
    return { code: 2, out: '', err: 'grep: ' + value + ': invalid context length argument\n' };
  }
  if (kind === 'A' || kind === 'C') opts.after = number;
  if (kind === 'B' || kind === 'C') opts.before = number;
  return null;
}

function setGrepMaxCount(value, opts) {
  const number = toInt(value);
  if (number === null) return { code: 2, out: '', err: 'grep: invalid max count\n' };
  opts.maxCount = number < 0 ? null : number;
  return null;
}

function applyGrepShort(ch, value, opts) {
  switch (ch) {
    case 'r': opts.recursive = true; return null;
    case 'R': opts.recursive = true; opts.follow = true; return null;
    case 'i': opts.ignoreCase = true; return null;
    case 'v': opts.invert = true; return null;
    case 'n': opts.lineNumber = true; return null;
    case 'H': opts.withFilename = true; return null;
    case 'h': opts.withFilename = false; return null;
    case 'l': opts.listMode = 'with'; return null;
    case 'L': opts.listMode = 'without'; return null;
    case 'c': opts.count = true; return null;
    case 'o': opts.onlyMatching = true; return null;
    case 'w': opts.word = true; return null;
    case 'x': opts.line = true; return null;
    case 'q': opts.quiet = true; return null;
    case 'a': opts.text = true; return null;
    case 's': opts.noMessages = true; return null;
    case 'I': opts.ignoreBinary = true; return null;
    case 'E': opts.mode = 'ere'; return null;
    case 'F': opts.mode = 'fixed'; return null;
    case 'G': opts.mode = 'bre'; return null;
    case 'P': opts.mode = 'perl'; return null;
    case 'e': opts.patterns.push(value); return null;
    case 'A': case 'B': case 'C': return setGrepContext(ch, value, opts);
    case 'm': return setGrepMaxCount(value, opts);
    default: return grepOptionError("invalid option -- '" + ch + "'");
  }
}

function applyGrepLong(name, value, opts) {
  switch (name) {
    case 'recursive': opts.recursive = true; return null;
    case 'dereference-recursive': opts.recursive = true; opts.follow = true; return null;
    case 'ignore-case': opts.ignoreCase = true; return null;
    case 'invert-match': opts.invert = true; return null;
    case 'line-number': opts.lineNumber = true; return null;
    case 'with-filename': opts.withFilename = true; return null;
    case 'no-filename': opts.withFilename = false; return null;
    case 'files-with-matches': opts.listMode = 'with'; return null;
    case 'files-without-match': opts.listMode = 'without'; return null;
    case 'count': opts.count = true; return null;
    case 'only-matching': opts.onlyMatching = true; return null;
    case 'word-regexp': opts.word = true; return null;
    case 'line-regexp': opts.line = true; return null;
    case 'quiet': case 'silent': opts.quiet = true; return null;
    case 'text': opts.text = true; return null;
    case 'no-messages': opts.noMessages = true; return null;
    case 'extended-regexp': opts.mode = 'ere'; return null;
    case 'fixed-strings': opts.mode = 'fixed'; return null;
    case 'basic-regexp': opts.mode = 'bre'; return null;
    case 'perl-regexp': opts.mode = 'perl'; return null;
    case 'include': opts.include.push(value); return null;
    case 'exclude': opts.exclude.push(value); return null;
    case 'exclude-dir': opts.excludeDir.push(value); return null;
    case 'regexp': opts.patterns.push(value); return null;
    case 'after-context': return setGrepContext('A', value, opts);
    case 'before-context': return setGrepContext('B', value, opts);
    case 'context': return setGrepContext('C', value, opts);
    case 'max-count': return setGrepMaxCount(value, opts);
    // Colour output is never produced by the builtin shell; accept and ignore.
    case 'color': case 'colour': return null;
    case 'line-buffered': return null;
    case 'binary-files':
      if (value === 'text') opts.text = true;
      else if (value === 'without-match') opts.ignoreBinary = true;
      return null;
    default: return grepOptionError("unrecognized option '--" + name + "'");
  }
}

function parseGrepArgs(args) {
  const opts = {
    recursive: false,
    follow: false,
    ignoreCase: false,
    invert: false,
    lineNumber: false,
    withFilename: null,
    listMode: null,
    count: false,
    onlyMatching: false,
    word: false,
    line: false,
    quiet: false,
    text: false,
    ignoreBinary: false,
    noMessages: false,
    after: 0,
    before: 0,
    contextGiven: false,
    maxCount: null,
    mode: 'bre',
    include: [],
    exclude: [],
    excludeDir: [],
    patterns: [],
  };
  const operands = [];
  let stop = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (stop) {
      operands.push(token);
      continue;
    }
    if (token === '--') {
      stop = true;
      continue;
    }
    if (token === '-' || !token.startsWith('-')) {
      operands.push(token);
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      let value = eq < 0 ? null : token.slice(eq + 1);
      if (GREP_LONG_VALUES.has(name) && value === null) {
        const next = args[index + 1];
        if (next === undefined) return { error: grepOptionError('option requires an argument -- ' + name) };
        value = next;
        index += 1;
      }
      const failure = applyGrepLong(name, value, opts);
      if (failure) return { error: failure };
      continue;
    }
    for (let at = 1; at < token.length; at += 1) {
      const ch = token[at];
      let value = null;
      if (GREP_SHORT_VALUES.has(ch)) {
        const rest = token.slice(at + 1);
        if (rest) {
          value = rest;
          at = token.length;
        } else {
          const next = args[index + 1];
          if (next === undefined) return { error: grepOptionError('option requires an argument -- ' + ch) };
          value = next;
          index += 1;
          at = token.length;
        }
      }
      const failure = applyGrepShort(ch, value, opts);
      if (failure) return { error: failure };
    }
  }
  return { opts, operands };
}

/** True when pattern[index] starts a usable interval quantifier. */
function intervalAt(pattern, index) {
  const match = /^\{\d+(,\d*)?\}/.exec(pattern.slice(index));
  return match ? match[0] : null;
}

/** Interval quantifier for BRE, where the closing brace must be escaped. */
function intervalAtBre(pattern, index) {
  const match = /^\{\d+(,\d*)?\\\}/.exec(pattern.slice(index));
  if (!match) return null;
  return { text: match[0].replace('\\}', '}'), length: match[0].length };
}

/**
 * Translate a grep pattern into JavaScript regex source.
 * mode: 'bre' (default), 'ere', 'perl' (treated as ERE), 'fixed'.
 */
function translateRegex(pattern, mode) {
  if (mode === 'fixed') return escapeRegex(pattern);
  const bre = mode === 'bre';
  let out = '';
  let canQuantify = false;
  let lastQuantified = false;
  let atomStart = 0;
  const groups = [];

  // Appends an atom and remembers where it starts, so a following repetition
  // operator can wrap it the way GNU does (a** behaves like (a*)*).
  const atom = (text) => {
    atomStart = out.length;
    out += text;
    canQuantify = true;
    lastQuantified = false;
  };

  const repeat = (text) => {
    if (lastQuantified) {
      out = out.slice(0, atomStart) + '(?:' + out.slice(atomStart) + ')' + text;
    } else {
      out += text;
    }
    canQuantify = true;
    lastQuantified = true;
  };

  const openGroup = () => {
    groups.push(out.length);
    out += '(';
    canQuantify = false;
    lastQuantified = false;
  };

  const closeGroup = () => {
    if (groups.length === 0) return false;
    atomStart = groups.pop();
    out += ')';
    canQuantify = true;
    lastQuantified = false;
    return true;
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (ch === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) throw new Error('trailing backslash');
      index += 1;
      if (bre) {
        if (next === '(') { openGroup(); continue; }
        if (next === ')') { if (!closeGroup()) throw new Error('unmatched )'); continue; }
        if (next === '|') { out += '|'; canQuantify = false; lastQuantified = false; continue; }
        if (next === '+') { if (canQuantify) repeat('+'); else atom('\\+'); continue; }
        if (next === '?') { if (canQuantify) repeat('?'); else atom('\\?'); continue; }
        if (next === '{') {
          const interval = intervalAtBre(pattern, index);
          if (interval) {
            repeat(interval.text);
            index += interval.length - 1;
          } else {
            atom('\\{');
          }
          continue;
        }
        if (next === '}') { atom('\\}'); continue; }
      }
      if (next === '<' || next === '>') { out += '\\b'; canQuantify = false; lastQuantified = false; continue; }
      if (next === 'b' || next === 'B') { out += '\\' + next; canQuantify = false; lastQuantified = false; continue; }
      atom('\\' + next);
      continue;
    }
    if (ch === '[') {
      const cls = readBracketClass(pattern, index, { shellNegation: false });
      if (!cls) throw new Error('invalid bracket expression');
      atom(cls.text);
      index = cls.end;
      continue;
    }
    if (bre) {
      if (ch === '*') {
        if (canQuantify) repeat('*');
        else atom('\\*');
        continue;
      }
      if (ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '+' || ch === '?' || ch === '|') {
        atom('\\' + ch);
        continue;
      }
      atom(ch);
      continue;
    }
    if (ch === '(') { openGroup(); continue; }
    if (ch === ')') {
      if (!closeGroup()) atom('\\)');
      continue;
    }
    if (ch === '|') { out += '|'; canQuantify = false; lastQuantified = false; continue; }
    if (ch === '*' || ch === '+' || ch === '?') {
      if (canQuantify) {
        repeat(ch);
        continue;
      }
      // GNU drops a repetition operator that has nothing to repeat.
      if (out.endsWith('(')) throw new Error('unmatched (');
      continue;
    }
    if (ch === '{') {
      const interval = intervalAt(pattern, index);
      if (interval) {
        if (canQuantify) repeat(interval);
        index += interval.length - 1;
        continue;
      }
      atom('\\{');
      continue;
    }
    atom(ch);
  }
  if (groups.length > 0) throw new Error('unmatched (');
  return out;
}

function buildGrepRegex(patterns, opts) {
  try {
    let source = patterns.map(pattern => translateRegex(pattern, opts.mode)).join('|');
    if (opts.word) source = '(?<![0-9A-Za-z_])(?:' + source + ')(?![0-9A-Za-z_])';
    if (opts.line) source = '^(?:' + source + ')$';
    return { regex: new RegExp(source, opts.ignoreCase ? 'gi' : 'g') };
  } catch (error) {
    return { error: regexErrorMessage(error) };
  }
}

/** Maps translateRegex failures to the diagnostics GNU grep prints. */
function regexErrorMessage(error) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'unmatched (') return 'Unmatched ( or \\(';
  if (message === 'unmatched )') return 'Unmatched ) or \\)';
  if (message === 'trailing backslash') return 'Trailing backslash';
  return 'Invalid regular expression';
}

function grepLineMatches(regex, line, invert) {
  regex.lastIndex = 0;
  const found = regex.test(line);
  return invert ? !found : found;
}

function renderGrepLine(display, usePrefix, showNumber, number, selected, text) {
  const sep = selected ? ':' : '-';
  let prefix = '';
  if (usePrefix) prefix += display + sep;
  if (showNumber) prefix += number + sep;
  return prefix + text;
}

function grepCountLine(display, usePrefix, count) {
  return usePrefix ? display + ':' + count : String(count);
}

function matchesAnyGlob(globs, name) {
  for (const glob of globs) {
    if (compileGlob(glob).test(name)) return true;
  }
  return false;
}

function makeGrepSink(opts) {
  const contextMode = (opts.contextGiven || opts.after > 0 || opts.before > 0) && !opts.count && !opts.listMode;
  return {
    out: [],
    err: [],
    contextMode,
    any: false,
    pending: false,
    emit(record) {
      if (this.pending) {
        this.out.push('--\n');
        this.pending = false;
      }
      this.out.push(record);
      this.any = true;
    },
    beginFile() {
      if (this.contextMode && this.any) this.pending = true;
    },
    text() {
      return this.out.join('');
    },
    errorText() {
      return this.err.join('');
    },
  };
}

function grepPrefix(display, usePrefix, opts, number) {
  let prefix = '';
  if (usePrefix) prefix += display + ':';
  if (opts.lineNumber) prefix += number + ':';
  return prefix;
}

function runGrep(args, ctx) {
  const parsed = parseGrepArgs(args);
  if (parsed.error) return parsed.error;
  const opts = parsed.opts;
  const patterns = opts.patterns.slice();
  const operands = parsed.operands.slice();
  if (patterns.length === 0) {
    if (operands.length === 0) return grepUsageError();
    patterns.push(operands.shift());
  }
  const built = buildGrepRegex(patterns, opts);
  if (built.error) return { code: 2, out: '', err: 'grep: ' + built.error + '\n' };
  const regex = built.regex;
  const fs = ctx.fs;
  const cwd = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : '/';
  const sink = makeGrepSink(opts);
  const state = { matched: false, error: false };

  const quietResult = () => ({ code: 0, out: '', err: sink.errorText() });

  function reportFileError(display, code) {
    state.error = true;
    if (!opts.noMessages) sink.err.push(formatError('grep', display, code));
  }

  function handleTarget(target) {
    let buffer;
    if (target.kind === 'stdin') {
      const input = ctx.stdin;
      if (Buffer.isBuffer(input)) buffer = input;
      else buffer = Buffer.from(typeof input === 'string' ? input : input == null ? '' : String(input), 'utf8');
    } else {
      try {
        buffer = fs.readBuffer(target.vpath, '/', { maxBytes: Infinity });
      } catch (error) {
        reportFileError(target.display, error instanceof ShellError ? error.code : 'EINVAL');
        return null;
      }
    }
    const binary = buffer.includes(0);
    if (binary && opts.ignoreBinary) return null;
    const text = buffer.toString('utf8');
    const lines = splitLines(text);
    if (binary && !opts.text) {
      let hits = 0;
      for (const line of lines) {
        if (grepLineMatches(regex, line, opts.invert)) hits += 1;
      }
      if (opts.maxCount === 0) return null;
      if (hits === 0) {
        if (opts.listMode === 'without') sink.emit(target.display + '\n');
        return null;
      }
      state.matched = true;
      if (opts.quiet) return 'stop';
      if (opts.listMode === 'with') {
        sink.emit(target.display + '\n');
        return null;
      }
      if (opts.listMode === 'without') return null;
      if (opts.count) {
        sink.emit(grepCountLine(target.display, usePrefix, hits) + '\n');
        return null;
      }
      sink.emit('Binary file ' + target.display + ' matches\n');
      return null;
    }
    const total = lines.length;
    const flags = new Array(total);
    for (let index = 0; index < total; index += 1) {
      flags[index] = grepLineMatches(regex, lines[index], opts.invert);
    }
    if (opts.maxCount === 0) return null;
    const display = target.display;
    let count = 0;
    let lastPrinted = 0;
    sink.beginFile();
    for (let index = 0; index < total; index += 1) {
      if (!flags[index]) continue;
      if (opts.maxCount !== null && count >= opts.maxCount) break;
      count += 1;
      if (opts.quiet) {
        state.matched = true;
        return 'stop';
      }
      if (opts.listMode === 'with') {
        state.matched = true;
        sink.emit(display + '\n');
        return null;
      }
      if (opts.count) continue;
      if (opts.listMode === 'without') continue;
      const number = index + 1;
      if (opts.onlyMatching) {
        if (!opts.invert) {
          regex.lastIndex = 0;
          let found = regex.exec(lines[index]);
          while (found !== null) {
            if (found[0] !== '') sink.emit(grepPrefix(display, usePrefix, opts, number) + found[0] + '\n');
            if (found[0] === '') regex.lastIndex += 1;
            found = regex.exec(lines[index]);
          }
        }
        continue;
      }
      if (!sink.contextMode) {
        sink.emit(renderGrepLine(display, usePrefix, opts.lineNumber, number, true, lines[index]) + '\n');
        continue;
      }
      const start = Math.max(1, number - opts.before);
      if (lastPrinted && start > lastPrinted + 1) sink.emit('--\n');
      const from = Math.max(start, lastPrinted + 1);
      for (let at = from; at < number; at += 1) {
        sink.emit(renderGrepLine(display, usePrefix, opts.lineNumber, at, false, lines[at - 1]) + '\n');
      }
      sink.emit(renderGrepLine(display, usePrefix, opts.lineNumber, number, true, lines[index]) + '\n');
      lastPrinted = number;
      const end = Math.min(total, number + opts.after);
      let at = number + 1;
      for (; at <= end; at += 1) {
        if (flags[at - 1]) break;
        sink.emit(renderGrepLine(display, usePrefix, opts.lineNumber, at, false, lines[at - 1]) + '\n');
      }
      if (at - 1 > lastPrinted) lastPrinted = at - 1;
    }
    if (count > 0) state.matched = true;
    if (opts.listMode === 'without') {
      if (count === 0) sink.emit(display + '\n');
      return null;
    }
    if (opts.count) {
      sink.emit(grepCountLine(display, usePrefix, count) + '\n');
      return null;
    }
    return null;
  }

  function walkDir(vpath, display) {
    let entries;
    try {
      entries = fs.readdir(vpath, '/');
    } catch (error) {
      reportFileError(display, error instanceof ShellError ? error.code : 'EINVAL');
      return null;
    }
    for (const entry of entries) {
      const childVpath = joinVirtualPath(vpath, entry.name);
      const childDisplay = joinDisplayPath(display, entry.name);
      if (entry.isDir) {
        if (entry.name === '.git') continue;
        if (matchesAnyGlob(opts.excludeDir, entry.name)) continue;
        const stop = walkDir(childVpath, childDisplay);
        if (stop) return stop;
        continue;
      }
      if (entry.isSymlink) {
        if (!opts.follow) continue;
        let info;
        try {
          info = fs.stat(childVpath, '/');
        } catch {
          continue;
        }
        if (info.isDir) {
          if (entry.name === '.git' || matchesAnyGlob(opts.excludeDir, entry.name)) continue;
          const stop = walkDir(childVpath, childDisplay);
          if (stop) return stop;
          continue;
        }
        if (!info.isFile) continue;
      } else if (!entry.isFile) {
        continue;
      }
      if (opts.include.length && !matchesAnyGlob(opts.include, entry.name)) continue;
      if (matchesAnyGlob(opts.exclude, entry.name)) continue;
      const stop = handleTarget({ kind: 'file', vpath: childVpath, display: childDisplay });
      if (stop) return stop;
    }
    return null;
  }

  let hasDirOperand = false;
  if (opts.recursive) {
    for (const operand of operands) {
      if (operand === '-') continue;
      try {
        if (fs.stat(operand, cwd).isDir) hasDirOperand = true;
      } catch {
        // A missing operand is reported when it is visited.
      }
    }
  }
  let usePrefix;
  if (opts.withFilename !== null) usePrefix = opts.withFilename;
  else if (opts.recursive) usePrefix = operands.length !== 1 || hasDirOperand;
  else usePrefix = operands.length > 1;

  if (opts.recursive) {
    if (operands.length === 0) {
      const stop = walkDir(cwd, '');
      if (stop) return quietResult();
    } else {
      for (const operand of operands) {
        if (operand === '-') {
          const stop = handleTarget({ kind: 'stdin', display: '(standard input)' });
          if (stop) return quietResult();
          continue;
        }
        let info;
        try {
          info = fs.stat(operand, cwd);
        } catch (error) {
          reportFileError(operand, error instanceof ShellError ? error.code : 'EINVAL');
          continue;
        }
        if (info.isDir) {
          const base = stripTrailingSlashes(operand);
          const stop = walkDir(fs.vpath(operand, cwd), base);
          if (stop) return quietResult();
          continue;
        }
        const stop = handleTarget({ kind: 'file', vpath: fs.vpath(operand, cwd), display: operand });
        if (stop) return quietResult();
      }
    }
  } else if (operands.length === 0) {
    const stop = handleTarget({ kind: 'stdin', display: '(standard input)' });
    if (stop) return quietResult();
  } else {
    for (const operand of operands) {
      if (operand === '-') {
        const stop = handleTarget({ kind: 'stdin', display: '(standard input)' });
        if (stop) return quietResult();
        continue;
      }
      const stop = handleTarget({ kind: 'file', vpath: fs.vpath(operand, cwd), display: operand });
      if (stop) return quietResult();
    }
  }

  if (opts.quiet) {
    return { code: state.matched ? 0 : state.error ? 2 : 1, out: '', err: sink.errorText() };
  }
  if (state.error) return { code: 2, out: sink.text(), err: sink.errorText() };
  return { code: state.matched ? 0 : 1, out: sink.text(), err: sink.errorText() };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

const TICK = String.fromCharCode(96);

class FindParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FindParseError';
  }
}

function findQuoted(token) {
  return TICK + token + "'";
}

function findPathError(vpath, code) {
  return 'find: ' + "'" + vpath + "'" + ': ' + (ERRNO_TEXT[code] ?? code) + '\n';
}

const FIND_SIZE_UNITS = new Map([
  ['b', 512],
  ['c', 1],
  ['w', 2],
  ['k', 1024],
  ['M', 1024 * 1024],
  ['G', 1024 * 1024 * 1024],
]);

function findSizeTest(spec) {
  const match = /^([+-]?)(\d+)([bcwkMG]?)$/.exec(spec);
  if (!match) throw new FindParseError('find: Invalid argument ' + findQuoted(spec) + ' to -size');
  const unit = FIND_SIZE_UNITS.get(match[3] || 'b');
  const amount = Number(match[2]);
  const kind = match[1];
  return function sizeTest(entry) {
    const blocks = Math.ceil(entry.size / unit);
    if (kind === '+') return blocks > amount;
    if (kind === '-') return blocks < amount;
    return blocks === amount;
  };
}

function findTypeTest(value) {
  const kind = String(value);
  if (!/^[bcdflps]$/.test(kind)) {
    throw new FindParseError('find: Unknown argument to -type: ' + kind);
  }
  if (kind === 'f') return entry => entry.isFile && !entry.isSymlink;
  if (kind === 'd') return entry => entry.isDir;
  if (kind === 'l') return entry => entry.isSymlink;
  return () => false;
}

function parseFindDepth(tokens, state, name) {
  const value = tokens[state.index];
  if (value === undefined) throw new FindParseError('find: missing argument to ' + findQuoted(name));
  state.index += 1;
  const number = toInt(value);
  if (number === null || number < 0) {
    throw new FindParseError('find: Expected a non-negative decimal integer argument to ' + name + ', but got ' + findQuoted(value));
  }
  return number;
}

function parseFindPrimary(tokens, state) {
  const token = tokens[state.index];
  if (token === '-print') {
    state.index += 1;
    return { type: 'print', zero: false };
  }
  if (token === '-print0') {
    state.index += 1;
    return { type: 'print', zero: true };
  }
  if (token === '-maxdepth') {
    state.index += 1;
    state.maxDepth = parseFindDepth(tokens, state, '-maxdepth');
    return { type: 'test', test: () => true };
  }
  if (token === '-mindepth') {
    state.index += 1;
    state.minDepth = parseFindDepth(tokens, state, '-mindepth');
    return { type: 'test', test: () => true };
  }
  if (token === '-empty') {
    state.index += 1;
    return {
      type: 'test',
      test: entry => {
        if (entry.isDir) {
          try {
            return entry.fs.readdir(entry.vpath, '/').length === 0;
          } catch {
            return false;
          }
        }
        return entry.isFile && entry.size === 0;
      },
    };
  }
  if (token === '-name' || token === '-iname' || token === '-path') {
    state.index += 1;
    const value = tokens[state.index];
    if (value === undefined) throw new FindParseError('find: missing argument to ' + findQuoted(token));
    state.index += 1;
    if (token === '-path') {
      const glob = compileGlob(value, { pathMode: true });
      return { type: 'test', test: entry => glob.test(entry.display) };
    }
    const glob = compileGlob(value, { ignoreCase: token === '-iname' });
    return { type: 'test', test: entry => glob.test(entry.name) };
  }
  if (token === '-type') {
    state.index += 1;
    const value = tokens[state.index];
    if (value === undefined) throw new FindParseError('find: missing argument to ' + findQuoted(token));
    state.index += 1;
    const test = findTypeTest(value);
    return { type: 'test', test };
  }
  if (token === '-size') {
    state.index += 1;
    const value = tokens[state.index];
    if (value === undefined) throw new FindParseError('find: missing argument to ' + findQuoted(token));
    state.index += 1;
    const test = findSizeTest(value);
    return { type: 'test', test };
  }
  if (token === '-newer') {
    state.index += 1;
    const value = tokens[state.index];
    if (value === undefined) throw new FindParseError('find: missing argument to ' + findQuoted(token));
    state.index += 1;
    let info;
    try {
      info = state.fs.stat(value, state.cwd);
    } catch (error) {
      const code = error instanceof ShellError ? error.code : 'ENOENT';
      throw new FindParseError(findPathError(value, code).replace(/\n$/, ''));
    }
    const threshold = info.mtimeMs;
    return { type: 'test', test: entry => entry.mtimeMs > threshold };
  }
  if (token === '-exec' || token === '-execdir' || token === '-ok' || token === '-okdir') {
    throw new FindParseError('find: unknown predicate ' + findQuoted(token));
  }
  if (typeof token === 'string' && token.startsWith('-')) {
    throw new FindParseError('find: unknown predicate ' + findQuoted(token));
  }
  throw new FindParseError('find: paths must precede expression: ' + findQuoted(String(token)));
}

function parseFindUnary(tokens, state) {
  const token = tokens[state.index];
  if (token === '!' || token === '-not') {
    state.index += 1;
    return { type: 'not', child: parseFindUnary(tokens, state) };
  }
  if (token === '(') {
    state.index += 1;
    const node = parseFindOr(tokens, state);
    if (tokens[state.index] !== ')') {
      throw new FindParseError("find: invalid expression; I was expecting to find a ')' somewhere but did not see one.");
    }
    state.index += 1;
    return node;
  }
  return parseFindPrimary(tokens, state);
}

function parseFindAnd(tokens, state) {
  let left = parseFindUnary(tokens, state);
  while (state.index < tokens.length) {
    const token = tokens[state.index];
    if (token === '-o' || token === '-or' || token === ')') break;
    if (token === '-a' || token === '-and') {
      state.index += 1;
    }
    const right = parseFindUnary(tokens, state);
    left = { type: 'and', left, right };
  }
  return left;
}

function parseFindOr(tokens, state) {
  let left = parseFindAnd(tokens, state);
  while (state.index < tokens.length) {
    const token = tokens[state.index];
    if (token !== '-o' && token !== '-or') break;
    state.index += 1;
    const right = parseFindAnd(tokens, state);
    left = { type: 'or', left, right };
  }
  return left;
}

function findHasAction(node) {
  if (!node) return false;
  if (node.type === 'print') return true;
  if (node.type === 'and' || node.type === 'or') return findHasAction(node.left) || findHasAction(node.right);
  if (node.type === 'not') return findHasAction(node.child);
  return false;
}

function evaluateFind(node, entry) {
  if (!node) return true;
  if (node.type === 'and') {
    if (!evaluateFind(node.left, entry)) return false;
    return evaluateFind(node.right, entry);
  }
  if (node.type === 'or') {
    if (evaluateFind(node.left, entry)) return true;
    return evaluateFind(node.right, entry);
  }
  if (node.type === 'not') return !evaluateFind(node.child, entry);
  if (node.type === 'print') {
    entry.out.push(node.zero ? entry.display + '\u0000' : entry.display + '\n');
    return true;
  }
  return Boolean(node.test(entry));
}

function runFind(args, ctx) {
  const fs = ctx.fs;
  const cwd = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : '/';
  const paths = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (typeof token === 'string' && (token.startsWith('-') || token === '!' || token === '(')) break;
    paths.push(token);
    index += 1;
  }
  if (paths.length === 0) paths.push('.');
  const state = { index: 0, fs, cwd, maxDepth: Infinity, minDepth: 0 };
  const tokens = args.slice(index);
  let expression = null;
  if (tokens.length) {
    try {
      expression = parseFindOr(tokens, state);
      if (state.index < tokens.length) {
        const token = tokens[state.index];
        if (typeof token === 'string' && !token.startsWith('-') && token !== ')') {
          throw new FindParseError('find: paths must precede expression: ' + findQuoted(token));
        }
        throw new FindParseError('find: unknown predicate ' + findQuoted(String(token)));
      }
    } catch (error) {
      if (!(error instanceof FindParseError)) throw error;
      return { code: 1, out: '', err: error.message + '\n' };
    }
  }
  if (!findHasAction(expression)) {
    const print = { type: 'print', zero: false };
    expression = expression ? { type: 'and', left: expression, right: print } : print;
  }
  const out = [];
  const err = [];
  let failed = false;

  function visit(vpath, display, depth) {
    let info;
    try {
      info = fs.lstat(vpath, '/');
    } catch (error) {
      failed = true;
      err.push(findPathError(display, error instanceof ShellError ? error.code : 'EINVAL'));
      return;
    }
    const entry = {
      fs,
      out,
      vpath,
      display,
      name: baseNameOf(display),
      depth,
      isDir: info.isDir,
      isFile: info.isFile,
      isSymlink: info.isSymlink,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
    if (depth >= state.minDepth) evaluateFind(expression, entry);
    if (!info.isDir || depth >= state.maxDepth) return;
    let entries;
    try {
      entries = fs.readdir(vpath, '/');
    } catch (error) {
      failed = true;
      err.push(findPathError(display, error instanceof ShellError ? error.code : 'EINVAL'));
      return;
    }
    const base = stripTrailingSlashes(display);
    for (const child of entries) {
      visit(joinVirtualPath(vpath, child.name), joinDisplayPath(base, child.name), depth + 1);
    }
  }

  for (const operand of paths) {
    let vpath;
    try {
      vpath = fs.vpath(operand, cwd);
      fs.lstat(vpath, '/');
    } catch (error) {
      failed = true;
      err.push(findPathError(operand, error instanceof ShellError ? error.code : 'ENOENT'));
      continue;
    }
    visit(vpath, operand, 0);
  }
  return { code: failed ? 1 : 0, out: out.join(''), err: err.join('') };
}

// ---------------------------------------------------------------------------
// xargs
// ---------------------------------------------------------------------------

const XARGS_SHORT_VALUES = new Set(['n', 'I', 'd', 'L', 'P', 's', 'E', 'a']);
const XARGS_LONG_VALUES = new Set([
  'max-args', 'replace', 'delimiter', 'max-lines', 'max-procs', 'max-chars',
  'eof', 'arg-file',
]);

function xargsOptionError(message) {
  return { code: 1, out: '', err: 'xargs: ' + message + '\n' };
}

function decodeDelimiter(spec) {
  const text = String(spec);
  if (text.length === 1) return text;
  if (text[0] !== '\\') return text[0];
  const body = text.slice(1);
  const simple = { n: '\n', t: '\t', r: '\r', '0': '\u0000', '\\': '\\', a: '\u0007', b: '\b', f: '\f', v: '\v' };
  if (Object.prototype.hasOwnProperty.call(simple, body)) return simple[body];
  if (/^[0-7]{1,3}$/.test(body)) return String.fromCharCode(parseInt(body, 8));
  return body[0] ?? '';
}

/** Default xargs tokenizer: blanks separate, quotes and backslashes are special. */
function tokenizeXargs(text) {
  const items = [];
  let current = '';
  let started = false;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (escaped) {
      current += ch;
      started = true;
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === '\\') {
        escaped = true;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (started) {
        items.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote === "'") return { error: "unmatched single quote; by default quotes are special to xargs unless you use the -0 option" };
  if (quote === '"') return { error: "unmatched double quote; by default quotes are special to xargs unless you use the -0 option" };
  if (escaped) current += '\\';
  if (started) items.push(current);
  return { items };
}

/** Quote/backslash processing for -I replacement lines. */
function expandXargsLine(line) {
  let out = '';
  let index = 0;
  while (index < line.length) {
    const ch = line[index];
    if (ch === '\\') {
      const next = line[index + 1];
      if (next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      out += '\\';
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = line.indexOf(ch, index + 1);
      if (end > 0) {
        out += line.slice(index + 1, end);
        index = end + 1;
        continue;
      }
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

function splitXargsItems(input, opts) {
  if (opts.delim !== null) {
    const delim = opts.delim;
    let text = input;
    if (text.endsWith(delim)) text = text.slice(0, -delim.length);
    if (text === '') return { items: [] };
    return { items: text.split(delim) };
  }
  if (opts.replace !== null) {
    const lines = input.split('\n');
    const items = [];
    for (const raw of lines) {
      const line = raw.replace(/^[ \t]+/, '');
      if (line === '') continue;
      items.push(expandXargsLine(line));
    }
    return { items };
  }
  if (opts.maxLines !== null) {
    const lines = input.split('\n').filter(line => line.trim() !== '');
    const groups = [];
    for (let index = 0; index < lines.length; index += opts.maxLines) {
      groups.push(lines.slice(index, index + opts.maxLines).join(' '));
    }
    const items = [];
    for (const group of groups) {
      const parsed = tokenizeXargs(group);
      if (parsed.error) return { error: parsed.error };
      items.push({ line: true, tokens: parsed.items });
    }
    return { items, lineGroups: true };
  }
  return tokenizeXargs(input);
}

function parseXargsArgs(args) {
  const opts = {
    delim: null,
    replace: null,
    maxArgs: null,
    maxLines: null,
    noRunIfEmpty: false,
    trace: false,
  };
  let index = 0;
  let stop = false;
  while (index < args.length) {
    const token = args[index];
    if (stop || token === '-' || !token.startsWith('-')) break;
    if (token === '--') {
      stop = true;
      index += 1;
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      let value = eq < 0 ? null : token.slice(eq + 1);
      if (name === 'null') { opts.delim = '\u0000'; index += 1; continue; }
      if (name === 'no-run-if-empty') { opts.noRunIfEmpty = true; index += 1; continue; }
      if (name === 'verbose') { opts.trace = true; index += 1; continue; }
      if (name === 'replace') {
        opts.replace = value === null ? '{}' : value;
        index += 1;
        continue;
      }
      if (!XARGS_LONG_VALUES.has(name)) return { error: xargsOptionError("unrecognized option '--" + name + "'") };
      if (value === null) {
        const next = args[index + 1];
        if (next === undefined) return { error: xargsOptionError('option requires an argument -- ' + name) };
        value = next;
        index += 1;
      }
      const applied = applyXargsLong(name, value, opts);
      if (applied) return { error: applied };
      index += 1;
      continue;
    }
    let consumed = false;
    for (let at = 1; at < token.length; at += 1) {
      const ch = token[at];
      let value = null;
      if (XARGS_SHORT_VALUES.has(ch)) {
        const rest = token.slice(at + 1);
        if (rest) {
          value = rest;
        } else {
          const next = args[index + 1];
          if (next === undefined) return { error: xargsOptionError('option requires an argument -- ' + ch) };
          value = next;
          consumed = true;
        }
      }
      const applied = applyXargsShort(ch, value, opts);
      if (applied) return { error: applied };
      if (value !== null) {
        at = token.length;
      }
    }
    index += consumed ? 2 : 1;
  }
  const command = index < args.length ? args[index] : 'echo';
  const fixed = index < args.length ? args.slice(index + 1) : [];
  return { opts, command, fixed };
}

function applyXargsShort(ch, value, opts) {
  switch (ch) {
    case '0': opts.delim = '\u0000'; return null;
    case 'r': opts.noRunIfEmpty = true; return null;
    case 't': opts.trace = true; return null;
    case 'n': {
      const number = toInt(value);
      if (number === null || number < 1) return xargsOptionError('value ' + value + ' for -n option should be >= 1');
      opts.maxArgs = number;
      return null;
    }
    case 'L': {
      const number = toInt(value);
      if (number === null || number < 1) return xargsOptionError('value ' + value + ' for -L option should be >= 1');
      opts.maxLines = number;
      return null;
    }
    case 'I': opts.replace = value; return null;
    case 'd': opts.delim = decodeDelimiter(value); return null;
    case 'P': case 's': case 'E': case 'a': return null;
    default: return xargsOptionError("invalid option -- '" + ch + "'");
  }
}

function applyXargsLong(name, value, opts) {
  switch (name) {
    case 'max-args': {
      const number = toInt(value);
      if (number === null || number < 1) return xargsOptionError('value ' + value + ' for -n option should be >= 1');
      opts.maxArgs = number;
      return null;
    }
    case 'max-lines': {
      const number = toInt(value);
      if (number === null || number < 1) return xargsOptionError('value ' + value + ' for -L option should be >= 1');
      opts.maxLines = number;
      return null;
    }
    case 'delimiter': opts.delim = decodeDelimiter(value); return null;
    case 'replace': opts.replace = value; return null;
    case 'max-procs': case 'max-chars': case 'eof': case 'arg-file': return null;
    default: return xargsOptionError("unrecognized option '--" + name + "'");
  }
}

function runXargs(args, ctx) {
  const parsed = parseXargsArgs(args);
  if (parsed.error) return parsed.error;
  const opts = parsed.opts;
  const command = parsed.command;
  const fixed = parsed.fixed;
  const input = typeof ctx.stdin === 'string' ? ctx.stdin : ctx.stdin == null ? '' : String(ctx.stdin);
  const split = splitXargsItems(input, opts);
  if (split.error) return xargsOptionError(split.error);
  const out = [];
  const err = [];
  let status = 0;

  function execute(argv) {
    const line = [command].concat(argv);
    if (opts.trace) err.push(line.join(' ') + '\n');
    if (typeof ctx.runCommand === 'function') {
      let result;
      try {
        result = ctx.runCommand(command, argv, '');
      } catch {
        return 126;
      }
      const code = result && typeof result.code === 'number' ? result.code : 0;
      if (result && typeof result.out === 'string' && result.out !== '') out.push(result.out);
      if (result && typeof result.err === 'string' && result.err !== '') err.push(result.err);
      if (code === 255) {
        err.push('xargs: ' + command + ': exited with status 255; aborting\n');
        return 124;
      }
      if (code === 126 || code === 127) return code;
      return code === 0 ? 0 : 123;
    }
    out.push(line.join(' ') + '\n');
    return 0;
  }

  if (opts.replace !== null) {
    if (split.items.length === 0) {
      if (!opts.noRunIfEmpty) {
        // Replacement mode has nothing to substitute; nothing runs.
      }
      return { code: 0, out: '', err: '' };
    }
    for (const item of split.items) {
      const argv = fixed.map(part => part.split(opts.replace).join(item));
      const code = execute(argv);
      if (code === 124) return { code: 124, out: out.join(''), err: err.join('') };
      if (code !== 0 && status === 0) status = code;
    }
    return { code: status, out: out.join(''), err: err.join('') };
  }

  const batches = [];
  if (opts.maxLines !== null && split.lineGroups) {
    for (const group of split.items) {
      if (opts.maxArgs === null) {
        batches.push(group.tokens);
        continue;
      }
      for (let at = 0; at < group.tokens.length; at += opts.maxArgs) {
        batches.push(group.tokens.slice(at, at + opts.maxArgs));
      }
    }
  } else {
    const limit = opts.maxArgs === null ? Infinity : opts.maxArgs;
    for (let at = 0; at < split.items.length; at += limit) {
      batches.push(split.items.slice(at, at + limit));
    }
  }
  if (batches.length === 0 && !opts.noRunIfEmpty) batches.push([]);
  for (const batch of batches) {
    const code = execute(fixed.concat(batch));
    if (code === 124) return { code: 124, out: out.join(''), err: err.join('') };
    if (code !== 0 && status === 0) status = code;
  }
  return { code: status, out: out.join(''), err: err.join('') };
}