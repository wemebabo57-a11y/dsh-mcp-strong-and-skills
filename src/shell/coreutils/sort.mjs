// sort, uniq, comm and diff: bash-compatible text utilities (synchronous).
// Contract: main(prog, argv, ctx) -> { code, out, err } with argv[0] === prog.

import {
  formatError,
  joinLines,
  loop,
  parseOptions,
  readInputs,
  splitLines,
  toInt,
  usageError
} from '../io.mjs';

export const names = ['sort', 'uniq', 'comm', 'diff'];

const EMPTY_VALUE = '\u0001';
const NO_NEWLINE = '\\ No newline at end of file';
const DIFF_CONTEXT = 3;
const VERSION = '1.0';
const DIFF_MAX_TRACE_BYTES = 32 * 1024 * 1024;

export function main(prog, argv, ctx) {
  const args = argv.slice();
  if (args.length && args[0] === prog) args.shift();
  const name = prog.slice(prog.lastIndexOf('/') + 1);
  switch (name) {
    case 'sort': return runSort(name, args, ctx);
    case 'uniq': return runUniq(name, args, ctx);
    case 'comm': return runComm(name, args, ctx);
    case 'diff': return runDiff(name, args, ctx);
    default: return usageError(name || 'coreutils', "unsupported command '" + name + "'");
  }
}

// ------------------------------------------------------------------ text bits

function isBlank(ch) {
  return ch === ' ' || ch === '\t';
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isAlnum(ch) {
  return isAlpha(ch) || isDigit(ch);
}

function foldAscii(text) {
  let out = '';
  for (const ch of text) {
    out += ch >= 'A' && ch <= 'Z' ? String.fromCharCode(ch.charCodeAt(0) + 32) : ch;
  }
  return out;
}

/** Compare two strings by their UTF-8 bytes, like memcmp in the C locale. */
function compareBytes(left, right) {
  if (left === right) return 0;
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * parseOptions rejects an empty option argument, but sort -t '' and -k '' need
 * to reach their own diagnostics. Hide empty values behind a sentinel.
 */
function parseCommandOptions(args, defs, valueChars) {
  let patched = args;
  if (valueChars) {
    patched = args.slice();
    for (let index = 0; index < patched.length - 1; index += 1) {
      const token = patched[index];
      if (patched[index + 1] !== '' || token.length < 2 || token === '--') continue;
      if (token.startsWith('--')) continue;
      if (!valueChars.includes(token[token.length - 1])) continue;
      patched[index + 1] = EMPTY_VALUE;
    }
  }
  const parsed = parseOptions(patched, defs);
  if (parsed.error) return parsed;
  for (const [key, value] of parsed.opts) {
    if (value === EMPTY_VALUE) parsed.opts.set(key, '');
  }
  return parsed;
}

function optionFlag(opts, short, long) {
  return opts.has(short) || opts.has(long);
}

function optionValue(opts, keys) {
  for (const key of keys) {
    if (opts.has(key)) return opts.get(key);
  }
  return undefined;
}

// ---------------------------------------------------------------------- sort

const SORT_OPTIONS = {
  b: 'bool',
  f: 'bool',
  h: 'bool',
  m: 'bool',
  n: 'bool',
  r: 'bool',
  s: 'bool',
  u: 'bool',
  V: 'bool',
  k: 'value',
  o: 'value',
  t: 'value',
  key: 'value',
  output: 'value',
  'field-separator': 'value',
  parallel: 'value',
  'ignore-leading-blanks': 'bool',
  'ignore-case': 'bool',
  'human-numeric-sort': 'bool',
  'numeric-sort': 'bool',
  reverse: 'bool',
  stable: 'bool',
  unique: 'bool',
  'version-sort': 'bool',
  merge: 'bool',
  help: 'bool',
  version: 'bool'
};

const SORT_VALUE_LONGS = new Set(['key', 'output', 'field-separator', 'parallel']);
const SORT_SHORT_VALUES = 'kot';
const UNIT_ORDER = 'KMGTPEZY';

const SORT_HELP = [
  'Usage: sort [OPTION]... [FILE]...',
  '',
  'Write sorted concatenation of all FILE(s) to standard output.',
  '',
  '  -b, --ignore-leading-blanks  ignore leading blanks',
  '  -f, --ignore-case            fold lower case to upper case characters',
  '  -h, --human-numeric-sort     compare human readable numbers (e.g., 2K 1G)',
  '  -n, --numeric-sort           compare according to string numerical value',
  '  -r, --reverse                reverse the result of comparisons',
  '  -s, --stable                 stabilize sort by disabling last-resort comparison',
  '  -u, --unique                 output only the first of an equal run',
  '  -V, --version-sort           natural sort of (version) numbers within text',
  '  -k, --key=KEYDEF             sort via a key; KEYDEF gives location and type',
  '  -o, --output=FILE            write result to FILE instead of standard output',
  '  -t, --field-separator=SEP    use SEP instead of non-blank to blank transition',
  '      --help                   display this help and exit',
  '      --version                output version information and exit',
  '',
].join('\n');

function makeKey() {
  return {
    sword: 1,
    schar: 0,
    eword: 0,
    echar: 0,
    skipsBlanks: false,
    fold: false,
    numeric: false,
    human: false,
    version: false,
    reverse: false
  };
}

/** Parse a sort -k KEYDEF: start[.char][opts][,end[.char][opts]]. */
function parseKeySpec(spec) {
  const text = String(spec);
  let index = 0;
  const key = makeKey();

  const readNumber = (label) => {
    const start = index;
    while (index < text.length && isDigit(text[index])) index += 1;
    if (index === start) {
      return { value: 0, error: label + ": invalid count at start of '" + text.slice(start) + "'" };
    }
    return { value: Number(text.slice(start, index)), error: null };
  };

  const readModifiers = (isEnd) => {
    while (index < text.length) {
      const ch = text[index];
      if (ch === 'b') {
        if (!isEnd) key.skipsBlanks = true;
      } else if (ch === 'f') {
        key.fold = true;
      } else if (ch === 'n') {
        key.numeric = true;
      } else if (ch === 'r') {
        key.reverse = true;
      } else if (ch === 'h') {
        key.human = true;
      } else if (ch === 'V') {
        key.version = true;
      } else if (ch === 'd' || ch === 'g' || ch === 'M' || ch === 'i') {
        return "unsupported key modifier '" + ch + "'";
      } else {
        break;
      }
      index += 1;
    }
    return null;
  };

  let parsed = readNumber('invalid number at field start');
  if (parsed.error) return { key: null, error: parsed.error };
  if (parsed.value === 0) {
    return { key: null, error: "field number is zero: invalid field specification '" + text + "'" };
  }
  key.sword = parsed.value;

  if (text[index] === '.') {
    index += 1;
    parsed = readNumber("invalid number after '.'");
    if (parsed.error) return { key: null, error: parsed.error };
    if (parsed.value === 0) {
      return { key: null, error: "character offset is zero: invalid field specification '" + text + "'" };
    }
    key.schar = parsed.value - 1;
  }

  let modifierError = readModifiers(false);
  if (modifierError) return { key: null, error: modifierError };

  if (text[index] === ',') {
    index += 1;
    parsed = readNumber("invalid number after ','");
    if (parsed.error) return { key: null, error: parsed.error };
    if (parsed.value === 0) {
      return { key: null, error: "field number is zero: invalid field specification '" + text + "'" };
    }
    key.eword = parsed.value;
    if (text[index] === '.') {
      index += 1;
      parsed = readNumber("invalid number after '.'");
      if (parsed.error) return { key: null, error: parsed.error };
      key.echar = parsed.value;
    }
    modifierError = readModifiers(true);
    if (modifierError) return { key: null, error: modifierError };
  }

  if (index < text.length) {
    return { key: null, error: "stray character in field spec: invalid field specification '" + text + "'" };
  }
  return { key, error: null };
}

/** Collect every -k/--key value in command-line order (parseOptions keeps one). */
function collectKeySpecs(argv) {
  const specs = [];
  let index = 0;
  let stop = false;
  while (index < argv.length) {
    const token = argv[index];
    if (stop || token === '-' || !token.startsWith('-')) {
      index += 1;
      continue;
    }
    if (token === '--') {
      stop = true;
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      if (name === 'key') {
        if (eq >= 0) {
          specs.push(token.slice(eq + 1));
        } else {
          specs.push(index + 1 < argv.length ? argv[index + 1] : '');
          index += 1;
        }
      } else if (eq < 0 && SORT_VALUE_LONGS.has(name)) {
        index += 1;
      }
      index += 1;
      continue;
    }
    let consumedNext = false;
    for (let offset = 1; offset < token.length; offset += 1) {
      const ch = token[offset];
      if (SORT_OPTIONS[ch] !== 'value') continue;
      const rest = token.slice(offset + 1);
      if (ch === 'k') {
        if (rest) {
          specs.push(rest);
        } else {
          specs.push(index + 1 < argv.length ? argv[index + 1] : '');
          consumedNext = true;
        }
      } else if (!rest) {
        consumedNext = true;
      }
      break;
    }
    index += consumedNext ? 2 : 1;
  }
  return specs;
}

function buildSortConfig(opts, specs, tab) {
  const flags = {
    blanks: optionFlag(opts, 'b', 'ignore-leading-blanks'),
    fold: optionFlag(opts, 'f', 'ignore-case'),
    human: optionFlag(opts, 'h', 'human-numeric-sort'),
    numeric: optionFlag(opts, 'n', 'numeric-sort'),
    reverse: optionFlag(opts, 'r', 'reverse'),
    stable: optionFlag(opts, 's', 'stable'),
    unique: optionFlag(opts, 'u', 'unique'),
    version: optionFlag(opts, 'V', 'version-sort')
  };
  const keys = [];
  if (specs.length === 0) {
    keys.push(makeKey());
  } else {
    for (const spec of specs) {
      const parsed = parseKeySpec(spec);
      if (parsed.error) return { error: parsed.error };
      const key = parsed.key;
      // GNU: a key that has its own ordering option inherits none of the
      // global ordering options; the last-resort comparison keeps global -r.
      key.ownOptions = key.skipsBlanks || key.fold || key.numeric
        || key.human || key.version || key.reverse;
      keys.push(key);
    }
  }
  for (const key of keys) {
    if (key.ownOptions) continue;
    if (flags.blanks) key.skipsBlanks = true;
    if (flags.fold) key.fold = true;
    if (flags.human) key.human = true;
    if (flags.numeric) key.numeric = true;
    if (flags.version) key.version = true;
    if (flags.reverse) key.reverse = true;
  }
  return {
    keys,
    tab,
    stable: flags.stable,
    unique: flags.unique,
    reverse: flags.reverse,
    error: null
  };
}

/** Beginning of field 'word' (1-based); includes the blanks before the field. */
function fieldStart(line, word, tab) {
  let index = 0;
  if (tab !== null) {
    for (let count = 1; count < word; count += 1) {
      const found = line.indexOf(tab, index);
      if (found < 0) return line.length;
      index = found + 1;
    }
    return index;
  }
  for (let count = 1; count < word; count += 1) {
    while (index < line.length && isBlank(line[index])) index += 1;
    while (index < line.length && !isBlank(line[index])) index += 1;
  }
  return index;
}

/** End of field 'word' (1-based), excluding the blanks after it. */
function fieldEnd(line, word, tab) {
  const start = fieldStart(line, word, tab);
  if (tab !== null) {
    const found = line.indexOf(tab, start);
    return found < 0 ? line.length : found;
  }
  let index = start;
  while (index < line.length && isBlank(line[index])) index += 1;
  while (index < line.length && !isBlank(line[index])) index += 1;
  return index;
}

/** The byte range a -k key selects; GNU semantics, including empty keys. */
function keySlice(line, key, tab) {
  let start = fieldStart(line, key.sword, tab);
  if (key.skipsBlanks) {
    while (start < line.length && isBlank(line[start])) start += 1;
  }
  start = Math.min(line.length, start + key.schar);
  let end;
  if (key.eword === 0) {
    end = line.length;
  } else if (key.echar > 0) {
    end = Math.min(line.length, fieldStart(line, key.eword, tab) + key.echar);
  } else {
    end = fieldEnd(line, key.eword, tab);
  }
  if (end < start) end = start;
  return line.slice(start, end);
}

// Exact decimal comparison used by -n and by the numeric half of -h.
function parseDecimal(text) {
  let index = 0;
  while (index < text.length && isBlank(text[index])) index += 1;
  let sign = 1;
  if (text[index] === '+') {
    index += 1;
  } else if (text[index] === '-') {
    sign = -1;
    index += 1;
  }
  const digitsStart = index;
  while (index < text.length && isDigit(text[index])) index += 1;
  const intPart = text.slice(digitsStart, index);
  let fracPart = '';
  if (text[index] === '.') {
    const fracStart = index + 1;
    let scan = fracStart;
    while (scan < text.length && isDigit(text[scan])) scan += 1;
    if (scan > fracStart) {
      fracPart = text.slice(fracStart, scan);
      index = scan;
    }
  }
  if (!intPart && !fracPart) return { sign: 1, intPart: '0', fracPart: '' };
  return { sign, intPart, fracPart };
}

function compareMagnitude(left, right) {
  const intLeft = left.intPart.replace(/^0+/, '');
  const intRight = right.intPart.replace(/^0+/, '');
  if (intLeft.length !== intRight.length) return intLeft.length < intRight.length ? -1 : 1;
  if (intLeft !== intRight) return intLeft < intRight ? -1 : 1;
  const width = Math.max(left.fracPart.length, right.fracPart.length);
  const fracLeft = left.fracPart.padEnd(width, '0');
  const fracRight = right.fracPart.padEnd(width, '0');
  if (fracLeft === fracRight) return 0;
  return fracLeft < fracRight ? -1 : 1;
}

function compareNumeric(leftText, rightText) {
  const left = parseDecimal(leftText);
  const right = parseDecimal(rightText);
  const magnitude = compareMagnitude(left, right);
  if (magnitude === 0) return 0;
  if (left.sign !== right.sign) return left.sign < 0 ? -1 : 1;
  return left.sign < 0 ? -magnitude : magnitude;
}

/** Unit rank of a human-readable size: 0 for plain numbers, +-1.. for K..Y. */
function unitRank(text) {
  let index = 0;
  let sign = 1;
  if (text[index] === '-') {
    sign = -1;
    index += 1;
  }
  while (index < text.length && isBlank(text[index])) index += 1;
  if (text[index] === '+') index += 1;
  while (index < text.length && isDigit(text[index])) index += 1;
  if (text[index] === '.') {
    index += 1;
    while (index < text.length && isDigit(text[index])) index += 1;
  }
  if (index >= text.length) return 0;
  // GNU accepts an uppercase unit or a lowercase 'k'; other lowercase
  // suffixes are ignored (for example '1m' is just 1).
  const suffix = text[index] === 'k' ? 'K' : text[index];
  const position = UNIT_ORDER.indexOf(suffix);
  return position < 0 ? 0 : (position + 1) * sign;
}

function compareHuman(leftText, rightText) {
  const left = leftText.replace(/^[ \t]+/, '');
  const right = rightText.replace(/^[ \t]+/, '');
  const leftRank = unitRank(left);
  const rightRank = unitRank(right);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  return compareNumeric(left, right);
}

// Port of gnulib filevercmp (the comparison used by sort -V).
function versionOrder(text, position, length) {
  if (position >= length) return -1;
  const ch = text[position];
  if (isDigit(ch)) return 0;
  if (isAlpha(ch)) return ch.charCodeAt(0);
  if (ch === '~') return -2;
  return ch.charCodeAt(0) + 256;
}

function versionCompare(a, aLength, b, bLength) {
  let aPosition = 0;
  let bPosition = 0;
  while (aPosition < aLength || bPosition < bLength) {
    let firstDiff = 0;
    while ((aPosition < aLength && !isDigit(a[aPosition])) || (bPosition < bLength && !isDigit(b[bPosition]))) {
      const left = versionOrder(a, aPosition, aLength);
      const right = versionOrder(b, bPosition, bLength);
      if (left !== right) return left - right;
      aPosition += 1;
      bPosition += 1;
    }
    while (aPosition < aLength && a[aPosition] === '0') aPosition += 1;
    while (bPosition < bLength && b[bPosition] === '0') bPosition += 1;
    while (aPosition < aLength && bPosition < bLength && isDigit(a[aPosition]) && isDigit(b[bPosition])) {
      if (!firstDiff) firstDiff = a.charCodeAt(aPosition) - b.charCodeAt(bPosition);
      aPosition += 1;
      bPosition += 1;
    }
    if (aPosition < aLength && isDigit(a[aPosition])) return 1;
    if (bPosition < bLength && isDigit(b[bPosition])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

function filePrefixLength(text, length) {
  let prefix = 0;
  let index = 0;
  for (;;) {
    if (index === length) return prefix;
    index += 1;
    prefix = index;
    while (index + 1 < length && text[index] === '.' && (isAlpha(text[index + 1]) || text[index + 1] === '~')) {
      index += 2;
      while (index < length && (isAlnum(text[index]) || text[index] === '~')) index += 1;
    }
  }
}

function compareVersion(left, right) {
  const a = left;
  const b = right;
  if (a.length === 0) return b.length === 0 ? 0 : -1;
  if (b.length === 0) return 1;
  if (a[0] === '.') {
    if (b[0] !== '.') return -1;
    if (a.length === 1) return b.length === 1 ? 0 : -1;
    if (b.length === 1) return 1;
    const aDotDot = a[1] === '.' && a.length === 2;
    const bDotDot = b[1] === '.' && b.length === 2;
    if (aDotDot) return bDotDot ? 0 : -1;
    if (bDotDot) return 1;
  } else if (b[0] === '.') {
    return 1;
  }
  const aPrefix = filePrefixLength(a, a.length);
  const bPrefix = filePrefixLength(b, b.length);
  const onePass = aPrefix === a.length && bPrefix === b.length;
  const result = versionCompare(a, aPrefix, b, bPrefix);
  if (result !== 0 || onePass) return result;
  return versionCompare(a, a.length, b, b.length);
}

function compareText(left, right, fold) {
  if (!fold) return compareBytes(left, right);
  return compareBytes(foldAscii(left), foldAscii(right));
}

function compareKey(leftLine, rightLine, key, tab) {
  const left = keySlice(leftLine, key, tab);
  const right = keySlice(rightLine, key, tab);
  if (key.numeric) return compareNumeric(left, right);
  if (key.human) return compareHuman(left, right);
  if (key.version) return compareVersion(left, right);
  return compareText(left, right, key.fold);
}

function makeLineCompare(config) {
  return (left, right) => {
    for (const key of config.keys) {
      const diff = compareKey(left, right, key, config.tab);
      if (diff !== 0) return key.reverse ? -diff : diff;
    }
    if (config.stable || config.unique) return 0;
    const diff = compareBytes(left, right);
    return config.reverse ? -diff : diff;
  };
}

function runSort(prog, args, ctx) {
  const parsed = parseCommandOptions(args, SORT_OPTIONS, SORT_SHORT_VALUES);
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  if (opts.has('version')) return { code: 0, out: 'sort (dsh coreutils) ' + VERSION + '\n', err: '' };
  if (opts.has('help')) return { code: 0, out: SORT_HELP, err: '' };
  const tabValue = optionValue(opts, ['t', 'field-separator']);
  let tab = null;
  if (tabValue !== undefined) {
    if (tabValue === '') return usageError(prog, 'empty tab');
    if (tabValue.length > 1) return usageError(prog, "multi-character tab '" + tabValue + "'");
    tab = tabValue;
  }
  const config = buildSortConfig(opts, collectKeySpecs(args), tab);
  if (config.error) return usageError(prog, config.error);
  const input = readInputs(ctx, prog, parsed.args);
  if (input.error) return { code: 2, out: '', err: input.error };
  let text = '';
  loop(ctx, input.files, 64, (file) => { text += file.text; });
  const compare = makeLineCompare(config);
  const lines = splitLines(text);
  lines.sort(compare);
  let result = lines;
  if (config.unique) {
    result = [];
    for (const line of lines) {
      if (result.length === 0 || compare(result[result.length - 1], line) !== 0) result.push(line);
    }
  }
  const output = joinLines(result);
  const target = optionValue(opts, ['o', 'output']);
  if (target !== undefined) {
    try {
      ctx.fs.writeText(target, ctx.cwd, output);
    } catch (error) {
      if (error && error.code) return { code: 2, out: '', err: formatError(prog, target, error.code) };
      throw error;
    }
    return { code: 0, out: '', err: '' };
  }
  return { code: 0, out: output, err: '' };
}

// ---------------------------------------------------------------------- uniq

const UNIQ_HELP = [
  'Usage: uniq [OPTION]... [FILE]...',
  '',
  'Filter adjacent matching lines from the input, writing to standard output.',
  '',
  '  -c, --count           prefix lines by the number of occurrences',
  '  -d, --repeated        only print duplicate lines, one for each group',
  '  -D, --all-repeated    print all duplicate lines',
  '  -u, --unique          only print unique lines',
  '  -i, --ignore-case     ignore differences in case when comparing',
  '  -f, --skip-fields=N   avoid comparing the first N fields',
  '  -s, --skip-chars=N    avoid comparing the first N characters',
  '  -w, --check-chars=N   compare no more than N characters in lines',
  '      --help            display this help and exit',
  '      --version         output version information and exit',
  '',
].join('\n');

const UNIQ_OPTIONS = {
  c: 'bool',
  d: 'bool',
  D: 'bool',
  u: 'bool',
  i: 'bool',
  f: 'value',
  s: 'value',
  w: 'value',
  count: 'bool',
  repeated: 'bool',
  'all-repeated': 'bool',
  unique: 'bool',
  'ignore-case': 'bool',
  'skip-fields': 'value',
  'skip-chars': 'value',
  'check-chars': 'value',
  help: 'bool',
  version: 'bool'
};

function uniqNumber(opts, keys, message) {
  const value = optionValue(opts, keys);
  if (value === undefined) return { value: 0, error: null };
  const number = toInt(value);
  if (number === null || number < 0) {
    return { value: 0, error: message + ": '" + value + "'" };
  }
  return { value: number, error: null };
}

/** The substring uniq compares: -f skips fields, -s chars, -w limits the length. */
function uniqKey(line, options) {
  let index = 0;
  for (let field = 0; field < options.skipFields && index < line.length; field += 1) {
    while (index < line.length && isBlank(line[index])) index += 1;
    while (index < line.length && !isBlank(line[index])) index += 1;
  }
  index = Math.min(line.length, index + options.skipChars);
  let end = line.length;
  if (options.checkChars !== null) end = Math.min(end, index + options.checkChars);
  const slice = line.slice(index, end);
  return options.ignoreCase ? foldAscii(slice) : slice;
}

/** Port of GNU uniq's check_file state machine (all output modes). */
function uniqLines(lines, options) {
  const out = [];
  const emit = (line, match, count) => {
    const show = count === 0
      ? options.outputUnique
      : (match ? options.outputLaterRepeated : options.outputFirstRepeated);
    if (!show) return;
    if (options.count) out.push(String(count + 1).padStart(7) + ' ' + line);
    else out.push(line);
  };
  if (lines.length === 0) return out;
  let previous = lines[0];
  let previousKey = uniqKey(previous, options);
  let matchCount = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const key = uniqKey(line, options);
    const match = key === previousKey;
    if (match) matchCount += 1;
    if (!match || options.outputLaterRepeated) {
      emit(previous, match, matchCount);
      previous = line;
      previousKey = key;
      if (!match) matchCount = 0;
    }
  }
  emit(previous, false, matchCount);
  return out;
}

function runUniq(prog, args, ctx) {
  const parsed = parseOptions(args, UNIQ_OPTIONS);
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  if (opts.has('version')) return { code: 0, out: 'uniq (dsh coreutils) ' + VERSION + '\n', err: '' };
  if (opts.has('help')) return { code: 0, out: UNIQ_HELP, err: '' };
  const fields = uniqNumber(opts, ['f', 'skip-fields'], 'invalid number of fields to skip');
  if (fields.error) return { code: 1, out: '', err: prog + ': ' + fields.error + '\n' };
  const chars = uniqNumber(opts, ['s', 'skip-chars'], 'invalid number of bytes to skip');
  if (chars.error) return { code: 1, out: '', err: prog + ': ' + chars.error + '\n' };
  const checked = uniqNumber(opts, ['w', 'check-chars'], 'invalid number of bytes to compare');
  if (checked.error) return { code: 1, out: '', err: prog + ': ' + checked.error + '\n' };
  const count = optionFlag(opts, 'c', 'count');
  const duplicatedOnly = optionFlag(opts, 'D', 'all-repeated');
  if (count && duplicatedOnly) {
    return { code: 1, out: '', err: prog + ': printing all duplicated lines and repeat counts is meaningless\n' };
  }
  const options = {
    skipFields: fields.value,
    skipChars: chars.value,
    checkChars: optionValue(opts, ['w', 'check-chars']) === undefined ? null : checked.value,
    ignoreCase: optionFlag(opts, 'i', 'ignore-case'),
    count,
    outputUnique: !(optionFlag(opts, 'd', 'repeated') || duplicatedOnly),
    outputFirstRepeated: !optionFlag(opts, 'u', 'unique'),
    outputLaterRepeated: duplicatedOnly
  };
  const input = readInputs(ctx, prog, parsed.args);
  if (input.error) return { code: 1, out: '', err: input.error };
  let text = '';
  loop(ctx, input.files, 64, (file) => { text += file.text; });
  const lines = uniqLines(splitLines(text), options);
  return { code: 0, out: joinLines(lines), err: '' };
}

// ---------------------------------------------------------------------- comm

const COMM_HELP = [
  'Usage: comm [OPTION]... FILE1 FILE2',
  '',
  'Compare sorted files FILE1 and FILE2 line by line.',
  '',
  '  -1  suppress column 1 (lines unique to FILE1)',
  '  -2  suppress column 2 (lines unique to FILE2)',
  '  -3  suppress column 3 (lines that appear in both files)',
  '      --help     display this help and exit',
  '      --version  output version information and exit',
  '',
].join('\n');

function runComm(prog, args, ctx) {
  const parsed = parseOptions(args, { 1: 'bool', 2: 'bool', 3: 'bool', help: 'bool', version: 'bool' });
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  if (opts.has('version')) return { code: 0, out: 'comm (dsh coreutils) ' + VERSION + '\n', err: '' };
  if (opts.has('help')) return { code: 0, out: COMM_HELP, err: '' };
  if (parsed.args.length === 0) return { code: 1, out: '', err: prog + ': missing operand\n' };
  if (parsed.args.length === 1) {
    return { code: 1, out: '', err: prog + ": missing operand after '" + parsed.args[0] + "'\n" };
  }
  if (parsed.args.length > 2) {
    return { code: 1, out: '', err: prog + ": extra operand '" + parsed.args[2] + "'\n" };
  }
  const input = readInputs(ctx, prog, parsed.args);
  if (input.error) return { code: 1, out: '', err: input.error };
  const left = splitLines(input.files[0].text);
  const right = splitLines(input.files[1].text);
  const show1 = !opts.has('1');
  const show2 = !opts.has('2');
  const show3 = !opts.has('3');
  const out = [];
  const prefix2 = show1 ? '\t' : '';
  const prefix3 = (show1 ? '\t' : '') + (show2 ? '\t' : '');
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const diff = compareBytes(left[a], right[b]);
    if (diff < 0) {
      if (show1) out.push(left[a]);
      a += 1;
    } else if (diff > 0) {
      if (show2) out.push(prefix2 + right[b]);
      b += 1;
    } else {
      if (show3) out.push(prefix3 + left[a]);
      a += 1;
      b += 1;
    }
  }
  while (a < left.length) {
    if (show1) out.push(left[a]);
    a += 1;
  }
  while (b < right.length) {
    if (show2) out.push(prefix2 + right[b]);
    b += 1;
  }
  return { code: 0, out: joinLines(out), err: '' };
}

// ---------------------------------------------------------------------- diff

const DIFF_OPTIONS = {
  u: 'bool',
  q: 'bool',
  i: 'bool',
  w: 'bool',
  b: 'bool',
  unified: 'bool',
  brief: 'bool',
  'ignore-case': 'bool',
  'ignore-all-space': 'bool',
  'ignore-space-change': 'bool'
};

/** Split into diff lines; the final line without a newline is flagged. */
function splitDiffLines(text) {
  const lines = [];
  if (!text) return lines;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lines.push({ text: text.slice(start, index), noNewline: false });
      start = index + 1;
    }
  }
  if (start < text.length) lines.push({ text: text.slice(start), noNewline: true });
  return lines;
}

function normalizeDiffText(text, options) {
  let value = text;
  if (options.ignoreAllSpace) {
    value = value.replace(/[ \t]/g, '');
  } else if (options.ignoreSpaceChange) {
    value = value.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, '');
  }
  return options.ignoreCase ? foldAscii(value) : value;
}

function diffLinesEqual(left, right, options) {
  // GNU compares the trailing newline as part of the line text, so the
  // whitespace-ignoring modes also ignore a missing newline at end of file.
  const ignoreNewline = options.ignoreAllSpace || options.ignoreSpaceChange;
  if (!ignoreNewline && left.noNewline !== right.noNewline) return false;
  return normalizeDiffText(left.text, options) === normalizeDiffText(right.text, options);
}

/**
 * Myers O(ND) shortest edit script. Returns ops in file order:
 * { type: 'equal', a, b } | { type: 'delete', a } | { type: 'insert', b }.
 */
function myersDiff(aLength, bLength, equal, ctx) {
  const max = aLength + bLength;
  if (max === 0) return [];
  const offset = max + 1;
  const furthest = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max; d += 1) {
    if (d % 32 === 0) ctx.check?.();
    trace.push(furthest.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && furthest[offset + k - 1] < furthest[offset + k + 1])) {
        x = furthest[offset + k + 1];
      } else {
        x = furthest[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < aLength && y < bLength && equal(x, y)) {
        x += 1;
        y += 1;
      }
      furthest[offset + k] = x;
      if (x >= aLength && y >= bLength) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  const ops = [];
  let x = aLength;
  let y = bLength;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d];
    const k = x - y;
    let previousK;
    if (k === -d || (k !== d && previous[offset + k - 1] < previous[offset + k + 1])) {
      previousK = k + 1;
    } else {
      previousK = k - 1;
    }
    const previousX = previous[offset + previousK];
    const previousY = previousX - previousK;
    const editX = previousK === k - 1 ? previousX + 1 : previousX;
    const editY = previousK === k - 1 ? previousY : previousY + 1;
    while (x > editX && y > editY) {
      ops.push({ type: 'equal', a: x - 1, b: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (previousK === k - 1) ops.push({ type: 'delete', a: x - 1 });
    else ops.push({ type: 'insert', b: y - 1 });
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', a: x - 1, b: y - 1 });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** Group the edit script into maximal change blocks (half-open ranges). */
function diffBlocks(ops) {
  const blocks = [];
  let current = null;
  let a = 0;
  let b = 0;
  for (const op of ops) {
    if (op.type === 'equal') {
      if (current) {
        blocks.push(current);
        current = null;
      }
      a += 1;
      b += 1;
      continue;
    }
    if (!current) current = { aStart: a, aEnd: a, bStart: b, bEnd: b };
    if (op.type === 'delete') {
      a += 1;
      current.aEnd = a;
    } else {
      b += 1;
      current.bEnd = b;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function mergeHunks(blocks, aLength, bLength) {
  const hunks = [];
  let index = 0;
  while (index < blocks.length) {
    const first = blocks[index];
    let last = first;
    let next = index + 1;
    while (next < blocks.length && blocks[next].aStart - last.aEnd <= DIFF_CONTEXT * 2) {
      last = blocks[next];
      next += 1;
    }
    hunks.push({
      blocks: blocks.slice(index, next),
      startA: Math.max(0, first.aStart - DIFF_CONTEXT),
      endA: Math.min(aLength, last.aEnd + DIFF_CONTEXT),
      startB: Math.max(0, first.bStart - DIFF_CONTEXT),
      endB: Math.min(bLength, last.bEnd + DIFF_CONTEXT)
    });
    index = next;
  }
  return hunks;
}

function hunkRange(start, count) {
  if (count === 0) return start + ',0';
  if (count === 1) return String(start + 1);
  return (start + 1) + ',' + count;
}

function pushContextLine(out, line) {
  out.push(' ' + line.text);
  if (line.noNewline) out.push(NO_NEWLINE);
}

function pushChangedLine(out, sign, line) {
  out.push(sign + line.text);
  if (line.noNewline) out.push(NO_NEWLINE);
}

function renderUnified(linesA, linesB, blocks, labels) {
  const out = ['--- ' + labels[0], '+++ ' + labels[1]];
  for (const hunk of mergeHunks(blocks, linesA.length, linesB.length)) {
    out.push(
      '@@ -' + hunkRange(hunk.startA, hunk.endA - hunk.startA)
      + ' +' + hunkRange(hunk.startB, hunk.endB - hunk.startB) + ' @@'
    );
    let position = hunk.startA;
    for (const block of hunk.blocks) {
      while (position < block.aStart) {
        pushContextLine(out, linesA[position]);
        position += 1;
      }
      for (let index = block.aStart; index < block.aEnd; index += 1) {
        pushChangedLine(out, '-', linesA[index]);
      }
      for (let index = block.bStart; index < block.bEnd; index += 1) {
        pushChangedLine(out, '+', linesB[index]);
      }
      position = block.aEnd;
    }
    while (position < hunk.endA) {
      pushContextLine(out, linesA[position]);
      position += 1;
    }
  }
  return joinLines(out);
}

function normalRange(start, count) {
  if (count === 1) return String(start);
  return start + ',' + (start + count - 1);
}

function renderNormal(linesA, linesB, blocks) {
  const out = [];
  for (const block of blocks) {
    const aCount = block.aEnd - block.aStart;
    const bCount = block.bEnd - block.bStart;
    if (aCount === 0) {
      out.push(String(block.aStart) + 'a' + normalRange(block.bStart + 1, bCount));
      for (let index = block.bStart; index < block.bEnd; index += 1) {
        pushChangedLine(out, '> ', linesB[index]);
      }
    } else if (bCount === 0) {
      out.push(normalRange(block.aStart + 1, aCount) + 'd' + String(block.bStart));
      for (let index = block.aStart; index < block.aEnd; index += 1) {
        pushChangedLine(out, '< ', linesA[index]);
      }
    } else {
      out.push(normalRange(block.aStart + 1, aCount) + 'c' + normalRange(block.bStart + 1, bCount));
      for (let index = block.aStart; index < block.aEnd; index += 1) {
        pushChangedLine(out, '< ', linesA[index]);
      }
      out.push('---');
      for (let index = block.bStart; index < block.bEnd; index += 1) {
        pushChangedLine(out, '> ', linesB[index]);
      }
    }
  }
  return joinLines(out);
}

function runDiff(prog, args, ctx) {
  const parsed = parseOptions(args, DIFF_OPTIONS);
  if (parsed.error) return usageError(prog, parsed.error);
  const opts = parsed.opts;
  if (parsed.args.length === 0) {
    return { code: 2, out: '', err: prog + ": missing operand after '" + prog + "'\n" };
  }
  if (parsed.args.length === 1) {
    return { code: 2, out: '', err: prog + ": missing operand after '" + parsed.args[0] + "'\n" };
  }
  if (parsed.args.length > 2) {
    return { code: 2, out: '', err: prog + ": extra operand '" + parsed.args[2] + "'\n" };
  }
  const input = readInputs(ctx, prog, parsed.args);
  if (input.error) return { code: 2, out: '', err: input.error };
  const labels = [parsed.args[0], parsed.args[1]];
  const linesA = splitDiffLines(input.files[0].text);
  const linesB = splitDiffLines(input.files[1].text);
  const options = {
    ignoreCase: optionFlag(opts, 'i', 'ignore-case'),
    ignoreAllSpace: optionFlag(opts, 'w', 'ignore-all-space'),
    ignoreSpaceChange: optionFlag(opts, 'b', 'ignore-space-change')
  };
  const equal = (a, b) => diffLinesEqual(linesA[a], linesB[b], options);
  if (optionFlag(opts, 'q', 'brief')) {
    let same = linesA.length === linesB.length;
    if (same) {
      for (let index = 0; index < linesA.length; index += 1) {
        if (!equal(index, index)) {
          same = false;
          break;
        }
      }
    }
    if (same) return { code: 0, out: '', err: '' };
    return { code: 1, out: 'Files ' + labels[0] + ' and ' + labels[1] + ' differ\n', err: '' };
  }
  const blocks = diffBlocks(myersDiff(linesA.length, linesB.length, equal, ctx));
  if (blocks.length === 0) return { code: 0, out: '', err: '' };
  const output = optionFlag(opts, 'u', 'unified')
    ? renderUnified(linesA, linesB, blocks, labels)
    : renderNormal(linesA, linesB, blocks);
  return { code: 1, out: output, err: '' };
}
