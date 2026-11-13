// Bash-compatible arithmetic evaluation for $(( )) and (( )).
// 64-bit signed semantics approximated with JS numbers, truncated toward zero.

const OPS = [
  '<<=', '>>=', '**=', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '++', '--',
  '+', '-', '*', '/', '%', '!', '~', '<', '>', '&', '|', '^', '?', ':', '=', '(', ')', ',',
];

function lex(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9a-zA-Z#_]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    let matched = null;
    for (const op of OPS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (!matched) throw new Error('arithmetic syntax error: ' + src);
    tokens.push({ t: 'op', v: matched });
    i += matched.length;
  }
  return tokens;
}

function parseNumber(text) {
  if (text.includes('#')) {
    const at = text.indexOf('#');
    const radix = Number(text.slice(0, at));
    const digits = text.slice(at + 1);
    const value = Number.parseInt(digits, radix);
    return Number.isFinite(value) ? value : 0;
  }
  if (/^0[xX]/.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^0[0-7]+$/.test(text)) return Number.parseInt(text.slice(1), 8);
  return Number.parseInt(text, 10) || 0;
}

const BINARY = {
  ',': 1,
  '=': 2, '+=': 2, '-=': 2, '*=': 2, '/=': 2, '%=': 2, '<<=': 2, '>>=': 2, '&=': 2, '^=': 2, '|=': 2,
  '?': 3,
  '||': 4,
  '&&': 5,
  '|': 6,
  '^': 7,
  '&': 8,
  '==': 9, '!=': 9,
  '<': 10, '>': 10, '<=': 10, '>=': 10,
  '<<': 11, '>>': 11,
  '+': 12, '-': 12,
  '*': 13, '/': 13, '%': 13,
  '**': 14,
};

const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']);

export function evalArith(src, scope, depth = 0) {
  if (depth > 32) throw new Error('arithmetic recursion too deep: ' + src);
  const tokens = lex(String(src));
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (value) => {
    const token = next();
    if (!token || token.v !== value) throw new Error('arithmetic syntax error near ' + (token ? token.v : 'end of expression'));
    return token;
  };

  function getVariable(name) {
    const raw = scope.getVar(name);
    if (raw === undefined) return 0;
    if (/^\s*[+-]?(\d+|0[xX][0-9a-fA-F]+)$/.test(String(raw))) return Number(String(raw).trim());
    if (String(raw).trim() === '') return 0;
    return Number(evalArith(String(raw), scope, depth + 1)) || 0;
  }

  function prefix() {
    const token = next();
    if (!token) throw new Error('arithmetic syntax error: unexpected end of expression');
    if (token.t === 'num') return parseNumber(token.v);
    if (token.t === 'name') {
      if (peek() && peek().v === '++') { next(); const value = getVariable(token.v) + 1; scope.setVar(token.v, String(value)); return value; }
      if (peek() && peek().v === '--') { next(); const value = getVariable(token.v) - 1; scope.setVar(token.v, String(value)); return value; }
      return getVariable(token.v);
    }
    if (token.v === '(') { const value = expression(1); expect(')'); return value; }
    if (token.v === '!') return valueOf(prefix()) ? 0 : 1;
    if (token.v === '~') return ~toInt(valueOf(prefix()));
    if (token.v === '-') return -valueOf(prefix());
    if (token.v === '+') return valueOf(prefix());
    if (token.v === '++') { const name = next(); if (!name || name.t !== 'name') throw new Error('arithmetic syntax error: ++ needs a variable'); const value = getVariable(name.v) + 1; scope.setVar(name.v, String(value)); return value; }
    if (token.v === '--') { const name = next(); if (!name || name.t !== 'name') throw new Error('arithmetic syntax error: -- needs a variable'); const value = getVariable(name.v) - 1; scope.setVar(name.v, String(value)); return value; }
    throw new Error('arithmetic syntax error near ' + token.v);
  }

  function valueOf(value) { return value && typeof value === 'object' ? value.value : value; }
  function toInt(value) { const number = Number(valueOf(value)); return Number.isFinite(number) ? Math.trunc(number) : 0; }

  function apply(op, left, right) {
    switch (op) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': if (right === 0) throw new Error('division by 0'); return toInt(left / right);
      case '%': if (right === 0) throw new Error('division by 0'); return left % right;
      case '**': return Math.pow(left, right);
      case '<<': return toInt(left) << (toInt(right) & 63);
      case '>>': return toInt(left) >> (toInt(right) & 63);
      case '&': return toInt(left) & toInt(right);
      case '|': return toInt(left) | toInt(right);
      case '^': return toInt(left) ^ toInt(right);
      case '==': return left === right ? 1 : 0;
      case '!=': return left !== right ? 1 : 0;
      case '<': return left < right ? 1 : 0;
      case '>': return left > right ? 1 : 0;
      case '<=': return left <= right ? 1 : 0;
      case '>=': return left >= right ? 1 : 0;
      case '&&': return left && right ? 1 : 0;
      case '||': return left || right ? 1 : 0;
      case ',': return right;
      default: throw new Error('arithmetic syntax error: ' + op);
    }
  }

  function expression(minPrecedence) {
    let left = prefix();
    for (;;) {
      const token = peek();
      if (!token || token.t !== 'op') break;
      const op = token.v;
      if (op === ')' || op === ':' || op === ',') break;
      const precedence = BINARY[op];
      if (precedence === undefined) break;
      if (ASSIGN.has(op)) {
        if (minPrecedence > 2) break;
        next();
        const right = expression(2);
        if (!left || left.node !== 'ref') throw new Error('arithmetic syntax error: assignment needs a variable');
        const current = getVariable(left.name);
        const rightValue = valueOf(right);
        const value = op === '=' ? rightValue : apply(op.slice(0, -1), current, rightValue);
        scope.setVar(left.name, String(value));
        left = { value, node: undefined };
        continue;
      }
      if (op === '?') {
        if (minPrecedence > 3) break;
        next();
        const yes = expression(1);
        expect(':');
        const no = expression(3);
        left = { value: left.value ? yes.value ?? yes : no.value ?? no };
        continue;
      }
      if (precedence < minPrecedence) break;
      next();
      const right = expression(op === '**' ? precedence : precedence + 1);
      left = { value: apply(op, valueOf(left), valueOf(right)) };
    }
    return left;
  }

  // Variables need to be addressable for assignment: wrap names.
  const originalPrefix = prefix;
  pos = 0;
  // Re-run with a reference-aware prefix by redefining lookup through the name node.

  function prefixRef() {
    const token = peek();
    if (token && token.t === 'name' && peekAhead() && ASSIGN.has(peekAhead().v)) {
      next();
      return { value: getVariable(token.v), name: token.v, node: 'ref' };
    }
    const raw = originalPrefix();
    const value = raw && typeof raw === 'object' ? raw.value : raw;
    return { value, node: undefined };
  }
  function peekAhead() { return tokens[pos + 1]; }
  // Swap prefix for the reference-aware variant used by expression().
  const saved = prefix;
  // eslint-disable-next-line no-func-assign
  prefix = prefixRef;
  try {
    const result = expression(1);
    return result && typeof result === 'object' ? result.value : result;
  } finally {
    prefix = saved;
  }
}
