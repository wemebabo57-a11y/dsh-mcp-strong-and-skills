// Shell parser: token stream -> AST per docs/shell-design.md.
// Synchronous, dependency-free; performs no expansion and no execution.

const EOF_TOKEN = Object.freeze({ t: 'eof' });
const COMPOUND_KINDS = new Set(['group', 'if', 'for', 'while', 'until', 'case']);

/** Parse a token stream produced by lex() into a node list. */
export function parseScript(tokens) {
  const normalized = Array.isArray(tokens)
    ? tokens.map((token) => (token && token.t === 'op' && token.v === 'newline' ? { ...token, v: '\n' } : token))
    : [];
  const parser = new Parser(normalized);
  const body = parser.parseBlock([]);
  if (!parser.atEnd()) parser.unexpected(parser.peek());
  return body;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek(offset = 0) {
    const token = this.tokens[this.index + offset];
    return token === undefined ? EOF_TOKEN : token;
  }

  next() {
    const token = this.peek();
    if (token !== EOF_TOKEN) this.index += 1;
    return token;
  }

  atEnd() {
    return this.index >= this.tokens.length;
  }

  atOp(value) {
    return isOp(this.peek(), value);
  }

  isOpAt(offset, value) {
    return isOp(this.peek(offset), value);
  }

  atKeyword(keyword) {
    return plainWord(this.peek()) === keyword;
  }

  skipNewlines() {
    while (this.atOp('\n')) this.next();
  }

  isStop(stops) {
    if (this.atEnd()) return true;
    const token = this.peek();
    if (token.t === 'word') {
      const text = plainWord(token);
      if (text !== null && stops.includes(text)) return true;
    }
    if (token.t === 'op' && stops.includes(token.v)) return true;
    return false;
  }

  parseBlock(stops) {
    const nodes = [];
    this.skipNewlines();
    while (!this.atEnd() && !this.isStop(stops)) {
      nodes.push(this.parseList(stops));
      this.skipNewlines();
    }
    return nodes;
  }

  parseList(stops) {
    const items = [];
    for (;;) {
      if (this.atEnd() || this.isStop(stops)) break;
      const node = this.parseAndOr(stops);
      let sep = '\n';
      let terminated = false;
      const token = this.peek();
      if (isOp(token, ';')) { this.next(); sep = ';'; }
      else if (isOp(token, '&')) { this.next(); sep = '&'; }
      else if (isOp(token, '\n')) { this.skipNewlines(); sep = '\n'; }
      else { terminated = true; }
      items.push({ node, sep });
      if (terminated) break;
      if (this.atEnd() || this.isStop(stops)) break;
    }
    return { k: 'list', items };
  }

  parseAndOr(stops) {
    const first = this.parsePipeline(stops);
    const rest = [];
    while (this.atOp('&&') || this.atOp('||')) {
      const op = this.next().v;
      this.skipNewlines();
      rest.push({ op, node: this.parsePipeline(stops) });
    }
    return rest.length === 0 ? first : { k: 'andor', first, rest };
  }

  parsePipeline(stops) {
    let negate = false;
    while (this.atKeyword('!')) {
      this.next();
      negate = !negate;
      this.skipNewlines();
    }
    const cmds = [this.parseCommand(stops)];
    while (this.atOp('|')) {
      this.next();
      this.skipNewlines();
      cmds.push(this.parseCommand(stops));
    }
    return cmds.length === 1 && !negate ? cmds[0] : { k: 'pipeline', negate, cmds };
  }

  parseCommand(stops) {
    const token = this.peek();
    if (token.t === 'arith') {
      this.next();
      const node = { k: 'arithcmd', src: token.src };
      this.attachRedirs(node);
      return node;
    }
    if (isOp(token, '(')) {
      this.next();
      return this.parseGroupBody(')', true);
    }
    if (isOp(token, '{')) {
      this.next();
      return this.parseGroupBody('}', false);
    }
    if (token.t === 'word') {
      const text = plainWord(token);
      if (text === 'if') { this.next(); return this.parseIf(); }
      if (text === 'while' || text === 'until') { this.next(); return this.parseWhile(text); }
      if (text === 'for') { this.next(); return this.parseFor(); }
      if (text === 'case') { this.next(); return this.parseCase(); }
      if (text === 'function') { this.next(); return this.parseFunctionKeyword(); }
      if (text !== null && isName(text) && this.isOpAt(1, '(') && this.isOpAt(2, ')')) {
        this.next();
        this.next();
        this.next();
        return this.parseFunctionBody(text);
      }
    }
    return this.parseSimple();
  }

  parseGroupBody(close, subshell) {
    const body = this.parseBlock([close]);
    if (!this.atOp(close)) this.unexpected(this.peek());
    this.next();
    const node = { k: 'group', body, subshell };
    this.attachRedirs(node);
    return node;
  }

  parseFunctionBody(name) {
    this.skipNewlines();
    const body = this.parseCommand([]);
    if (!COMPOUND_KINDS.has(body.k)) this.unexpected(this.peek());
    return { k: 'func', name, body };
  }

  parseFunctionKeyword() {
    const nameToken = this.peek();
    const name = plainWord(nameToken);
    if (name === null || !isName(name)) this.unexpected(nameToken);
    this.next();
    if (this.atOp('(') && this.isOpAt(1, ')')) {
      this.next();
      this.next();
    }
    return this.parseFunctionBody(name);
  }

  parseIf() {
    const branches = [];
    let cond = this.parseBlock(['then']);
    if (cond.length === 0) this.unexpected(this.peek());
    this.expectKeyword('then');
    let body = this.parseBlock(['elif', 'else', 'fi']);
    branches.push({ cond, body });
    while (this.atKeyword('elif')) {
      this.next();
      cond = this.parseBlock(['then']);
      if (cond.length === 0) this.unexpected(this.peek());
      this.expectKeyword('then');
      body = this.parseBlock(['elif', 'else', 'fi']);
      branches.push({ cond, body });
    }
    let elseBody = null;
    if (this.atKeyword('else')) {
      this.next();
      elseBody = this.parseBlock(['fi']);
    }
    this.expectKeyword('fi');
    const node = { k: 'if', branches, elseBody };
    this.attachRedirs(node);
    return node;
  }

  parseWhile(kind) {
    const cond = this.parseBlock(['do']);
    if (cond.length === 0) this.unexpected(this.peek());
    this.expectKeyword('do');
    const body = this.parseBlock(['done']);
    this.expectKeyword('done');
    const node = { k: kind, cond, body };
    this.attachRedirs(node);
    return node;
  }

  parseFor() {
    const token = this.peek();
    if (token.t === 'arith') {
      this.next();
      this.skipNewlines();
      if (this.atOp(';')) { this.next(); this.skipNewlines(); }
      this.expectKeyword('do');
      const body = this.parseBlock(['done']);
      this.expectKeyword('done');
      return { k: 'for', name: null, words: null, arith: token.src, body };
    }
    const nameToken = this.peek();
    const name = plainWord(nameToken);
    if (name === null || !isName(name)) this.unexpected(nameToken);
    this.next();
    let words = null;
    if (this.atKeyword('in')) {
      this.next();
      words = [];
      while (this.peek().t === 'word') words.push(toWord(this.next()));
    }
    this.skipNewlines();
    if (this.atOp(';')) { this.next(); this.skipNewlines(); }
    this.expectKeyword('do');
    const body = this.parseBlock(['done']);
    this.expectKeyword('done');
    return { k: 'for', name, words, body };
  }

  parseCase() {
    const wordToken = this.peek();
    if (wordToken.t !== 'word') this.unexpected(wordToken);
    const word = toWord(this.next());
    this.skipNewlines();
    this.expectKeyword('in');
    this.skipNewlines();
    const arms = [];
    for (;;) {
      this.skipNewlines();
      if (this.atKeyword('esac')) { this.next(); break; }
      if (this.atOp('(')) this.next();
      const pats = [];
      for (;;) {
        const pattern = this.peek();
        if (pattern.t !== 'word') this.unexpected(pattern);
        pats.push(toWord(this.next()));
        if (this.atOp('|')) { this.next(); continue; }
        break;
      }
      if (!this.atOp(')')) this.unexpected(this.peek());
      this.next();
      const body = this.parseBlock([';;', ';&', ';;&', 'esac']);
      let term = ';;';
      if (this.atOp(';;') || this.atOp(';&') || this.atOp(';;&')) term = this.next().v;
      arms.push({ pats, body, term, fall: term !== ';;' });
    }
    const node = { k: 'case', word, arms };
    this.attachRedirs(node);
    return node;
  }

  parseSimple() {
    const assigns = [];
    const words = [];
    const redirs = [];
    for (;;) {
      const token = this.peek();
      if (token.t === 'redir' || token.t === 'heredoc') {
        redirs.push(toRedir(this.next()));
        continue;
      }
      if (token.t !== 'word') break;
      const word = this.next();
      if (words.length === 0) {
        const rawWord = word.raw || '';
        const firstPart = word.parts && word.parts[0];
        if (firstPart && firstPart.t === 'lit' && firstPart.q === 0) {
          const indexed = /^([A-Za-z_][A-Za-z0-9_]*)\[([0-9]+)\]=([\s\S]*)$/.exec(rawWord);
          if (indexed) {
            const valueParts = indexed[3] ? [{ t: 'lit', v: indexed[3], q: 0 }] : [];
            assigns.push({ name: indexed[1], index: Number(indexed[2]), value: { parts: valueParts } });
            continue;
          }
          const appending = /^([A-Za-z_][A-Za-z0-9_]*)\+=$/.exec(rawWord);
          if (appending && this.atOp('(')) {
            this.next();
            const items = [];
            while (!this.atOp(')')) {
              if (this.peek().t !== 'word') this.unexpected(this.peek());
              items.push(toWord(this.next()));
            }
            this.next();
            assigns.push({ name: appending[1], value: { parts: [] }, array: items, append: true });
            continue;
          }
        }
        const assignment = splitAssignment(word);
        if (assignment) {
          if (!assignment.value.parts.length && this.atOp('(')) {
            this.next();
            const items = [];
            while (!this.atOp(')')) {
              if (this.peek().t !== 'word') this.unexpected(this.peek());
              items.push(toWord(this.next()));
            }
            this.next();
            assigns.push({ name: assignment.name, value: { parts: [] }, array: items });
            continue;
          }
          assigns.push(assignment);
          continue;
        }
      }
      words.push({ parts: word.parts, cond: word.cond });
    }
    if (assigns.length === 0 && words.length === 0 && redirs.length === 0) {
      this.unexpected(this.peek());
    }
    return { k: 'simple', assigns, words, redirs };
  }

  attachRedirs(node) {
    let redirs = null;
    for (;;) {
      const token = this.peek();
      if (token.t === 'redir' || token.t === 'heredoc') {
        if (redirs === null) redirs = [];
        redirs.push(toRedir(this.next()));
        continue;
      }
      break;
    }
    if (redirs !== null) node.redirs = redirs;
    return node;
  }

  expectKeyword(keyword) {
    if (!this.atKeyword(keyword)) this.unexpected(this.peek());
    this.next();
  }

  unexpected(token) {
    if (!token || token.t === 'eof') throw new Error('syntax error: unexpected end of file');
    throw new Error("syntax error near unexpected token \`" + describeToken(token) + "'");
  }
}

function isOp(token, value) {
  return Boolean(token) && token.t === 'op' && token.v === value;
}

function plainWord(token) {
  if (!token || token.t !== 'word') return null;
  const parts = token.parts;
  if (parts.length !== 1) return null;
  const part = parts[0];
  return part.t === 'lit' && part.q === 0 ? part.v : null;
}

function isName(text) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

function toWord(token) {
  return { parts: token.parts };
}

function toRedir(token) {
  if (token.t === 'heredoc') {
    return {
      fd: token.fd,
      op: '<<',
      target: { parts: [{ t: 'lit', v: token.delim, q: token.quoted ? 1 : 0 }] },
      here: { delim: token.delim, body: token.body, quoted: token.quoted, stripTabs: token.stripTabs },
    };
  }
  return { fd: token.fd, op: token.op, target: { parts: token.target.parts } };
}

function splitAssignment(token) {
  const parts = token.parts;
  if (parts.length === 0) return null;
  const first = parts[0];
  if (first.t !== 'lit' || first.q !== 0) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(first.v);
  if (!match) return null;
  const valueParts = [];
  if (match[2].length > 0) valueParts.push({ t: 'lit', v: match[2], q: 0 });
  for (let i = 1; i < parts.length; i += 1) valueParts.push(parts[i]);
  return { name: match[1], value: { parts: valueParts } };
}

function describeToken(token) {
  if (!token || token.t === 'eof') return 'end of file';
  if (token.t === 'op') return token.v === '\n' ? 'newline' : token.v;
  if (token.t === 'word') {
    const text = plainWord(token);
    return text !== null ? text : token.raw;
  }
  if (token.t === 'redir') return token.op;
  if (token.t === 'heredoc') return '<<';
  if (token.t === 'arith') return '((';
  return token.t;
}
