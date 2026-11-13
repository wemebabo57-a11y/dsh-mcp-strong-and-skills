// Coreutils: date, seq, digest sums, path names, which, sleep, printenv, hostname.
// Every entry point here is synchronous: no await, no promises, no timers.
import os from 'node:os';
import { createHash } from 'node:crypto';
import { formatError, usageError, parseOptions, splitLines } from '../io.mjs';

export const names = [
  'basename',
  'date',
  'dirname',
  'false',
  'hostname',
  'md5sum',
  'printenv',
  'realpath',
  'seq',
  'sha256sum',
  'sleep',
  'true',
  'which',
];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MAX_SEQ_VALUES = 1000000;

/* ------------------------------------------------------------------ helpers */

function cwdOf(ctx) {
  return ctx && typeof ctx.cwd === 'string' && ctx.cwd.startsWith('/') ? ctx.cwd : '/';
}

function stdinOf(ctx) {
  return ctx && typeof ctx.stdin === 'string' ? ctx.stdin : '';
}

function check(ctx) {
  if (ctx && typeof ctx.check === 'function') ctx.check();
}

function envName(ctx) {
  return ctx ? ctx.env : null;
}

function envGet(ctx, name) {
  const env = envName(ctx);
  if (!env) return undefined;
  const wanted = String(name);
  if (typeof env.get === 'function') {
    const direct = env.get(wanted);
    if (direct !== undefined) return String(direct);
    for (const [key, value] of env) {
      if (String(key).toLowerCase() === wanted.toLowerCase()) return String(value);
    }
    return undefined;
  }
  if (typeof env !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(env, wanted)) return String(env[wanted]);
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted.toLowerCase()) return String(env[key]);
  }
  return undefined;
}

function envEntries(ctx) {
  const env = envName(ctx);
  if (!env) return [];
  if (typeof env.get === 'function') {
    const list = [];
    for (const [key, value] of env) list.push([String(key), String(value)]);
    return list;
  }
  if (typeof env !== 'object') return [];
  return Object.keys(env).map(key => [key, String(env[key])]);
}

function padNumber(value, width, fill) {
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value));
  const filler = fill === undefined ? '0' : fill;
  const body = digits.length >= width ? digits : filler.repeat(width - digits.length) + digits;
  return sign + body;
}

// GNU's '#' flag selects the alternate case: lowercase a text that already has
// an uppercase letter, uppercase it otherwise (never mix cases inside a word).
function alternateCase(text) {
  return text === text.toLowerCase() ? text.toUpperCase() : text.toLowerCase();
}

function normaliseVirtualPath(input) {
  const text = String(input).replace(/\\/g, '/');
  const parts = text.split('/').filter(segment => segment.length > 0 && segment !== '.');
  const out = [];
  for (const segment of parts) {
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return '/' + out.join('/');
}

function absoluteVirtualPath(input, cwd) {
  const text = String(input).replace(/\\/g, '/');
  if (/^[A-Za-z]:[\\/]/.test(text)) return normaliseVirtualPath(text);
  if (text.startsWith('/')) return normaliseVirtualPath(text);
  return normaliseVirtualPath(cwd + '/' + text);
}

function baseNameOf(name) {
  if (name === '') return '';
  let end = name.length;
  while (end > 1 && name[end - 1] === '/') end--;
  const trimmed = name.slice(0, end);
  if (/^\/+$/.test(trimmed)) return '/';
  const at = trimmed.lastIndexOf('/');
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

function dirNameOf(name) {
  if (name === '') return '.';
  let end = name.length;
  while (end > 1 && name[end - 1] === '/') end--;
  const trimmed = name.slice(0, end);
  if (/^\/+$/.test(trimmed)) return '/';
  const at = trimmed.lastIndexOf('/');
  if (at < 0) return '.';
  const prefix = trimmed.slice(0, at).replace(/\/+$/, '');
  return prefix === '' ? '/' : prefix;
}

/* --------------------------------------------------------------------- date */

function daysInMonth(year, month) {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return lengths[month - 1];
}

function validCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function dayOfYear(year, month0, day) {
  const start = Date.UTC(year, 0, 1);
  const current = Date.UTC(year, month0, day);
  return Math.round((current - start) / 86400000) + 1;
}

function isoWeekInfo(year, month0, day) {
  const date = new Date(Date.UTC(year, month0, day));
  const weekDay = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekDay + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { week, year: isoYear };
}

function formatOffset(minutes, colons) {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  const hours = padNumber(Math.floor(absolute / 60), 2);
  const rest = padNumber(absolute % 60, 2);
  if (colons === 0) return sign + hours + rest;
  if (colons === 1) return sign + hours + ':' + rest;
  return sign + hours + ':' + rest + ':00';
}

function timeZoneName(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date);
    const found = parts.find(part => part.type === 'timeZoneName');
    if (found && found.value) return found.value;
  } catch {
    // Fall through to the numeric form below.
  }
  return formatOffset(-date.getTimezoneOffset(), 1);
}

function buildFields(date, utc) {
  let year;
  let month0;
  let day;
  let hours;
  let minutes;
  let seconds;
  let milliseconds;
  let weekDay;
  if (utc) {
    year = date.getUTCFullYear();
    month0 = date.getUTCMonth();
    day = date.getUTCDate();
    hours = date.getUTCHours();
    minutes = date.getUTCMinutes();
    seconds = date.getUTCSeconds();
    milliseconds = date.getUTCMilliseconds();
    weekDay = date.getUTCDay();
  } else {
    year = date.getFullYear();
    month0 = date.getMonth();
    day = date.getDate();
    hours = date.getHours();
    minutes = date.getMinutes();
    seconds = date.getSeconds();
    milliseconds = date.getMilliseconds();
    weekDay = date.getDay();
  }
  const iso = isoWeekInfo(year, month0, day);
  return {
    date,
    utc,
    year,
    month0,
    day,
    hours,
    minutes,
    seconds,
    milliseconds,
    weekDay,
    dayOfYear: dayOfYear(year, month0, day),
    isoWeek: iso.week,
    isoYear: iso.year,
    offsetMinutes: utc ? 0 : -date.getTimezoneOffset(),
  };
}

function applyWidth(text, mods, defaultWidth, defaultFill) {
  let body = text;
  const width = mods.width || defaultWidth || 0;
  let fill = defaultFill === undefined ? '0' : defaultFill;
  if (mods.flags.includes('_')) fill = ' ';
  else if (mods.flags.includes('0')) fill = '0';
  if (mods.flags.includes('-')) {
    if (mods.width && body.length < mods.width) body += ' '.repeat(mods.width - body.length);
    return body;
  }
  if (width && body.length < width) {
    const missing = width - body.length;
    if (fill === '0' && body.length > 0 && (body[0] === '-' || body[0] === '+')) {
      body = body[0] + '0'.repeat(missing) + body.slice(1);
    } else {
      body = fill.repeat(missing) + body;
    }
  }
  return body;
}

function directiveText(key, f, mods) {
  const hour12 = f.hours % 12 === 0 ? 12 : f.hours % 12;
  switch (key) {
    case '%': return '%';
    case 'n': return '\n';
    case 't': return '\t';
    case 'Y': return applyWidth(padNumber(f.year, 4), mods, 4, '0');
    case 'y': return applyWidth(padNumber(((f.year % 100) + 100) % 100, 2), mods, 2, '0');
    case 'C': return applyWidth(padNumber(Math.floor(f.year / 100), 2), mods, 2, '0');
    case 'm': return applyWidth(padNumber(f.month0 + 1, 2), mods, 2, '0');
    case 'd': return applyWidth(padNumber(f.day, 2), mods, 2, '0');
    case 'e': return applyWidth(padNumber(f.day, 2, ' '), mods, 2, ' ');
    case 'H': return applyWidth(padNumber(f.hours, 2), mods, 2, '0');
    case 'k': return applyWidth(padNumber(f.hours, 2, ' '), mods, 2, ' ');
    case 'I': return applyWidth(padNumber(hour12, 2), mods, 2, '0');
    case 'l': return applyWidth(padNumber(hour12, 2, ' '), mods, 2, ' ');
    case 'M': return applyWidth(padNumber(f.minutes, 2), mods, 2, '0');
    case 'S': return applyWidth(padNumber(f.seconds, 2), mods, 2, '0');
    case 'N': return applyWidth(padNumber(f.milliseconds, 3) + '000000', mods, 9, '0');
    case 'j': return applyWidth(padNumber(f.dayOfYear, 3), mods, 3, '0');
    case 's': return String(Math.floor(f.date.getTime() / 1000));
    case 'u': return String(f.weekDay === 0 ? 7 : f.weekDay);
    case 'w': return String(f.weekDay);
    case 'a': return applyWidth(DAYS_SHORT[f.weekDay], mods, 0, ' ');
    case 'A': return applyWidth(DAYS_LONG[f.weekDay], mods, 0, ' ');
    case 'b':
    case 'h': return applyWidth(MONTHS_SHORT[f.month0], mods, 0, ' ');
    case 'B': return applyWidth(MONTHS_LONG[f.month0], mods, 0, ' ');
    case 'p': return f.hours < 12 ? 'AM' : 'PM';
    case 'P': return f.hours < 12 ? 'am' : 'pm';
    case 'Z': return f.utc ? 'UTC' : timeZoneName(f.date);
    case 'z': return formatOffset(f.offsetMinutes, mods.colons);
    case 'F': return formatFields(f.date, '%Y-%m-%d', f.utc);
    case 'T': return formatFields(f.date, '%H:%M:%S', f.utc);
    case 'R': return formatFields(f.date, '%H:%M', f.utc);
    case 'D': return formatFields(f.date, '%m/%d/%y', f.utc);
    case 'c': return formatFields(f.date, '%a %b %e %H:%M:%S %Y', f.utc);
    case 'x': return formatFields(f.date, '%m/%d/%y', f.utc);
    case 'X': return formatFields(f.date, '%H:%M:%S', f.utc);
    case 'q': return String(Math.floor(f.month0 / 3) + 1);
    case 'V': return applyWidth(padNumber(f.isoWeek, 2), mods, 2, '0');
    case 'G': return applyWidth(padNumber(f.isoYear, 4), mods, 4, '0');
    case 'g': return applyWidth(padNumber(((f.isoYear % 100) + 100) % 100, 2), mods, 2, '0');
    default: return '%' + key;
  }
}

function formatFields(date, format, utc) {
  const f = buildFields(date, utc);
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch !== '%') { out += ch; continue; }
    if (i + 1 >= format.length) { out += '%'; break; }
    i++;
    let flags = '';
    while (i < format.length && '-_0^#'.includes(format[i])) { flags += format[i]; i++; }
    let widthText = '';
    while (i < format.length && format[i] >= '0' && format[i] <= '9') { widthText += format[i]; i++; }
    let colons = 0;
    while (i < format.length && format[i] === ':') { colons++; i++; }
    if (i < format.length && (format[i] === 'E' || format[i] === 'O')) i++;
    if (i >= format.length) { out += '%'; break; }
    const key = format[i];
    let text = directiveText(key, f, { flags, width: widthText ? Number(widthText) : 0, colons });
    if (key !== '%' && key !== 'n' && key !== 't') {
      if (flags.includes('^')) text = text.toUpperCase();
      else if (flags.includes('#')) text = alternateCase(text);
    }
    out += text;
  }
  return out;
}

function parseDateValue(input, utc) {
  const value = String(input).trim();
  if (!value) return null;
  const epoch = /^@(-?\d+(?:\.\d+)?)$/.exec(value);
  if (epoch) {
    const seconds = Number(epoch[1]);
    if (!Number.isFinite(seconds)) return null;
    return seconds * 1000;
  }
  const lowered = value.toLowerCase();
  const dayLength = 86400000;
  if (lowered === 'now') return Date.now();
  if (lowered === 'today' || lowered === 'yesterday' || lowered === 'tomorrow') {
    const now = new Date();
    const base = utc
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      : new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const shift = lowered === 'yesterday' ? -dayLength : lowered === 'tomorrow' ? dayLength : 0;
    return base + shift;
  }
  const full = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    const hours = full[4] === undefined ? 0 : Number(full[4]);
    const minutes = full[5] === undefined ? 0 : Number(full[5]);
    const seconds = full[6] === undefined ? 0 : Number(full[6]);
    const fraction = full[7] === undefined ? 0 : Number('0.' + full[7]);
    if (!validCalendarDate(year, month, day)) return null;
    if (hours > 23 || minutes > 59 || seconds > 60) return null;
    const milliseconds = Math.floor(fraction * 1000);
    const zone = full[8];
    if (zone && zone !== 'Z' && zone !== 'z') {
      const sign = zone[0] === '-' ? -1 : 1;
      const digits = zone.slice(1).replace(':', '');
      const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
      return Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds) - offset * 60000;
    }
    if (utc || zone) return Date.UTC(year, month - 1, day, hours, minutes, seconds, milliseconds);
    return new Date(year, month - 1, day, hours, minutes, seconds, milliseconds).getTime();
  }
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(value);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const seconds = clock[3] === undefined ? 0 : Number(clock[3]);
    const fraction = clock[4] === undefined ? 0 : Number('0.' + clock[4]);
    if (hours > 23 || minutes > 59 || seconds > 60) return null;
    const milliseconds = Math.floor(fraction * 1000);
    const now = new Date();
    if (utc) {
      return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, seconds, milliseconds);
    }
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, seconds, milliseconds).getTime();
  }
  return null;
}

function runDate(prog, argv, ctx) {
  const normalized = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '-d' || token === '--date') && argv[i + 1] === '') { normalized.push('--date='); i++; continue; }
    if ((token === '-r' || token === '--reference') && argv[i + 1] === '') { normalized.push('--reference='); i++; continue; }
    normalized.push(token);
  }
  const parsed = parseOptions(normalized, {
    u: 'bool',
    utc: 'bool',
    r: 'value',
    reference: 'value',
    d: 'value',
    date: 'value',
    s: 'value',
    set: 'value',
    R: 'bool',
    'rfc-email': 'bool',
    debug: 'bool',
    help: 'bool',
    version: 'bool',
  });
  if (parsed.error) return usageError(prog, parsed.error);

  const utc = parsed.opts.has('u') || parsed.opts.has('utc');
  const dateText = parsed.opts.get('d') ?? parsed.opts.get('date');
  const reference = parsed.opts.get('r') ?? parsed.opts.get('reference');
  const toSet = parsed.opts.get('s') ?? parsed.opts.get('set');
  if (dateText !== undefined && reference !== undefined) {
    return { code: 1, out: '', err: prog + ': the options to specify dates for printing are mutually exclusive\n' };
  }
  if (toSet !== undefined) {
    const target = parseDateValue(toSet, utc);
    if (target === null) return { code: 1, out: '', err: prog + ": invalid date '" + toSet + "'\n" };
    return { code: 1, out: '', err: prog + ': cannot set date: Operation not permitted\n' };
  }

  let format = null;
  for (const operand of parsed.args) {
    if (operand.startsWith('+') && format === null) {
      format = operand.slice(1);
      continue;
    }
    if (operand.startsWith('+')) return { code: 1, out: '', err: prog + ": extra operand '" + operand + "'\n" };
    const attempted = parseDateValue(operand, utc);
    if (attempted === null) return { code: 1, out: '', err: prog + ": invalid date '" + operand + "'\n" };
    return { code: 1, out: '', err: prog + ': cannot set date: Operation not permitted\n' };
  }

  let when = Date.now();
  if (dateText !== undefined) {
    const value = parseDateValue(dateText, utc);
    if (value === null) return { code: 1, out: '', err: prog + ": invalid date '" + dateText + "'\n" };
    when = value;
  } else if (reference !== undefined) {
    try {
      const info = ctx.fs.stat(reference, cwdOf(ctx));
      when = info.mtimeMs;
    } catch (error) {
      return { code: 1, out: '', err: formatError(prog, reference, error && error.code ? error.code : 'ENOENT') };
    }
  }

  if (parsed.opts.has('R') || parsed.opts.has('rfc-email')) {
    if (format === null) format = '%a, %d %b %Y %H:%M:%S %z';
  }
  if (format === null) format = '%a %b %e %H:%M:%S %Z %Y';
  return { code: 0, out: formatFields(new Date(when), format, utc) + '\n', err: '' };
}

/* ---------------------------------------------------------------------- seq */

function parseSeqNumber(text) {
  const raw = String(text);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const exponentAt = raw.search(/[eE]/);
  const mantissa = exponentAt < 0 ? raw : raw.slice(0, exponentAt);
  const exponent = exponentAt < 0 ? 0 : Number(raw.slice(exponentAt + 1));
  const dot = mantissa.indexOf('.');
  const decimals = dot < 0 ? 0 : mantissa.length - dot - 1;
  return { value, precision: Math.max(0, decimals - exponent) };
}

function exponentialFormat(value, precision) {
  const text = value.toExponential(precision);
  const parts = text.split('e');
  const exponent = Number(parts[1]);
  const sign = exponent < 0 ? '-' : '+';
  return parts[0] + 'e' + sign + String(Math.abs(exponent)).padStart(2, '0');
}

function stripTrailingZeros(text) {
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '');
  if (trimmed.endsWith('.')) return trimmed.slice(0, -1);
  return trimmed;
}

function generalFormat(value, precision, alternate, upper) {
  const requested = precision === undefined || precision === null ? 6 : precision;
  const digits = requested === 0 ? 1 : requested;
  let body;
  if (Number.isNaN(value)) body = 'nan';
  else if (!Number.isFinite(value)) body = value > 0 ? 'inf' : '-inf';
  else if (value === 0) body = alternate ? '0.' + '0'.repeat(digits - 1) : '0';
  else {
    const rounded = Number(value.toPrecision(digits));
    const exponent = Number(rounded.toExponential(digits - 1).split('e')[1]);
    if (exponent < -4 || exponent >= digits) {
      const scientific = rounded.toExponential(digits - 1).split('e');
      const mantissa = alternate ? scientific[0] : stripTrailingZeros(scientific[0]);
      body = mantissa + 'e' + (exponent < 0 ? '-' : '+') + String(Math.abs(exponent)).padStart(2, '0');
    } else {
      const decimals = digits - 1 - exponent;
      const fixed = rounded.toFixed(Math.max(0, decimals));
      body = alternate ? fixed : stripTrailingZeros(fixed);
    }
  }
  return upper ? body.toUpperCase() : body;
}

function padNumeric(body, spec) {
  let text = body;
  const width = spec.width || 0;
  if (text.length >= width) return text;
  const missing = width - text.length;
  if (spec.flags.includes('-')) return text + ' '.repeat(missing);
  if (spec.flags.includes('0') && !/^[\s+-]*(?:inf|nan)/i.test(text)) {
    if (text.length > 0 && (text[0] === '-' || text[0] === '+' || text[0] === ' ')) {
      return text[0] + '0'.repeat(missing) + text.slice(1);
    }
    return '0'.repeat(missing) + text;
  }
  return ' '.repeat(missing) + text;
}

function formatFloatValue(value, spec) {
  const conv = spec.conv.toLowerCase();
  const upper = spec.conv !== conv;
  const precision = spec.precision === null || spec.precision === undefined ? 6 : spec.precision;
  let body;
  if (Number.isNaN(value)) body = 'nan';
  else if (!Number.isFinite(value)) body = value > 0 ? 'inf' : '-inf';
  else if (conv === 'f') body = value.toFixed(Math.min(precision, 100));
  else if (conv === 'e') body = exponentialFormat(value, Math.min(precision, 100));
  else if (conv === 'g') body = generalFormat(value, precision, spec.flags.includes('#'), false);
  else body = String(value);
  if (upper) body = body.toUpperCase();
  if (value >= 0 && !Number.isNaN(value) && Number.isFinite(value)) {
    if (spec.flags.includes('+')) body = '+' + body;
    else if (spec.flags.includes(' ')) body = ' ' + body;
  }
  return padNumeric(body, spec);
}

function parsePrintfFormat(format) {
  let prefix = '';
  let suffix = '';
  let spec = null;
  let conversions = 0;
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch !== '%') {
      if (spec) suffix += ch;
      else prefix += ch;
      continue;
    }
    if (format[i + 1] === '%') {
      if (spec) suffix += '%';
      else prefix += '%';
      i++;
      continue;
    }
    let j = i + 1;
    let flags = '';
    while (j < format.length && '-+ 0#'.includes(format[j])) { flags += format[j]; j++; }
    let widthText = '';
    while (j < format.length && format[j] >= '0' && format[j] <= '9') { widthText += format[j]; j++; }
    let precision = null;
    if (format[j] === '.') {
      j++;
      let digits = '';
      while (j < format.length && format[j] >= '0' && format[j] <= '9') { digits += format[j]; j++; }
      precision = digits === '' ? 0 : Number(digits);
    }
    const conv = format[j];
    if (conv === undefined || !'efgEFG'.includes(conv)) return { error: 'has unknown % directive' };
    conversions++;
    if (conversions > 1) return { error: 'has too many % directives' };
    spec = { flags, width: widthText === '' ? 0 : Number(widthText), precision, conv };
    i = j;
  }
  if (conversions === 0) return { error: 'has no % directive' };
  return { prefix, suffix, spec };
}

function renderSeqValue(value, precision) {
  if (precision > 0) return value.toFixed(Math.min(precision, 100));
  if (Number.isInteger(value)) return String(value);
  return generalFormat(value, 10, false, false);
}

function outOfRange(value, last, step) {
  const tolerance = Math.max(Math.abs(value), Math.abs(last), Math.abs(step), 1) * 8 * Number.EPSILON;
  return step > 0 ? value > last + tolerance : value < last - tolerance;
}

function runSeq(prog, argv, ctx) {
  const normalized = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if ((token === '-s' || token === '--separator') && argv[i + 1] === '') { normalized.push('--separator='); i++; continue; }
    if ((token === '-f' || token === '--format') && argv[i + 1] === '') { normalized.push('--format='); i++; continue; }
    normalized.push(token);
  }
  const parsed = parseOptions(normalized, {
    s: 'value',
    separator: 'value',
    w: 'bool',
    'equal-width': 'bool',
    f: 'value',
    format: 'value',
    help: 'bool',
    version: 'bool',
  });
  if (parsed.error) return usageError(prog, parsed.error);

  const separator = parsed.opts.get('s') ?? parsed.opts.get('separator') ?? '\n';
  const equalWidth = parsed.opts.has('w') || parsed.opts.has('equal-width');
  const formatText = parsed.opts.get('f') ?? parsed.opts.get('format');
  if (formatText !== undefined && equalWidth) {
    return { code: 1, out: '', err: prog + ': format string may not be specified when printing equal width strings\n' };
  }
  const args = parsed.args;
  if (args.length === 0) return { code: 1, out: '', err: prog + ': missing operand\n' };
  if (args.length > 3) return { code: 1, out: '', err: prog + ": extra operand '" + args[3] + "'\n" };

  const numbers = [];
  let precision = 0;
  for (const token of args) {
    const number = parseSeqNumber(token);
    if (!number) {
      return { code: 1, out: '', err: prog + ": invalid floating point argument: '" + token + "'\n" };
    }
    numbers.push(number.value);
    precision = Math.max(precision, number.precision);
  }

  let first;
  let step;
  let last;
  if (numbers.length === 1) {
    first = 1;
    step = 1;
    last = numbers[0];
  } else if (numbers.length === 2) {
    first = numbers[0];
    step = 1;
    last = numbers[1];
  } else {
    first = numbers[0];
    step = numbers[1];
    last = numbers[2];
  }
  if (step === 0) {
    return { code: 1, out: '', err: prog + ": invalid Zero increment value: '" + (numbers.length === 3 ? args[1] : args[0]) + "'\n" };
  }

  let formatted = null;
  if (formatText !== undefined) {
    formatted = parsePrintfFormat(formatText);
    if (formatted.error) {
      return { code: 1, out: '', err: prog + ": format '" + formatText + "' " + formatted.error + '\n' };
    }
  }

  const values = [];
  let truncated = true;
  for (let index = 0; index < MAX_SEQ_VALUES; index++) {
    const value = first + index * step;
    if (outOfRange(value, last, step)) { truncated = false; break; }
    values.push(value);
    if (index % 8192 === 0) check(ctx);
  }
  if (truncated) return { code: 1, out: '', err: prog + ': sequence too long\n' };
  if (!values.length) return { code: 0, out: '', err: '' };

  let rendered = values.map(value => {
    if (formatted) return formatted.prefix + formatFloatValue(value, formatted.spec) + formatted.suffix;
    return renderSeqValue(value, precision);
  });
  if (equalWidth) {
    let width = 0;
    for (const text of rendered) width = Math.max(width, text.length);
    rendered = rendered.map(text => text.padStart(width, '0'));
  }
  return { code: 0, out: rendered.join(separator) + '\n', err: '' };
}

/* ------------------------------------------------------------ digest sums */

function digestOf(algorithm, buffer) {
  return createHash(algorithm).update(buffer).digest('hex');
}

function readDigestInput(ctx, prog, target) {
  if (target === '-') return { buffer: Buffer.from(stdinOf(ctx), 'utf8'), error: null };
  try {
    return { buffer: ctx.fs.readBuffer(target, cwdOf(ctx)), error: null };
  } catch (error) {
    const code = error && error.code ? error.code : 'ENOENT';
    return { buffer: null, error: formatError(prog, target, code) };
  }
}

function runDigestDefault(prog, args, ctx, algorithm) {
  const targets = args.length ? args : ['-'];
  let out = '';
  let err = '';
  let code = 0;
  for (const target of targets) {
    const input = readDigestInput(ctx, prog, target);
    if (input.error) {
      err += input.error;
      code = 1;
      continue;
    }
    out += digestOf(algorithm, input.buffer) + '  ' + target + '\n';
  }
  return { code, out, err };
}

function runDigestCheck(prog, options, ctx, algorithm) {
  const checkFile = options.file;
  const quiet = options.quiet;
  const status = options.status;
  const strict = options.strict;
  const ignoreMissing = options.ignoreMissing;
  const hashLength = algorithm === 'md5' ? 32 : 64;
  let text;
  if (checkFile === '-') {
    text = stdinOf(ctx);
  } else {
    try {
      text = ctx.fs.readText(checkFile, cwdOf(ctx));
    } catch (error) {
      return { code: 1, out: '', err: formatError(prog, checkFile, error && error.code ? error.code : 'ENOENT') };
    }
  }
  let out = '';
  let err = '';
  let misformatted = 0;
  let unreadable = 0;
  let mismatched = 0;
  for (const line of splitLines(text)) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('\\')) { misformatted++; continue; }
    const digest = line.slice(0, hashLength);
    if (digest.length !== hashLength || !/^[0-9a-fA-F]+$/.test(digest)) { misformatted++; continue; }
    let rest = line.slice(hashLength);
    if (rest.startsWith(' *')) rest = rest.slice(2);
    else if (rest.startsWith('  ')) rest = rest.slice(2);
    else if (rest.startsWith(' ')) rest = rest.slice(1);
    else { misformatted++; continue; }
    if (!rest) { misformatted++; continue; }
    const name = rest;
    let buffer;
    if (name === '-') {
      buffer = Buffer.from(stdinOf(ctx), 'utf8');
    } else {
      try {
        buffer = ctx.fs.readBuffer(name, cwdOf(ctx));
      } catch (error) {
        const code = error && error.code ? error.code : 'ENOENT';
        if (ignoreMissing && code === 'ENOENT') continue;
        if (!status) {
          err += formatError(prog, name, code);
          out += name + ': FAILED open or read\n';
        }
        unreadable++;
        continue;
      }
    }
    if (digestOf(algorithm, buffer) === digest.toLowerCase()) {
      if (!quiet && !status) out += name + ': OK\n';
    } else {
      if (!status) out += name + ': FAILED\n';
      mismatched++;
    }
  }
  if (!status) {
    if (misformatted) {
      err += prog + ': WARNING: ' + misformatted + (misformatted === 1 ? ' line is improperly formatted' : ' lines are improperly formatted') + '\n';
    }
    if (unreadable) {
      err += prog + ': WARNING: ' + unreadable + (unreadable === 1 ? ' listed file could not be read' : ' listed files could not be read') + '\n';
    }
    if (mismatched) {
      err += prog + ': WARNING: ' + mismatched + (mismatched === 1 ? ' computed checksum did NOT match' : ' computed checksums did NOT match') + '\n';
    }
  }
  const code = mismatched || unreadable || (strict && misformatted) ? 1 : 0;
  return { code, out, err };
}

function runDigest(prog, argv, ctx, algorithm) {
  const parsed = parseOptions(argv, {
    b: 'bool',
    binary: 'bool',
    t: 'bool',
    text: 'bool',
    c: 'value',
    check: 'value',
    status: 'bool',
    q: 'bool',
    quiet: 'bool',
    strict: 'bool',
    w: 'bool',
    warn: 'bool',
    'ignore-missing': 'bool',
    help: 'bool',
    version: 'bool',
  });
  if (parsed.error) return usageError(prog, parsed.error);
  const checkFile = parsed.opts.get('c') ?? parsed.opts.get('check');
  if (checkFile !== undefined) {
    return runDigestCheck(prog, {
      file: checkFile,
      quiet: parsed.opts.has('q') || parsed.opts.has('quiet'),
      status: parsed.opts.has('status'),
      strict: parsed.opts.has('strict'),
      ignoreMissing: parsed.opts.has('ignore-missing'),
    }, ctx, algorithm);
  }
  const checkOnly = ['status', 'strict', 'quiet'].find(name => parsed.opts.has(name));
  if (checkOnly !== undefined) {
    return { code: 1, out: '', err: prog + ': the --' + checkOnly + ' option is meaningful only when verifying checksums\n' };
  }
  return runDigestDefault(prog, parsed.args, ctx, algorithm);
}

/* --------------------------------------------------------------- basename */

function stripSuffix(name, suffix) {
  if (!suffix) return name;
  if (name === suffix) return name;
  if (!name.endsWith(suffix)) return name;
  return name.slice(0, name.length - suffix.length);
}

function runBasename(prog, argv) {
  const parsed = parseOptions(argv, {
    a: 'bool',
    multiple: 'bool',
    s: 'value',
    suffix: 'value',
    z: 'bool',
    zero: 'bool',
    help: 'bool',
    version: 'bool',
  });
  if (parsed.error) return usageError(prog, parsed.error);
  const optionSuffix = parsed.opts.get('s') ?? parsed.opts.get('suffix');
  const multiple = parsed.opts.has('a') || parsed.opts.has('multiple') || optionSuffix !== undefined;
  const zero = parsed.opts.has('z') || parsed.opts.has('zero');
  const terminator = zero ? '\0' : '\n';
  const args = parsed.args;
  if (!args.length) return { code: 1, out: '', err: prog + ': missing operand\n' };
  if (!multiple && args.length > 2) {
    return { code: 1, out: '', err: prog + ": extra operand '" + args[2] + "'\n" };
  }
  const targets = multiple ? args : [args[0]];
  const suffix = optionSuffix !== undefined ? optionSuffix : multiple ? '' : args[1] ?? '';
  let out = '';
  for (const target of targets) out += stripSuffix(baseNameOf(target), suffix) + terminator;
  return { code: 0, out, err: '' };
}

function runDirname(prog, argv) {
  const parsed = parseOptions(argv, {
    z: 'bool',
    zero: 'bool',
    help: 'bool',
    version: 'bool',
  });
  if (parsed.error) return usageError(prog, parsed.error);
  const zero = parsed.opts.has('z') || parsed.opts.has('zero');
  const terminator = zero ? '\0' : '\n';
  if (!parsed.args.length) return { code: 1, out: '', err: prog + ': missing operand\n' };
  let out = '';
  for (const target of parsed.args) out += dirNameOf(target) + terminator;
  return { code: 0, out, err: '' };
}

/* ---------------------------------------------------------------- realpath */

function canonicalizeDefault(name, ctx) {
  const cwd = cwdOf(ctx);
  const trimmed = name.replace(/\/+$/, '');
  const base = baseNameOf(trimmed);
  if (!trimmed || base === '.' || base === '..' || base === '/') return ctx.fs.realpath(name, cwd);
  const parent = trimmed.slice(0, trimmed.length - base.length).replace(/\/+$/, '');
  const realParent = ctx.fs.realpath(parent === '' ? '/' : parent, cwd);
  const joined = realParent === '/' ? '/' + base : realParent + '/' + base;
  try {
    return ctx.fs.realpath(joined, cwd);
  } catch {
    return joined;
  }
}

function canonicalizeMissing(name, ctx) {
  const cwd = cwdOf(ctx);
  const absolute = absoluteVirtualPath(name, cwd);
  try {
    return ctx.fs.realpath(absolute, cwd);
  } catch {
    // Resolve the longest existing prefix physically, keep the rest lexical.
  }
  const segments = absolute.split('/').filter(segment => segment.length > 0);
  let resolved = '/';
  let index = 0;
  for (; index < segments.length; index++) {
    const candidate = resolved === '/' ? '/' + segments[index] : resolved + '/' + segments[index];
    try {
      resolved = ctx.fs.realpath(candidate, cwd);
    } catch {
      break;
    }
  }
  const tail = segments.slice(index).join('/');
  if (!tail) return resolved;
  return resolved === '/' ? '/' + tail : resolved + '/' + tail;
}

function runRealpath(prog, argv, ctx) {
  const options = { mode: 'canonicalize', strip: false, zero: false };
  const args = [];
  let stop = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (stop || token === '-' || !token.startsWith('-')) { args.push(token); continue; }
    if (token === '--') { stop = true; continue; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      if (name === 'canonicalize-existing') options.mode = 'existing';
      else if (name === 'canonicalize-missing') options.mode = 'missing';
      else if (name === 'canonicalize') options.mode = 'canonicalize';
      else if (name === 'strip') options.strip = true;
      else if (name === 'zero') options.zero = true;
      else if (name === 'help' || name === 'version') continue;
      else return usageError(prog, "unrecognized option '--" + name + "'");
      continue;
    }
    for (let j = 1; j < token.length; j++) {
      const ch = token[j];
      if (ch === 'e') options.mode = 'existing';
      else if (ch === 'E') options.mode = 'canonicalize';
      else if (ch === 'm') options.mode = 'missing';
      else if (ch === 's') options.strip = true;
      else if (ch === 'z') options.zero = true;
      else return usageError(prog, "invalid option -- '" + ch + "'");
    }
  }
  if (!args.length) return { code: 1, out: '', err: prog + ': missing operand\n' };
  const terminator = options.zero ? '\0' : '\n';
  const cwd = cwdOf(ctx);
  let out = '';
  let err = '';
  let code = 0;
  for (const name of args) {
    try {
      let resolved;
      if (options.strip) resolved = absoluteVirtualPath(name, cwd);
      else if (options.mode === 'missing') resolved = canonicalizeMissing(name, ctx);
      else if (options.mode === 'existing') resolved = ctx.fs.realpath(name, cwd);
      else resolved = canonicalizeDefault(name, ctx);
      out += (resolved.startsWith('/') ? resolved : '/' + resolved) + terminator;
    } catch (error) {
      err += formatError(prog, name, error && error.code ? error.code : 'ENOENT');
      code = 1;
    }
  }
  return { code, out, err };
}

/* ------------------------------------------------------------------- which */

function pathValue(ctx) {
  const direct = envGet(ctx, 'PATH');
  return direct === undefined ? '' : direct;
}

function splitSearchPath(value) {
  // Windows PATH values use ';' and may start with a drive letter; POSIX uses ':'.
  if (value.includes(';') || /^[A-Za-z]:[\\/]/.test(value)) return value.split(';');
  return value.split(':');
}

function hasBuiltinCommand(ctx, name) {
  const list = ctx ? ctx.builtins : null;
  if (!list) return false;
  if (typeof list.has === 'function') return list.has(name);
  if (Array.isArray(list)) return list.includes(name);
  if (typeof list === 'object') return Object.prototype.hasOwnProperty.call(list, name);
  return false;
}

function isExecutable(ctx, candidate) {
  try {
    const info = ctx.fs.stat(candidate, cwdOf(ctx));
    return !info.isDir;
  } catch {
    return false;
  }
}

function findCommand(ctx, name, all) {
  const results = [];
  if (name.includes('/')) {
    if (isExecutable(ctx, name)) results.push(name);
    return results;
  }
  if (hasBuiltinCommand(ctx, name)) {
    results.push(name);
    if (!all) return results;
  }
  for (const rawEntry of splitSearchPath(pathValue(ctx))) {
    const entry = rawEntry.replace(/\\/g, '/').replace(/\/+$/, '');
    const candidate = entry === '' ? name : entry + '/' + name;
    if (isExecutable(ctx, candidate)) {
      results.push(candidate);
      if (!all) break;
    }
  }
  return results;
}

function runWhich(prog, argv, ctx) {
  const parsed = parseOptions(argv, {
    a: 'bool',
    all: 'bool',
    s: 'bool',
    silent: 'bool',
    help: 'bool',
    version: 'bool',
  });
  if (parsed.error) return usageError(prog, parsed.error);
  if (!parsed.args.length) return { code: 1, out: '', err: '' };
  const all = parsed.opts.has('a') || parsed.opts.has('all');
  const silent = parsed.opts.has('s') || parsed.opts.has('silent');
  let out = '';
  let code = 0;
  for (const name of parsed.args) {
    const found = findCommand(ctx, name, all);
    if (!found.length) { code = 1; continue; }
    if (!silent) out += found.join('\n') + '\n';
  }
  return { code, out, err: '' };
}

/* ------------------------------------------------------------------- sleep */

function parseSleepInterval(token) {
  const match = /^\+?((?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([smhd]?)$/.exec(String(token));
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const suffixes = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
  const factor = suffixes[match[2]];
  const seconds = numeric * factor;
  return Number.isFinite(seconds) ? seconds : null;
}

function sleepMilliseconds(milliseconds, ctx) {
  if (!(milliseconds > 0)) return;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  let remaining = Math.min(milliseconds, Number.MAX_SAFE_INTEGER);
  while (remaining > 0) {
    const slice = Math.min(remaining, 250);
    Atomics.wait(cell, 0, 0, slice);
    remaining -= slice;
    check(ctx);
  }
}

function runSleep(prog, argv, ctx) {
  const tokens = [];
  let stop = false;
  for (const token of argv) {
    if (stop) { tokens.push(token); continue; }
    if (token === '--') { stop = true; continue; }
    if (token.length > 1 && token.startsWith('-')) {
      return usageError(prog, "invalid option -- '" + token[1] + "'");
    }
    tokens.push(token);
  }
  if (!tokens.length) return { code: 1, out: '', err: prog + ': missing operand\n' };
  let total = 0;
  for (const token of tokens) {
    const seconds = parseSleepInterval(token);
    if (seconds === null) return { code: 1, out: '', err: prog + ": invalid time interval '" + token + "'\n" };
    total += seconds;
    if (!Number.isFinite(total)) return { code: 1, out: '', err: prog + ": invalid time interval '" + token + "'\n" };
  }
  sleepMilliseconds(total * 1000, ctx);
  return { code: 0, out: '', err: '' };
}

/* ---------------------------------------------------------------- printenv */

function runPrintenv(prog, argv, ctx) {
  const parsed = parseOptions(argv, {
    0: 'bool',
    null: 'bool',
    help: 'bool',
    version: 'bool',
  });
  if (parsed.error) return usageError(prog, parsed.error);
  const zero = parsed.opts.has('0') || parsed.opts.has('null');
  const terminator = zero ? '\0' : '\n';
  if (!parsed.args.length) {
    let out = '';
    for (const [name, value] of envEntries(ctx)) out += name + '=' + value + terminator;
    return { code: 0, out, err: '' };
  }
  let out = '';
  let code = 0;
  for (const name of parsed.args) {
    const value = envGet(ctx, name);
    if (value === undefined) { code = 1; continue; }
    out += value + terminator;
  }
  return { code, out, err: '' };
}

/* ---------------------------------------------------------------- hostname */

function runHostname(prog, argv) {
  const parsed = parseOptions(argv, {
    s: 'bool',
    short: 'bool',
    f: 'bool',
    fqdn: 'bool',
    d: 'bool',
    domain: 'bool',
    help: 'bool',
    version: 'bool',
  });
  if (parsed.error) return usageError(prog, parsed.error);
  if (parsed.args.length) {
    return { code: 1, out: '', err: prog + ': you must be root to change the host name\n' };
  }
  const host = os.hostname();
  let value = host;
  if (parsed.opts.has('s') || parsed.opts.has('short')) value = host.split('.')[0];
  else if (parsed.opts.has('d') || parsed.opts.has('domain')) {
    value = host.includes('.') ? host.slice(host.indexOf('.') + 1) : '';
  }
  return { code: 0, out: value + '\n', err: '' };
}

/* -------------------------------------------------------------------- main */

export function main(prog, argv, ctx) {
  const name = String(prog ?? '').replace(/\\/g, '/').split('/').pop();
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (args.length && args[0] === prog) args.shift();
  switch (name) {
    case 'date': return runDate(name, args, ctx);
    case 'seq': return runSeq(name, args, ctx);
    case 'sha256sum': return runDigest(name, args, ctx, 'sha256');
    case 'md5sum': return runDigest(name, args, ctx, 'md5');
    case 'basename': return runBasename(name, args);
    case 'dirname': return runDirname(name, args);
    case 'realpath': return runRealpath(name, args, ctx);
    case 'which': return runWhich(name, args, ctx);
    case 'sleep': return runSleep(name, args, ctx);
    case 'printenv': return runPrintenv(name, args, ctx);
    case 'hostname': return runHostname(name, args);
    case 'true': return { code: 0, out: '', err: '' };
    case 'false': return { code: 1, out: '', err: '' };
    default: return usageError(name || 'coreutils', 'unknown command');
  }
}
