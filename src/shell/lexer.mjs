// Shell lexer: script text -> token stream per docs/shell-design.md.
// Synchronous, pure ESM, zero dependencies. No expansion or execution here.
import { parseScript } from './parser.mjs';

const SPECIAL_PARAMETERS = new Set(['?', '#', '@', '*', '$', '!', '-']);
const COMMAND_KEYWORDS = new Set(['if', 'while', 'until', 'for', 'then', 'else', 'elif', 'do', '!', 'time']);
const WORD_BREAKS = new Set([' ', '\t', '\n', '|', '&', ';', '(', ')', '<', '>']);
const OPERATOR_START = new Set(['&', '|', ';', '(', ')', '{', '}', '<', '>', '\n']);

/** Lex a script into tokens. options is accepted for forward compatibility. */
export function lex(script, options = {}) {
  const text = script === undefined || script === null ? '' : String(script);
  const source = text.replace(/\r\n/g, '\n');
  return new Lexer(source, options).run();
}

class Lexer {
  constructor(source, options) {
    this.src = source;
    this.length = source.length;
    this.i = 0;
    this.options = options ?? {};
    this.pendingHeredocs = [];
    this.expectFunctionName = false;
  }

  run() {
    const tokens = [];
    let commandPos = true;
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (ch === ' ' || ch === '\t') { this.i += 1; continue; }
      if (ch === '\n') {
        this.i += 1;
        if (this.pendingHeredocs.length) this.readHeredocBodies();
        tokens.push({ t: 'op', v: 'newline' });
        commandPos = true;
        continue;
      }
      if (ch === '#') { this.skipComment(); continue; }
      if (ch === '&') {
        if (this.src.startsWith('&>>', this.i)) {
          this.i += 3;
          tokens.push(this.redirToken(null, '&>>'));
          continue;
        }
        if (this.src.startsWith('&>', this.i)) {
          this.i += 2;
          tokens.push(this.redirToken(null, '&>'));
          continue;
        }
        if (this.src.startsWith('&&', this.i)) {
          this.i += 2;
          tokens.push({ t: 'op', v: '&&' });
          commandPos = true;
          continue;
        }
        this.i += 1;
        tokens.push({ t: 'op', v: '&' });
        commandPos = true;
        continue;
      }
      if (ch === '|') {
        if (this.src.startsWith('||', this.i)) { this.i += 2; tokens.push({ t: 'op', v: '||' }); }
        else { this.i += 1; tokens.push({ t: 'op', v: '|' }); }
        commandPos = true;
        continue;
      }
      if (ch === ';') {
        if (this.src.startsWith(';;&', this.i)) { this.i += 3; tokens.push({ t: 'op', v: ';;&' }); }
        else if (this.src.startsWith(';;', this.i)) { this.i += 2; tokens.push({ t: 'op', v: ';;' }); }
        else if (this.src.startsWith(';&', this.i)) { this.i += 2; tokens.push({ t: 'op', v: ';&' }); }
        else { this.i += 1; tokens.push({ t: 'op', v: ';' }); }
        commandPos = true;
        continue;
      }
      if (ch === '(') {
        if (commandPos && this.src[this.i + 1] === '(') {
          const start = this.i + 2;
          const end = scanArithmetic(this.src, start);
          const text = this.src.slice(start, end - 2).trim();
          this.i = end;
          tokens.push({ t: 'arith', src: text });
          commandPos = false;
          continue;
        }
        this.i += 1;
        tokens.push({ t: 'op', v: '(' });
        commandPos = true;
        continue;
      }
      if (ch === ')') {
        this.i += 1;
        tokens.push({ t: 'op', v: ')' });
        commandPos = true;
        continue;
      }
      if (ch === '{' || ch === '}') {
        if (commandPos && isBraceDelimiter(this.src[this.i + 1])) {
          this.i += 1;
          tokens.push({ t: 'op', v: ch });
          commandPos = ch === '{';
          continue;
        }
      }
      if (commandPos && ch === '[' && this.src[this.i + 1] === '[') {
        const after = this.src[this.i + 2];
        if (after === undefined || after === ' ' || after === '\t' || after === '\n') {
          const inner = this.readConditional();
          tokens.push({ t: 'word', parts: [{ t: 'lit', v: inner, q: 1 }], raw: '[[' + inner + ']]', cond: inner });
          commandPos = false;
          continue;
        }
      }
      if (ch === '<' || ch === '>') {
        const token = this.readRedirection(null);
        if (token.t === 'heredoc') this.pendingHeredocs.push(token);
        tokens.push(token);
        continue;
      }
      if (isDigit(ch)) {
        let j = this.i;
        while (isDigit(this.src[j])) j += 1;
        if (this.src[j] === '<' || this.src[j] === '>') {
          const fd = Number(this.src.slice(this.i, j));
          this.i = j;
          const token = this.readRedirection(fd);
          if (token.t === 'heredoc') this.pendingHeredocs.push(token);
          tokens.push(token);
          continue;
        }
      }
      const start = this.i;
      const word = this.readWord();
      if (!word) {
        if (this.i === start) this.i += 1;
        continue;
      }
      tokens.push(word);
      const value = plainWordValue(word);
      if (commandPos && value === 'function') {
        this.expectFunctionName = true;
        commandPos = false;
      } else if (this.expectFunctionName) {
        this.expectFunctionName = false;
        commandPos = true;
      } else {
        commandPos = value !== null && COMMAND_KEYWORDS.has(value);
      }
    }
    if (this.pendingHeredocs.length) {
      throw new Error('syntax error: unexpected end of file');
    }
    return tokens;
  }

  skipComment() {
    while (this.i < this.length && this.src[this.i] !== '\n') this.i += 1;
  }
  readConditional() {
    this.i += 2;
    const start = this.i;
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (ch === '\\') { this.i += 2; continue; }
      if (ch === "'") {
        this.i += 1;
        while (this.i < this.length && this.src[this.i] !== "'") this.i += 1;
        if (this.i >= this.length) this.eofError("']'");
        this.i += 1;
        continue;
      }
      if (ch === '"') {
        this.i += 1;
        while (this.i < this.length) {
          const inner = this.src[this.i];
          if (inner === '\\') { this.i += 2; continue; }
          if (inner === '"') { this.i += 1; break; }
          this.i += 1;
        }
        continue;
      }
      if (ch === ']' && this.src[this.i + 1] === ']') {
        const after = this.src[this.i + 2];
        if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === ';' || after === '&' || after === '|' || after === ')' || after === ')') {
          const inner = this.src.slice(start, this.i);
          this.i += 2;
          return inner;
        }
      }
      this.i += 1;
    }
    throw new Error('syntax error: unexpected end of file inside [[ ]]');
  }

  readRedirection(fd) {
    const src = this.src;
    let op;
    let stripTabs = false;
    if (src[this.i] === '<') {
      if (src.startsWith('<<<', this.i)) { op = '<<<'; this.i += 3; }
      else if (src.startsWith('<<-', this.i)) { op = '<<'; stripTabs = true; this.i += 3; }
      else if (src.startsWith('<<', this.i)) { op = '<<'; this.i += 2; }
      else if (src.startsWith('<&', this.i)) { op = '<&'; this.i += 2; }
      else if (src.startsWith('<>', this.i)) { op = '<>'; this.i += 2; }
      else { op = '<'; this.i += 1; }
    } else if (src.startsWith('>>', this.i)) { op = '>>'; this.i += 2; }
    else if (src.startsWith('>&', this.i)) { op = '>&'; this.i += 2; }
    else { op = '>'; this.i += 1; }
    if (op === '<<') {
      const { delim, quoted } = this.readHeredocDelimiter();
      return { t: 'heredoc', fd, delim, quoted, stripTabs, body: '' };
    }
    return this.redirToken(fd, op);
  }

  redirToken(fd, op) {
    return { t: 'redir', fd, op, target: this.readRedirTarget() };
  }

  readRedirTarget() {
    while (this.src[this.i] === ' ' || this.src[this.i] === '\t') this.i += 1;
    if (this.src[this.i] === '#') {
      this.skipComment();
      const next = this.src[this.i];
      const text = next === '\n' ? 'newline' : next === undefined ? 'end of file' : next;
      throw new Error("syntax error near unexpected token \`" + text + "'");
    }
    const word = this.readWord();
    if (!word) {
      const next = this.src[this.i];
      const text = next === '\n' ? 'newline' : next === undefined ? 'end of file' : next;
      throw new Error("syntax error near unexpected token \`" + text + "'");
    }
    return { parts: word.parts };
  }

  readHeredocDelimiter() {
    while (this.src[this.i] === ' ' || this.src[this.i] === '\t') this.i += 1;
    let text = '';
    let quoted = false;
    let saw = false;
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || '|&;()<>'.includes(ch)) break;
      saw = true;
      if (ch === '\\') {
        quoted = true;
        this.i += 1;
        const next = this.src[this.i];
        if (next === undefined) break;
        if (next === '\n') { this.i += 1; continue; }
        text += next;
        this.i += 1;
        continue;
      }
      if (ch === "'") {
        quoted = true;
        this.i += 1;
        const end = this.src.indexOf("'", this.i);
        if (end < 0) this.eofError("'");
        text += this.src.slice(this.i, end);
        this.i = end + 1;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        this.i += 1;
        while (this.i < this.length && this.src[this.i] !== '"') {
          if (this.src[this.i] === '\\') {
            if (this.src[this.i + 1] !== undefined) text += this.src[this.i + 1];
            this.i += 2;
            continue;
          }
          text += this.src[this.i];
          this.i += 1;
        }
        if (this.i >= this.length) this.eofError('"');
        this.i += 1;
        continue;
      }
      text += ch;
      this.i += 1;
    }
    if (!saw) {
      const next = this.src[this.i];
      const label = next === '\n' ? 'newline' : next === undefined ? 'end of file' : next;
      throw new Error("syntax error near unexpected token \`" + label + "'");
    }
    return { delim: text, quoted };
  }

  readHeredocBodies() {
    while (this.pendingHeredocs.length) {
      const token = this.pendingHeredocs.shift();
      let body = '';
      for (;;) {
        if (this.i >= this.length) {
          throw new Error("unexpected EOF while looking for matching '" + token.delim + "'");
        }
        const newline = this.src.indexOf('\n', this.i);
        const end = newline < 0 ? this.length : newline;
        const line = this.src.slice(this.i, end);
        const candidate = token.stripTabs ? line.replace(/^\t+/, '') : line;
        if (candidate === token.delim) {
          this.i = end < this.length ? end + 1 : end;
          break;
        }
        body += (token.stripTabs ? candidate : line) + '\n';
        if (newline < 0) {
          throw new Error("unexpected EOF while looking for matching '" + token.delim + "'");
        }
        this.i = newline + 1;
      }
      token.body = body;
    }
  }

  readWord() {
    const start = this.i;
    const parts = [];
    let saw = false;
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (WORD_BREAKS.has(ch)) break;
      if (ch === '\\') {
        const next = this.src[this.i + 1];
        if (next === undefined) { addLiteral(parts, '\\', 0); saw = true; this.i += 1; continue; }
        if (next === '\n') { this.i += 2; continue; }
        addLiteral(parts, next, 1);
        saw = true;
        this.i += 2;
        continue;
      }
      if (ch === "'") {
        this.i += 1;
        const end = this.src.indexOf("'", this.i);
        if (end < 0) this.eofError("'");
        addLiteral(parts, this.src.slice(this.i, end), 1);
        this.i = end + 1;
        saw = true;
        continue;
      }
      if (ch === '"') {
        const before = parts.length;
        this.i += 1;
        this.readDoubleQuoted(parts);
        if (parts.length === before) addLiteral(parts, '', 2);
        saw = true;
        continue;
      }
      if (ch === '$') {
        this.readDollar(parts, 0);
        saw = true;
        continue;
      }
      if (ch === '`') {
        this.readBacktick(parts, 0);
        saw = true;
        continue;
      }
      addLiteral(parts, ch, 0);
      saw = true;
      this.i += 1;
    }
    if (!saw) return null;
    return { t: 'word', parts, raw: this.src.slice(start, this.i) };
  }

  readDoubleQuoted(parts) {
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (ch === '"') { this.i += 1; return; }
      if (ch === '\\') {
        const next = this.src[this.i + 1];
        if (next === undefined) { addLiteral(parts, '\\', 2); this.i += 1; continue; }
        if (next === '\n') { this.i += 2; continue; }
        if (next === '$' || next === '`' || next === '"' || next === '\\') {
          addLiteral(parts, next, 2);
          this.i += 2;
          continue;
        }
        addLiteral(parts, '\\', 2);
        this.i += 1;
        continue;
      }
      if (ch === '$') { this.readDollar(parts, 2); continue; }
      if (ch === '`') { this.readBacktick(parts, 2); continue; }
      addLiteral(parts, ch, 2);
      this.i += 1;
    }
    this.eofError('"');
  }

  readDollar(parts, quote) {
    this.i += 1;
    const ch = this.src[this.i];
    if (ch === undefined) { addLiteral(parts, '$', quote); return; }
    if (ch === '{') { this.readParamBraced(parts, quote); return; }
    if (ch === '(') {
      if (this.src[this.i + 1] === '(') {
        const start = this.i + 2;
        const end = scanArithmetic(this.src, start);
        const text = this.src.slice(start, end - 2).trim();
        this.i = end;
        parts.push({ t: 'arith', src: text, q: quote });
        return;
      }
      const inner = this.readCommandSubstitution();
      const ast = parseScript(new Lexer(inner, this.options).run());
      parts.push({ t: 'cmd', ast, q: quote });
      return;
    }
    if (quote === 0 && ch === "'") {
      const value = this.readAnsiC();
      addLiteral(parts, value, 1);
      return;
    }
    if (quote === 0 && ch === '"') {
      const before = parts.length;
      this.i += 1;
      this.readDoubleQuoted(parts);
      if (parts.length === before) addLiteral(parts, '', 2);
      return;
    }
    if (isDigit(ch)) {
      this.i += 1;
      parts.push(this.parameter(ch, true, false, false, quote));
      return;
    }
    if (SPECIAL_PARAMETERS.has(ch)) {
      this.i += 1;
      parts.push(this.parameter(ch, true, false, false, quote));
      return;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const name = this.readName();
      parts.push(this.parameter(name, false, false, false, quote));
      return;
    }
    addLiteral(parts, '$', quote);
  }

  parameter(name, special, braced, len, quote) {
    return { t: 'param', name, special, braced, len, op: null, arg: null, slice: null, q: quote };
  }

  readName() {
    const start = this.i;
    while (this.i < this.length && /[A-Za-z0-9_]/.test(this.src[this.i])) this.i += 1;
    return this.src.slice(start, this.i);
  }

  readDigits() {
    const start = this.i;
    while (this.i < this.length && isDigit(this.src[this.i])) this.i += 1;
    return this.src.slice(start, this.i);
  }

  readCommandSubstitution() {
    const start = this.i + 1;
    const end = scanParentheses(this.src, start);
    this.i = end;
    return this.src.slice(start, end - 1);
  }

  readBacktick(parts, quote) {
    this.i += 1;
    let inner = '';
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (ch === '\\') {
        const next = this.src[this.i + 1];
        if (next === '`' || next === '\\' || next === '$') {
          inner += next;
          this.i += 2;
          continue;
        }
        inner += '\\';
        this.i += 1;
        continue;
      }
      if (ch === '`') {
        this.i += 1;
        const ast = parseScript(new Lexer(inner, this.options).run());
        parts.push({ t: 'cmd', ast, q: quote });
        return;
      }
      inner += ch;
      this.i += 1;
    }
    this.eofError('`');
  }

  readAnsiC() {
    this.i += 1;
    let out = '';
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (ch === "'") { this.i += 1; return out; }
      if (ch !== '\\') { out += ch; this.i += 1; continue; }
      this.i += 1;
      const code = this.src[this.i];
      if (code === undefined) break;
      if (code === 'n') { out += '\n'; this.i += 1; continue; }
      if (code === 't') { out += '\t'; this.i += 1; continue; }
      if (code === 'r') { out += '\r'; this.i += 1; continue; }
      if (code === 'a') { out += '\x07'; this.i += 1; continue; }
      if (code === 'b') { out += '\b'; this.i += 1; continue; }
      if (code === 'f') { out += '\f'; this.i += 1; continue; }
      if (code === 'v') { out += '\v'; this.i += 1; continue; }
      if (code === 'e' || code === 'E') { out += '\x1b'; this.i += 1; continue; }
      if (code === '\\' || code === "'" || code === '"' || code === '?') { out += code; this.i += 1; continue; }
      if (code === 'x') {
        this.i += 1;
        let digits = '';
        while (digits.length < 2 && /[0-9A-Fa-f]/.test(this.src[this.i])) { digits += this.src[this.i]; this.i += 1; }
        out += digits ? String.fromCodePoint(Number.parseInt(digits, 16)) : '\\x';
        continue;
      }
      if (code === 'u' || code === 'U') {
        const max = code === 'u' ? 4 : 8;
        this.i += 1;
        let digits = '';
        while (digits.length < max && /[0-9A-Fa-f]/.test(this.src[this.i])) { digits += this.src[this.i]; this.i += 1; }
        out += digits ? String.fromCodePoint(Number.parseInt(digits, 16)) : '\\' + code;
        continue;
      }
      if (code === 'c') {
        this.i += 1;
        const next = this.src[this.i];
        if (next === undefined) { out += '\\c'; continue; }
        out += String.fromCharCode(next.toUpperCase().charCodeAt(0) ^ 0x40);
        this.i += 1;
        continue;
      }
      if (code >= '0' && code <= '7') {
        let digits = '';
        while (digits.length < 3 && this.src[this.i] >= '0' && this.src[this.i] <= '7') {
          digits += this.src[this.i];
          this.i += 1;
        }
        out += String.fromCharCode(Number.parseInt(digits, 8));
        continue;
      }
      out += '\\' + code;
      this.i += 1;
    }
    this.eofError("'");
  }

  readParamBraced(parts, quote) {
    this.i += 1;
    let len = false;
    let indirect = false;
    if (this.src[this.i] === '#') {
      if (this.src[this.i + 1] === '}') {
        this.i += 2;
        parts.push(this.parameter('#', true, true, false, quote));
        return;
      }
      len = true;
      this.i += 1;
    }
    if (this.src[this.i] === '!') { indirect = true; this.i += 1; }
    const ch = this.src[this.i];
    if (ch === undefined) this.eofError('}');
    let name;
    let special = false;
    if (/[A-Za-z_]/.test(ch)) {
      name = this.readName();
    } else if (isDigit(ch)) {
      name = this.readDigits();
      special = true;
    } else if (SPECIAL_PARAMETERS.has(ch)) {
      name = ch;
      special = true;
      this.i += 1;
    } else {
      throw new Error('bad substitution: ' + this.src.slice(this.i));
    }
    let index = null;
    if (this.src[this.i] === '[') {
      const close = this.src.indexOf(']', this.i + 1);
      if (close > this.i) {
        const inside = this.src.slice(this.i + 1, close).trim();
        if (/^[0-9]+$/.test(inside)) { index = Number(inside); this.i = close + 1; }
        else if (inside === '@' || inside === '*') { index = inside; this.i = close + 1; }
      }
    }
    const push = (part) => { if (indirect) part.indirect = true; if (index !== null) part.index = index; parts.push(part); };
    const finish = (...args) => { this.finishParameter(parts, ...args); if (indirect) parts[parts.length - 1].indirect = true; if (index !== null) parts[parts.length - 1].index = index; };
    if (this.i >= this.length) this.eofError('}');
    if (this.src[this.i] === '}') {
      this.i += 1;
      push(this.parameter(name, special, true, len, quote));
      return;
    }
    const operator = this.src[this.i];
    const next = this.src[this.i + 1];
    if (operator === ':' && (next === '-' || next === '=' || next === '+' || next === '?')) {
      this.i += 2;
      const arg = this.readExpansionArgument(quote);
      finish(name, special, len, operator + next, arg, null, quote);
      return;
    }
    if (operator === ':') {
      this.i += 1;
      const offset = this.readSliceText().trim();
      let length = null;
      if (this.src[this.i] === ':') {
        this.i += 1;
        length = this.readSliceText().trim();
      }
      if (this.src[this.i] !== '}') {
        throw new Error('bad substitution: ' + this.src.slice(this.i));
      }
      this.i += 1;
      push({ t: 'param', name, special, braced: true, len, op: null, arg: null, slice: [offset, length], q: quote });
      return;
    }
    if (operator === '-' || operator === '=' || operator === '+' || operator === '?') {
      this.i += 1;
      const arg = this.readExpansionArgument(quote);
      finish(name, special, len, operator, arg, null, quote);
      return;
    }
    if (operator === '^' || operator === ',') {
      const doubled = next === operator;
      const op2 = doubled ? operator + operator : operator;
      this.i += doubled ? 2 : 1;
      if (this.src[this.i] === '}') {
        this.i += 1;
        push({ t: 'param', name, special, braced: true, len, op: op2, arg: null, slice: null, q: quote });
        return;
      }
      const arg = this.readExpansionArgument(quote);
      finish(name, special, len, op2, arg, null, quote);
      return;
    }
    if (operator === '#' || operator === '%') {
      const doubled = next === operator;
      const op = doubled ? operator + operator : operator;
      this.i += doubled ? 2 : 1;
      const arg = this.readExpansionArgument(quote);
      finish(name, special, len, op, arg, null, quote);
      return;
    }
    if (operator === '/') {
      const doubled = next === '/';
      const op = doubled ? '//' : '/';
      this.i += doubled ? 2 : 1;
      const first = this.readExpansionWord(quote, true);
      let replacement = { parts: [] };
      if (first.stop === '/') {
        this.i += 1;
        const second = this.readExpansionWord(quote, false);
        if (second.stop !== '}') this.eofError('}');
        this.i += 1;
        replacement = { parts: second.parts };
      } else {
        this.i += 1;
      }
      finish(name, special, len, op, first.parts, null, quote, replacement);
      return;
    }
    throw new Error('bad substitution: ' + this.src.slice(this.i));
  }

  finishParameter(parts, name, special, len, op, arg, slice, quote, replacement) {
    const part = { t: 'param', name, special, braced: true, len, op, arg, slice, q: quote };
    if (replacement !== undefined) part.replacement = replacement;
    parts.push(part);
  }

  readExpansionArgument(quote) {
    const result = this.readExpansionWord(quote, false);
    if (result.stop !== '}') this.eofError('}');
    this.i += 1;
    return result.parts;
  }

  readExpansionWord(quote, stopSlash) {
    const parts = [];
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (ch === '}') return { parts, stop: '}' };
      if (stopSlash && ch === '/') return { parts, stop: '/' };
      if (quote === 2) {
        if (ch === '"') { this.i += 1; this.readDoubleQuoted(parts); continue; }
        if (ch === "'") {
          const end = this.src.indexOf("'", this.i + 1);
          if (end < 0) this.eofError("'");
          addLiteral(parts, this.src.slice(this.i, end + 1), 2);
          this.i = end + 1;
          continue;
        }
        if (ch === '\\') {
          const next = this.src[this.i + 1];
          if (next === '\n') { this.i += 2; continue; }
          if (stopSlash && next === '/') { addLiteral(parts, '/', 2); this.i += 2; continue; }
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
            addLiteral(parts, next, 2);
            this.i += 2;
            continue;
          }
          addLiteral(parts, '\\', 2);
          this.i += 1;
          continue;
        }
        if (ch === '$') { this.readDollar(parts, 2); continue; }
        if (ch === '`') { this.readBacktick(parts, 2); continue; }
        addLiteral(parts, ch, 2);
        this.i += 1;
        continue;
      }
      if (ch === '\\') {
        const next = this.src[this.i + 1];
        if (next === undefined) { addLiteral(parts, '\\', 1); this.i += 1; continue; }
        if (next === '\n') { this.i += 2; continue; }
        addLiteral(parts, next, 1);
        this.i += 2;
        continue;
      }
      if (ch === "'") {
        this.i += 1;
        const end = this.src.indexOf("'", this.i);
        if (end < 0) this.eofError("'");
        addLiteral(parts, this.src.slice(this.i, end), 1);
        this.i = end + 1;
        continue;
      }
      if (ch === '"') { this.i += 1; this.readDoubleQuoted(parts); continue; }
      if (ch === '$') { this.readDollar(parts, 0); continue; }
      if (ch === '`') { this.readBacktick(parts, 0); continue; }
      addLiteral(parts, ch, 0);
      this.i += 1;
    }
    this.eofError('}');
  }

  readSliceText() {
    const start = this.i;
    let depth = 0;
    while (this.i < this.length) {
      const ch = this.src[this.i];
      if (ch === '\\') { this.i += 2; continue; }
      if (ch === "'") { this.i = scanSingleQuote(this.src, this.i + 1); continue; }
      if (ch === '"') { this.i = scanDoubleQuote(this.src, this.i + 1); continue; }
      if (ch === '`') { this.i = scanBacktick(this.src, this.i + 1); continue; }
      if (ch === '$' && this.src[this.i + 1] === '{') { this.i = scanBraces(this.src, this.i + 2); continue; }
      if (ch === '$' && this.src[this.i + 1] === '(') {
        this.i = this.src[this.i + 2] === '(' ? scanArithmetic(this.src, this.i + 3) : scanParentheses(this.src, this.i + 2);
        continue;
      }
      if (ch === '(') { depth += 1; this.i += 1; continue; }
      if (ch === ')') { if (depth > 0) depth -= 1; this.i += 1; continue; }
      if ((ch === ':' || ch === '}') && depth === 0) break;
      this.i += 1;
    }
    return this.src.slice(start, this.i);
  }

  eofError(marker) {
    throw new Error("unexpected EOF while looking for matching '" + marker + "'");
  }
}

function isDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isBraceDelimiter(ch) {
  return ch === undefined || ch === '' || ch === ' ' || ch === '\t' || ch === '\n'
    || ch === ';' || ch === '&' || ch === '|' || ch === ')' || ch === '<' || ch === '>';
}

function addLiteral(parts, value, quote) {
  if (!value && quote === 0) return;
  const last = parts[parts.length - 1];
  if (last && last.t === 'lit' && last.q === quote) last.v += value;
  else parts.push({ t: 'lit', v: value, q: quote });
}

function plainWordValue(word) {
  if (!word || word.t !== 'word' || word.parts.length !== 1) return null;
  const part = word.parts[0];
  if (part.t !== 'lit' || part.q !== 0) return null;
  return part.v;
}

function isCommentStart(source, index) {
  if (index === 0) return true;
  const previous = source[index - 1];
  return previous === ' ' || previous === '\t' || previous === '\n'
    || previous === ';' || previous === '|' || previous === '&' || previous === '('
    || previous === ')' || previous === '{' || previous === '}' || previous === '<' || previous === '>';
}

function skipComment(source, index) {
  const newline = source.indexOf('\n', index);
  return newline < 0 ? source.length : newline;
}

function scanSingleQuote(source, index) {
  const end = source.indexOf("'", index);
  if (end < 0) throw new Error("unexpected EOF while looking for matching \"'\"");
  return end + 1;
}

function scanDoubleQuote(source, index) {
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') { index += 2; continue; }
    if (ch === '"') return index + 1;
    if (ch === '`') { index = scanBacktick(source, index + 1); continue; }
    if (ch === '$' && source[index + 1] === '{') { index = scanBraces(source, index + 2); continue; }
    if (ch === '$' && source[index + 1] === '(') {
      index = source[index + 2] === '(' ? scanArithmetic(source, index + 3) : scanParentheses(source, index + 2);
      continue;
    }
    index += 1;
  }
  throw new Error("unexpected EOF while looking for matching '\"'");
}

function scanBacktick(source, index) {
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') { index += 2; continue; }
    if (ch === '`') return index + 1;
    index += 1;
  }
  throw new Error("unexpected EOF while looking for matching '\`'");
}

function scanBraces(source, index) {
  let depth = 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') { index += 2; continue; }
    if (ch === "'") { index = scanSingleQuote(source, index + 1); continue; }
    if (ch === '"') { index = scanDoubleQuote(source, index + 1); continue; }
    if (ch === '`') { index = scanBacktick(source, index + 1); continue; }
    if (ch === '$' && source[index + 1] === '{') { depth += 1; index += 2; continue; }
    if (ch === '$' && source[index + 1] === '(') {
      index = source[index + 2] === '(' ? scanArithmetic(source, index + 3) : scanParentheses(source, index + 2);
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  throw new Error("unexpected EOF while looking for matching '}'");
}

function scanParentheses(source, index) {
  let depth = 0;
  const pending = [];
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') { index += 2; continue; }
    if (ch === "'") { index = scanSingleQuote(source, index + 1); continue; }
    if (ch === '"') { index = scanDoubleQuote(source, index + 1); continue; }
    if (ch === '`') { index = scanBacktick(source, index + 1); continue; }
    if (ch === '#' && isCommentStart(source, index)) { index = skipComment(source, index); continue; }
    if (ch === '<' && source[index + 1] === '<' && source[index + 2] !== '<') {
      let cursor = index + 2;
      let stripTabs = false;
      if (source[cursor] === '-') { stripTabs = true; cursor += 1; }
      const delimiter = scanDelimiterWord(source, cursor);
      pending.push({ delim: delimiter.text, stripTabs });
      index = delimiter.end;
      continue;
    }
    if (ch === '$' && source[index + 1] === '{') { index = scanBraces(source, index + 2); continue; }
    if (ch === '$' && source[index + 1] === '(' && source[index + 2] === '(') {
      index = scanArithmetic(source, index + 3);
      continue;
    }
    if (ch === '(' && source[index + 1] === '(') {
      index = scanArithmetic(source, index + 2);
      continue;
    }
    if (ch === '\n') {
      index += 1;
      if (pending.length) {
        index = skipHeredocBodies(source, index, pending);
        pending.length = 0;
      }
      continue;
    }
    if (ch === '(') { depth += 1; index += 1; continue; }
    if (ch === ')') {
      if (depth === 0) return index + 1;
      depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  throw new Error("unexpected EOF while looking for matching ')'");
}

function scanDelimiterWord(source, index) {
  let text = '';
  while (index < source.length) {
    const ch = source[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || '|&;()<>'.includes(ch)) break;
    if (ch === '\\') {
      const next = source[index + 1];
      if (next === undefined) { index += 1; break; }
      if (next === '\n') { index += 2; continue; }
      text += next;
      index += 2;
      continue;
    }
    if (ch === "'") {
      const end = source.indexOf("'", index + 1);
      if (end < 0) throw new Error("unexpected EOF while looking for matching \"'\"");
      text += source.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (ch === '"') {
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && source[index + 1] !== undefined) {
          text += source[index + 1];
          index += 2;
          continue;
        }
        text += source[index];
        index += 1;
      }
      if (index >= source.length) throw new Error("unexpected EOF while looking for matching '\"'");
      index += 1;
      continue;
    }
    text += ch;
    index += 1;
  }
  return { text, end: index };
}

function skipHeredocBodies(source, index, pending) {
  for (const item of pending) {
    for (;;) {
      const newline = source.indexOf('\n', index);
      const end = newline < 0 ? source.length : newline;
      let line = source.slice(index, end);
      if (item.stripTabs) line = line.replace(/^\t+/, '');
      if (line === item.delim) {
        index = newline < 0 ? end : end + 1;
        break;
      }
      if (newline < 0) throw new Error("unexpected EOF while looking for matching '" + item.delim + "'");
      index = newline + 1;
    }
  }
  return index;
}

function scanArithmetic(source, index) {
  let depth = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') { index += 2; continue; }
    if (ch === "'") { index = scanSingleQuote(source, index + 1); continue; }
    if (ch === '"') { index = scanDoubleQuote(source, index + 1); continue; }
    if (ch === '`') { index = scanBacktick(source, index + 1); continue; }
    if (ch === '$' && source[index + 1] === '{') { index = scanBraces(source, index + 2); continue; }
    if (ch === '(') { depth += 1; index += 1; continue; }
    if (ch === ')') {
      if (depth === 0 && source[index + 1] === ')') return index + 2;
      if (depth > 0) depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  throw new Error("unexpected EOF while looking for matching '))'");
}
