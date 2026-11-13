// Text coreutils: cat, head, tail, wc, cut, tr, tee, nl, tac, paste.
// Every command is synchronous: it reads ctx.stdin / ctx.fs and returns { code, out, err }.

import { ERRNO_TEXT, ShellError } from '../fs.mjs';
import {
  fail,
  formatError,
  loop,
  parseOptions,
  parseRanges,
  toInt,
  usageError,
  writeOut,
} from '../io.mjs';

export const names = ['cat', 'head', 'tail', 'wc', 'cut', 'tr', 'tee', 'nl', 'tac', 'paste'];

const CHUNK = 1024;
const EMPTY_VALUE = '\u0001';
const BACKTICK = String.fromCharCode(0x60);
const DIGITS = '0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LETTERS = LOWER + UPPER;
const PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_' + BACKTICK + '{|}~';
const PRINTABLE = ' ' + PUNCT + DIGITS + LETTERS;
const CONTROL = String.fromCharCode(...Array.from({ length: 32 }, (unused, index) => index)) + '\u007f';

export function main(prog, argv, ctx) {
  const args = argv.slice();
  if (args.length && args[0] === prog) args.shift();
  const name = prog.slice(prog.lastIndexOf('/') + 1);
  switch (name) {
    case 'cat': return runCat(prog, args, ctx);
    case 'head': return runHeadLike(prog, args, ctx, false);
    case 'tail': return runHeadLike(prog, args, ctx, true);
    case 'wc': return runWc(prog, args, ctx);
    case 'cut': return runCut(prog, args, ctx);
    case 'tr': return runTr(prog, args, ctx);
    case 'tee': return runTee(prog, args, ctx);
    case 'nl': return runNl(prog, args, ctx);
    case 'tac': return runTac(prog, args, ctx);
    case 'paste': return runPaste(prog, args, ctx);
    default: return usageError(prog, "unsupported command '" + name + "'");
  }
}

// ---------------------------------------------------------------- shared bits

function finish(code, out, err) {
  return code === 0 ? writeOut(out) : { code, out, err };
}

/** Read one operand; '-' means stdin. Throws ShellError. */
function readOperand(ctx, path) {
  if (path === '-') return ctx.stdin ?? '';
  return ctx.fs.readText(path, ctx.cwd);
}

/** Split text into records that keep their trailing newline. */
function splitRecords(text) {
  const records = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      records.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) records.push(text.slice(start));
  return records;
}

/** Split text into lines without terminators; CR bytes stay in the content. */
function lineParts(text) {
  if (!text) return [];
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function displayName(path) {
  return path === '-' ? 'standard input' : path;
}

/** GNU-style "cannot open 'x' for reading" wording used by head/tail. */
function openError(prog, path, error) {
  const text = ERRNO_TEXT[error.code] ?? error.code;
  if (error.code === 'EISDIR') return prog + ": error reading '" + path + "': " + text + '\n';
  return prog + ": cannot open '" + path + "' for reading: " + text + '\n';
}

/**
 * parseOptions rejects an empty option argument, but nl -s '' and cut -d '' are legal.
 * Hide empty values behind a sentinel so the shared parser accepts them.
 */
function parseCommandOptions(args, defs, valueChars) {
  let patched = args;
  if (valueChars) {
    patched = args.slice();
    for (let i = 0; i < patched.length - 1; i++) {
      const token = patched[i];
      if (patched[i + 1] !== '' || token.length < 2 || token === '--') continue;
      if (token.startsWith('--')) continue;
      if (valueChars.includes(token[token.length - 1])) patched[i + 1] = EMPTY_VALUE;
    }
  }
  const parsed = parseOptions(patched, defs);
  if (parsed.error) return parsed;
  for (const [key, value] of parsed.opts) {
    if (value === EMPTY_VALUE) parsed.opts.set(key, '');
  }
  return parsed;
}

function firstValue(opts, keys) {
  for (const key of keys) if (opts.has(key)) return opts.get(key);
  return null;
}

// ----------------------------------------------------------------------- cat

const CAT_DEFS = {
  A: 'bool',
  b: 'bool',
  E: 'bool',
  n: 'bool',
  s: 'bool',
  T: 'bool',
  v: 'bool',
  'show-all': 'bool',
  'number-nonblank': 'bool',
  'show-ends': 'bool',
  number: 'bool',
  'squeeze-blank': 'bool',
  'show-tabs': 'bool',
  'show-nonprinting': 'bool',
};

/** One byte rendered the way cat -v does it. */
function escapeByte(byte, showTabs) {
  if (byte === 0x09) return showTabs ? '^I' : '\t';
  if (byte === 0x0a) return '\n';
  if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
  if (byte === 0x7f) return '^?';
  if (byte < 0x20) return '^' + String.fromCharCode(byte + 64);
  const low = byte - 0x80;
  if (low === 0x7f) return 'M-^?';
  if (low < 0x20) return 'M-^' + String.fromCharCode(low + 64);
  return 'M-' + String.fromCharCode(low);
}

/** Escape one code point through its UTF-8 bytes, matching cat -v byte-wise output. */
function escapeChar(text, showTabs) {
  const code = text.codePointAt(0);
  if (code < 0x80) return escapeByte(code, showTabs);
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) out += escapeByte(byte, showTabs);
  return out;
}

function escapeText(text, showTabs) {
  let out = '';
  for (const char of text) out += escapeChar(char, showTabs);
  return out;
}

function runCat(prog, args, ctx) {
  const parsed = parseOptions(args, CAT_DEFS);
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  const showAll = opts.has('A') || opts.has('show-all');
  const numbering = opts.has('n') || opts.has('number');
  const numberingNonBlank = opts.has('b') || opts.has('number-nonblank');
  const squeeze = opts.has('s') || opts.has('squeeze-blank');
  const showEnds = opts.has('E') || opts.has('show-ends') || showAll;
  const showTabs = opts.has('T') || opts.has('show-tabs') || showAll;
  const showNonPrinting = opts.has('v') || opts.has('show-nonprinting') || showAll;
  const sources = parsed.args.length ? parsed.args : ['-'];
  let out = '';
  let err = '';
  let counter = 0;
  let previousBlank = false;
  for (const path of sources) {
    let text;
    try {
      text = readOperand(ctx, path);
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      err += formatError(prog, path, error.code);
      continue;
    }
    loop(ctx, splitRecords(text), CHUNK, record => {
      const terminated = record.endsWith('\n');
      const body = terminated ? record.slice(0, -1) : record;
      const blank = body === '';
      if (squeeze) {
        if (blank && previousBlank) return;
        previousBlank = blank;
      }
      let line = body;
      if (showNonPrinting) line = escapeText(body, showTabs);
      else if (showTabs) line = line.split('\t').join('^I');
      if (showEnds && terminated) line += '$';
      const numbered = numberingNonBlank ? !blank : numbering;
      if (numbered) {
        counter += 1;
        out += String(counter).padStart(6, ' ') + '\t';
      }
      out += line;
      if (terminated) out += '\n';
    });
  }
  return finish(err ? 1 : 0, out, err);
}

// ---------------------------------------------------------------- head / tail

const COUNT_LONG = { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v' };

function parseCountArgs(args) {
  const state = { mode: null, value: null, quiet: false, verbose: false, files: [] };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--') {
      for (let j = i + 1; j < args.length; j++) state.files.push(args[j]);
      break;
    }
    if (token === '-' || !token.startsWith('-')) {
      state.files.push(token);
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      const short = COUNT_LONG[name];
      if (!short) return { error: "unrecognized option '--" + name + "'" };
      if (short === 'q' || short === 'v') {
        if (eq >= 0) return { error: "option '--" + name + "' doesn't allow an argument" };
        if (short === 'q') state.quiet = true; else state.verbose = true;
        continue;
      }
      let value;
      if (eq >= 0) value = token.slice(eq + 1);
      else {
        value = args[i + 1];
        if (value === undefined) return { error: "option '--" + name + "' requires an argument" };
        i += 1;
      }
      state.mode = short;
      state.value = value;
      continue;
    }
    let j = 1;
    let done = false;
    while (j < token.length && !done) {
      const char = token[j];
      if (char === 'q') { state.quiet = true; j += 1; continue; }
      if (char === 'v') { state.verbose = true; j += 1; continue; }
      if (char === 'n' || char === 'c') {
        let value = token.slice(j + 1);
        if (!value) {
          value = args[i + 1];
          if (value === undefined) return { error: "option requires an argument -- '" + char + "'" };
          i += 1;
        }
        state.mode = char;
        state.value = value;
        done = true;
        j = token.length;
        continue;
      }
      if (char >= '0' && char <= '9') {
        const digits = token.slice(j);
        if (!/^\d+$/.test(digits)) return { error: "invalid option -- '" + char + "'" };
        state.mode = 'n';
        state.value = digits;
        done = true;
        j = token.length;
        continue;
      }
      return { error: "invalid option -- '" + char + "'" };
    }
  }
  return { state };
}

function parseCountValue(kind, value) {
  const what = kind === 'c' ? 'bytes' : 'lines';
  const text = value === null ? '10' : String(value).trim();
  const match = /^([+-]?)(\d+)$/.exec(text);
  if (!match) return { error: 'invalid number of ' + what + ": '" + text + "'" };
  return { plus: match[1] === '+', minus: match[1] === '-', magnitude: Number(match[2]), what };
}

function headSlice(text, count, kind) {
  if (kind === 'c') {
    const bytes = Buffer.from(text, 'utf8');
    const limit = count.minus ? Math.max(0, bytes.length - count.magnitude) : count.magnitude;
    return bytes.subarray(0, Math.min(limit, bytes.length)).toString('utf8');
  }
  const records = splitRecords(text);
  const limit = count.minus ? Math.max(0, records.length - count.magnitude) : count.magnitude;
  return records.slice(0, limit).join('');
}

function tailSlice(text, count, kind) {
  if (kind === 'c') {
    const bytes = Buffer.from(text, 'utf8');
    const start = count.plus ? Math.max(0, count.magnitude - 1) : Math.max(0, bytes.length - count.magnitude);
    return bytes.subarray(start).toString('utf8');
  }
  const records = splitRecords(text);
  const start = count.plus ? Math.max(0, count.magnitude - 1) : Math.max(0, records.length - count.magnitude);
  return records.slice(start).join('');
}

function runHeadLike(prog, args, ctx, fromEnd) {
  const parsed = parseCountArgs(args);
  if (parsed.error) return usageError(prog, parsed.error);
  const state = parsed.state;
  const kind = state.mode ?? 'n';
  const count = parseCountValue(kind, state.value);
  if (count.error) return fail(prog, count.error, 1);
  const sources = state.files.length ? state.files : ['-'];
  const headers = state.verbose || (sources.length > 1 && !state.quiet);
  let out = '';
  let err = '';
  let first = true;
  for (const path of sources) {
    let text;
    try {
      text = readOperand(ctx, path);
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      err += openError(prog, path, error);
      continue;
    }
    if (headers) {
      if (!first) out += '\n';
      first = false;
      out += '==> ' + displayName(path) + ' <==\n';
    }
    out += fromEnd ? tailSlice(text, count, kind) : headSlice(text, count, kind);
  }
  return finish(err ? 1 : 0, out, err);
}

// ------------------------------------------------------------------------ wc

const WC_DEFS = {
  l: 'bool',
  w: 'bool',
  c: 'bool',
  m: 'bool',
  L: 'bool',
  lines: 'bool',
  words: 'bool',
  bytes: 'bool',
  chars: 'bool',
  'max-line-length': 'bool',
};

function maxLineWidth(text) {
  const lines = lineParts(text);
  let best = 0;
  for (const line of lines) {
    let column = 0;
    for (const char of line) {
      const code = char.codePointAt(0);
      if (code === 0x09) column += 8 - (column % 8);
      else if (code === 0x0d) column = 0;
      else if (code < 0x20 || code === 0x7f) continue;
      else column += 1;
    }
    if (column > best) best = column;
  }
  return best;
}

function countText(text, flags) {
  const counts = new Map();
  for (const flag of flags) {
    if (flag === 'lines') {
      let total = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) total += 1;
      counts.set(flag, total);
    } else if (flag === 'words') {
      counts.set(flag, text.split(/[ \t\n\v\f\r]+/).filter(Boolean).length);
    } else if (flag === 'chars') {
      counts.set(flag, [...text].length);
    } else if (flag === 'bytes') {
      counts.set(flag, Buffer.byteLength(text, 'utf8'));
    } else {
      counts.set(flag, maxLineWidth(text));
    }
  }
  return counts;
}

function runWc(prog, args, ctx) {
  const parsed = parseOptions(args, WC_DEFS);
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  let flags = [];
  if (opts.has('l') || opts.has('lines')) flags.push('lines');
  if (opts.has('w') || opts.has('words')) flags.push('words');
  if (opts.has('m') || opts.has('chars')) flags.push('chars');
  if (opts.has('c') || opts.has('bytes')) flags.push('bytes');
  if (opts.has('L') || opts.has('max-line-length')) flags.push('max');
  if (!flags.length) flags = ['lines', 'words', 'bytes'];
  const operands = parsed.args;
  const fromStdin = operands.length === 0;
  const sources = fromStdin ? ['-'] : operands;
  let totalBytes = 0;
  let irregular = fromStdin;
  for (const path of sources) {
    if (path === '-') { irregular = true; continue; }
    try {
      const info = ctx.fs.stat(path, ctx.cwd);
      if (info.isFile) totalBytes += info.size;
      else irregular = true;
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
    }
  }
  let width;
  if (sources.length === 1 && flags.length === 1) width = 1;
  else {
    width = String(totalBytes).length;
    if (irregular) width = Math.max(width, 7);
    width = Math.max(width, 1);
  }
  let out = '';
  let err = '';
  let code = 0;
  const totals = new Map(flags.map(flag => [flag, 0]));
  let printed = 0;
  for (const path of sources) {
    let text = null;
    if (path === '-') text = ctx.stdin ?? '';
    else {
      try {
        const info = ctx.fs.stat(path, ctx.cwd);
        if (info.isDir) {
          text = '';
          err += formatError(prog, path, 'EISDIR');
          code = 1;
        } else text = ctx.fs.readText(path, ctx.cwd);
      } catch (error) {
        if (!(error instanceof ShellError)) throw error;
        err += formatError(prog, path, error.code);
        code = 1;
      }
    }
    if (text === null) continue;
    const counts = countText(text, flags);
    for (const flag of flags) totals.set(flag, totals.get(flag) + counts.get(flag));
    let line = String(counts.get(flags[0])).padStart(width, ' ');
    for (let i = 1; i < flags.length; i += 1) line += ' ' + String(counts.get(flags[i])).padStart(width, ' ');
    if (!fromStdin) line += ' ' + path;
    out += line + '\n';
    printed += 1;
  }
  if (sources.length > 1 && printed > 0) {
    let line = String(totals.get(flags[0])).padStart(width, ' ');
    for (let i = 1; i < flags.length; i += 1) line += ' ' + String(totals.get(flags[i])).padStart(width, ' ');
    out += line + ' total\n';
  }
  return finish(code, out, err);
}

// ----------------------------------------------------------------------- cut

const CUT_DEFS = {
  b: 'value',
  c: 'value',
  d: 'value',
  f: 'value',
  s: 'bool',
  bytes: 'value',
  characters: 'value',
  fields: 'value',
  delimiter: 'value',
  'output-delimiter': 'value',
  'only-delimited': 'bool',
};

function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      if (range[1] > last[1]) last[1] = range[1];
      continue;
    }
    merged.push([range[0], range[1]]);
  }
  return merged;
}

function diagnoseList(spec, isField) {
  const zero = isField ? 'fields are numbered from 1' : 'byte/character positions are numbered from 1';
  const rangeMessage = isField ? 'invalid field range' : 'invalid byte or character range';
  if (String(spec).trim() === '') return zero;
  for (const piece of String(spec).split(',')) {
    const text = piece.trim();
    if (text === '') return zero;
    if (text === '-') return 'invalid range with no endpoint: -';
    if ((text.match(/-/g) ?? []).length > 1) return rangeMessage;
    if (!/^\d+(-\d*)?$/.test(text) && !/^-\d+$/.test(text)) {
      return isField ? "invalid field value '" + text + "'" : "invalid byte/character position '" + text + "'";
    }
  }
  return rangeMessage;
}

function cutList(spec, isField) {
  const zero = isField ? 'fields are numbered from 1' : 'byte/character positions are numbered from 1';
  for (const piece of String(spec).split(',')) {
    if (piece.trim() === '-') return { error: 'invalid range with no endpoint: -' };
  }
  const ranges = parseRanges(spec);
  if (!ranges) return { error: diagnoseList(spec, isField) };
  for (const [start, end] of ranges) {
    if (start === 0 || end === 0) return { error: zero };
    if (end !== Infinity && end < start) return { error: 'invalid decreasing range' };
  }
  return { ranges: mergeRanges(ranges) };
}

function runCut(prog, args, ctx) {
  const parsed = parseCommandOptions(args, CUT_DEFS, 'cdfb');
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  const charSpec = firstValue(opts, ['c', 'characters']);
  const byteSpec = firstValue(opts, ['b', 'bytes']);
  const fieldSpec = firstValue(opts, ['f', 'fields']);
  const delimiter = firstValue(opts, ['d', 'delimiter']);
  const outputDelimiter = firstValue(opts, ['output-delimiter']);
  const onlyDelimited = opts.has('s') || opts.has('only-delimited');
  const modes = [charSpec, byteSpec, fieldSpec].filter(value => value !== null).length;
  if (modes > 1) return fail(prog, 'only one type of list may be specified', 1);
  if (modes === 0) return fail(prog, 'you must specify a list of bytes, characters, or fields', 1);
  const fieldMode = fieldSpec !== null;
  if (!fieldMode && delimiter !== null) {
    return fail(prog, 'an input delimiter may be specified only when operating on fields', 1);
  }
  if (fieldMode && delimiter !== null && [...delimiter].length > 1) {
    return fail(prog, 'the delimiter must be a single character', 1);
  }
  const spec = fieldSpec ?? charSpec ?? byteSpec;
  const list = cutList(spec, fieldMode);
  if (list.error) return fail(prog, list.error, 1);
  const groups = list.ranges;
  const inputDelimiter = fieldMode ? (delimiter === null ? '\t' : delimiter === '' ? '\u0000' : delimiter) : '';
  const joinDelimiter = outputDelimiter !== null ? outputDelimiter : fieldMode ? inputDelimiter : '';
  const sources = parsed.args.length ? parsed.args : ['-'];
  let out = '';
  let err = '';
  for (const path of sources) {
    let text;
    try {
      text = readOperand(ctx, path);
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      err += formatError(prog, path, error.code);
      continue;
    }
    loop(ctx, splitRecords(text), CHUNK, record => {
      const body = record.endsWith('\n') ? record.slice(0, -1) : record;
      if (fieldMode) {
        const fields = body.split(inputDelimiter);
        if (fields.length === 1) {
          if (!onlyDelimited) out += body + '\n';
          return;
        }
        const selected = [];
        for (const [start, end] of groups) {
          const last = Math.min(end === Infinity ? fields.length : end, fields.length);
          for (let index = start; index <= last; index += 1) selected.push(fields[index - 1]);
        }
        out += selected.join(joinDelimiter) + '\n';
        return;
      }
      const chars = Array.from(body);
      let line = '';
      let first = true;
      for (const [start, end] of groups) {
        if (!first) line += joinDelimiter;
        first = false;
        const last = Math.min(end === Infinity ? chars.length : end, chars.length);
        for (let index = start; index <= last; index += 1) line += chars[index - 1];
      }
      out += line + '\n';
    });
  }
  return finish(err ? 1 : 0, out, err);
}

// ------------------------------------------------------------------------ tr

const TR_DEFS = {
  c: 'bool',
  d: 'bool',
  s: 'bool',
  complement: 'bool',
  delete: 'bool',
  'squeeze-repeats': 'bool',
};

const TR_CLASSES = {
  alpha: LETTERS,
  alnum: LETTERS + DIGITS,
  blank: ' \t',
  cntrl: CONTROL,
  digit: DIGITS,
  graph: PRINTABLE.slice(1),
  lower: LOWER,
  print: PRINTABLE,
  punct: PUNCT,
  space: ' \t\n\u000b\f\r',
  upper: UPPER,
  xdigit: DIGITS + 'ABCDEFabcdef',
};

const TR_ESCAPES = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\u000b', a: '\u0007', b: '\b', '\\': '\\' };

function readEscape(text, index) {
  const next = text[index + 1];
  if (next === undefined) return { char: '\\', next: index + 1 };
  if (Object.prototype.hasOwnProperty.call(TR_ESCAPES, next)) {
    return { char: TR_ESCAPES[next], next: index + 2 };
  }
  if (next >= '0' && next <= '7') {
    let digits = '';
    let at = index + 1;
    while (digits.length < 3 && at < text.length && text[at] >= '0' && text[at] <= '7') {
      digits += text[at];
      at += 1;
    }
    return { char: String.fromCharCode(Number.parseInt(digits, 8) & 0xff), next: at };
  }
  return { char: next, next: index + 2 };
}

function parseSet(text) {
  const items = [];
  for (let i = 0; i < text.length; ) {
    const char = text[i];
    if (char === '\\') {
      const escaped = readEscape(text, i);
      items.push({ char: escaped.char });
      i = escaped.next;
      continue;
    }
    if (char === '[' && text[i + 1] === ':') {
      const end = text.indexOf(':]', i + 2);
      if (end > 0) {
        const name = text.slice(i + 2, end);
        if (!Object.prototype.hasOwnProperty.call(TR_CLASSES, name)) {
          return { error: "invalid character class '" + name + "'" };
        }
        items.push({ chars: [...TR_CLASSES[name]], name });
        i = end + 2;
        continue;
      }
    }
    items.push({ char });
    i += 1;
  }
  const chars = [];
  const classes = new Set();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.chars) {
      classes.add(item.name);
      for (const char of item.chars) chars.push(char);
      continue;
    }
    const middle = items[i + 1];
    const after = items[i + 2];
    if (middle && !middle.chars && middle.char === '-' && after && !after.chars) {
      const start = item.char.codePointAt(0);
      const end = after.char.codePointAt(0);
      if (end < start) {
        return { error: "range-endpoints of '" + item.char + '-' + after.char + "' are in reverse collating sequence order" };
      }
      for (let code = start; code <= end; code += 1) chars.push(String.fromCodePoint(code));
      i += 2;
      continue;
    }
    chars.push(item.char);
  }
  return { chars, classes };
}

function complementSet(set) {
  const present = new Set(set.chars);
  const chars = [];
  for (let code = 0; code < 256; code += 1) {
    const char = String.fromCharCode(code);
    if (!present.has(char)) chars.push(char);
  }
  return { chars, classes: new Set() };
}

function runTr(prog, args, ctx) {
  const parsed = parseOptions(args, TR_DEFS);
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  const deleting = opts.has('d') || opts.has('delete');
  const squeezing = opts.has('s') || opts.has('squeeze-repeats');
  const complement = opts.has('c') || opts.has('complement');
  const operands = parsed.args;
  if (operands.length === 0) return fail(prog, 'missing operand', 1);
  if (deleting && !squeezing && operands.length > 1) return fail(prog, "extra operand '" + operands[1] + "'", 1);
  if (!deleting && !squeezing && operands.length === 1) {
    return fail(prog, "missing operand after '" + operands[0] + "'", 1);
  }
  if (operands.length > 2) return fail(prog, "extra operand '" + operands[2] + "'", 1);
  const first = parseSet(operands[0]);
  if (first.error) return fail(prog, first.error, 1);
  const second = operands.length > 1 ? parseSet(operands[1]) : null;
  if (second && second.error) return fail(prog, second.error, 1);
  const source = complement ? complementSet(first) : first;
  const caseClasses = new Set(['upper', 'lower']);
  if (second && !deleting) {
    let wantsCase = false;
    for (const name of second.classes) if (caseClasses.has(name)) wantsCase = true;
    if (wantsCase) {
      let hasCase = false;
      for (const name of source.classes) if (caseClasses.has(name)) hasCase = true;
      if (!hasCase) return fail(prog, 'misaligned [:upper:] and/or [:lower:] construct', 1);
    }
  }
  const map = new Map();
  let squeezeSet = null;
  let deleteSet = null;
  if (deleting) {
    deleteSet = new Set(source.chars);
    if (second) squeezeSet = new Set(second.chars);
  } else if (second) {
    if (!second.chars.length && source.chars.length) {
      return fail(prog, 'when not truncating set1, string2 must be non-empty', 1);
    }
    const last = second.chars[second.chars.length - 1];
    for (let i = 0; i < source.chars.length; i += 1) {
      map.set(source.chars[i], i < second.chars.length ? second.chars[i] : last);
    }
    if (squeezing) squeezeSet = new Set(second.chars);
  } else if (squeezing) {
    squeezeSet = new Set(source.chars);
  }
  let out = '';
  let previous = null;
  for (const char of ctx.stdin ?? '') {
    if (deleteSet && deleteSet.has(char)) continue;
    let mapped = char;
    const replacement = map.get(char);
    if (replacement !== undefined) mapped = replacement;
    if (squeezeSet && squeezeSet.has(mapped) && mapped === previous) continue;
    out += mapped;
    previous = mapped;
  }
  return writeOut(out);
}

// ----------------------------------------------------------------------- tee

const TEE_DEFS = { a: 'bool', append: 'bool' };

function runTee(prog, args, ctx) {
  const parsed = parseOptions(args, TEE_DEFS);
  if (parsed.error) return usageError(prog, parsed.error);
  const append = parsed.opts.has('a') || parsed.opts.has('append');
  const text = ctx.stdin ?? '';
  let err = '';
  for (const path of parsed.args) {
    try {
      ctx.fs.writeText(path, ctx.cwd, text, { append });
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      err += formatError(prog, path, error.code);
    }
  }
  return finish(err ? 1 : 0, text, err);
}

// ------------------------------------------------------------------------ nl

const NL_DEFS = {
  b: 'value',
  n: 'value',
  w: 'value',
  s: 'value',
  v: 'value',
  i: 'value',
  'body-numbering': 'value',
  'number-format': 'value',
  'number-width': 'value',
  separator: 'value',
  'starting-line-number': 'value',
  'line-increment': 'value',
};

function formatNumber(value, width, format) {
  const text = String(value);
  if (text.length >= width) return text;
  if (format === 'ln') return text.padEnd(width, ' ');
  if (format === 'rz') return text.padStart(width, '0');
  return text.padStart(width, ' ');
}

function runNl(prog, args, ctx) {
  const parsed = parseCommandOptions(args, NL_DEFS, 'bnwsv');
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  const style = firstValue(opts, ['b', 'body-numbering']) ?? 't';
  const format = firstValue(opts, ['n', 'number-format']) ?? 'rn';
  const widthText = firstValue(opts, ['w', 'number-width']) ?? '6';
  const separator = firstValue(opts, ['s', 'separator']) ?? '\t';
  const startText = firstValue(opts, ['v', 'starting-line-number']) ?? '1';
  const stepText = firstValue(opts, ['i', 'line-increment']) ?? '1';
  if (!['a', 't', 'n'].includes(style)) return fail(prog, "invalid body numbering style: '" + style + "'", 1);
  if (!['ln', 'rn', 'rz'].includes(format)) return fail(prog, "invalid line numbering format: '" + format + "'", 1);
  const width = toInt(widthText);
  if (width === null || width < 1) return fail(prog, "invalid line number field width: '" + widthText + "'", 1);
  const start = toInt(startText);
  if (start === null) return fail(prog, "invalid starting line number: '" + startText + "'", 1);
  const step = toInt(stepText);
  if (step === null) return fail(prog, "invalid line number increment: '" + stepText + "'", 1);
  const sources = parsed.args.length ? parsed.args : ['-'];
  const padding = ' '.repeat(width + [...separator].length);
  let out = '';
  let err = '';
  let counter = start;
  for (const path of sources) {
    let text;
    try {
      text = readOperand(ctx, path);
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      err += formatError(prog, path, error.code);
      continue;
    }
    loop(ctx, splitRecords(text), CHUNK, record => {
      const body = record.endsWith('\n') ? record.slice(0, -1) : record;
      const blank = body === '';
      const numbered = style === 'a' || (style === 't' && !blank);
      if (numbered) {
        out += formatNumber(counter, width, format) + separator + body + '\n';
        counter += step;
      } else out += padding + body + '\n';
    });
  }
  return finish(err ? 1 : 0, out, err);
}

// ----------------------------------------------------------------------- tac

function runTac(prog, args, ctx) {
  const parsed = parseOptions(args, {});
  if (parsed.error) return usageError(prog, parsed.error);
  const sources = parsed.args.length ? parsed.args : ['-'];
  let out = '';
  let err = '';
  for (const path of sources) {
    let text;
    try {
      text = readOperand(ctx, path);
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      const reason = ERRNO_TEXT[error.code] ?? error.code;
      err += prog + ": failed to open '" + path + "' for reading: " + reason + '\n';
      continue;
    }
    const records = splitRecords(text);
    for (let i = records.length - 1; i >= 0; i -= 1) out += records[i];
  }
  return finish(err ? 1 : 0, out, err);
}

// --------------------------------------------------------------------- paste

const PASTE_DEFS = { d: 'value', s: 'bool', delimiters: 'value', serial: 'bool' };

function parseDelimiters(text) {
  const list = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== '\\') {
      list.push(char);
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      list.push('\\');
      continue;
    }
    if (next === '0') list.push('');
    else if (next === 'n') list.push('\n');
    else if (next === 't') list.push('\t');
    else if (next === '\\') list.push('\\');
    else list.push(next);
    i += 1;
  }
  return list.length ? list : [''];
}

function runPaste(prog, args, ctx) {
  const parsed = parseCommandOptions(args, PASTE_DEFS, 'd');
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  const serial = opts.has('s') || opts.has('serial');
  const delimiterText = firstValue(opts, ['d', 'delimiters']) ?? '\t';
  const delimiters = parseDelimiters(delimiterText);
  const sources = parsed.args.length ? parsed.args : ['-'];
  const rows = [];
  for (const path of sources) {
    try {
      rows.push(lineParts(readOperand(ctx, path)));
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      return { code: 1, out: '', err: formatError(prog, path, error.code) };
    }
  }
  let out = '';
  if (serial) {
    for (const row of rows) {
      let line = '';
      for (let i = 0; i < row.length; i += 1) {
        if (i > 0) line += delimiters[(i - 1) % delimiters.length];
        line += row[i];
      }
      out += line + '\n';
    }
    return writeOut(out);
  }
  let longest = 0;
  for (const row of rows) if (row.length > longest) longest = row.length;
  for (let index = 0; index < longest; index += 1) {
    let line = '';
    for (let file = 0; file < rows.length; file += 1) {
      if (file > 0) line += delimiters[(file - 1) % delimiters.length];
      line += rows[file][index] ?? '';
    }
    out += line + '\n';
  }
  return writeOut(out);
}
