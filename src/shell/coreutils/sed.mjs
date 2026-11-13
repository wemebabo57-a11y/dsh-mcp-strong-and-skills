/**
 * sed - stream editor, a practical subset of GNU sed.
 *
 * Supported options: -n/--quiet/--silent, -e/--expression, -f/--file,
 * -i[SUFFIX]/--in-place[=SUFFIX], -s/--separate, -E/-r/--regexp-extended (ERE),
 * -l N/--line-length, --posix (accepted, no effect: GNU extensions stay enabled),
 * --unbuffered/--binary/--follow-symlinks/--sandbox (accepted, no effect),
 * --help, --version. --debug and --null-data are rejected as unsupported.
 * Multiple -e/-f scripts are concatenated in order; labels are global across them.
 *
 * Addresses: LINE, $, /REGEX/, /REGEX/I, /REGEX/M (M ignored), first~step,
 * addr1,addr2 ranges, ! negation, and {...} blocks (with their own address).
 * A regex second address is not tested against the line that opened the range
 * (numeric, $ and step second addresses are), matching GNU sed.  Line address 0
 * is accepted only as the start of a 0,/REGEX/ range: that range opens on line
 * 1 and the regex is tested on line 1 as well; every other use of 0 is an
 * 'invalid usage of line address 0' script error.
 *
 * Commands: s/// (flags g, p, i/I, N, w FILE; &, \1..\9 and \n \t \r \f \v \a \\
 * in the replacement), y/src/dst/, d, D, p, P, q [code], Q [code], n, N, h, H,
 * g, G, x, a\ text, i\ text, c\ text, =, l [width], b [label], t [label],
 * T [label] (branch when the last s/// did not substitute), :label, r FILE,
 * w FILE, { } blocks.
 *
 * ---- POSIX BRE -> JavaScript RegExp translation ----
 * GNU/POSIX basic regular expressions differ from JavaScript in ways that need an
 * explicit rewrite; translateRegex() performs it character by character:
 *
 *   \(  \)              -> (  )                    capturing group
 *   \{m,n\} \{m\} \{m,\} -> {m,n} {m} {m,}         interval
 *   \+  \?  \|          -> +  ?  |                 repetition / alternation
 *   ( ) { } + ? | (unescaped) -> escaped literals
 *   ^                   -> ^ only at the start of the RE or right after \( or \|;
 *                          anywhere else it is a literal \^ (as POSIX requires)
 *   $                   -> $ only at the end of the RE or right before \) or \|;
 *                          anywhere else it is a literal \$
 *   *                   -> literal at the start of the RE (POSIX BRE), operator
 *                          elsewhere
 *   .  and  [...]       -> preserved.  The compiled RegExp uses the "s" flag so
 *                          . matches a newline (the pattern space can contain one
 *                          after N); "m" is not used, so ^/$ never match inside
 *                          the pattern space.
 *   [[:alpha:]] etc.    -> the equivalent JavaScript class body (C locale table)
 *   []] / [^]]          -> a leading ] inside a bracket expression is a literal,
 *                          so it is escaped for JavaScript
 *   \n \t \r \f \v \a   -> the corresponding control character
 *   \< \>               -> \b(?=\w) / \b(?<=\w)     (GNU word-boundary extension)
 *   \` \'               -> ^ / $                    (GNU buffer-boundary extension)
 *   \w \W \s \S \b \B \1..\9 and \X for any other X -> passed through unchanged
 *
 * With -E/--regexp-extended the roles flip: ( ) { } + ? | are operators and their
 * backslashed forms are literals; everything else is translated the same way.
 *
 * ---- Deliberate deviations from GNU sed (documented, not accidental) ----
 *  - Exit codes follow this repository's convention: 2 for any script or usage
 *    error (GNU uses 1 for script errors and 4 for a missing label), 1 for an
 *    unreadable input file (GNU uses 2), 0 otherwise (or the code given to q/Q).
 *  - No input files with -i reports "sed: no input files" and exits 2 (GNU: 4).
 *  - y/// compares transliteration strings by code point, not by byte, so
 *    multi-byte UTF-8 transliterations are accepted (GNU rejects them).
 *  - Unsupported GNU extras fail loudly instead of silently misbehaving: the s
 *    "execute" flag e and the case-conversion escapes \U \L \E \u \l are rejected
 *    with a script error; the s flags M/m are accepted and ignored.
 *  - -i writes each file back after processing it and never changes permissions.
 *  - Input is decoded as UTF-8 through the virtual filesystem.  The pattern
 *    space is therefore a JavaScript string, so "." and interval counts work on
 *    code points: s/./X/g turns "café" into "XXXX" here, while GNU sed in the C
 *    locale matches one byte per dot and produces "XXXXX".
 *
 * Processing model (matches GNU sed 4.9):
 *  - the pattern space carries a "chomped" flag for an input line with no
 *    trailing newline; printing it emits no trailing newline, and the next record
 *    first emits the missing newline (GNU's output_missing_newline behaviour)
 *  - the append/read queue is flushed after the pattern space at cycle end
 *  - q prints the pattern space (unless -n), flushes the queue and exits
 *  - Q exits immediately without printing or flushing
 *  - N at EOF prints the pattern space and stops the current stream
 *  - D without a newline in the pattern space acts like d
 *  - a zero-length match immediately following a non-empty match is skipped
 *    (the a-star substitution over "aab" gives "XbX")
 *  - with -s (or -i) line numbers, $, ranges, n/N and q/Q are per file.
 *  - l escapes the pattern space the way GNU does: printable ASCII verbatim,
 *    every other character as octal byte escapes (\ooo), then a final $; a
 *    width argument wraps long lines with a trailing backslash.
 *  - with -i the text produced for a file is written back to that file and the
 *    standard output stays empty; -i also implies -s.
 */

import { ERRNO_TEXT, ShellError } from '../fs.mjs';
import { fail, writeOut } from '../io.mjs';

export const names = ['sed'];

/** Backtick, kept in a constant so it never has to be escaped in source. */
const TICK = '\u0060';

/** GNU-style quoted token: \`name' */
function quoted(text) {
  return TICK + text + "'";
}

/** POSIX character classes as JavaScript class bodies (C locale). */
const POSIX_CLASSES = new Map([
  ['alpha', 'A-Za-z'],
  ['alnum', 'A-Za-z0-9'],
  ['blank', ' \\t'],
  ['cntrl', '\\x00-\\x1f\\x7f'],
  ['digit', '0-9'],
  ['graph', '\\x21-\\x7e'],
  ['lower', 'a-z'],
  ['print', '\\x20-\\x7e'],
  ['punct', '\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e'],
  ['space', ' \\t\\n\\v\\f\\r'],
  ['upper', 'A-Z'],
  ['word', 'A-Za-z0-9_'],
  ['xdigit', '0-9A-Fa-f'],
]);

/** Characters that are literal in a BRE but special in a JavaScript RegExp. */
const JS_SPECIAL = new Set(['\\', '^', '$', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);

class ArgError extends Error {}

class ScriptFailure extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos === undefined ? null : pos;
  }
}

// ---------------------------------------------------------------------------
// regular expressions
// ---------------------------------------------------------------------------

function escapeClassChar(ch) {
  if (ch === '\\') return '\\\\';
  const code = ch.codePointAt(0);
  if (code < 0x20 || code === 0x7f) return '\\x' + code.toString(16).padStart(2, '0');
  return ch;
}

/**
 * Read one POSIX bracket expression starting at src[start] === '['.
 * Returns {js, next}; an unterminated expression is treated as a literal '['.
 */
function readBracketExpression(src, start) {
  const n = src.length;
  let i = start + 1;
  let head = '[';
  if (src[i] === '^') {
    head += '^';
    i += 1;
  }
  let first = true;
  let body = '';
  while (i < n) {
    const ch = src[i];
    if (ch === ']') {
      if (first) {
        body += '\\]';
        i += 1;
        first = false;
        continue;
      }
      return { js: head + body + ']', next: i + 1 };
    }
    first = false;
    if (ch === '[') {
      const kind = src[i + 1];
      if (kind === ':') {
        const end = src.indexOf(':]', i + 2);
        if (end !== -1) {
          const name = src.slice(i + 2, end);
          const fragment = POSIX_CLASSES.get(name);
          if (fragment !== undefined) {
            body += fragment;
            i = end + 2;
            continue;
          }
          body += '\\[';
          i += 1;
          continue;
        }
      }
      if (kind === '.' || kind === '=') {
        const end = src.indexOf(kind + ']', i + 2);
        if (end !== -1) {
          for (const inner of src.slice(i + 2, end)) body += escapeClassChar(inner);
          i = end + 2;
          continue;
        }
      }
      body += '\\[';
      i += 1;
      continue;
    }
    if (ch === '\\') {
      body += '\\\\';
      i += 1;
      continue;
    }
    body += escapeClassChar(ch);
    i += 1;
  }
  return { js: '\\[', next: start + 1 };
}

/**
 * Translate a POSIX BRE (or ERE when ere is true) into a JavaScript RegExp
 * source.  The full translation table lives in the module header comment.
 */
function translateRegex(source, options) {
  const ere = options && options.ere === true;
  const src = String(source);
  const n = src.length;
  let out = '';
  let i = 0;
  let atAlternateStart = true;

  while (i < n) {
    const ch = src[i];

    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) {
        out += '\\\\';
        i += 1;
        atAlternateStart = false;
        continue;
      }
      i += 2;
      if (!ere) {
        if (next === '(') {
          out += '(';
          atAlternateStart = true;
          continue;
        }
        if (next === ')') {
          out += ')';
          atAlternateStart = false;
          continue;
        }
        if (next === '|') {
          out += '|';
          atAlternateStart = true;
          continue;
        }
        if (next === '+') {
          out += '+';
          atAlternateStart = false;
          continue;
        }
        if (next === '?') {
          out += '?';
          atAlternateStart = false;
          continue;
        }
        if (next === '{') {
          const close = src.indexOf('\\}', i);
          if (close !== -1) {
            const body = src.slice(i, close);
            if (/^[0-9]+(?:,[0-9]*)?$/.test(body)) {
              out += '{' + body + '}';
              i = close + 2;
              atAlternateStart = false;
              continue;
            }
          }
          out += '\\{';
          atAlternateStart = false;
          continue;
        }
        if (next === '}') {
          out += '\\}';
          atAlternateStart = false;
          continue;
        }
      } else if (next === '(' || next === ')' || next === '{' || next === '}' ||
                 next === '+' || next === '?' || next === '|') {
        out += '\\' + next;
        atAlternateStart = false;
        continue;
      }
      // escapes with the same meaning in both dialects
      if (next === 'n') {
        out += '\\n';
        atAlternateStart = false;
        continue;
      }
      if (next === 't') {
        out += '\\t';
        atAlternateStart = false;
        continue;
      }
      if (next === 'r') {
        out += '\\r';
        atAlternateStart = false;
        continue;
      }
      if (next === 'f') {
        out += '\\f';
        atAlternateStart = false;
        continue;
      }
      if (next === 'v') {
        out += '\\v';
        atAlternateStart = false;
        continue;
      }
      if (next === 'a') {
        out += '\\x07';
        atAlternateStart = false;
        continue;
      }
      if (next === '<') {
        out += '\\b(?=\\w)';
        atAlternateStart = false;
        continue;
      }
      if (next === '>') {
        out += '\\b(?<=\\w)';
        atAlternateStart = false;
        continue;
      }
      if (next === TICK) {
        out += '^';
        atAlternateStart = false;
        continue;
      }
      if (next === "'") {
        out += '$';
        atAlternateStart = false;
        continue;
      }
      out += '\\' + next;
      atAlternateStart = false;
      continue;
    }

    if (ch === '[') {
      const bracket = readBracketExpression(src, i);
      out += bracket.js;
      i = bracket.next;
      atAlternateStart = false;
      continue;
    }

    if (ch === '^') {
      out += atAlternateStart ? '^' : '\\^';
      i += 1;
      atAlternateStart = false;
      continue;
    }

    if (ch === '$') {
      const rest = src.slice(i + 1);
      const groupClose = ere ? rest.startsWith(')') : rest.startsWith('\\)');
      const alternate = ere ? rest.startsWith('|') : rest.startsWith('\\|');
      out += rest.length === 0 || groupClose || alternate ? '$' : '\\$';
      i += 1;
      atAlternateStart = false;
      continue;
    }

    if (ch === '*') {
      out += atAlternateStart ? '\\*' : '*';
      i += 1;
      atAlternateStart = false;
      continue;
    }

    if (ere && (ch === '(' || ch === ')' || ch === '|' || ch === '{' || ch === '}' ||
                ch === '+' || ch === '?')) {
      out += ch;
      atAlternateStart = ch === '(' || ch === '|';
      i += 1;
      continue;
    }

    out += JS_SPECIAL.has(ch) ? '\\' + ch : ch;
    atAlternateStart = false;
    i += 1;
  }

  return out;
}

function compileRegex(source, options) {
  const body = translateRegex(source, options);
  const flags = 'gs' + (options && options.ignoreCase ? 'i' : '');
  try {
    return new RegExp(body, flags);
  } catch (error) {
    throw new ScriptFailure('invalid regular expression: ' +
      (error && error.message ? error.message : 'bad pattern'), options && options.pos);
  }
}

/** Split a sed replacement into literal text and back-reference parts. */
function parseReplacement(text, pos) {
  const parts = [];
  let literal = '';
  const flush = () => {
    if (literal.length > 0) {
      parts.push({ literal });
      literal = '';
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      i += 1;
      if (next === undefined) {
        literal += '\\';
        break;
      }
      if (next >= '1' && next <= '9') {
        flush();
        parts.push({ ref: next.charCodeAt(0) - 48 });
        continue;
      }
      if (next === '&') literal += '&';
      else if (next === 'n') literal += '\n';
      else if (next === 't') literal += '\t';
      else if (next === 'r') literal += '\r';
      else if (next === 'f') literal += '\f';
      else if (next === 'v') literal += '\v';
      else if (next === 'a') literal += '\x07';
      else if (next === '\\') literal += '\\';
      else if (next === 'U' || next === 'L' || next === 'E' || next === 'u' || next === 'l') {
        throw new ScriptFailure('unsupported escape \\' + next + ' in replacement', pos);
      } else literal += next;
      continue;
    }
    if (ch === '&') {
      flush();
      parts.push({ ref: 0 });
      continue;
    }
    literal += ch;
  }
  flush();
  return parts;
}

function expandReplacement(parts, match) {
  let out = '';
  for (const part of parts) {
    if (part.literal !== undefined) out += part.literal;
    else if (part.ref === 0) out += match[0];
    else out += match[part.ref] === undefined ? '' : match[part.ref];
  }
  return out;
}

/** Decode \n \t \r \f \v \a \\ and \X -> X (y/// and a/i/c text). */
function unescapeChars(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    i += 1;
    if (next === undefined) {
      out += '\\';
      break;
    }
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === 'f') out += '\f';
    else if (next === 'v') out += '\v';
    else if (next === 'a') out += '\x07';
    else out += next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// input records
// ---------------------------------------------------------------------------

/** Split text into records; chomped marks a last line without a trailing newline. */
function splitRecords(text) {
  const lines = [];
  if (text.length === 0) return lines;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      lines.push({ text: text.slice(start, i), chomped: false });
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({ text: text.slice(start), chomped: true });
  return lines;
}

// ---------------------------------------------------------------------------
// option parsing
// ---------------------------------------------------------------------------

const VERSION = '1.0';

const HELP_TEXT = [
  'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...',
  '',
  '  -n, --quiet, --silent',
  '                 suppress automatic printing of pattern space',
  '  -e script, --expression=script',
  '                 add the script to the commands to be executed',
  '  -f script-file, --file=script-file',
  '                 add the contents of script-file to the commands to be',
  '                 executed',
  '  -i[SUFFIX], --in-place[=SUFFIX]',
  '                 edit files in place (makes backup if SUFFIX supplied)',
  '  -s, --separate',
  '                 consider files as separate rather than as a single',
  '                 continuous long stream',
  '  -E, -r, --regexp-extended',
  '                 use extended regular expressions',
  '  -l N, --line-length=N',
  '                 specify the desired line-wrap length for the l command',
  '      --posix    disable all GNU extensions',
  '  -u, --unbuffered',
  '                 accepted for compatibility; output is unbuffered anyway',
  '      --help     display this help and exit',
  '      --version  output version information and exit',
  '',
  'If no -e, --expression, -f, or --file option is given, the first non-option',
  'argument is taken as the sed script to interpret. All remaining arguments',
  'are names of input files; if no input files are specified, the standard',
  'input is read.',
  '',
].join('\n');

function parseArgs(argv) {
  const opts = {
    quiet: false,
    separate: false,
    inPlace: null,
    ere: false,
    lineWidth: 70,
    help: false,
    version: false,
    scripts: [],
    files: [],
  };
  const operands = [];
  let endOptions = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (endOptions || arg === '-' || arg.length === 0 || arg[0] !== '-') {
      operands.push(arg);
      continue;
    }
    if (arg === '--') {
      endOptions = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? null : arg.slice(eq + 1);
      const takeValue = () => {
        if (inline !== null) return inline;
        if (i + 1 >= argv.length) throw new ArgError("option '--" + name + "' requires an argument");
        i += 1;
        return argv[i];
      };
      if (name === 'quiet' || name === 'silent') opts.quiet = true;
      else if (name === 'separate') opts.separate = true;
      else if (name === 'regexp-extended') opts.ere = true;
      else if (name === 'posix' || name === 'unbuffered' || name === 'binary' ||
               name === 'follow-symlinks' || name === 'sandbox') {
        // accepted, no effect
      } else if (name === 'expression') {
        opts.scripts.push({ kind: 'e', text: takeValue() });
      } else if (name === 'file') {
        opts.scripts.push({ kind: 'f', text: takeValue() });
      } else if (name === 'in-place') {
        opts.inPlace = { suffix: inline === null ? '' : inline };
        opts.separate = true;
      } else if (name === 'line-length') {
        const raw = takeValue();
        if (!/^[0-9]+$/.test(raw)) throw new ArgError('invalid line length: ' + raw);
        opts.lineWidth = Number(raw);
      } else if (name === 'help') opts.help = true;
      else if (name === 'version') opts.version = true;
      else if (name === 'debug' || name === 'null-data') {
        throw new ArgError("unsupported option '--" + name + "'");
      } else {
        throw new ArgError("unrecognized option '--" + name + "'");
      }
      continue;
    }
    for (let k = 1; k < arg.length; k += 1) {
      const ch = arg[k];
      const rest = arg.slice(k + 1);
      if (ch === 'n') opts.quiet = true;
      else if (ch === 's') opts.separate = true;
      else if (ch === 'E' || ch === 'r') opts.ere = true;
      else if (ch === 'u' || ch === 'b') {
        // accepted, no effect
      } else if (ch === 'i') {
        opts.inPlace = { suffix: rest };
        opts.separate = true;
        k = arg.length;
      } else if (ch === 'e' || ch === 'f') {
        let text = rest;
        if (text.length === 0) {
          if (i + 1 >= argv.length) throw new ArgError("option requires an argument -- '" + ch + "'");
          i += 1;
          text = argv[i];
        }
        opts.scripts.push({ kind: ch, text });
        k = arg.length;
      } else if (ch === 'l') {
        let text = rest;
        if (text.length === 0) {
          if (i + 1 >= argv.length) throw new ArgError("option requires an argument -- 'l'");
          i += 1;
          text = argv[i];
        }
        if (!/^[0-9]+$/.test(text)) throw new ArgError('invalid line length: ' + text);
        opts.lineWidth = Number(text);
        k = arg.length;
      } else {
        throw new ArgError("invalid option -- '" + ch + "'");
      }
    }
  }

  if (opts.scripts.length === 0 && !opts.help && !opts.version) {
    if (operands.length === 0) throw new ArgError('no script specified');
    opts.scripts.push({ kind: 'operand', text: operands.shift() });
  }
  opts.files = operands;
  return opts;
}

// ---------------------------------------------------------------------------
// script parser
// ---------------------------------------------------------------------------

function parseProgram(sources, ere) {
  const segments = [];
  let text = '';
  for (let i = 0; i < sources.length; i += 1) {
    if (i > 0) text += '\n';
    segments.push({ start: text.length, length: sources[i].text.length, index: i });
    text += sources[i].text;
  }
  const len = text.length;
  let pos = 0;

  const locate = at => {
    let segment = segments.length > 0 ? segments[segments.length - 1] : { start: 0, length: 0, index: 0 };
    for (const candidate of segments) {
      if (at <= candidate.start + candidate.length) {
        segment = candidate;
        break;
      }
    }
    const char = Math.min(at + 1, segment.start + segment.length) - segment.start;
    return '-e expression #' + (segment.index + 1) + ', char ' + char;
  };

  const reject = (message, at) => {
    throw new ScriptFailure(message, at === undefined ? pos : at);
  };
  const skipBlanks = () => {
    while (pos < len && (text[pos] === ' ' || text[pos] === '\t')) pos += 1;
  };
  const skipSeparators = () => {
    while (pos < len) {
      const ch = text[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ';') pos += 1;
      else break;
    }
  };
  const readDelimited = (delimiter, commandName) => {
    let raw = '';
    while (pos < len) {
      const ch = text[pos];
      if (ch === '\\') {
        if (pos + 1 < len) {
          raw += ch + text[pos + 1];
          pos += 2;
          continue;
        }
        pos += 1;
        raw += '\\';
        continue;
      }
      if (ch === delimiter) {
        pos += 1;
        return raw;
      }
      if (ch === '\n') break;
      raw += ch;
      pos += 1;
    }
    reject('unterminated ' + quoted(commandName) + ' command');
    return '';
  };
  const readRegexBody = delimiter => {
    let raw = '';
    while (pos < len) {
      const ch = text[pos];
      if (ch === '\\') {
        if (pos + 1 < len) {
          raw += ch + text[pos + 1];
          pos += 2;
          continue;
        }
        pos += 1;
        raw += '\\';
        continue;
      }
      if (ch === delimiter) {
        pos += 1;
        return raw;
      }
      if (ch === '\n') break;
      raw += ch;
      pos += 1;
    }
    reject('unterminated address regex');
    return '';
  };
  const readNumber = () => {
    skipBlanks();
    if (pos >= len || text[pos] < '0' || text[pos] > '9') return null;
    let value = 0;
    while (pos < len && text[pos] >= '0' && text[pos] <= '9') {
      value = value * 10 + (text[pos].charCodeAt(0) - 48);
      pos += 1;
    }
    return value;
  };
  const readLabel = () => {
    skipBlanks();
    let label = '';
    while (pos < len) {
      const ch = text[pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ';' || ch === '}') break;
      label += ch;
      pos += 1;
    }
    return label;
  };
  const readFilename = () => {
    skipBlanks();
    let name = '';
    while (pos < len && text[pos] !== '\n') {
      name += text[pos];
      pos += 1;
    }
    return name.replace(/[ \t\r]+$/, '');
  };

  let lastRegex = null;
  const resolveRegex = (raw, ignoreCase, at) => {
    if (raw.length === 0) {
      if (lastRegex === null) reject('no previous regular expression', at);
      return lastRegex;
    }
    const regex = compileRegex(raw, { ere, ignoreCase, pos: at });
    lastRegex = regex;
    return regex;
  };

  const parseAddress = () => {
    if (pos >= len) return null;
    const ch = text[pos];
    if (ch >= '0' && ch <= '9') {
      let value = 0;
      while (pos < len && text[pos] >= '0' && text[pos] <= '9') {
        value = value * 10 + (text[pos].charCodeAt(0) - 48);
        pos += 1;
      }
      if (text[pos] === '~') {
        pos += 1;
        let step = 0;
        while (pos < len && text[pos] >= '0' && text[pos] <= '9') {
          step = step * 10 + (text[pos].charCodeAt(0) - 48);
          pos += 1;
        }
        // GNU sed accepts a missing or zero step and then matches only "first";
        // line address 0 is still invalid when no step follows it.
        if (value === 0 && step === 0) reject('invalid usage of line address 0', pos);
        return { kind: 'step', first: value, step };
      }
      // Line address 0 is only valid as the first address of a
      // 0,/regex/ range; the command loop below rejects every other use.
      if (value === 0) return { kind: 'line', line: 0, zero: true };
      return { kind: 'line', line: value };
    }
    if (ch === '$') {
      pos += 1;
      return { kind: 'last' };
    }
    if (ch === '/') {
      pos += 1;
      const raw = readRegexBody('/');
      return { kind: 'regex', raw, ignoreCase: false, regex: null };
    }
    if (ch === '\\') {
      if (pos + 1 >= len) return null;
      const delimiter = text[pos + 1];
      pos += 2;
      const raw = readRegexBody(delimiter);
      return { kind: 'regex', raw, ignoreCase: false, regex: null };
    }
    return null;
  };

  const readRegexFlags = address => {
    for (;;) {
      const ch = text[pos];
      if (ch === 'I' || ch === 'i') {
        address.ignoreCase = true;
        pos += 1;
      } else if (ch === 'M' || ch === 'm') {
        pos += 1;
      } else break;
    }
  };

  const commands = [];
  const blockStack = [];
  const labels = new Map();
  const branches = [];

  for (;;) {
    skipSeparators();
    if (pos >= len) break;
    if (text[pos] === '#') {
      while (pos < len && text[pos] !== '\n') pos += 1;
      continue;
    }
    const cmd = {
      index: commands.length,
      cmd: '',
      addr1: null,
      addr2: null,
      negate: false,
      rangeActive: false,
      rangeStarted: false,
      rangeEverStarted: false,
    };

    cmd.addr1 = parseAddress();
    if (cmd.addr1 !== null && cmd.addr1.kind === 'regex') readRegexFlags(cmd.addr1);
    if (cmd.addr1 !== null) {
      skipBlanks();
      if (text[pos] === ',') {
        pos += 1;
        skipBlanks();
        cmd.addr2 = parseAddress();
        if (cmd.addr2 === null) reject("unexpected " + quoted(','));
        if (cmd.addr2.kind === 'regex') readRegexFlags(cmd.addr2);
      }
      skipBlanks();
      if (text[pos] === '!') {
        cmd.negate = true;
        pos += 1;
        skipBlanks();
      }
    }

    if (cmd.addr1 !== null && cmd.addr1.kind === 'line' && cmd.addr1.line === 0) {
      if (cmd.addr2 === null || cmd.addr2.kind !== 'regex') {
        reject('invalid usage of line address 0', pos);
      }
    }
    if (pos >= len) reject('missing command');
    const ch = text[pos];
    pos += 1;
    cmd.cmd = ch;

    if (ch === '#') {
      while (pos < len && text[pos] !== '\n') pos += 1;
      continue;
    }

    for (const address of [cmd.addr1, cmd.addr2]) {
      if (address === null || address.kind !== 'regex') continue;
      address.regex = resolveRegex(address.raw, address.ignoreCase, pos);
    }

    if (ch === '{') {
      blockStack.push(cmd.index);
    } else if (ch === '}') {
      if (cmd.addr1 !== null) reject("unexpected " + quoted('}'), pos - 1);
      const open = blockStack.pop();
      if (open === undefined) reject("unexpected " + quoted('}'), pos - 1);
      commands[open].jump = commands.length + 1;
    } else if (ch === 's') {
      const delimiter = text[pos];
      pos += 1;
      const patternRaw = readDelimited(delimiter, 's');
      const replacementRaw = readDelimited(delimiter, 's');
      cmd.replacement = parseReplacement(replacementRaw, pos);
      cmd.global = false;
      cmd.print = false;
      cmd.number = 0;
      cmd.writeFile = null;
      let ignoreCase = false;
      for (;;) {
        if (pos >= len) break;
        const flag = text[pos];
        if (flag === 'g') {
          cmd.global = true;
          pos += 1;
          continue;
        }
        if (flag === 'p') {
          cmd.print = true;
          pos += 1;
          continue;
        }
        if (flag === 'i' || flag === 'I') {
          ignoreCase = true;
          pos += 1;
          continue;
        }
        if (flag === 'M' || flag === 'm') {
          pos += 1;
          continue;
        }
        if (flag >= '0' && flag <= '9') {
          let value = 0;
          while (pos < len && text[pos] >= '0' && text[pos] <= '9') {
            value = value * 10 + (text[pos].charCodeAt(0) - 48);
            pos += 1;
          }
          if (value === 0) reject('number option to ' + quoted('s') + ' command may not be zero', pos - 1);
          cmd.number = value;
          continue;
        }
        if (flag === 'w') {
          pos += 1;
          cmd.writeFile = readFilename();
          if (cmd.writeFile.length === 0) reject('missing filename in r/R/w/W commands', pos);
          break;
        }
        if (flag === 'e') reject('unsupported flag ' + quoted('e') + ' for ' + quoted('s') + ' command', pos);
        if (flag === ' ' || flag === '\t' || flag === '\n' || flag === '\r' || flag === ';' || flag === '}') break;
        reject('unknown option to ' + quoted('s'), pos);
      }
      cmd.regex = resolveRegex(patternRaw, ignoreCase, pos);
    } else if (ch === 'y') {
      const delimiter = text[pos];
      pos += 1;
      const fromRaw = readDelimited(delimiter, 'y');
      const toRaw = readDelimited(delimiter, 'y');
      const from = Array.from(unescapeChars(fromRaw));
      const to = Array.from(unescapeChars(toRaw));
      if (from.length !== to.length) reject('strings for ' + quoted('y') + ' command are different lengths', pos);
      const table = new Map();
      for (let i = 0; i < from.length; i += 1) {
        if (!table.has(from[i])) table.set(from[i], to[i]);
      }
      cmd.trans = table;
    } else if (ch === 'a' || ch === 'i' || ch === 'c') {
      // GNU sed accepts three text forms: `a\` + newline + text lines,
      // `a text` (leading blanks are skipped) and `aX` (text starts at once).
      // A \ at the very end of the script carries no text at all: a and i
      // output nothing and c drops the line; a command at end of file without
      // any text is an error, exactly like GNU sed.
      let raw = '';
      let noText = false;
      if (text[pos] === '\\') {
        pos += 1;
        if (pos >= len) noText = true;
        else if (text[pos] === '\n') pos += 1;
      } else {
        while (pos < len && (text[pos] === ' ' || text[pos] === '\t')) pos += 1;
        if (pos >= len) {
          reject('expected \\ after ' + quoted('a') + ', ' + quoted('c') + ' or ' + quoted('i'), pos);
        }
      }
      if (!noText) {
        while (pos < len) {
          const c = text[pos];
          if (c === '\n') break;
          if (c === '\\' && text[pos + 1] === '\n') {
            raw += '\n';
            pos += 2;
            continue;
          }
          raw += c;
          pos += 1;
        }
      }
      cmd.text = noText ? null : unescapeChars(raw);
    } else if (ch === 'q' || ch === 'Q') {
      const code = readNumber();
      cmd.code = code === null ? 0 : code;
    } else if (ch === 'l') {
      cmd.width = readNumber();
    } else if (ch === 'r' || ch === 'w') {
      cmd.file = readFilename();
      if (cmd.file.length === 0) reject('missing filename in r/R/w/W commands', pos);
    } else if (ch === 'b' || ch === 't' || ch === 'T') {
      cmd.label = readLabel();
      if (cmd.label.length > 0) branches.push(cmd);
    } else if (ch === ':') {
      const label = readLabel();
      cmd.label = label;
      if (label.length > 0 && !labels.has(label)) labels.set(label, cmd.index);
    } else if (ch === 'd' || ch === 'D' || ch === 'p' || ch === 'P' || ch === 'n' ||
               ch === 'N' || ch === 'h' || ch === 'H' || ch === 'g' || ch === 'G' ||
               ch === 'x' || ch === '=') {
      // no arguments
    } else {
      reject('unknown command: ' + quoted(ch), pos - 1);
    }

    commands.push(cmd);
  }

  if (blockStack.length > 0) reject('unmatched ' + quoted('{'), 0);
  for (const branch of branches) {
    const target = labels.get(branch.label);
    if (target === undefined) {
      throw new ScriptFailure("can't find label for jump to " + quoted(branch.label), null);
    }
    branch.jump = target;
  }

  return {
    commands,
    locate,
    quietDirective: text.startsWith('#n') && (text.length === 2 || text[2] === '\n'),
  };
}

// ---------------------------------------------------------------------------
// engine helpers
// ---------------------------------------------------------------------------

/** Escape the pattern space the way the l command does, wrapping at width. */
function sedEscape(text, width) {
  const pieces = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '\\') pieces.push('\\\\');
    else if (ch === '\x07') pieces.push('\\a');
    else if (ch === '\b') pieces.push('\\b');
    else if (ch === '\f') pieces.push('\\f');
    else if (ch === '\n') pieces.push('\\n');
    else if (ch === '\r') pieces.push('\\r');
    else if (ch === '\t') pieces.push('\\t');
    else if (ch === '\v') pieces.push('\\v');
    else if (code >= 0x20 && code < 0x7f) pieces.push(ch);
    else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        pieces.push('\\' + byte.toString(8).padStart(3, '0'));
      }
    }
  }
  let out = '';
  let column = 0;
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    out += piece;
    column += piece.length;
    if (width > 0 && column >= width - 1 && i < pieces.length - 1) {
      out += '\\\n';
      column = 0;
    }
  }
  return out + '$';
}

const ACTION_END = 'end';
const ACTION_DELETE = 'delete';
const ACTION_HALT = 'halt';
const ACTION_QUIT = 'quit';
const ACTION_QUIT_NOW = 'quit-now';

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function main(prog, argv, ctx) {
  const args = argv.slice();
  if (args.length > 0 && args[0] === prog) args.shift();

  let opts;
  try {
    opts = parseArgs(args);
  } catch (error) {
    if (error instanceof ArgError) return fail(prog, error.message, 2);
    throw error;
  }

  if (opts.version) return writeOut('sed (dsh coreutils) ' + VERSION + '\n');
  if (opts.help) return writeOut(HELP_TEXT);

  const sources = [];
  for (const script of opts.scripts) {
    if (script.kind === 'f') {
      let content;
      try {
        content = ctx.fs.readText(script.text, ctx.cwd, { maxBytes: Infinity });
      } catch (error) {
        const code = error instanceof ShellError ? error.code : 'EINVAL';
        return fail(prog, "couldn't open file " + script.text + ': ' +
          (ERRNO_TEXT[code] || 'Input/output error'), 2);
      }
      sources.push({ text: content });
    } else {
      sources.push({ text: script.text });
    }
  }

  let program;
  try {
    program = parseProgram(sources, opts.ere);
  } catch (error) {
    if (error instanceof ScriptFailure) {
      const where = error.pos === null ? null : program_location(sources, error.pos);
      return fail(prog, (where === null ? '' : where + ': ') + error.message, 2);
    }
    throw error;
  }

  const quiet = opts.quiet || program.quietDirective;

  if (opts.inPlace !== null && opts.files.length === 0) return fail(prog, 'no input files', 2);

  // ----- load input -----
  const inputs = [];
  const readErrors = [];
  const loadOne = (path, isStdin) => {
    if (isStdin) {
      const raw = typeof ctx.stdin === 'string' ? ctx.stdin : '';
      inputs.push({ path, raw, lines: splitRecords(raw), failed: false });
      return;
    }
    try {
      const raw = ctx.fs.readText(path, ctx.cwd, { maxBytes: Infinity });
      inputs.push({ path, raw, lines: splitRecords(raw), failed: false });
    } catch (error) {
      const code = error instanceof ShellError ? error.code : 'EINVAL';
      readErrors.push(prog + ": can't read " + path + ': ' + (ERRNO_TEXT[code] || 'Input/output error') + '\n');
      inputs.push({ path, raw: '', lines: [], failed: true });
    }
  };
  if (opts.files.length === 0) loadOne('-', true);
  else for (const path of opts.files) loadOne(path, path === '-' && opts.inPlace === null);

  let totalLines = 0;
  for (const input of inputs) totalLines += input.lines.length;

  // ----- state -----
  const st = {
    ps: '',
    chomped: false,
    hold: '',
    holdChomped: false,
    queue: [],
    substituted: false,
    lineNo: 0,
    lastLine: false,
    out: '',
    err: readErrors.join(''),
    code: readErrors.length > 0 ? 1 : 0,
    exitCode: null,
    haltAfterCycle: false,
    fileDone: false,
  };
  let cursorFile = 0;
  let cursorLine = -1;
  let globalLine = 0;

  const wbuffers = new Map();
  const wdevices = new Map();

  const deviceWrite = (name, text) => {
    const device = ctx.fs.deviceFor(name, ctx.cwd);
    if (device === 'stdout') st.out += text;
    else if (device === 'stderr') st.err += text;
  };
  const openWFile = name => {
    if (wbuffers.has(name) || wdevices.has(name)) return;
    const device = ctx.fs.deviceFor(name, ctx.cwd);
    if (device !== null) {
      wdevices.set(name, device);
      return;
    }
    try {
      ctx.fs.writeText(name, ctx.cwd, '');
      wbuffers.set(name, '');
    } catch (error) {
      const code = error instanceof ShellError ? error.code : 'EINVAL';
      st.err += prog + ": couldn't open file " + name + ': ' +
        (ERRNO_TEXT[code] || 'Input/output error') + '\n';
      st.code = st.code === 0 ? 1 : st.code;
      wdevices.set(name, 'failed');
    }
  };
  const writeWFile = (name, text) => {
    if (!wbuffers.has(name) && !wdevices.has(name)) openWFile(name);
    if (wbuffers.has(name)) {
      wbuffers.set(name, wbuffers.get(name) + text);
      return;
    }
    if (wdevices.get(name) === 'failed') return;
    deviceWrite(name, text);
  };

  for (const cmd of program.commands) {
    if (cmd.cmd === 'w' && typeof cmd.file === 'string') openWFile(cmd.file);
    if (cmd.cmd === 's' && typeof cmd.writeFile === 'string') openWFile(cmd.writeFile);
  }

  const ensureNewline = () => {
    if (st.out.length > 0 && !st.out.endsWith('\n')) st.out += '\n';
  };
  const emit = (text, newline) => {
    ensureNewline();
    st.out += text;
    if (newline) st.out += '\n';
  };
  const flushQueue = () => {
    if (st.queue.length === 0) return;
    for (const line of st.queue) emit(line, true);
    st.queue.length = 0;
  };
  const printPatternSpace = () => emit(st.ps, !st.chomped);

  const resetRanges = () => {
    for (const cmd of program.commands) {
      cmd.rangeActive = false;
      cmd.rangeStarted = false;
      cmd.rangeEverStarted = false;
    }
  };

  const matchAddress = address => {
    if (address.kind === 'line') return st.lineNo === address.line;
    if (address.kind === 'last') return st.lastLine;
    if (address.kind === 'step') {
      if (address.step === 0) return st.lineNo === address.first;
      if (address.first === 0) return st.lineNo > 0 && st.lineNo % address.step === 0;
      return st.lineNo >= address.first && (st.lineNo - address.first) % address.step === 0;
    }
    address.regex.lastIndex = 0;
    return address.regex.test(st.ps);
  };

  // A numeric second address ends the range on the first line whose number is
  // greater than or equal to it, so 3,2p still ends after line 3 (GNU sed).
  const rangeEndMatches = cmd => {
    if (cmd.addr2.kind === 'line') return st.lineNo >= cmd.addr2.line;
    return matchAddress(cmd.addr2);
  };

  const addressMatches = cmd => {
    cmd.rangeStarted = false;
    const zeroStart = cmd.addr1 !== null && cmd.addr1.kind === 'line' && cmd.addr1.line === 0;
    let result;
    if (cmd.addr1 === null) result = true;
    else if (cmd.addr2 === null) result = matchAddress(cmd.addr1);
    else if (zeroStart) {
      // GNU's 0,/REGEX/ range: open on line 1, test REGEX on line 1 too, and
      // never reopen once the range has closed.
      if (cmd.rangeActive) {
        if (rangeEndMatches(cmd)) cmd.rangeActive = false;
        result = true;
      } else if (cmd.rangeEverStarted) {
        result = false;
      } else {
        // c never prints its text for a 0,/regex/ range: the range starts on a
        // line that does not exist, so GNU never treats it as started.
        cmd.rangeEverStarted = true;
        result = true;
        if (rangeEndMatches(cmd)) cmd.rangeActive = false;
        else cmd.rangeActive = true;
      }
    } else if (!cmd.rangeActive) {
      if (!matchAddress(cmd.addr1)) result = false;
      else {
        cmd.rangeActive = true;
        cmd.rangeStarted = true;
        if (cmd.addr2.kind !== 'regex' && rangeEndMatches(cmd)) cmd.rangeActive = false;
        result = true;
      }
    } else {
      if (rangeEndMatches(cmd)) cmd.rangeActive = false;
      result = true;
    }
    return cmd.negate ? !result : result;
  };

  const applySubstitution = cmd => {
    const text = st.ps;
    const regex = cmd.regex;
    const target = cmd.number > 0 ? cmd.number : 1;
    let result = '';
    let emitted = 0;
    let scan = 0;
    let count = 0;
    let lastEnd = -1;
    let previousNonEmpty = false;
    let matched = false;
    while (scan <= text.length) {
      regex.lastIndex = scan;
      const match = regex.exec(text);
      if (match === null) break;
      const start = match.index;
      const end = start + match[0].length;
      const empty = end === start;
      count += 1;
      if (empty && start === lastEnd && previousNonEmpty) {
        scan = start + 1;
        continue;
      }
      if (count < target) {
        scan = empty ? start + 1 : end;
        lastEnd = end;
        previousNonEmpty = !empty;
        continue;
      }
      matched = true;
      result += text.slice(emitted, start) + expandReplacement(cmd.replacement, match);
      emitted = end;
      lastEnd = end;
      previousNonEmpty = !empty;
      scan = empty ? start + 1 : end;
      if (!cmd.global) break;
    }
    if (!matched) return false;
    result += text.slice(emitted);
    st.ps = result;
    return true;
  };

  const setupLine = (input, index) => {
    globalLine += 1;
    const line = input.lines[index];
    st.lineNo = opts.separate ? index + 1 : globalLine;
    st.lastLine = opts.separate ? index === input.lines.length - 1 : globalLine === totalLines;
    st.ps = line.text;
    st.chomped = line.chomped;
    st.substituted = false;
  };

  const stepWithinFile = () => {
    const input = inputs[cursorFile];
    if (input === undefined) return false;
    cursorLine += 1;
    if (cursorLine >= input.lines.length) return false;
    setupLine(input, cursorLine);
    return true;
  };
  const stepAcrossFiles = () => {
    for (;;) {
      const input = inputs[cursorFile];
      if (input === undefined) return false;
      cursorLine += 1;
      if (cursorLine < input.lines.length) {
        setupLine(input, cursorLine);
        return true;
      }
      cursorFile += 1;
      cursorLine = -1;
      if (inputs[cursorFile] === undefined) return false;
    }
  };
  const advanceLine = () => (opts.separate ? stepWithinFile() : stepAcrossFiles());

  const runLine = () => {
    const commands = program.commands;
    let pc = 0;
    for (;;) {
      if (pc >= commands.length) return ACTION_END;
      const cmd = commands[pc];
      if (!addressMatches(cmd)) {
        if (cmd.cmd === '{') pc = cmd.jump;
        else pc += 1;
        continue;
      }
      switch (cmd.cmd) {
        case '{':
        case '}':
          pc += 1;
          continue;
        case 's':
          if (applySubstitution(cmd)) {
            st.substituted = true;
            if (cmd.print) printPatternSpace();
            if (cmd.writeFile !== null) writeWFile(cmd.writeFile, st.ps + (st.chomped ? '' : '\n'));
          }
          pc += 1;
          continue;
        case 'y': {
          let next = '';
          for (const ch of st.ps) {
            const mapped = cmd.trans.get(ch);
            next += mapped === undefined ? ch : mapped;
          }
          st.ps = next;
          pc += 1;
          continue;
        }
        case 'd':
          return ACTION_DELETE;
        case 'D': {
          const index = st.ps.indexOf('\n');
          if (index === -1) return ACTION_DELETE;
          st.ps = st.ps.slice(index + 1);
          pc = 0;
          continue;
        }
        case 'p':
          printPatternSpace();
          pc += 1;
          continue;
        case 'P': {
          const index = st.ps.indexOf('\n');
          emit(index === -1 ? st.ps : st.ps.slice(0, index), true);
          pc += 1;
          continue;
        }
        case '=':
          emit(String(st.lineNo), true);
          pc += 1;
          continue;
        case 'l': {
          const width = cmd.width === null ? opts.lineWidth : cmd.width;
          emit(sedEscape(st.ps, width), true);
          pc += 1;
          continue;
        }
        case 'a':
          if (cmd.text !== null) {
            for (const line of cmd.text.split('\n')) st.queue.push(line);
          }
          pc += 1;
          continue;
        case 'i':
          if (cmd.text !== null) {
            for (const line of cmd.text.split('\n')) emit(line, true);
          }
          pc += 1;
          continue;
        case 'c':
          // c prints its text once per range, but every selected line prints it
          // when the range is negated (GNU sed).
          if (cmd.text !== null && (cmd.addr2 === null || cmd.rangeStarted || cmd.negate)) {
            for (const line of cmd.text.split('\n')) emit(line, true);
          }
          return ACTION_DELETE;
        case 'r':
          try {
            const content = ctx.fs.readText(cmd.file, ctx.cwd, { maxBytes: Infinity });
            for (const line of splitRecords(content)) st.queue.push(line.text);
          } catch {
            // GNU sed silently ignores unreadable r files
          }
          pc += 1;
          continue;
        case 'w':
          writeWFile(cmd.file, st.ps + (st.chomped ? '' : '\n'));
          pc += 1;
          continue;
        case 'h':
          st.hold = st.ps;
          st.holdChomped = st.chomped;
          pc += 1;
          continue;
        case 'H':
          st.hold = st.hold + '\n' + st.ps;
          st.holdChomped = st.chomped;
          pc += 1;
          continue;
        case 'g':
          st.ps = st.hold;
          st.chomped = st.holdChomped;
          pc += 1;
          continue;
        case 'G':
          st.ps = st.ps + '\n' + st.hold;
          pc += 1;
          continue;
        case 'x': {
          const ps = st.ps;
          const chomped = st.chomped;
          st.ps = st.hold;
          st.chomped = st.holdChomped;
          st.hold = ps;
          st.holdChomped = chomped;
          pc += 1;
          continue;
        }
        case 'b':
          if (cmd.label === '') return ACTION_END;
          pc = cmd.jump;
          continue;
        case 't':
          if (st.substituted) {
            st.substituted = false;
            if (cmd.label === '') return ACTION_END;
            pc = cmd.jump;
            continue;
          }
          pc += 1;
          continue;
        case 'T':
          if (!st.substituted) {
            st.substituted = false;
            if (cmd.label === '') return ACTION_END;
            pc = cmd.jump;
            continue;
          }
          pc += 1;
          continue;
        case 'n': {
          if (!quiet) printPatternSpace();
          flushQueue();
          if (!advanceLine()) {
            st.fileDone = true;
            return ACTION_HALT;
          }
          pc += 1;
          continue;
        }
        case 'N': {
          const saved = { ps: st.ps, chomped: st.chomped };
          if (!advanceLine()) {
            st.ps = saved.ps;
            st.chomped = saved.chomped;
            if (opts.separate) {
              st.fileDone = true;
              return ACTION_END;
            }
            st.haltAfterCycle = true;
            return ACTION_END;
          }
          st.ps = saved.ps + '\n' + st.ps;
          pc += 1;
          continue;
        }
        case 'q':
          if (!quiet) printPatternSpace();
          flushQueue();
          st.exitCode = cmd.code;
          return ACTION_QUIT;
        case 'Q':
          st.exitCode = cmd.code;
          return ACTION_QUIT_NOW;
        default:
          pc += 1;
          continue;
      }
    }
  };

  const finishFile = input => {
    if (opts.inPlace === null) return;
    if (input.failed || input.path === '-') return;
    const suffix = opts.inPlace.suffix;
    if (suffix.length > 0) {
      const backup = suffix.indexOf('*') !== -1 ? suffix.split('*').join(input.path) : input.path + suffix;
      try {
        ctx.fs.writeText(backup, ctx.cwd, input.raw);
      } catch (error) {
        const code = error instanceof ShellError ? error.code : 'EINVAL';
        st.err += prog + ": couldn't write backup " + backup + ': ' +
          (ERRNO_TEXT[code] || 'Input/output error') + '\n';
        st.code = st.code === 0 ? 1 : st.code;
        return;
      }
    }
    try {
      ctx.fs.writeText(input.path, ctx.cwd, st.out);
    } catch (error) {
      const code = error instanceof ShellError ? error.code : 'EINVAL';
      st.err += prog + ": couldn't write " + input.path + ': ' +
        (ERRNO_TEXT[code] || 'Input/output error') + '\n';
      st.code = st.code === 0 ? 1 : st.code;
    }
  };

  let halted = false;

  const runCycle = () => {
    const action = runLine();
    if (action === ACTION_END) {
      if (!quiet) printPatternSpace();
      flushQueue();
      if (st.haltAfterCycle) halted = true;
      return;
    }
    if (action === ACTION_DELETE) {
      flushQueue();
      return;
    }
    if (action === ACTION_HALT) {
      flushQueue();
      halted = true;
      return;
    }
    if (action === ACTION_QUIT || action === ACTION_QUIT_NOW) {
      halted = true;
    }
  };

  if (opts.separate) {
    for (cursorFile = 0; cursorFile < inputs.length; cursorFile += 1) {
      cursorLine = -1;
      resetRanges();
      st.fileDone = false;
      halted = false;
      if (opts.inPlace !== null) st.out = '';
      while (!halted && !st.fileDone) {
        if (!stepWithinFile()) break;
        if (typeof ctx.check === 'function' && (globalLine & 1023) === 0) ctx.check();
        runCycle();
      }
      finishFile(inputs[cursorFile]);
    }
  } else {
    cursorFile = 0;
    cursorLine = -1;
    while (!halted) {
      if (!stepAcrossFiles()) break;
      if (typeof ctx.check === 'function' && (globalLine & 1023) === 0) ctx.check();
      runCycle();
    }
  }

  for (const entry of wbuffers) {
    try {
      ctx.fs.writeText(entry[0], ctx.cwd, entry[1]);
    } catch (error) {
      const code = error instanceof ShellError ? error.code : 'EINVAL';
      st.err += prog + ": couldn't write " + entry[0] + ': ' +
        (ERRNO_TEXT[code] || 'Input/output error') + '\n';
      st.code = st.code === 0 ? 1 : st.code;
    }
  }

  const code = st.exitCode !== null ? st.exitCode : st.code;
  const out = opts.inPlace === null ? st.out : '';
  if (code === 0) return writeOut(out);
  return { code, out, err: st.err };
}

/** Build the "expression #N, char M" prefix for a script error position. */
function program_location(sources, at) {
  const segments = [];
  let offset = 0;
  for (let i = 0; i < sources.length; i += 1) {
    if (i > 0) offset += 1;
    segments.push({ start: offset, length: sources[i].text.length, index: i });
    offset += sources[i].text.length;
  }
  let segment = segments[segments.length - 1];
  for (const candidate of segments) {
    if (at <= candidate.start + candidate.length) {
      segment = candidate;
      break;
    }
  }
  if (segment === undefined) return null;
  const char = Math.min(at + 1, segment.start + segment.length) - segment.start;
  return '-e expression #' + (segment.index + 1) + ', char ' + char;
}
