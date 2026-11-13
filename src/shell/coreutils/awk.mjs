// src/shell/coreutils/awk.mjs
//
// awk: a POSIX-flavoured AWK written from scratch for the builtin shell.
// The pipeline is classic: lexer -> recursive-descent parser -> tree-walking
// interpreter. Everything is synchronous and dependency free; input is read
// through ctx.fs, buffered output is returned to the caller, and print pipes
// and system() go through ctx.runCommand.
//
// Supported: -F, -v, -f, BEGIN/END, pattern-action rules (including ranges),
// the expression grammar (concatenation, awk's numeric-vs-string comparisons,
// ternary, in, ~ / !~, assignment, pre/post increment), control flow (if,
// while, do/while, for, for-in, break, continue, next, nextfile, exit), arrays
// with delete, user functions with local parameters, redirection to files and
// pipes, getline (plain, < file, cmd |), and the usual builtins.
//
// Not supported: gawk extensions such as arrays of arrays, FIELDWIDTHS,
// PROCINFO, indirect calls, coprocesses (|&) and exact locale collation.
// length()/substr() count UTF-16 code units rather than bytes.

import { ShellError, ERRNO_TEXT } from '../fs.mjs';

export const names = ['awk'];

const BS = String.fromCharCode(92);
const SUBSEP_DEFAULT = String.fromCharCode(28);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '**=']);
const REL_OPS = new Set(['<', '<=', '>', '>=', '==', '!=']);

// ---------------------------------------------------------------- value model
//
// awk values are one of: a JS number, a JS string (a "pure string" such as a
// string constant), a StrNum (a string that came from input, ARGV, -v or
// getline), an array (JS Map) or a regex literal. Comparisons are numeric when
// both sides are numeric-ish and string otherwise, which reproduces awk's
// famous "1.0" == 1 being false while $1 == 1 is true for input "1.0".

class StrNum {
  constructor(text) {
    this.s = text;
    const value = numericPrefix(text);
    this.n = value === null ? 0 : value;
  }
}

const EMPTY_VALUE = new StrNum('');

const NUM_PREFIX = /^[ \t\n\r\f\v]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const NUM_EXACT = /^[ \t\n\r\f\v]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\f\v]*$/;

/** strtod-style leading numeric prefix, or null when there is none. */
function numericPrefix(text) {
  if (typeof text !== 'string' || text === '') return null;
  const match = NUM_PREFIX.exec(text);
  if (!match) return null;
  const value = Number(match[0].replace(/^[ \t\n\r\f\v]+/, ''));
  return Number.isFinite(value) ? value : null;
}

function looksNumeric(text) {
  if (typeof text !== 'string' || text === '') return false;
  return NUM_EXACT.test(text);
}

function isNumericValue(value) {
  return typeof value === 'number' || value instanceof StrNum;
}

function isArray(value) {
  return value instanceof Map;
}

function specialNumberText(value) {
  if (Number.isNaN(value)) return '-nan';
  return value > 0 ? '+inf' : '-inf';
}

/** Integral doubles print without a decimal point, exactly like awk. */
function integerText(value) {
  if (value === 0) return '0';
  if (Math.abs(value) < 1e21) return String(value);
  return BigInt(value).toString();
}

// ------------------------------------------------------------------ errors

class AwkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AwkError';
    this.code = code === undefined ? 2 : code;
  }
}

class ExitSignal extends Error {
  constructor(code) {
    super('exit');
    this.name = 'ExitSignal';
    this.code = code;
  }
}

class NextSignal extends Error {
  constructor() { super('next'); this.name = 'NextSignal'; }
}

class NextFileSignal extends Error {
  constructor() { super('nextfile'); this.name = 'NextFileSignal'; }
}

class BreakSignal extends Error {
  constructor() { super('break'); this.name = 'BreakSignal'; }
}

class ContinueSignal extends Error {
  constructor() { super('continue'); this.name = 'ContinueSignal'; }
}

class ReturnSignal extends Error {
  constructor(value) { super('return'); this.name = 'ReturnSignal'; this.value = value; }
}

// ------------------------------------------------------------ printf engine

function stripTrailingZeros(text) {
  let at = text.indexOf('e');
  if (at < 0) at = text.indexOf('E');
  const mantissa = at < 0 ? text : text.slice(0, at);
  const rest = at < 0 ? '' : text.slice(at);
  if (mantissa.indexOf('.') < 0) return text;
  let out = mantissa;
  while (out.endsWith('0')) out = out.slice(0, -1);
  if (out.endsWith('.')) out = out.slice(0, -1);
  return out + rest;
}

/** C prints exponents with at least two digits: 1e+06, 1e-05. */
function normalizeExponent(text) {
  const at = text.indexOf('e');
  if (at < 0) return text;
  const mantissa = text.slice(0, at);
  let exponent = text.slice(at + 1);
  let sign = '+';
  if (exponent[0] === '+' || exponent[0] === '-') {
    sign = exponent[0];
    exponent = exponent.slice(1);
  }
  while (exponent.length < 2) exponent = '0' + exponent;
  return mantissa + 'e' + sign + exponent;
}

function decimalExponent(value) {
  const text = Math.abs(value).toExponential();
  return Number.parseInt(text.slice(text.indexOf('e') + 1), 10);
}

// printf rounding must match C, which rounds the exact binary value with ties
// going to the even digit. JavaScript toFixed() rounds the exact value but with
// ties away from zero, so the digit strings below are built from the exact
// decimal expansion of the double and rounded by hand.

const DECIMAL_VIEW = new DataView(new ArrayBuffer(8));

/** Exact decimal expansion of a positive finite double. */
function exactDecimal(value) {
  DECIMAL_VIEW.setFloat64(0, value);
  const high = DECIMAL_VIEW.getUint32(0);
  const low = DECIMAL_VIEW.getUint32(4);
  const exponentBits = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << BigInt(32)) | BigInt(low);
  let exponent;
  if (exponentBits === 0) {
    exponent = -1074;
  } else {
    mantissa |= BigInt(1) << BigInt(52);
    exponent = exponentBits - 1075;
  }
  if (exponent >= 0) {
    const digits = (mantissa << BigInt(exponent)).toString();
    return { digits, point: digits.length };
  }
  const shift = -exponent;
  const digits = (mantissa * BigInt(5) ** BigInt(shift)).toString();
  return { digits, point: digits.length - shift };
}

/** Add one to a decimal digit string; the result may gain a leading '1'. */
function incrementDigits(text) {
  const chars = text.split('');
  let at = chars.length - 1;
  while (at >= 0) {
    if (chars[at] === '9') {
      chars[at] = '0';
      at -= 1;
      continue;
    }
    chars[at] = String.fromCharCode(chars[at].charCodeAt(0) + 1);
    return chars.join('');
  }
  return '1' + chars.join('');
}

/** Round a digit string to count significant digits (ties to even). */
function roundSignificant(digits, count) {
  if (digits.length <= count) return digits + '0'.repeat(count - digits.length);
  const head = digits.slice(0, count);
  const first = digits[count];
  const tail = digits.slice(count + 1);
  let roundUp = false;
  if (first > '5') {
    roundUp = true;
  } else if (first === '5') {
    if (/[1-9]/.test(tail)) roundUp = true;
    else roundUp = (head.charCodeAt(head.length - 1) - 48) % 2 === 1;
  }
  return roundUp ? incrementDigits(head) : head;
}

/** Fixed-point text for |value| with exactly decimals fractional digits. */
function exactFixed(value, decimals) {
  const abs = Math.abs(value);
  if (abs === 0) return decimals > 0 ? '0.' + '0'.repeat(decimals) : '0';
  const expansion = exactDecimal(abs);
  const keep = expansion.point + decimals;
  let head;
  let rest;
  if (keep <= 0) {
    head = '0';
    rest = '0'.repeat(-keep) + expansion.digits;
  } else if (keep >= expansion.digits.length) {
    head = expansion.digits + '0'.repeat(keep - expansion.digits.length);
    rest = '';
  } else {
    head = expansion.digits.slice(0, keep);
    rest = expansion.digits.slice(keep);
  }
  let text = head;
  if (rest.length > 0) {
    const first = rest[0];
    const tail = rest.slice(1);
    let roundUp = false;
    if (first > '5') {
      roundUp = true;
    } else if (first === '5') {
      if (/[1-9]/.test(tail)) roundUp = true;
      else roundUp = (text.charCodeAt(text.length - 1) - 48) % 2 === 1;
    }
    if (roundUp) text = incrementDigits(text);
  }
  if (decimals === 0) return text;
  if (text.length <= decimals) text = '0'.repeat(decimals + 1 - text.length) + text;
  return text.slice(0, text.length - decimals) + '.' + text.slice(text.length - decimals);
}

function formatFixed(value, precision) {
  if (!Number.isFinite(value)) return specialNumberText(value);
  const digits = Math.max(0, Math.min(100, precision));
  const text = exactFixed(value, digits);
  return value < 0 && text[0] !== '-' ? '-' + text : text;
}

function formatExponential(value, precision, upper) {
  if (!Number.isFinite(value)) return specialNumberText(value);
  const digits = Math.max(0, Math.min(100, precision));
  const mark = upper ? 'E' : 'e';
  const abs = Math.abs(value);
  if (abs === 0) {
    const mantissa = digits > 0 ? '0.' + '0'.repeat(digits) : '0';
    return mantissa + mark + '+00';
  }
  const expansion = exactDecimal(abs);
  let exponent = expansion.point - 1;
  let significant = roundSignificant(expansion.digits, digits + 1);
  if (significant.length > digits + 1) {
    exponent += 1;
    significant = significant.slice(0, digits + 1);
  }
  const mantissa = digits > 0 ? significant[0] + '.' + significant.slice(1) : significant[0];
  const sign = exponent < 0 ? '-' : '+';
  let magnitude = String(Math.abs(exponent));
  while (magnitude.length < 2) magnitude = '0' + magnitude;
  const text = mantissa + mark + sign + magnitude;
  return value < 0 ? '-' + text : text;
}

function formatGeneral(value, precision, upper, hash) {
  if (!Number.isFinite(value)) return specialNumberText(value);
  const digits = precision === null ? 6 : Math.max(1, Math.min(100, precision));
  const abs = Math.abs(value);
  let text;
  if (abs === 0) {
    text = hash ? '0.' + '0'.repeat(digits - 1) : '0';
  } else {
    const expansion = exactDecimal(abs);
    const exponent = expansion.point - 1;
    if (exponent < -4 || exponent >= digits) {
      text = formatExponential(abs, digits - 1, upper);
      if (!hash) text = stripTrailingZeros(text);
    } else {
      text = exactFixed(abs, Math.max(0, digits - 1 - exponent));
      if (!hash) text = stripTrailingZeros(text);
      const dot = text.indexOf('.');
      const integerPart = dot < 0 ? text : text.slice(0, dot);
      let lead = 0;
      while (lead < integerPart.length - 1 && integerPart[lead] === '0') lead += 1;
      if (integerPart.length - 1 - lead >= digits) {
        text = formatExponential(abs, digits - 1, upper);
        if (!hash) text = stripTrailingZeros(text);
      }
    }
  }
  if (value < 0 && text[0] !== '-') text = '-' + text;
  return upper ? text.toUpperCase() : text;
}

function padText(text, spec) {
  const width = spec.width;
  if (!width || text.length >= width) return text;
  if (spec.flags.minus) return text + ' '.repeat(width - text.length);
  return ' '.repeat(width - text.length) + text;
}

function padNumber(text, spec) {
  const width = spec.width;
  if (!width || text.length >= width) return text;
  if (spec.flags.minus) return text + ' '.repeat(width - text.length);
  const isInteger = spec.conv === 'd' || spec.conv === 'i' || spec.conv === 'o' ||
    spec.conv === 'u' || spec.conv === 'x' || spec.conv === 'X';
  // C ignores the zero flag for integer conversions that also give a precision.
  if (spec.flags.zero && !(isInteger && spec.precision !== null)) {
    const count = width - text.length;
    if (text[0] === '-' || text[0] === '+' || text[0] === ' ') {
      return text[0] + '0'.repeat(count) + text.slice(1);
    }
    if (text[0] === '0' && (text[1] === 'x' || text[1] === 'X')) {
      return text.slice(0, 2) + '0'.repeat(count) + text.slice(2);
    }
    return '0'.repeat(count) + text;
  }
  return ' '.repeat(width - text.length) + text;
}

/** Parse one conversion specification at position start (which is the %). */
function parseFormatSpec(format, start) {
  const spec = {
    flags: { minus: false, plus: false, space: false, hash: false, zero: false },
    width: null,
    precision: null,
    starWidth: false,
    starPrecision: false,
    conv: '',
  };
  let index = start + 1;
  let reading = true;
  while (reading && index < format.length) {
    const ch = format[index];
    if (ch === '-') spec.flags.minus = true;
    else if (ch === '+') spec.flags.plus = true;
    else if (ch === ' ') spec.flags.space = true;
    else if (ch === '#') spec.flags.hash = true;
    else if (ch === '0') spec.flags.zero = true;
    else reading = false;
    if (reading) index += 1;
  }
  if (format[index] === '*') {
    spec.starWidth = true;
    index += 1;
  } else {
    let digits = '';
    while (index < format.length && format[index] >= '0' && format[index] <= '9') {
      digits += format[index];
      index += 1;
    }
    if (digits) spec.width = Number(digits);
  }
  if (format[index] === '.') {
    index += 1;
    if (format[index] === '*') {
      spec.starPrecision = true;
      index += 1;
    } else {
      let digits = '';
      while (index < format.length && format[index] >= '0' && format[index] <= '9') {
        digits += format[index];
        index += 1;
      }
      spec.precision = digits ? Number(digits) : 0;
    }
  }
  while (index < format.length && 'hlLqjzt'.indexOf(format[index]) >= 0) index += 1;
  spec.conv = index < format.length ? format[index] : '';
  spec.end = index + 1;
  return spec;
}

/** Replace % escapes in one numeric-to-text conversion result. */
function applySign(text, spec) {
  if (text[0] === '-') {
    if (spec.flags.plus || spec.flags.space) return text;
    return text;
  }
  if (spec.flags.plus) return '+' + text;
  if (spec.flags.space) return ' ' + text;
  return text;
}

// ------------------------------------------------------- value conversions

function toNumRaw(value) {
  if (typeof value === 'number') return value;
  if (value instanceof StrNum) return value.n;
  if (typeof value === 'string') {
    const parsed = numericPrefix(value);
    return parsed === null ? 0 : parsed;
  }
  return 0;
}

const PLAIN_RT = {
  scalar(value) { return value; },
  convFmt() { return '%.6g'; },
  ofmt() { return '%.6g'; },
  matchRecord() { return false; },
};

function toNum(value, rt) {
  const runtime = rt || PLAIN_RT;
  return toNumRaw(runtime.scalar(value));
}

function numberToText(value, format) {
  if (Number.isInteger(value)) return integerText(value);
  if (!Number.isFinite(value)) return specialNumberText(value);
  if (typeof format !== 'string' || format[0] !== '%') return String(value);
  const spec = parseFormatSpec(format, 0);
  if (spec.conv === '' || spec.conv === '%') return String(value);
  if (spec.conv === 'd' || spec.conv === 'i' || spec.conv === 'o' || spec.conv === 'u' || spec.conv === 'x' || spec.conv === 'X') {
    return String(Math.trunc(value));
  }
  return formatNumberSpec(spec, value, null);
}

function toStr(value, rt) {
  if (!rt) rt = PLAIN_RT;
  if (typeof value === 'string') return value;
  if (value instanceof StrNum) return value.s;
  if (typeof value === 'number') return numberToText(value, rt.convFmt());
  if (value instanceof RegexValue) return rt.matchRecord(value) ? '1' : '0';
  if (isArray(value)) throw new AwkError('attempt to use array in a scalar context');
  return '';
}

function toOutStr(value, rt) {
  if (!rt) rt = PLAIN_RT;
  if (typeof value === 'string') return value;
  if (value instanceof StrNum) return value.s;
  if (typeof value === 'number') return numberToText(value, rt.ofmt());
  if (value instanceof RegexValue) return rt.matchRecord(value) ? '1' : '0';
  if (isArray(value)) throw new AwkError('attempt to use array in a scalar context');
  return '';
}

function truthy(value, rt) {
  const resolved = rt ? rt.scalar(value) : value;
  if (typeof resolved === 'number') return resolved !== 0 && !Number.isNaN(resolved);
  if (resolved instanceof StrNum) return resolved.n !== 0;
  if (typeof resolved === 'string') return resolved !== '';
  if (isArray(resolved)) return true;
  return false;
}

function compareValues(left, right, rt) {
  const runtime = rt || PLAIN_RT;
  const a = runtime.scalar(left);
  const b = runtime.scalar(right);
  if (isNumericValue(a) && isNumericValue(b)) {
    const x = toNumRaw(a);
    const y = toNumRaw(b);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  }
  const x = toStr(a, runtime);
  const y = toStr(b, runtime);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

// ------------------------------------------------------------ printf output

function formatInteger(spec, value, rt) {
  const number = Math.trunc(toNum(value, rt));
  const finite = Number.isFinite(number) ? number : 0;
  const conv = spec.conv;
  let negative = finite < 0;
  let digits;
  let prefix = '';
  if (conv === 'd' || conv === 'i') {
    digits = String(Math.abs(finite));
  } else if (conv === 'u') {
    const unsigned = finite < 0 ? 4294967296 + finite : finite;
    digits = String(unsigned);
    negative = false;
  } else {
    const magnitude = Math.abs(finite);
    digits = magnitude.toString(conv === 'o' ? 8 : 16);
    if (conv === 'X') digits = digits.toUpperCase();
    if (spec.flags.hash) prefix = conv === 'o' ? '0' : (conv === 'X' ? '0X' : '0x');
  }
  if (spec.precision !== null) {
    if (spec.precision === 0 && digits === '0') digits = '';
    while (digits.length < spec.precision) digits = '0' + digits;
  }
  if (digits === '') digits = '0';
  const sign = negative ? '-' : spec.flags.plus ? '+' : spec.flags.space ? ' ' : '';
  return padNumber(sign + prefix + digits, spec);
}

function formatFloat(spec, value, rt) {
  const number = toNum(value, rt);
  const conv = spec.conv;
  const precision = spec.precision === null ? 6 : spec.precision;
  let text;
  if (conv === 'e' || conv === 'E') text = formatExponential(number, precision, conv === 'E');
  else if (conv === 'f' || conv === 'F') text = formatFixed(number, precision);
  else text = formatGeneral(number, spec.precision, conv === 'G', spec.flags.hash);
  if (spec.flags.hash && text.indexOf('.') < 0) {
    if (conv === 'e' || conv === 'E') {
      const at = text.indexOf('e');
      text = at >= 0 ? text.slice(0, at) + '.' + text.slice(at) : text + '.';
    } else if (conv === 'f' || conv === 'F') {
      text += '.';
    }
  }
  return padNumber(applySign(text, spec), spec);
}

function formatChar(spec, value, rt) {
  const resolved = rt ? rt.scalar(value) : value;
  let text = '';
  if (typeof resolved === 'string') {
    text = resolved.length > 0 ? resolved[0] : String.fromCharCode(0);
  } else {
    const code = Math.trunc(toNumRaw(resolved)) & 0xFF;
    text = String.fromCharCode(code);
  }
  return padText(text, spec);
}

function formatNumberSpec(spec, value, rt) {
  const conv = spec.conv;
  if (conv === 'd' || conv === 'i' || conv === 'o' || conv === 'u' || conv === 'x' || conv === 'X') {
    return formatInteger(spec, value, rt);
  }
  if (conv === 'e' || conv === 'E' || conv === 'f' || conv === 'F' || conv === 'g' || conv === 'G') {
    return formatFloat(spec, value, rt);
  }
  if (conv === 'c') return formatChar(spec, value, rt);
  if (conv === 's') {
    let text = toStr(value, rt);
    if (spec.precision !== null && text.length > spec.precision) text = text.slice(0, spec.precision);
    return padText(text, spec);
  }
  return toStr(value, rt);
}

function formatOutput(format, values, rt) {
  let out = '';
  let index = 0;
  let at = 0;
  while (at < format.length) {
    const ch = format[at];
    if (ch !== '%') {
      out += ch;
      at += 1;
      continue;
    }
    if (format[at + 1] === '%') {
      out += '%';
      at += 2;
      continue;
    }
    const spec = parseFormatSpec(format, at);
    at = spec.end;
    if (spec.starWidth) {
      if (index >= values.length) throw new AwkError('not enough arguments to satisfy format string');
      spec.width = Math.trunc(toNum(values[index], rt));
      index += 1;
      if (spec.width < 0) {
        spec.flags.minus = true;
        spec.width = -spec.width;
      }
    }
    if (spec.starPrecision) {
      if (index >= values.length) throw new AwkError('not enough arguments to satisfy format string');
      spec.precision = Math.max(0, Math.trunc(toNum(values[index], rt)));
      index += 1;
    }
    if (spec.conv === '') {
      out += '%';
      continue;
    }
    if (index >= values.length) throw new AwkError('not enough arguments to satisfy format string');
    out += formatNumberSpec(spec, values[index], rt);
    index += 1;
  }
  return out;
}

// ------------------------------------------------------- regular expressions
//
// AWK uses POSIX EREs, JavaScript uses a close cousin. The differences that
// matter here: POSIX has no non-capturing groups or lazy quantifiers, backslash
// before an ordinary letter is that letter, and bracket expressions support
// [:class:] names. The compiler below rewrites the source into JS syntax.

const POSIX_CLASS_BODIES = (function buildPosixClasses() {
  const punct = (function buildPunct() {
    let body = '';
    for (let code = 33; code <= 126; code += 1) {
      const ch = String.fromCharCode(code);
      if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) continue;
      if (ch === BS || ch === ']' || ch === '^' || ch === '-') body += BS + ch;
      else body += ch;
    }
    return body;
  })();
  const table = new Map();
  table.set('alpha', 'A-Za-z');
  table.set('digit', '0-9');
  table.set('alnum', 'A-Za-z0-9');
  table.set('upper', 'A-Z');
  table.set('lower', 'a-z');
  table.set('space', ' \\t\\n\\r\\f\\v');
  table.set('blank', ' \\t');
  table.set('punct', punct);
  table.set('cntrl', '\\x00-\\x1F\\x7F');
  table.set('graph', '!-~');
  table.set('print', ' -~');
  table.set('xdigit', '0-9A-Fa-f');
  table.set('word', 'A-Za-z0-9_');
  return table;
})();

function escapeJsLiteral(ch) {
  if (ch === BS || ch === '^' || ch === '$' || ch === '.' || ch === '*' || ch === '+' || ch === '?' ||
      ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '|') {
    return BS + ch;
  }
  return ch;
}

function translateEscapeChar(next) {
  switch (next) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'f': return '\f';
    case 'v': return '\v';
    case 'a': return String.fromCharCode(7);
    case 'b': return String.fromCharCode(8);
    default: return next;
  }
}

function translateClassEscape(next) {
  if (next === 'n' || next === 't' || next === 'r' || next === 'f' || next === 'v') return BS + next;
  if (next === 'a') return '\\x07';
  if (next === 'b') return '\\x08';
  if (next === 'd' || next === 's' || next === 'w' || next === 'D' || next === 'S' || next === 'W') return escapeJsLiteral(next);
  if (next >= '0' && next <= '9') return escapeJsLiteral(next);
  return escapeJsLiteral(next);
}

function readBracketExpression(pattern, start) {
  let index = start + 1;
  let body = '';
  if (pattern[index] === '^') {
    body += '^';
    index += 1;
  }
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
      const stop = pattern.indexOf(':]', index + 2);
      if (stop > 0) {
        const name = pattern.slice(index + 2, stop);
        const replacement = POSIX_CLASS_BODIES.get(name);
        if (replacement !== undefined) {
          body += replacement;
          index = stop + 2;
          continue;
        }
      }
      body += '\\[';
      index += 1;
      continue;
    }
    if (ch === BS) {
      const next = pattern[index + 1];
      if (next === undefined) {
        body += BS + BS;
        index += 1;
        continue;
      }
      body += translateClassEscape(next);
      index += 2;
      continue;
    }
    if (ch === '^' || ch === ']') {
      body += BS + ch;
      index += 1;
      continue;
    }
    body += ch;
    index += 1;
  }
  if (!closed) throw new AwkError('unterminated regular expression');
  return { text: '[' + body + ']', end: index };
}

function ereToJs(pattern) {
  let out = '';
  let index = 0;
  let lastWasQuantifier = false;
  while (index < pattern.length) {
    const ch = pattern[index];
    if (ch === BS) {
      const next = pattern[index + 1];
      if (next === undefined) {
        out += BS + BS;
        index += 1;
        continue;
      }
      if (next === 'n' || next === 't' || next === 'r' || next === 'f' || next === 'v') {
        out += BS + next;
        lastWasQuantifier = false;
      } else if (next === 'a') {
        out += '\\x07';
        lastWasQuantifier = false;
      } else if (next === 'b') {
        out += '\\x08';
        lastWasQuantifier = false;
      } else if (next >= '0' && next <= '9') {
        out += escapeJsLiteral(next);
        lastWasQuantifier = false;
      } else {
        out += escapeJsLiteral(next);
        lastWasQuantifier = false;
      }
      index += 2;
      continue;
    }
    if (ch === '[') {
      const bracket = readBracketExpression(pattern, index);
      out += bracket.text;
      index = bracket.end + 1;
      lastWasQuantifier = false;
      continue;
    }
    if (ch === '?' && lastWasQuantifier) {
      out += '\\?';
      index += 1;
      lastWasQuantifier = false;
      continue;
    }
    out += ch;
    lastWasQuantifier = ch === '*' || ch === '+' || ch === '?';
    index += 1;
  }
  return out;
}

function compileEre(pattern) {
  try {
    return new RegExp(ereToJs(pattern));
  } catch (error) {
    throw new AwkError('invalid regular expression: ' + pattern);
  }
}

function compileEreGlobal(pattern) {
  try {
    return new RegExp(ereToJs(pattern), 'g');
  } catch (error) {
    throw new AwkError('invalid regular expression: ' + pattern);
  }
}

class RegexValue {
  constructor(source) {
    this.source = source;
    this.regex = compileEre(source);
  }
}

// ------------------------------------------------------------------- lexer

const KEYWORDS = new Set([
  'BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do',
  'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'print', 'printf',
  'delete', 'in', 'getline',
]);

const OPERATORS = [
  '**=', '>>', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '^=',
  '==', '!=', '<=', '>=', '!~', '**',
  '^', '~', '!', '<', '>', '=', '+', '-', '*', '/', '%', '?', ':', ';', ',',
  '(', ')', '{', '}', '[', ']', '$', '|',
];

function isDigitChar(ch) {
  return ch >= '0' && ch <= '9';
}

function isHexChar(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isNameStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isNamePart(ch) {
  return isNameStart(ch) || isDigitChar(ch);
}

function decodeEscape(text, index) {
  const next = text[index + 1];
  if (next === undefined) return { value: BS, end: index + 1 };
  switch (next) {
    case 'n': return { value: '\n', end: index + 2 };
    case 't': return { value: '\t', end: index + 2 };
    case 'r': return { value: '\r', end: index + 2 };
    case 'f': return { value: '\f', end: index + 2 };
    case 'v': return { value: '\v', end: index + 2 };
    case 'a': return { value: String.fromCharCode(7), end: index + 2 };
    case 'b': return { value: String.fromCharCode(8), end: index + 2 };
    case BS: return { value: BS, end: index + 2 };
    case '"': return { value: '"', end: index + 2 };
    case '/': return { value: '/', end: index + 2 };
    default: break;
  }
  if (next >= '0' && next <= '7') {
    let digits = '';
    let end = index + 1;
    while (digits.length < 3 && text[end] >= '0' && text[end] <= '7') {
      digits += text[end];
      end += 1;
    }
    return { value: String.fromCharCode(Number.parseInt(digits, 8) & 0xFF), end };
  }
  if (next === 'x') {
    let digits = '';
    let end = index + 2;
    while (digits.length < 2 && isHexChar(text[end] || '')) {
      digits += text[end];
      end += 1;
    }
    if (digits) return { value: String.fromCharCode(Number.parseInt(digits, 16)), end };
  }
  return { value: next, end: index + 2 };
}

function unescapeText(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === BS) {
      const decoded = decodeEscape(text, index);
      out += decoded.value;
      index = decoded.end;
      continue;
    }
    out += text[index];
    index += 1;
  }
  return out;
}

function syntaxErrorAt(line, near) {
  let message = 'syntax error at source line ' + line;
  if (near) message += ' near ' + near;
  return new AwkError(message);
}

// ------------------------------------------------------------------ parser
//
// Recursive descent with awk's precedence ladder:
//   assignment < ternary < || < && < in < ~ !~ < comparison < concatenation
//   < + - < * / % < unary < ^ < postfix < primary

function isLvalue(node) {
  return node.t === 'var' || node.t === 'field' || node.t === 'index';
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
    this.noGt = 0;
  }

  peek(offset) {
    const at = this.index + (offset === undefined ? 0 : offset);
    return this.tokens[at < this.tokens.length ? at : this.tokens.length - 1];
  }

  next() {
    const token = this.tokens[this.index];
    if (this.index < this.tokens.length - 1) this.index += 1;
    return token;
  }

  atKind(kind) { return this.peek().k === kind; }

  atOp(value) {
    const token = this.peek();
    return token.k === 'op' && token.v === value;
  }

  atKw(value) {
    const token = this.peek();
    return token.k === 'kw' && token.v === value;
  }

  describe(token) {
    if (token.k === 'eof') return 'end of program';
    if (token.k === 'nl') return 'newline';
    if (token.k === 'str') return 'string constant';
    return "'" + String(token.v) + "'";
  }

  expectOp(value) {
    if (!this.atOp(value)) throw syntaxErrorAt(this.peek().line, this.describe(this.peek()));
    return this.next();
  }

  expectName() {
    if (!this.atKind('name')) throw syntaxErrorAt(this.peek().line, this.describe(this.peek()));
    return this.next().v;
  }

  skipNewlines() {
    while (this.atKind('nl')) this.next();
  }

  skipSeparators() {
    for (;;) {
      if (this.atKind('nl')) { this.next(); continue; }
      if (this.atOp(';')) { this.next(); continue; }
      return;
    }
  }

  skipTerminators() {
    for (;;) {
      if (this.atKind('nl')) { this.next(); continue; }
      if (this.atOp(';')) { this.next(); continue; }
      return;
    }
  }

  atTerminator() {
    const token = this.peek();
    if (token.k === 'nl' || token.k === 'eof') return true;
    if (token.k === 'op' && (token.v === ';' || token.v === '}')) return true;
    if (token.k === 'kw' && token.v === 'else') return true;
    return false;
  }

  // ------------------------------------------------------------ program

  parseProgram() {
    const program = { begin: [], end: [], rules: [], funcs: new Map() };
    this.skipSeparators();
    while (!this.atKind('eof')) {
      const token = this.peek();
      if (token.k === 'kw' && token.v === 'BEGIN') {
        this.next();
        this.skipNewlines();
        const beginBody = this.parseBlock();
        for (let i = 0; i < beginBody.length; i += 1) program.begin.push(beginBody[i]);
      } else if (token.k === 'kw' && token.v === 'END') {
        this.next();
        this.skipNewlines();
        const endBody = this.parseBlock();
        for (let i = 0; i < endBody.length; i += 1) program.end.push(endBody[i]);
      } else if (token.k === 'kw' && (token.v === 'function' || token.v === 'func')) {
        this.parseFunction(program.funcs);
      } else if (this.atOp('{')) {
        program.rules.push({ first: null, second: null, action: this.parseBlock() });
      } else {
        const first = this.parseExpr();
        let second = null;
        if (this.atOp(',')) {
          this.next();
          this.skipNewlines();
          second = this.parseExpr();
        }
        let action = null;
        if (this.atOp('{')) action = this.parseBlock();
        program.rules.push({ first, second, action });
      }
      this.skipSeparators();
    }
    return program;
  }

  parseFunction(funcs) {
    this.next();
    const name = this.expectName();
    this.expectOp('(');
    const params = [];
    this.skipNewlines();
    if (!this.atOp(')')) {
      for (;;) {
        params.push(this.expectName());
        if (this.atOp(',')) {
          this.next();
          this.skipNewlines();
          continue;
        }
        break;
      }
    }
    this.expectOp(')');
    this.skipNewlines();
    const body = this.parseBlock();
    funcs.set(name, { name, params, body });
  }

  // --------------------------------------------------------- statements

  parseBlock() {
    this.expectOp('{');
    const body = [];
    this.skipSeparators();
    while (!this.atOp('}')) {
      if (this.atKind('eof')) throw syntaxErrorAt(this.peek().line, 'end of program');
      body.push(this.parseStatement());
      this.skipSeparators();
    }
    this.next();
    return body;
  }

  parseStatement() {
    const token = this.peek();
    if (token.k === 'op' && token.v === '{') return { t: 'block', body: this.parseBlock() };
    if (token.k === 'op' && token.v === ';') { this.next(); return { t: 'empty' }; }
    if (token.k === 'kw') {
      switch (token.v) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'do': return this.parseDo();
        case 'for': return this.parseFor();
        case 'break': this.next(); this.skipTerminators(); return { t: 'break' };
        case 'continue': this.next(); this.skipTerminators(); return { t: 'continue' };
        case 'next': this.next(); this.skipTerminators(); return { t: 'next' };
        case 'nextfile': this.next(); this.skipTerminators(); return { t: 'nextfile' };
        case 'exit': return this.parseJump('exit');
        case 'return': return this.parseJump('return');
        case 'print': return this.parsePrint(false);
        case 'printf': return this.parsePrint(true);
        case 'delete': return this.parseDelete();
        default: break;
      }
    }
    const expression = this.parseExpr();
    this.skipTerminators();
    return { t: 'expr', expression };
  }

  parseIf() {
    this.next();
    this.expectOp('(');
    const saved = this.noGt;
    this.noGt = 0;
    const condition = this.parseExpr();
    this.noGt = saved;
    this.expectOp(')');
    this.skipNewlines();
    const thenBranch = this.parseStatement();
    this.skipSeparators();
    let elseBranch = null;
    if (this.atKw('else')) {
      this.next();
      this.skipNewlines();
      elseBranch = this.parseStatement();
    }
    return { t: 'if', condition, then: thenBranch, otherwise: elseBranch };
  }

  parseWhile() {
    this.next();
    this.expectOp('(');
    const saved = this.noGt;
    this.noGt = 0;
    const condition = this.parseExpr();
    this.noGt = saved;
    this.expectOp(')');
    this.skipNewlines();
    const body = this.parseStatement();
    return { t: 'while', condition, body };
  }

  parseDo() {
    this.next();
    this.skipNewlines();
    const body = this.parseStatement();
    this.skipSeparators();
    if (!this.atKw('while')) throw syntaxErrorAt(this.peek().line, this.describe(this.peek()));
    this.next();
    this.expectOp('(');
    const saved = this.noGt;
    this.noGt = 0;
    const condition = this.parseExpr();
    this.noGt = saved;
    this.expectOp(')');
    this.skipTerminators();
    return { t: 'do', body, condition };
  }

  parseFor() {
    this.next();
    this.expectOp('(');
    const saved = this.noGt;
    this.noGt = 0;
    if (this.atKind('name') && this.peek(1).k === 'kw' && this.peek(1).v === 'in') {
      const name = this.next().v;
      this.next();
      const array = this.expectName();
      this.expectOp(')');
      this.noGt = saved;
      this.skipNewlines();
      const body = this.parseStatement();
      return { t: 'forin', name, array, body };
    }
    let init = null;
    if (!this.atOp(';')) init = this.parseExpr();
    this.expectOp(';');
    this.skipNewlines();
    let condition = null;
    if (!this.atOp(';')) condition = this.parseExpr();
    this.expectOp(';');
    this.skipNewlines();
    let increment = null;
    if (!this.atOp(')')) increment = this.parseExpr();
    this.noGt = saved;
    this.expectOp(')');
    this.skipNewlines();
    const body = this.parseStatement();
    return { t: 'for', init, condition, increment, body };
  }

  parseJump(kind) {
    this.next();
    let value = null;
    if (!this.atTerminator()) {
      const saved = this.noGt;
      this.noGt = 0;
      value = this.parseExpr();
      this.noGt = saved;
    }
    this.skipTerminators();
    return { t: kind, value };
  }

  parseDelete() {
    this.next();
    const name = this.expectName();
    let index = null;
    if (this.atOp('[')) {
      this.next();
      const saved = this.noGt;
      this.noGt = 0;
      index = [this.parseExpr()];
      while (this.atOp(',')) {
        this.next();
        this.skipNewlines();
        index.push(this.parseExpr());
      }
      this.noGt = saved;
      this.expectOp(']');
    }
    this.skipTerminators();
    return { t: 'delete', name, index };
  }

  parenGroupInfo() {
    let depth = 0;
    let comma = false;
    for (let i = this.index; i < this.tokens.length; i += 1) {
      const token = this.tokens[i];
      if (token.k === 'eof') return { comma: false, after: i };
      if (token.k !== 'op') continue;
      if (token.v === '(' || token.v === '[') depth += 1;
      else if (token.v === ')' || token.v === ']') {
        depth -= 1;
        if (depth === 0) return { comma, after: i + 1 };
      } else if (token.v === ',' && depth === 1) {
        comma = true;
      }
    }
    return { comma: false, after: this.tokens.length };
  }

  parsePrint(isPrintf) {
    this.next();
    const args = [];
    let parenArgs = false;
    if (this.atOp('(')) {
      const info = this.parenGroupInfo();
      const after = this.tokens[info.after];
      parenArgs = info.comma && !(after !== undefined && after.k === 'kw' && after.v === 'in');
    }
    if (parenArgs) {
      this.next();
      const saved = this.noGt;
      this.noGt = 0;
      this.skipNewlines();
      if (!this.atOp(')')) {
        args.push(this.parseExpr());
        while (this.atOp(',')) {
          this.next();
          this.skipNewlines();
          args.push(this.parseExpr());
        }
      }
      this.noGt = saved;
      this.expectOp(')');
      while (this.atOp(',')) {
        this.next();
        this.skipNewlines();
        const savedArg = this.noGt;
        this.noGt = savedArg + 1;
        args.push(this.parseExpr());
        this.noGt = savedArg;
      }
    } else if (!this.atTerminator() && !this.atOp('>') && !this.atOp('>>') && !this.atOp('|')) {
      const saved = this.noGt;
      this.noGt = saved + 1;
      args.push(this.parseExpr());
      while (this.atOp(',')) {
        this.next();
        this.skipNewlines();
        args.push(this.parseExpr());
      }
      this.noGt = saved;
    }
    let redirect = null;
    if (this.atOp('>') || this.atOp('>>') || this.atOp('|')) {
      const op = this.next().v;
      const saved = this.noGt;
      this.noGt = 0;
      const target = this.parseConcat();
      this.noGt = saved;
      redirect = { op, target };
    }
    this.skipTerminators();
    return { t: isPrintf ? 'printf' : 'print', args, redirect };
  }

  // -------------------------------------------------------- expressions

  parseExpr() {
    return this.parseAssignment();
  }

  parseAssignment() {
    const left = this.parseTernary();
    if (this.atOp('|') && this.peek(1).k === 'kw' && this.peek(1).v === 'getline') {
      this.next();
      const node = this.parseGetline();
      node.pipe = left;
      return node;
    }
    const token = this.peek();
    if (token.k === 'op' && ASSIGN_OPS.has(token.v)) {
      if (!isLvalue(left)) throw syntaxErrorAt(token.line, this.describe(token));
      this.next();
      this.skipNewlines();
      const value = this.parseAssignment();
      return { t: 'assign', op: token.v, target: left, value };
    }
    return left;
  }

  parseTernary() {
    const condition = this.parseOr();
    if (this.atOp('?')) {
      this.next();
      this.skipNewlines();
      const yes = this.parseTernary();
      this.skipNewlines();
      this.expectOp(':');
      this.skipNewlines();
      const no = this.parseTernary();
      return { t: 'ternary', condition, yes, no };
    }
    return condition;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.atOp('||')) {
      this.next();
      this.skipNewlines();
      const right = this.parseAnd();
      left = { t: 'binary', op: '||', left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseIn();
    while (this.atOp('&&')) {
      this.next();
      this.skipNewlines();
      const right = this.parseIn();
      left = { t: 'binary', op: '&&', left, right };
    }
    return left;
  }

  parseIn() {
    let left = this.parseMatch();
    while (this.atKw('in')) {
      this.next();
      const array = this.expectName();
      left = { t: 'in', index: left, array };
    }
    return left;
  }

  parseMatch() {
    let left = this.parseRelational();
    while (this.atOp('~') || this.atOp('!~')) {
      const op = this.next().v;
      this.skipNewlines();
      const right = this.parseRelational();
      left = { t: 'binary', op, left, right };
    }
    return left;
  }

  parseRelational() {
    const left = this.parseConcat();
    const token = this.peek();
    if (token.k === 'op' && REL_OPS.has(token.v)) {
      if (token.v === '>' && this.noGt > 0) return left;
      this.next();
      this.skipNewlines();
      const right = this.parseConcat();
      return { t: 'binary', op: token.v, left, right };
    }
    return left;
  }

  startsConcatOperand() {
    const token = this.peek();
    if (token.k === 'num' || token.k === 'str' || token.k === 'regex' || token.k === 'name') return true;
    if (token.k === 'op') return token.v === '(' || token.v === '$';
    return false;
  }

  parseConcat() {
    let left = this.parseAdditive();
    while (this.startsConcatOperand()) {
      const right = this.parseAdditive();
      left = { t: 'binary', op: 'concat', left, right };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.atOp('+') || this.atOp('-')) {
      const op = this.next().v;
      this.skipNewlines();
      const right = this.parseMultiplicative();
      left = { t: 'binary', op, left, right };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.atOp('*') || this.atOp('/') || this.atOp('%')) {
      const op = this.next().v;
      this.skipNewlines();
      const right = this.parseUnary();
      left = { t: 'binary', op, left, right };
    }
    return left;
  }

  parseUnary() {
    if (this.atOp('-')) {
      this.next();
      return { t: 'unary', op: '-', expr: this.parseUnary() };
    }
    if (this.atOp('+')) {
      this.next();
      return { t: 'unary', op: '+', expr: this.parseUnary() };
    }
    if (this.atOp('!')) {
      this.next();
      return { t: 'unary', op: '!', expr: this.parseUnary() };
    }
    if (this.atOp('++') || this.atOp('--')) {
      const op = this.next().v;
      const target = this.parseUnary();
      if (!isLvalue(target)) throw syntaxErrorAt(this.peek().line, this.describe(this.peek()));
      return { t: 'inc', op, target, prefix: true };
    }
    return this.parsePow();
  }

  parsePow() {
    const base = this.parsePostfix();
    if (this.atOp('^') || this.atOp('**')) {
      this.next();
      this.skipNewlines();
      const exponent = this.parseUnary();
      return { t: 'binary', op: '^', left: base, right: exponent };
    }
    return base;
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      if (this.atOp('++') || this.atOp('--')) {
        if (!isLvalue(node)) throw syntaxErrorAt(this.peek().line, this.describe(this.peek()));
        node = { t: 'inc', op: this.next().v, target: node, prefix: false };
        continue;
      }
      return node;
    }
  }

  parsePrimary() {
    const token = this.peek();
    if (token.k === 'num') { this.next(); return { t: 'num', value: token.v }; }
    if (token.k === 'str') { this.next(); return { t: 'str', value: token.v }; }
    if (token.k === 'regex') { this.next(); return { t: 'regex', source: token.v }; }
    if (token.k === 'name') {
      this.next();
      if (this.atOp('(')) return this.parseCall(token.v);
      if (this.atOp('[')) {
        this.next();
        const saved = this.noGt;
        this.noGt = 0;
        const index = [this.parseExpr()];
        while (this.atOp(',')) {
          this.next();
          this.skipNewlines();
          index.push(this.parseExpr());
        }
        this.noGt = saved;
        this.expectOp(']');
        return { t: 'index', name: token.v, index };
      }
      if (token.v === 'length') return { t: 'call', name: 'length', args: [] };
      return { t: 'var', name: token.v };
    }
    if (token.k === 'op' && token.v === '$') {
      this.next();
      return { t: 'field', expr: this.parseFieldOperand() };
    }
    if (token.k === 'op' && token.v === '(') {
      this.next();
      const saved = this.noGt;
      this.noGt = 0;
      const parts = [this.parseExpr()];
      while (this.atOp(',')) {
        this.next();
        this.skipNewlines();
        parts.push(this.parseExpr());
      }
      this.noGt = saved;
      this.expectOp(')');
      if (parts.length > 1) return { t: 'subscript', list: parts };
      return parts[0];
    }
    if (token.k === 'kw' && token.v === 'getline') return this.parseGetline();
    throw syntaxErrorAt(token.line, this.describe(token));
  }

  parseFieldOperand() {
    const token = this.peek();
    if (token.k === 'op' && token.v === '(') {
      this.next();
      const saved = this.noGt;
      this.noGt = 0;
      const expr = this.parseExpr();
      this.noGt = saved;
      this.expectOp(')');
      return expr;
    }
    if (token.k === 'op' && token.v === '$') {
      this.next();
      return { t: 'field', expr: this.parseFieldOperand() };
    }
    if (token.k === 'op' && (token.v === '-' || token.v === '+')) {
      const op = this.next().v;
      return { t: 'unary', op, expr: this.parseFieldOperand() };
    }
    if (token.k === 'num') { this.next(); return { t: 'num', value: token.v }; }
    if (token.k === 'name') { this.next(); return { t: 'var', name: token.v }; }
    if (token.k === 'op' && (token.v === '++' || token.v === '--')) {
      const op = this.next().v;
      const target = this.parseFieldOperand();
      return { t: 'inc', op, target, prefix: true };
    }
    throw syntaxErrorAt(token.line, this.describe(token));
  }

  parseCall(name) {
    this.expectOp('(');
    const saved = this.noGt;
    this.noGt = 0;
    const args = [];
    this.skipNewlines();
    if (!this.atOp(')')) {
      args.push(this.parseExpr());
      while (this.atOp(',')) {
        this.next();
        this.skipNewlines();
        args.push(this.parseExpr());
      }
    }
    this.noGt = saved;
    this.expectOp(')');
    return { t: 'call', name, args };
  }

  parseGetline() {
    this.next();
    let target = null;
    if (this.atKind('name')) target = this.next().v;
    if (this.atOp('<')) {
      this.next();
      const saved = this.noGt;
      this.noGt = 0;
      const file = this.parseConcat();
      this.noGt = saved;
      return { t: 'getline', target, file, pipe: null };
    }
    return { t: 'getline', target, file: null, pipe: null };
  }
}

// ------------------------------------------------------------------ lexing

function scanNumber(source, start) {
  let pos = start;
  if (source[pos] === '0' && (source[pos + 1] === 'x' || source[pos + 1] === 'X')) {
    let end = pos + 2;
    let digits = '';
    while (end < source.length && isHexChar(source[end])) {
      digits += source[end];
      end += 1;
    }
    if (!digits) throw new AwkError('syntax error at source line 1 near 0x');
    return { value: Number.parseInt(digits, 16), end };
  }
  let text = '';
  while (pos < source.length && isDigitChar(source[pos])) {
    text += source[pos];
    pos += 1;
  }
  if (source[pos] === '.') {
    text += '.';
    pos += 1;
    while (pos < source.length && isDigitChar(source[pos])) {
      text += source[pos];
      pos += 1;
    }
  }
  if (source[pos] === 'e' || source[pos] === 'E') {
    let look = pos + 1;
    let exponent = '';
    if (source[look] === '+' || source[look] === '-') {
      exponent += source[look];
      look += 1;
    }
    if (isDigitChar(source[look])) {
      while (look < source.length && isDigitChar(source[look])) {
        exponent += source[look];
        look += 1;
      }
      text += 'e' + exponent;
      pos = look;
    }
  }
  if (text.length > 1 && text[0] === '0' && text.indexOf('.') < 0 && text.indexOf('e') < 0 && text.indexOf('E') < 0 && /^[0-7]+$/.test(text.slice(1))) {
    return { value: Number.parseInt(text, 8), end: pos };
  }
  return { value: Number(text), end: pos };
}

function scanString(source, start, line) {
  let pos = start + 1;
  let out = '';
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '"') return { value: out, end: pos + 1 };
    if (ch === '\n') throw new AwkError('newline in string at source line ' + line);
    if (ch === BS) {
      const decoded = decodeEscape(source, pos);
      out += decoded.value;
      pos = decoded.end;
      continue;
    }
    out += ch;
    pos += 1;
  }
  throw new AwkError('unterminated string at source line ' + line);
}

function scanRegex(source, start, line) {
  let pos = start + 1;
  let out = '';
  let inClass = false;
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === BS) {
      if (pos + 1 >= source.length) break;
      out += ch + source[pos + 1];
      pos += 2;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      out += ch;
      pos += 1;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      out += ch;
      pos += 1;
      continue;
    }
    if (ch === '/' && !inClass) return { value: out, end: pos + 1 };
    if (ch === '\n') break;
    out += ch;
    pos += 1;
  }
  throw new AwkError('unterminated regular expression at source line ' + line);
}

function tokenize(source) {
  const tokens = [];
  const total = source.length;
  let pos = 0;
  let line = 1;
  let expectOperand = true;

  const push = function pushToken(kind, value) {
    tokens.push({ k: kind, v: value, line });
    if (kind === 'nl' || kind === 'eof') return;
    if (kind === 'kw') {
      expectOperand = true;
      return;
    }
    if (kind === 'op') {
      if (value === '++' || value === '--') return;
      if (value === '}') {
        expectOperand = true;
        return;
      }
      if (value === ')' || value === ']') {
        expectOperand = false;
        return;
      }
      expectOperand = true;
      return;
    }
    expectOperand = false;
  };

  while (pos < total) {
    const ch = source[pos];
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pos += 1;
      continue;
    }
    if (ch === BS) {
      if (source[pos + 1] === '\n') {
        pos += 2;
        line += 1;
        continue;
      }
      throw syntaxErrorAt(line, "'" + ch + "'");
    }
    if (ch === '\n') {
      push('nl', '\n');
      line += 1;
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < total && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (isDigitChar(ch) || (ch === '.' && isDigitChar(source[pos + 1]))) {
      const scanned = scanNumber(source, pos);
      push('num', scanned.value);
      pos = scanned.end;
      continue;
    }
    if (ch === '"') {
      const scanned = scanString(source, pos, line);
      push('str', scanned.value);
      pos = scanned.end;
      continue;
    }
    if (ch === '/' && expectOperand) {
      const scanned = scanRegex(source, pos, line);
      push('regex', scanned.value);
      pos = scanned.end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = pos + 1;
      while (end < total && isNamePart(source[end])) end += 1;
      const word = source.slice(pos, end);
      push(KEYWORDS.has(word) ? 'kw' : 'name', word);
      pos = end;
      continue;
    }
    let matched = null;
    for (let i = 0; i < OPERATORS.length; i += 1) {
      if (source.startsWith(OPERATORS[i], pos)) {
        matched = OPERATORS[i];
        break;
      }
    }
    if (matched === null) throw syntaxErrorAt(line, "'" + ch + "'");
    push('op', matched);
    pos += matched.length;
  }
  tokens.push({ k: 'eof', v: '', line });
  return tokens;
}

// ------------------------------------------------------------------- input

function splitWhitespaceFields(text) {
  const trimmed = text.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
  if (trimmed === '') return [];
  return trimmed.split(/[ \t\n]+/);
}

function splitByRegex(text, regex) {
  const flags = regex.flags.indexOf('g') >= 0 ? regex.flags : regex.flags + 'g';
  const scanner = new RegExp(regex.source, flags);
  const parts = [];
  let last = 0;
  let match;
  while ((match = scanner.exec(text)) !== null) {
    if (match[0] === '') {
      scanner.lastIndex += 1;
      continue;
    }
    parts.push(text.slice(last, match.index));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function splitRecords(text, rs) {
  if (text === '') return [];
  if (rs === '\n') {
    const parts = text.split('\n');
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
  }
  if (rs === '') {
    const records = [];
    let pos = 0;
    while (pos < text.length) {
      while (pos < text.length && text[pos] === '\n') pos += 1;
      if (pos >= text.length) break;
      const stop = text.indexOf('\n\n', pos);
      if (stop < 0) {
        let tail = text.slice(pos);
        if (tail.length && tail[tail.length - 1] === '\n') tail = tail.slice(0, -1);
        if (tail !== '') records.push(tail);
        break;
      }
      records.push(text.slice(pos, stop));
      pos = stop + 1;
    }
    return records;
  }
  if (rs.length === 1) {
    const parts = text.split(rs);
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
  }
  const records = [];
  const scanner = compileEreGlobal(rs);
  let last = 0;
  let match;
  while ((match = scanner.exec(text)) !== null) {
    if (match[0] === '') {
      scanner.lastIndex += 1;
      continue;
    }
    records.push(text.slice(last, match.index));
    last = match.index + match[0].length;
  }
  records.push(text.slice(last));
  if (records.length && records[records.length - 1] === '') records.pop();
  return records;
}

function fieldValue(text) {
  return looksNumeric(text) ? new StrNum(text) : text;
}

function splitInputLines(text) {
  const parts = text.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function shellSplit(command) {
  const parts = [];
  let current = '';
  let started = false;
  let index = 0;
  while (index < command.length) {
    const ch = command[index];
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) {
        parts.push(current);
        current = '';
        started = false;
      }
      index += 1;
      continue;
    }
    if (ch === "'") {
      started = true;
      index += 1;
      while (index < command.length && command[index] !== "'") {
        current += command[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      started = true;
      index += 1;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === BS && index + 1 < command.length) {
          current += command[index + 1];
          index += 2;
          continue;
        }
        current += command[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (ch === BS && index + 1 < command.length) {
      current += command[index + 1];
      started = true;
      index += 2;
      continue;
    }
    current += ch;
    started = true;
    index += 1;
  }
  if (started) parts.push(current);
  return parts;
}

class InputReader {
  constructor(rt, entries) {
    this.rt = rt;
    this.entries = entries;
    this.entryIndex = 0;
    this.records = null;
    this.position = 0;
    this.name = '';
  }

  loadNext() {
    while (this.entryIndex < this.entries.length) {
      const entry = this.entries[this.entryIndex];
      this.entryIndex += 1;
      if (entry.kind === 'assign') {
        this.rt.applyAssignment(entry.text);
        continue;
      }
      let text;
      if (entry.kind === 'stdin') text = this.rt.stdinText();
      else text = this.rt.readFileText(entry.name);
      this.name = entry.kind === 'stdin' ? '-' : entry.name;
      this.records = splitRecords(text, this.rt.rs());
      this.position = 0;
      this.rt.beginFile(this.name);
      return true;
    }
    return false;
  }

  next(applyRecord) {
    for (;;) {
      if (this.records !== null && this.position < this.records.length) {
        const text = this.records[this.position];
        this.position += 1;
        this.rt.startRecord(text, applyRecord !== false);
        return text;
      }
      if (!this.loadNext()) return null;
    }
  }

  skipFile() {
    if (this.records !== null) this.position = this.records.length;
  }
}

// --------------------------------------------------------------- runtime

class Runtime {
  constructor(program, ctx, options) {
    this.program = program;
    this.ctx = ctx;
    this.fs = ctx.fs;
    this.cwd = options.cwd;
    this.stdinValue = options.stdin === undefined || options.stdin === null ? '' : options.stdin;
    this.options = options;
    this.globals = new Map();
    this.frames = [];
    this.record = '';
    this.fields = [''];
    this.nf = 0;
    this.out = [];
    this.err = [];
    this.files = new Map();
    this.pipes = new Map();
    this.openFiles = new Map();
    this.pipeStreams = new Map();
    this.rangeState = [];
    this.reader = null;
    this.exitCode = 0;
    this.exited = false;
    this.seed = 0;
    this.lastSeed = 0;
    this.ticks = 0;
  }

  // ----------------------------------------------------------- setup

  setup() {
    this.globals.set('FS', ' ');
    this.globals.set('OFS', ' ');
    this.globals.set('ORS', '\n');
    this.globals.set('RS', '\n');
    this.globals.set('CONVFMT', '%.6g');
    this.globals.set('OFMT', '%.6g');
    this.globals.set('SUBSEP', SUBSEP_DEFAULT);
    this.globals.set('NR', 0);
    this.globals.set('NF', 0);
    this.globals.set('FNR', 0);
    this.globals.set('FILENAME', '');
    this.globals.set('RSTART', 0);
    this.globals.set('RLENGTH', -1);
    const environ = new Map();
    const env = this.ctx.env;
    if (env instanceof Map) {
      for (const entry of env.entries()) environ.set(String(entry[0]), String(entry[1]));
    } else if (env && typeof env === 'object') {
      const keys = Object.keys(env);
      for (let i = 0; i < keys.length; i += 1) environ.set(keys[i], String(env[keys[i]]));
    }
    this.globals.set('ENVIRON', environ);
    const argv = new Map();
    argv.set('0', 'awk');
    const operands = this.options.operands;
    for (let i = 0; i < operands.length; i += 1) argv.set(String(i + 1), operands[i].argv);
    this.globals.set('ARGV', argv);
    this.globals.set('ARGC', operands.length + 1);
    for (let i = 0; i < this.options.assigns.length; i += 1) {
      const assign = this.options.assigns[i];
      this.setVar(assign.name, fieldValue(assign.value));
    }
    if (this.options.fs !== null && this.options.fs !== undefined) this.globals.set('FS', this.options.fs);
  }

  applyAssignment(text) {
    const at = text.indexOf('=');
    if (at < 0) return;
    const name = text.slice(0, at);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    this.setVar(name, fieldValue(unescapeText(text.slice(at + 1))));
  }

  convFmt() {
    const value = this.globals.get('CONVFMT');
    return typeof value === 'string' ? value : '%.6g';
  }

  ofmt() {
    const value = this.globals.get('OFMT');
    return typeof value === 'string' ? value : '%.6g';
  }

  rs() {
    const value = this.globals.get('RS');
    return typeof value === 'string' ? value : '\n';
  }

  stdinText() {
    return this.stdinValue;
  }

  tick() {
    this.ticks += 1;
    if ((this.ticks & 0x3FF) === 0 && this.ctx && typeof this.ctx.check === 'function') this.ctx.check();
  }

  // ----------------------------------------------------------- values

  scalar(value) {
    if (value instanceof RegexValue) return this.matchRecord(value) ? 1 : 0;
    return value;
  }

  matchRecord(regexValue) {
    return regexValue.regex.test(this.record);
  }

  getVar(name) {
    if (this.frames.length) {
      const frame = this.frames[this.frames.length - 1];
      if (frame.vars.has(name)) return frame.vars.get(name);
      if (frame.params.has(name)) return EMPTY_VALUE;
    }
    if (this.globals.has(name)) return this.globals.get(name);
    return EMPTY_VALUE;
  }

  setVar(name, value) {
    if (this.frames.length) {
      const frame = this.frames[this.frames.length - 1];
      if (frame.params.has(name)) {
        frame.vars.set(name, value);
        return;
      }
    }
    if (name === 'NF') {
      this.setNF(toNum(value, this));
      return;
    }
    this.globals.set(name, value);
  }

  arrayFor(name) {
    const existing = this.getVar(name);
    if (existing instanceof Map) return existing;
    const created = new Map();
    if (this.frames.length) {
      const frame = this.frames[this.frames.length - 1];
      const ref = frame.refs ? frame.refs.get(name) : null;
      if (ref) {
        if (ref.frame) ref.frame.vars.set(ref.name, created);
        else this.globals.set(ref.name, created);
      }
    }
    this.setVar(name, created);
    return created;
  }

  subscriptKey(values) {
    const separator = toStr(this.globals.get('SUBSEP'), this);
    let key = '';
    for (let i = 0; i < values.length; i += 1) {
      if (i > 0) key += separator;
      key += toStr(values[i], this);
    }
    return key;
  }

  // ----------------------------------------------------------- records

  fieldSeparator() {
    return toStr(this.globals.get('FS'), this);
  }

  splitRecordText(text, plain) {
    const fs = this.fieldSeparator();
    const paragraph = !plain && this.rs() === '';
    if (fs === ' ') return splitWhitespaceFields(text);
    if (fs === '') return text === '' ? [] : Array.from(text);
    if (fs.length === 1) {
      if (text === '') return [];
      if (paragraph) {
        const parts = [];
        let current = '';
        for (let i = 0; i < text.length; i += 1) {
          if (text[i] === fs || text[i] === '\n') {
            parts.push(current);
            current = '';
            continue;
          }
          current += text[i];
        }
        parts.push(current);
        return parts;
      }
      return text.split(fs);
    }
    const source = paragraph ? '(?:' + ereToJs(fs) + '|\n)' : ereToJs(fs);
    return splitByRegex(text, new RegExp(source));
  }

  setRecord(text) {
    this.record = text;
    const parts = this.splitRecordText(text);
    const fields = [text];
    for (let i = 0; i < parts.length; i += 1) fields.push(fieldValue(parts[i]));
    this.fields = fields;
    this.nf = parts.length;
    this.globals.set('NF', this.nf);
  }

  getField(index) {
    if (index < 0) throw new AwkError('attempt to access field ' + index);
    if (index === 0) return fieldValue(this.record);
    if (index <= this.nf) return this.fields[index];
    return EMPTY_VALUE;
  }

  setField(index, value) {
    if (index < 0) throw new AwkError('attempt to access field ' + index);
    if (index === 0) {
      this.setRecord(toStr(value, this));
      return;
    }
    while (this.fields.length <= index) this.fields.push('');
    this.fields[index] = value;
    if (index > this.nf) this.nf = index;
    this.rebuildRecord();
  }

  rebuildRecord() {
    const ofs = toStr(this.globals.get('OFS'), this);
    let text = '';
    for (let i = 1; i <= this.nf; i += 1) {
      if (i > 1) text += ofs;
      text += toStr(this.fields[i], this);
    }
    this.record = text;
    this.globals.set('NF', this.nf);
  }

  setNF(count) {
    const size = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
    while (this.fields.length <= size) this.fields.push('');
    this.fields.length = size + 1;
    this.nf = size;
    this.rebuildRecord();
  }

  beginFile(name) {
    this.globals.set('FILENAME', name);
    this.globals.set('FNR', 0);
  }

  startRecord(text, applyFields) {
    this.globals.set('NR', toNumRaw(this.globals.get('NR')) + 1);
    this.globals.set('FNR', toNumRaw(this.globals.get('FNR')) + 1);
    if (applyFields) this.setRecord(text);
  }

  readFileText(path) {
    try {
      return this.fs.readText(path, this.cwd);
    } catch (error) {
      if (error instanceof ShellError) {
        const reason = ERRNO_TEXT[error.code] || error.message || 'I/O error';
        throw new AwkError("cannot open file '" + path + "' for reading: " + reason);
      }
      throw error;
    }
  }

  // ----------------------------------------------------------- output

  write(text) {
    this.out.push(text);
  }

  bufferFile(path, text, append) {
    let entry = this.files.get(path);
    if (!entry) {
      entry = { chunks: [], append };
      this.files.set(path, entry);
    }
    entry.chunks.push(text);
  }

  closeFile(path) {
    const entry = this.files.get(path);
    if (!entry) return -1;
    this.files.delete(path);
    try {
      this.fs.writeText(path, this.cwd, entry.chunks.join(''), { append: entry.append });
    } catch (error) {
      if (error instanceof ShellError) {
        const reason = ERRNO_TEXT[error.code] || error.message || 'I/O error';
        throw new AwkError("cannot write to '" + path + "': " + reason);
      }
      throw error;
    }
    return 0;
  }

  bufferPipe(command, text) {
    let entry = this.pipes.get(command);
    if (!entry) {
      entry = { chunks: [] };
      this.pipes.set(command, entry);
    }
    entry.chunks.push(text);
  }

  closePipe(command) {
    const entry = this.pipes.get(command);
    if (!entry) return -1;
    this.pipes.delete(command);
    return this.runShell(command, entry.chunks.join(''));
  }

  runShell(command, input) {
    const argv = shellSplit(command);
    if (argv.length === 0) return 0;
    let result = null;
    const shell = this.ctx.shell;
    if (shell && typeof shell.execSync === 'function') {
      try {
        result = shell.execSync(argv, input);
      } catch (error) {
        result = null;
      }
    }
    if (!result || typeof result !== 'object' || !('code' in result)) {
      result = this.ctx && typeof this.ctx.runCommand === 'function'
        ? this.ctx.runCommand(argv)
        : { code: 0, stdout: '', stderr: '' };
    }
    if (result && typeof result.stdout === 'string' && result.stdout !== '') this.out.push(result.stdout);
    if (result && typeof result.stderr === 'string' && result.stderr !== '') this.err.push(result.stderr);
    return result && typeof result.code === 'number' ? result.code : 0;
  }

  flushAll() {
    const fileNames = Array.from(this.files.keys());
    for (let i = 0; i < fileNames.length; i += 1) this.closeFile(fileNames[i]);
    const commands = Array.from(this.pipes.keys());
    for (let i = 0; i < commands.length; i += 1) this.closePipe(commands[i]);
  }

  redirect(redirect, text) {
    if (!redirect) {
      this.out.push(text);
      return;
    }
    const target = toStr(this.eval(redirect.target), this);
    if (redirect.op === '>') this.bufferFile(target, text, false);
    else if (redirect.op === '>>') this.bufferFile(target, text, true);
    else this.bufferPipe(target, text);
  }

  executePrint(node) {
    const ofs = toStr(this.globals.get('OFS'), this);
    const ors = toStr(this.globals.get('ORS'), this);
    let text;
    if (node.args.length === 0) {
      text = toOutStr(this.getField(0), this);
    } else {
      let joined = '';
      for (let i = 0; i < node.args.length; i += 1) {
        if (i > 0) joined += ofs;
        joined += toOutStr(this.eval(node.args[i]), this);
      }
      text = joined;
    }
    this.redirect(node.redirect, text + ors);
  }

  executePrintf(node) {
    if (node.args.length === 0) throw new AwkError('printf: no format string');
    const format = toStr(this.eval(node.args[0]), this);
    const values = [];
    for (let i = 1; i < node.args.length; i += 1) values.push(this.eval(node.args[i]));
    this.redirect(node.redirect, formatOutput(format, values, this));
  }

  // -------------------------------------------------------- expressions

  fieldIndex(expr) {
    const value = toNum(this.eval(expr), this);
    const index = Math.trunc(value);
    if (!Number.isFinite(index)) throw new AwkError('attempt to access field ' + value);
    return index;
  }

  eval(node) {
    switch (node.t) {
      case 'num':
        return node.value;
      case 'str':
        return node.value;
      case 'regex':
        return new RegexValue(node.source);
      case 'var':
        return this.getVar(node.name);
      case 'field':
        return this.getField(this.fieldIndex(node.expr));
      case 'index': {
        const array = this.arrayFor(node.name);
        const key = this.subscriptKey(node.index.map((item) => this.eval(item), this));
        if (!array.has(key)) return EMPTY_VALUE;
        return array.get(key);
      }
      case 'assign':
        return this.evalAssign(node);
      case 'inc':
        return this.evalInc(node);
      case 'unary':
        return this.evalUnary(node);
      case 'binary':
        return this.evalBinary(node);
      case 'ternary':
        return truthy(this.eval(node.condition), this) ? this.eval(node.yes) : this.eval(node.no);
      case 'in': {
        const array = this.arrayFor(node.array);
        const key = node.index.t === 'subscript'
          ? this.subscriptKey(node.index.list.map((item) => this.eval(item), this))
          : this.subscriptKey([this.eval(node.index)], this);
        return array.has(key) ? 1 : 0;
      }
      case 'call':
        return this.callFunction(node.name, node.args);
      case 'getline':
        return this.evalGetline(node);
      default:
        throw new AwkError('internal: unknown expression ' + node.t);
    }
  }

  assign(target, value) {
    if (target.t === 'var') {
      this.setVar(target.name, value);
      return;
    }
    if (target.t === 'field') {
      this.setField(this.fieldIndex(target.expr), value);
      return;
    }
    if (target.t === 'index') {
      const array = this.arrayFor(target.name);
      array.set(this.subscriptKey(target.index.map((item) => this.eval(item), this)), value);
      return;
    }
    throw new AwkError('assignment to a non-lvalue');
  }

  evalAssign(node) {
    if (node.op === '=') {
      const value = this.eval(node.value);
      this.assign(node.target, value);
      return value;
    }
    const current = toNum(this.eval(node.target), this);
    const right = toNum(this.eval(node.value), this);
    const op = node.op === '**=' ? '^' : node.op.slice(0, -1);
    const value = this.arithmetic(op, current, right);
    this.assign(node.target, value);
    return value;
  }

  evalInc(node) {
    const current = toNum(this.eval(node.target), this);
    const next = current + (node.op === '++' ? 1 : -1);
    this.assign(node.target, next);
    return node.prefix ? next : current;
  }

  evalUnary(node) {
    if (node.op === '!') return truthy(this.eval(node.expr), this) ? 0 : 1;
    const value = toNum(this.eval(node.expr), this);
    return node.op === '-' ? -value : value;
  }

  arithmetic(op, left, right) {
    switch (op) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/':
        if (right === 0) throw new AwkError('division by zero attempted');
        return left / right;
      case '%':
        if (right === 0) throw new AwkError('division by zero attempted in %');
        return left % right;
      case '^': return Math.pow(left, right);
      default: throw new AwkError('internal: unknown operator ' + op);
    }
  }

  evalBinary(node) {
    const op = node.op;
    if (op === '&&') {
      return truthy(this.eval(node.left), this) && truthy(this.eval(node.right), this) ? 1 : 0;
    }
    if (op === '||') {
      return truthy(this.eval(node.left), this) || truthy(this.eval(node.right), this) ? 1 : 0;
    }
    if (op === 'concat') {
      return toStr(this.eval(node.left), this) + toStr(this.eval(node.right), this);
    }
    if (op === '~' || op === '!~') {
      const text = toStr(this.eval(node.left), this);
      const pattern = this.regexOperand(node.right);
      const matched = pattern.test(text);
      return (op === '~' ? matched : !matched) ? 1 : 0;
    }
    if (REL_OPS.has(op)) {
      const order = compareValues(this.eval(node.left), this.eval(node.right), this);
      switch (op) {
        case '<': return order < 0 ? 1 : 0;
        case '<=': return order <= 0 ? 1 : 0;
        case '>': return order > 0 ? 1 : 0;
        case '>=': return order >= 0 ? 1 : 0;
        case '==': return order === 0 ? 1 : 0;
        default: return order !== 0 ? 1 : 0;
      }
    }
    const left = toNum(this.eval(node.left), this);
    const right = toNum(this.eval(node.right), this);
    return this.arithmetic(op, left, right);
  }

  regexOperand(node) {
    if (node.t === 'regex') return new RegexValue(node.source).regex;
    const value = this.eval(node);
    if (value instanceof RegexValue) return value.regex;
    return compileEre(toStr(value, this));
  }

  // --------------------------------------------------------- statements

  executeList(list) {
    for (let i = 0; i < list.length; i += 1) this.execute(list[i]);
  }

  execute(node) {
    switch (node.t) {
      case 'block':
        this.executeList(node.body);
        return;
      case 'empty':
        return;
      case 'expr':
        this.eval(node.expression);
        return;
      case 'print':
        this.executePrint(node);
        return;
      case 'printf':
        this.executePrintf(node);
        return;
      case 'if':
        if (truthy(this.eval(node.condition), this)) this.execute(node.then);
        else if (node.otherwise) this.execute(node.otherwise);
        return;
      case 'while':
        while (truthy(this.eval(node.condition), this)) {
          try {
            this.execute(node.body);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
          this.tick();
        }
        return;
      case 'do':
        for (;;) {
          try {
            this.execute(node.body);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
          if (!truthy(this.eval(node.condition), this)) break;
          this.tick();
        }
        return;
      case 'for':
        if (node.init) this.eval(node.init);
        for (;;) {
          if (node.condition && !truthy(this.eval(node.condition), this)) break;
          try {
            this.execute(node.body);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
          if (node.increment) this.eval(node.increment);
          this.tick();
        }
        return;
      case 'forin': {
        const array = this.arrayFor(node.array);
        const keys = Array.from(array.keys());
        for (let i = 0; i < keys.length; i += 1) {
          this.setVar(node.name, keys[i]);
          try {
            this.execute(node.body);
          } catch (signal) {
            if (signal instanceof BreakSignal) break;
            if (!(signal instanceof ContinueSignal)) throw signal;
          }
          this.tick();
        }
        return;
      }
      case 'break':
        throw new BreakSignal();
      case 'continue':
        throw new ContinueSignal();
      case 'next':
        throw new NextSignal();
      case 'nextfile':
        throw new NextFileSignal();
      case 'exit': {
        const code = node.value ? Math.trunc(toNum(this.eval(node.value), this)) : null;
        throw new ExitSignal(code);
      }
      case 'return':
        throw new ReturnSignal(node.value ? this.eval(node.value) : EMPTY_VALUE);
      case 'delete': {
        const array = this.arrayFor(node.name);
        if (node.index) array.delete(this.subscriptKey(node.index.map((item) => this.eval(item), this)));
        else array.clear();
        return;
      }
      default:
        throw new AwkError('internal: unknown statement ' + node.t);
    }
  }

  // ---------------------------------------------------------- functions

  callUserFunction(fn, args, argNodes) {
    if (this.frames.length > 400) throw new AwkError('function call nesting too deep');
    const caller = this.frames.length ? this.frames[this.frames.length - 1] : null;
    const frame = { vars: new Map(), params: new Set(fn.params), refs: new Map() };
    for (let i = 0; i < fn.params.length; i += 1) {
      const value = i < args.length ? args[i] : EMPTY_VALUE;
      frame.vars.set(fn.params[i], value);
      const node = argNodes && argNodes[i];
      if (node && node.t === 'var') frame.refs.set(fn.params[i], { frame: caller, name: node.name });
    }
    this.frames.push(frame);
    try {
      this.executeList(fn.body);
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.value;
      throw signal;
    } finally {
      this.frames.pop();
    }
    return EMPTY_VALUE;
  }

  // -------------------------------------------------------- main flow

  run() {
    this.setup();
    this.openInput();
    try {
      this.executeList(this.program.begin);
    } catch (signal) {
      if (signal instanceof ExitSignal) {
        this.exited = true;
        if (signal.code !== null) this.exitCode = signal.code;
      } else if (signal instanceof NextSignal || signal instanceof NextFileSignal) {
        throw new AwkError('next used in BEGIN');
      } else {
        throw signal;
      }
    }
    if (!this.exited) this.runMainLoop();
    try {
      this.executeList(this.program.end);
    } catch (signal) {
      if (signal instanceof ExitSignal) {
        if (signal.code !== null) this.exitCode = signal.code;
      } else if (signal instanceof NextSignal || signal instanceof NextFileSignal) {
        throw new AwkError('next used in END');
      } else {
        throw signal;
      }
    }
    this.flushAll();
  }

  openInput() {
    if (this.reader) return;
    let entries = this.options.operands;
    let hasInput = false;
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].kind !== 'assign') hasInput = true;
    }
    if (!hasInput) entries = entries.concat([{ kind: 'stdin', name: '-', text: '-', argv: '-' }]);
    this.reader = new InputReader(this, entries);
  }

  runMainLoop() {
    this.openInput();
    for (;;) {
      const text = this.reader.next(true);
      if (text === null) break;
      try {
        this.runRules();
      } catch (signal) {
        if (signal instanceof NextSignal) continue;
        if (signal instanceof NextFileSignal) {
          this.reader.skipFile();
          continue;
        }
        if (signal instanceof ExitSignal) {
          this.exited = true;
          if (signal.code !== null) this.exitCode = signal.code;
          break;
        }
        throw signal;
      }
      this.tick();
    }
  }

  runRules() {
    const rules = this.program.rules;
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      let matched;
      if (rule.first === null) {
        matched = true;
      } else if (rule.second === null) {
        matched = truthy(this.eval(rule.first), this);
      } else if (this.rangeState[i]) {
        matched = true;
      } else {
        matched = truthy(this.eval(rule.first), this);
        if (matched) this.rangeState[i] = true;
      }
      if (!matched) continue;
      if (rule.action) this.executeList(rule.action);
      else this.executePrint({ t: 'print', args: [], redirect: null });
      if (rule.second !== null && this.rangeState[i]) {
        if (truthy(this.eval(rule.second), this)) this.rangeState[i] = false;
      }
    }
  }

  getStreams() {
    if (!this.streams) this.streams = new Map();
    return this.streams;
  }

  streamFor(key, loader) {
    const streams = this.getStreams();
    let stream = streams.get(key);
    if (!stream) {
      stream = { lines: splitInputLines(loader()), index: 0 };
      streams.set(key, stream);
    }
    return stream;
  }

  captureShell(command) {
    const argv = shellSplit(command);
    if (argv.length === 0) return '';
    const shell = this.ctx.shell;
    if (shell && typeof shell.execSync === 'function') {
      try {
        const result = shell.execSync(argv, '');
        if (result && typeof result === 'object' && typeof result.stdout === 'string') return result.stdout;
      } catch (error) {
        return '';
      }
    }
    if (this.ctx && typeof this.ctx.runCommand === 'function') {
      const result = this.ctx.runCommand(argv);
      if (result && typeof result.stdout === 'string') return result.stdout;
    }
    return '';
  }

  evalGetline(node) {
    if (node.pipe) {
      const command = toStr(this.eval(node.pipe), this);
      const stream = this.streamFor('|' + command, () => this.captureShell(command));
      const line = stream.lines[stream.index];
      if (line === undefined) return 0;
      stream.index += 1;
      if (node.target) this.setVar(node.target, fieldValue(line));
      else this.setRecord(line);
      return 1;
    }
    if (node.file) {
      const name = toStr(this.eval(node.file), this);
      let stream;
      try {
        stream = this.streamFor('<' + name, () => this.readFileText(name));
      } catch (error) {
        if (error instanceof AwkError) return -1;
        throw error;
      }
      const line = stream.lines[stream.index];
      if (line === undefined) return 0;
      stream.index += 1;
      if (node.target) this.setVar(node.target, fieldValue(line));
      else this.setRecord(line);
      return 1;
    }
    if (!this.reader) return 0;
    const text = this.reader.next(!node.target);
    if (text === null) return 0;
    if (node.target) this.setVar(node.target, fieldValue(text));
    return 1;
  }

  splitWith(text, node) {
    if (node.t === 'regex') return splitByRegex(text, new RegexValue(node.source).regex);
    const separator = toStr(this.eval(node), this);
    if (separator === ' ') return splitWhitespaceFields(text);
    if (separator === '') return text === '' ? [] : Array.from(text);
    if (separator.length === 1) return text === '' ? [] : text.split(separator);
    return splitByRegex(text, compileEre(separator));
  }

  nextRandom() {
    let x = this.seed | 0;
    if (x === 0) x = 0x9E3779B9;
    x ^= x << 13;
    x |= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x |= 0;
    this.seed = x;
    return (x >>> 0) / 4294967296;
  }

  flushFile(path) {
    const entry = this.files.get(path);
    if (!entry) return 1;
    try {
      this.fs.writeText(path, this.cwd, entry.chunks.join(''), { append: entry.append });
    } catch (error) {
      if (error instanceof ShellError) {
        const reason = ERRNO_TEXT[error.code] || error.message || 'I/O error';
        throw new AwkError("cannot write to '" + path + "': " + reason);
      }
      throw error;
    }
    entry.chunks = [];
    entry.append = true;
    return 0;
  }

  flushPipe(command) {
    const entry = this.pipes.get(command);
    if (!entry) return 1;
    const text = entry.chunks.join('');
    entry.chunks = [];
    this.runShell(command, text);
    return 0;
  }

  callFunction(name, argNodes) {
    const fn = this.program.funcs.get(name);
    if (fn) {
      const args = [];
      for (let i = 0; i < argNodes.length; i += 1) args.push(this.eval(argNodes[i]));
      return this.callUserFunction(fn, args, argNodes);
    }
    return this.callBuiltin(name, argNodes);
  }

  needArgs(name, nodes, count) {
    if (nodes.length < count) throw new AwkError(name + ': not enough arguments');
  }

  callBuiltin(name, nodes) {
    switch (name) {
      case 'length': {
        if (nodes.length === 0) return Array.from(this.record).length;
        const value = this.eval(nodes[0]);
        if (isArray(value)) return value.size;
        return Array.from(toStr(value, this)).length;
      }
      case 'substr': {
        this.needArgs(name, nodes, 2);
        const text = toStr(this.eval(nodes[0]), this);
        const start = Math.trunc(toNum(this.eval(nodes[1]), this));
        let position = start < 1 ? 1 : start;
        const characters = Array.from(text);
        if (nodes.length > 2) {
          const length = Math.trunc(toNum(this.eval(nodes[2]), this));
          if (length <= 0 || position > characters.length) return '';
          return characters.slice(position - 1, position - 1 + length).join('');
        }
        if (position > characters.length) return '';
        return characters.slice(position - 1).join('');
      }
      case 'index': {
        this.needArgs(name, nodes, 2);
        const haystack = toStr(this.eval(nodes[0]), this);
        const needle = toStr(this.eval(nodes[1]), this);
        return haystack.indexOf(needle) + 1;
      }
      case 'split': {
        this.needArgs(name, nodes, 2);
        const text = toStr(this.eval(nodes[0]), this);
        const arrayNode = nodes[1];
        if (!arrayNode || arrayNode.t !== 'var') throw new AwkError('split: second argument must be an array name');
        const array = this.arrayFor(arrayNode.name);
        array.clear();
        const parts = nodes.length > 2 ? this.splitWith(text, nodes[2]) : this.splitRecordText(text, true);
        for (let i = 0; i < parts.length; i += 1) array.set(String(i + 1), fieldValue(parts[i]));
        return parts.length;
      }
      case 'sub':
      case 'gsub': {
        this.needArgs(name, nodes, 2);
        const regex = asRegex(this, nodes[0]);
        const replacement = toStr(this.eval(nodes[1]), this);
        const target = nodes.length > 2 ? nodes[2] : null;
        if (target && !isLvalue(target)) throw new AwkError(name + ': third argument is not an lvalue');
        const text = target ? toStr(this.eval(target), this) : this.record;
        const outcome = substitute(text, regex, replacement, name === 'gsub');
        if (target) this.assign(target, outcome.text);
        else this.setRecord(outcome.text);
        return outcome.count;
      }
      case 'match': {
        this.needArgs(name, nodes, 2);
        const text = toStr(this.eval(nodes[0]), this);
        const regex = asRegex(this, nodes[1]);
        const found = regex.exec(text);
        if (!found) {
          this.globals.set('RSTART', 0);
          this.globals.set('RLENGTH', -1);
          return 0;
        }
        const start = found.index + 1;
        this.globals.set('RSTART', start);
        this.globals.set('RLENGTH', found[0].length);
        return start;
      }
      case 'sprintf': {
        this.needArgs(name, nodes, 1);
        const format = toStr(this.eval(nodes[0]), this);
        const values = [];
        for (let i = 1; i < nodes.length; i += 1) values.push(this.eval(nodes[i]));
        return formatOutput(format, values, this);
      }
      case 'toupper':
        this.needArgs(name, nodes, 1);
        return toStr(this.eval(nodes[0]), this).toUpperCase();
      case 'tolower':
        this.needArgs(name, nodes, 1);
        return toStr(this.eval(nodes[0]), this).toLowerCase();
      case 'int':
        this.needArgs(name, nodes, 1);
        return Math.trunc(toNum(this.eval(nodes[0]), this));
      case 'sqrt':
        this.needArgs(name, nodes, 1);
        return Math.sqrt(toNum(this.eval(nodes[0]), this));
      case 'exp':
        this.needArgs(name, nodes, 1);
        return Math.exp(toNum(this.eval(nodes[0]), this));
      case 'log':
        this.needArgs(name, nodes, 1);
        return Math.log(toNum(this.eval(nodes[0]), this));
      case 'sin':
        this.needArgs(name, nodes, 1);
        return Math.sin(toNum(this.eval(nodes[0]), this));
      case 'cos':
        this.needArgs(name, nodes, 1);
        return Math.cos(toNum(this.eval(nodes[0]), this));
      case 'atan2': {
        this.needArgs(name, nodes, 2);
        const y = toNum(this.eval(nodes[0]), this);
        const x = toNum(this.eval(nodes[1]), this);
        return Math.atan2(y, x);
      }
      case 'rand':
        return this.nextRandom();
      case 'srand': {
        const previous = this.lastSeed;
        let seed;
        if (nodes.length > 0) seed = Math.trunc(toNum(this.eval(nodes[0]), this));
        else seed = Math.floor(Date.now() / 1000) % 2147483647;
        this.seed = seed | 0;
        this.lastSeed = seed;
        return previous;
      }
      case 'system': {
        this.needArgs(name, nodes, 1);
        return this.runShell(toStr(this.eval(nodes[0]), this), '');
      }
      case 'close': {
        this.needArgs(name, nodes, 1);
        const target = toStr(this.eval(nodes[0]), this);
        if (this.files.has(target)) return this.closeFile(target);
        if (this.pipes.has(target)) return this.closePipe(target);
        const streams = this.getStreams();
        if (streams.has('<' + target)) {
          streams.delete('<' + target);
          return 0;
        }
        if (streams.has('|' + target)) {
          streams.delete('|' + target);
          return 0;
        }
        return -1;
      }
      case 'fflush': {
        if (nodes.length === 0) {
          const fileNames = Array.from(this.files.keys());
          for (let i = 0; i < fileNames.length; i += 1) this.flushFile(fileNames[i]);
          const commands = Array.from(this.pipes.keys());
          for (let i = 0; i < commands.length; i += 1) this.flushPipe(commands[i]);
          return 0;
        }
        const target = toStr(this.eval(nodes[0]), this);
        if (this.files.has(target)) return this.flushFile(target);
        if (this.pipes.has(target)) return this.flushPipe(target);
        return -1;
      }
      default:
        throw new AwkError("function '" + name + "' not defined");
    }
  }
}

// ---------------------------------------------------------- functions

function expandReplacement(replacement, matchText) {
  let out = '';
  for (let i = 0; i < replacement.length; i += 1) {
    const ch = replacement[i];
    if (ch === '\\') {
      const next = replacement[i + 1];
      if (next === undefined) {
        out += '\\';
        break;
      }
      if (next === '&') {
        out += '&';
        i += 1;
        continue;
      }
      if (next === '\\') {
        if (replacement[i + 2] === '&') {
          out += '\\' + matchText;
          i += 2;
          continue;
        }
        out += '\\';
        i += 1;
        continue;
      }
      out += next;
      i += 1;
      continue;
    }
    if (ch === '&') {
      out += matchText;
      continue;
    }
    out += ch;
  }
  return out;
}

function substitute(text, regex, replacement, global) {
  const pattern = global ? compileEreGlobal(regex.source) : new RegExp(regex.source);
  let out = '';
  let count = 0;
  let pos = 0;
  let prevEnd = -1;
  for (;;) {
    if (pos > text.length) break;
    pattern.lastIndex = pos;
    const match = pattern.exec(text);
    if (match === null) break;
    const start = match.index;
    const size = match[0].length;
    if (size === 0 && start === prevEnd) {
      if (start >= text.length) break;
      out += text.slice(pos, start + 1);
      pos = start + 1;
      continue;
    }
    out += text.slice(pos, start);
    out += expandReplacement(replacement, match[0]);
    count += 1;
    prevEnd = start + size;
    if (size === 0) {
      if (start >= text.length) {
        pos = start;
        break;
      }
      out += text[start];
      pos = start + 1;
    } else {
      pos = start + size;
    }
    if (!global) break;
  }
  out += text.slice(pos);
  return { text: out, count };
}

function asRegex(rt, node) {
  if (node && node.t === 'regex') return new RegexValue(node.source).regex;
  const value = rt.eval(node);
  if (value instanceof RegexValue) return value.regex;
  return compileEre(toStr(value, rt));
}

// -------------------------------------------------------------------- cli

const USAGE = "usage: awk [-F fs] [-v var=value] ['program' | -f progfile] [file ...]";

function readProgramFile(ctx, path) {
  try {
    if (path === '-') return ctx.stdin === undefined || ctx.stdin === null ? '' : String(ctx.stdin);
    return ctx.fs.readText(path, ctx.cwd === undefined ? '/' : ctx.cwd);
  } catch (error) {
    if (error instanceof ShellError) {
      const reason = ERRNO_TEXT[error.code] || error.message || 'I/O error';
      throw new AwkError("can't open file " + path + ' for reading: ' + reason);
    }
    throw error;
  }
}

function parseInvocation(args, ctx) {
  const sources = [];
  const assigns = [];
  const operands = [];
  let fs = null;
  let programText = null;
  let index = 0;
  let sawOption = false;

  while (index < args.length) {
    const arg = args[index];
    if (programText !== null) {
      operands.push(arg);
      index += 1;
      continue;
    }
    if (arg === '--') {
      index += 1;
      sawOption = true;
      break;
    }
    if (arg === '--help') return { help: true };
    if (arg === '--version') return { version: true };
    if (arg === '-') {
      programText = '-';
      index += 1;
      break;
    }
    if (arg.length > 1 && arg[0] === '-') {
      sawOption = true;
      const flag = arg[1];
      if (flag === 'F') {
        let value;
        if (arg.length > 2) {
          value = arg.slice(2);
          index += 1;
        } else {
          if (index + 1 >= args.length) throw new AwkError('option requires an argument -- F');
          value = args[index + 1];
          index += 2;
        }
        fs = unescapeText(value);
        continue;
      }
      if (flag === 'v') {
        let value;
        if (arg.length > 2) {
          value = arg.slice(2);
          index += 1;
        } else {
          if (index + 1 >= args.length) throw new AwkError('option requires an argument -- v');
          value = args[index + 1];
          index += 2;
        }
        const at = value.indexOf('=');
        if (at < 0) throw new AwkError('invalid -v argument: ' + value);
        const name = value.slice(0, at);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AwkError('invalid -v argument: ' + value);
        assigns.push({ name, value: unescapeText(value.slice(at + 1)) });
        continue;
      }
      if (flag === 'f') {
        let value;
        if (arg.length > 2) {
          value = arg.slice(2);
          index += 1;
        } else {
          if (index + 1 >= args.length) throw new AwkError('option requires an argument -- f');
          value = args[index + 1];
          index += 2;
        }
        sources.push(readProgramFile(ctx, value));
        continue;
      }
      if (flag === 'e') {
        let value;
        if (arg.length > 2) {
          value = arg.slice(2);
          index += 1;
        } else {
          if (index + 1 >= args.length) throw new AwkError('option requires an argument -- e');
          value = args[index + 1];
          index += 2;
        }
        sources.push(value);
        continue;
      }
      throw new AwkError('unknown option ' + arg);
    }
    programText = arg;
    index += 1;
    break;
  }

  while (index < args.length) {
    operands.push(args[index]);
    index += 1;
  }

  let program;
  if (sources.length) {
    program = sources.join('\n');
    if (programText !== null && programText !== '-') operands.unshift(programText);
  } else if (programText !== null) {
    program = programText === '-' ? readProgramFile(ctx, '-') : programText;
  } else {
    throw new AwkError('no program text at all');
  }

  const entries = [];
  for (let i = 0; i < operands.length; i += 1) {
    const operand = operands[i];
    if (operand === '-') {
      entries.push({ kind: 'stdin', name: '-', text: '-', argv: '-' });
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(operand);
    if (match) {
      entries.push({ kind: 'assign', name: match[1], text: operand, value: match[2], argv: operand });
      continue;
    }
    entries.push({ kind: 'file', name: operand, text: operand, argv: operand });
  }

  return { help: false, version: false, program, fs, assigns, operands: entries, sawOption };
}

export function main(prog, argv, ctx) {
  const args = argv.slice();
  if (args.length && args[0] === prog) args.shift();
  let runtime = null;
  try {
    const invocation = parseInvocation(args, ctx);
    if (invocation.help) return { code: 0, out: USAGE + '\n', err: '' };
    if (invocation.version) return { code: 0, out: 'awk (dsh-strong-skills) 1.0\n', err: '' };
    const parser = new Parser(tokenize(invocation.program));
    const program = parser.parseProgram();
    runtime = new Runtime(program, ctx, {
      cwd: ctx.cwd === undefined ? '/' : ctx.cwd,
      stdin: ctx.stdin,
      fs: invocation.fs,
      assigns: invocation.assigns,
      operands: invocation.operands,
    });
    runtime.run();
    return { code: runtime.exitCode, out: runtime.out.join(''), err: runtime.err.join('') };
  } catch (error) {
    const outText = runtime ? runtime.out.join('') : '';
    const errText = runtime ? runtime.err.join('') : '';
    if (error instanceof AwkError) {
      return { code: error.code || 2, out: outText, err: errText + prog + ': ' + error.message + '\n' };
    }
    if (error instanceof ExitSignal) {
      return { code: error.code === null || error.code === undefined ? 0 : error.code, out: outText, err: errText };
    }
    if (error instanceof ShellError) {
      const reason = ERRNO_TEXT[error.code] || error.message || 'I/O error';
      return { code: 2, out: outText, err: errText + prog + ': ' + reason + '\n' };
    }
    throw error;
  }
}
