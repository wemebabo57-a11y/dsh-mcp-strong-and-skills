// Word expansion: quoting, parameter/arithmetic/command substitution, IFS
// splitting, tilde expansion and pathname expansion. Mirrors bash 5.2 behaviour
// for the constructs the interpreter supports.
import { evalArith } from './arith.mjs';
import { lex } from './lexer.mjs';

const DEFAULT_IFS = ' \t\n';
const MAGIC = /[*?[]/;

export function ifsOf(scope) {
  const raw = scope.getVar('IFS');
  if (raw === undefined) return DEFAULT_IFS;
  return String(raw);
}

function isSep(ch, ifs) {
  return ifs.indexOf(ch) !== -1;
}

// Shell glob matching is deliberately not implemented with a regular
// expression: patterns such as *a*a*a*...*b backtrack polynomially. The classic
// two-pointer matcher below is O(pattern x text) and cannot hang.
const GLOB_MAX_TOKENS = 4096;

function compileGlob(pattern) {
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      if (i < pattern.length) tokens.push({ type: 'lit', ch: pattern[i] });
      continue;
    }
    if (ch === '*') { tokens.push({ type: 'star' }); continue; }
    if (ch === '?') { tokens.push({ type: 'any' }); continue; }
    if (ch === '[') {
      let j = i + 1;
      let negate = false;
      if (pattern[j] === '!' || pattern[j] === '^') { negate = true; j++; }
      const items = [];
      let closed = false;
      let first = true;
      while (j < pattern.length) {
        let c = pattern[j];
        if (c === ']' && !first) { closed = true; j++; break; }
        first = false;
        if (c === '\\' && j + 1 < pattern.length) { c = pattern[j + 1]; j += 2; }
        else j++;
        if (pattern[j] === '-' && j + 1 < pattern.length && pattern[j + 1] !== ']') {
          let high = pattern[j + 1];
          const step = high === '\\' ? 2 : 1;
          if (high === '\\') high = pattern[j + 2];
          items.push({ lo: c, hi: high });
          j += step + 1;
        } else {
          items.push({ ch: c });
        }
      }
      if (!closed) { tokens.push({ type: 'lit', ch: '[' }); continue; }
      tokens.push({ type: 'class', negate, items });
      i = j - 1;
      continue;
    }
    tokens.push({ type: 'lit', ch });
  }
  if (tokens.length > GLOB_MAX_TOKENS) throw new RangeError('glob pattern too complex');
  return tokens;
}

function classMatches(token, ch) {
  const hit = token.items.some(item => (item.ch !== undefined ? item.ch === ch : ch >= item.lo && ch <= item.hi));
  return token.negate ? !hit : hit;
}

export function globMatch(pattern, text) {
  const tokens = compileGlob(pattern);
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const token = tokens[p];
    if (token && token.type === 'star') { star = p; resume = t; p++; continue; }
    if (token && (token.type === 'any'
      || (token.type === 'lit' && token.ch === text[t])
      || (token.type === 'class' && classMatches(token, text[t])))) {
      p++;
      t++;
      continue;
    }
    if (star !== -1) { p = star + 1; resume++; t = resume; continue; }
    return false;
  }
  while (tokens[p] && tokens[p].type === 'star') p++;
  return p === tokens.length;
}

// Find the leftmost-longest substring match, starting at or after `from`.
// Returns absolute [start, end) offsets or null. The NFA keeps the earliest
// start per pattern state and then re-runs from that start for the longest end,
// so a pathological pattern cannot backtrack exponentially.
export function globFind(pattern, text, from = 0) {
  const tokens = compileGlob(pattern);
  const total = tokens.length;
  const startAt = Math.max(0, Math.min(Number(from) || 0, text.length));

  function addState(map, state, start) {
    const previous = map.get(state);
    if (previous === undefined || start < previous) map.set(state, start);
  }
  function closeMap(map) {
    const queue = [...map.keys()];
    while (queue.length) {
      const state = queue.pop();
      const token = tokens[state];
      if (!token || token.type !== 'star') continue;
      const start = map.get(state);
      if (map.has(state + 1)) {
        if (map.get(state + 1) <= start) continue;
      }
      map.set(state + 1, start);
      queue.push(state + 1);
    }
  }
  let states = new Map();
  let start = -1;
  for (let at = startAt; at <= text.length; at++) {
    addState(states, 0, at);
    closeMap(states);
    if (states.has(total)) { start = states.get(total); break; }
    if (at === text.length) break;
    const next = new Map();
    const ch = text[at];
    for (const [state, origin] of states) {
      const token = tokens[state];
      if (!token) continue;
      if (token.type === 'star') { addState(next, state, origin); continue; }
      const hit = token.type === 'any'
        || (token.type === 'lit' && token.ch === ch)
        || (token.type === 'class' && classMatches(token, ch));
      if (hit) addState(next, state + 1, origin);
    }
    states = next;
  }
  if (start < 0) return null;

  const closeSet = set => {
    const out = new Set(set);
    const queue = [...set];
    while (queue.length) {
      const state = queue.pop();
      const token = tokens[state];
      if (!token || token.type !== 'star' || out.has(state + 1)) continue;
      out.add(state + 1);
      queue.push(state + 1);
    }
    return out;
  };
  let active = closeSet(new Set([0]));
  let end = -1;
  for (let at = start; at <= text.length; at++) {
    if (active.has(total)) end = at;
    if (at === text.length) break;
    const next = new Set();
    const ch = text[at];
    for (const state of active) {
      const token = tokens[state];
      if (!token) continue;
      if (token.type === 'star') { next.add(state); continue; }
      const hit = token.type === 'any'
        || (token.type === 'lit' && token.ch === ch)
        || (token.type === 'class' && classMatches(token, ch));
      if (hit) next.add(state + 1);
    }
    active = closeSet(next);
  }
  return end >= start ? { start, end } : null;
}

export function matchPattern(pattern, text) {
  try {
    return globMatch(pattern, text);
  } catch {
    return pattern === text;
  }
}

export function unescapePattern(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) { out += pattern[i + 1]; i++; continue; }
    out += pattern[i];
  }
  return out;
}

export function quotePattern(text) {
  let out = '';
  for (const ch of text) {
    if ('\\*?[]'.indexOf(ch) !== -1) out += '\\' + ch;
    else out += ch;
  }
  return out;
}

async function expandTilde(parts, scope) {
  if (!parts.length || parts[0].t !== 'lit' || parts[0].q !== 0) return parts;
  const value = parts[0].v;
  if (!value.startsWith('~')) return parts;
  const slash = value.search(/[/:]/);
  const name = slash === -1 ? value.slice(1) : value.slice(1, slash);
  let home;
  if (name === '') home = scope.getVar('HOME');
  else if (name === '+') home = scope.getVar('PWD');
  else if (name === '-') home = scope.getVar('OLDPWD');
  else home = scope.getVar('HOME');
  if (home === undefined) return parts;
  const rest = slash === -1 ? '' : value.slice(slash);
  return [{ t: 'lit', v: String(home) + rest, q: 1 }].concat(parts.slice(1));
}

async function expandBracedArg(parts, scope) {
  // Parameter patterns are patterns even when the expansion sits inside
  // double quotes: the outer quotes do not literalize `*` or `?`.
  const patternParts = parts.map((part) => (part.q === 0 || part.t !== 'lit' ? part : { ...part, q: 0 }));
  return expandPattern({ parts: patternParts }, scope);
}

function substitutionFileTarget(ast) {
  if (!Array.isArray(ast) || ast.length !== 1) return null;
  const list = ast[0];
  if (!list || list.k !== 'list' || !Array.isArray(list.items) || list.items.length !== 1) return null;
  const simple = list.items[0] && list.items[0].node;
  if (!simple || simple.k !== 'simple') return null;
  if ((simple.words || []).length || (simple.assigns || []).length) return null;
  const redirs = simple.redirs || [];
  if (redirs.length !== 1) return null;
  const redir = redirs[0];
  if (redir.op !== '<' || (redir.fd !== null && redir.fd !== 0)) return null;
  return redir.target || null;
}

export async function expandSubstitution(part, scope) {
  const fileWord = substitutionFileTarget(part.ast);
  if (fileWord) {
    const file = await expandSingle(fileWord, scope);
    const text = scope.fs.readText(file, scope.cwd);
    return String(text === undefined || text === null ? '' : text).replace(/\n+$/, '');
  }
  const text = await scope.shell.runSubstitution(part.ast, scope);
  return String(text === undefined || text === null ? '' : text).replace(/\n+$/, '');
}

async function substPartText(part, scope) {
  if (part.t === 'cmd') return expandSubstitution(part, scope);
  if (part.t === 'arith') return String(evalArith(await expandArithText(part.src, scope), scope));
  return '';
}

export async function parameterValue(part, scope) {
  let name = part.name;
  const colon = !!(part.op && part.op.startsWith(':'));
  const op = part.op ? (colon ? part.op.slice(1) : part.op) : null;
  const nounset = !!(scope.opts && scope.opts.nounset);

  if (part.special) {
    if (name === '?') return String(scope.lastStatus | 0);
    if (name === '#') return String(scope.positional ? scope.positional.length : 0);
    if (name === '$') return String(scope.pid || 1);
    if (name === '!') return String(scope.lastBgPid || 0);
    if (name === '-') return scope.opts && scope.opts.xtrace ? 'x' : '';
    if (name === '0') return String(scope.name || 'shell');
    if (name === '@' || name === '*') {
      const items = scope.positional ? scope.positional.slice() : [];
      if (name === '*') return items.join(ifsOf(scope).charAt(0) || ' ');
      return items;
    }
    if (/^[0-9]+$/.test(name)) {
      const index = Number(name);
      const items = scope.positional || [];
      return index >= 1 && index <= items.length ? String(items[index - 1]) : '';
    }
  }

  if (part.indirect) {
    const target = scope.getVar(name);
    if (target === undefined) {
      if (nounset) throw new Error(name + ': unbound variable');
      return '';
    }
    name = String(target);
  }

  let raw = scope.getVar(name);
  if (part.len && Array.isArray(raw) && (part.index === '@' || part.index === '*')) return String(raw.length);
  if (Array.isArray(raw)) {
    const index = part.index === null || part.index === undefined ? 0 : part.index;
    if (index === '@' || index === '*') {
      const items = raw.slice();
      if (op === null && !part.slice && !part.len) {
        if (index === '*') return items.join(ifsOf(scope).charAt(0) || ' ');
        return items;
      }
      raw = items.join(' ');
    } else {
      let position = Number(index);
      if (position < 0) position = raw.length + position;
      raw = raw[position];
    }
  }
  let unset = raw === undefined;
  let value = unset ? '' : String(raw);

  if (part.len) {
    if (name === '@' || name === '*') return String((scope.positional || []).length);
    return String(value.length);
  }

  const empty = !value;
  const missing = unset || (colon && empty);

  if (part.slice) {
    const offsetText = part.slice[0];
    const lengthText = part.slice[1];
    let offset = offsetText === null || offsetText === undefined ? 0 : Number(evalArith(await expandArithText(offsetText, scope), scope));
    if (!Number.isFinite(offset)) offset = 0;
    const source = value;
    let start = offset < 0 ? Math.max(0, source.length + offset) : offset;
    if (start > source.length) start = source.length;
    if (lengthText === null || lengthText === undefined) return source.slice(start);
    let length = Number(evalArith(await expandArithText(lengthText, scope), scope));
    if (!Number.isFinite(length)) length = 0;
    if (length < 0) {
      let end = source.length + length;
      if (end < start) end = start;
      return source.slice(start, end);
    }
    return source.slice(start, start + length);
  }

  if (op === null) {
    if (unset && nounset) throw new Error(name + ': unbound variable');
    return value;
  }

  if (op === '-') {
    if (missing) return part.arg ? await expandBracedArg(part.arg, scope) : '';
    if (unset && nounset) throw new Error(name + ': unbound variable');
    return value;
  }
  if (op === '+') {
    if (missing) return '';
    return part.arg ? await expandBracedArg(part.arg, scope) : '';
  }
  if (op && op[0] === '@') {
    const code = op[1];
    if (code === 'Q') return "'" + value.split("'").join("'\\''") + "'";
    if (code === 'E') return value.replace(/\\([abefnrtv\\'])/g, (match, ch) => ({ a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'" })[ch] || match);
    if (code === 'U') return value.toUpperCase();
    if (code === 'u') return value.charAt(0).toUpperCase() + value.slice(1);
    if (code === 'L') return value.toLowerCase();
    return value;
  }

  if (op === '^' || op === '^^' || op === ',' || op === ',,') {
    if (op === '^^') return value.toUpperCase();
    if (op === ',,') return value.toLowerCase();
    if (!value) return value;
    const head = op === '^' ? value.charAt(0).toUpperCase() : value.charAt(0).toLowerCase();
    return head + value.slice(1);
  }
  if (op === '=') {
    if (missing) {
      const assigned = part.arg ? await expandBracedArg(part.arg, scope) : '';
      scope.setVar(name, assigned);
      return assigned;
    }
    return value;
  }
  if (op === '?') {
    if (missing) {
      const message = part.arg ? await expandBracedArg(part.arg, scope) : 'parameter null or not set';
      throw new Error(name + ': ' + message);
    }
    return value;
  }
  if (op === '#' || op === '##' || op === '%' || op === '%%') {
    if (missing) return value;
    const pattern = part.arg ? await expandBracedArg(part.arg, scope) : '';
    if (op === '#' || op === '##') {
      const indexes = [];
      for (let i = 0; i <= value.length; i++) indexes.push(i);
      if (op === '##') indexes.reverse();
      for (const i of indexes) { if (matchPattern(pattern, value.slice(0, i))) return value.slice(i); }
      return value;
    }
    const indexes = [];
    for (let i = value.length; i >= 0; i--) indexes.push(i);
    if (op === '%%') indexes.reverse();
    for (const i of indexes) { if (matchPattern(pattern, value.slice(i))) return value.slice(0, i); }
    return value;
  }
  if (op === '/' || op === '//') {
    if (missing) return value;
    const pattern = part.arg ? await expandBracedArg(part.arg, scope) : '';
    let replacement = '';
    const global = op === '//';
    if (part.replacement !== undefined && part.replacement !== null) {
      replacement = await expandSingle(part.replacement, scope);
    }
    if (!pattern) return value;
    // Shell pattern substitution is plain glob matching, not a regular
    // expression. globFind is an O(pattern x text) NFA, so patterns such as
    // *a*a*a*...*b cannot backtrack exponentially or hang the shell.
    let cursor = 0;
    let out = '';
    for (;;) {
      const found = globFind(pattern, value, cursor);
      if (!found) { out += value.slice(cursor); break; }
      out += value.slice(cursor, found.start) + replacement;
      if (!global) { out += value.slice(found.end); break; }
      if (found.end <= found.start) {
        if (found.start >= value.length) { out += value.slice(found.start); break; }
        out += value[found.start];
        cursor = found.start + 1;
      } else {
        cursor = found.end;
        if (cursor >= value.length) break;
      }
    }
    return out;
  }
  return value;
}

export async function expandArithText(src, scope) {
  const input = String(src === undefined || src === null ? '' : src);
  if (input.indexOf('$') === -1 && input.indexOf('`') === -1) return input;
  let out = '';
  const tokens = lex(input);
  for (const token of tokens) {
    if (!token) continue;
    if (token.t === 'word') out += await expandSingle(token, scope);
    else if (token.t === 'arith') out += String(evalArith(token.src, scope));
    out += ' ';
  }
  return out;
}

export async function expandSingle(word, scope) {
  if (!word) return '';
  const parts = await expandTilde(word.parts || [], scope);
  let out = '';
  for (const part of parts) {
    if (part.t === 'lit') { out += part.v; continue; }
    if (part.t === 'arith') { out += String(evalArith(await expandArithText(part.src, scope), scope)); continue; }
    if (part.t === 'cmd') { out += await expandSubstitution(part, scope); continue; }
    if (part.t === 'param') {
      const value = await parameterValue(part, scope);
      if (Array.isArray(value)) out += value.join(' ');
      else out += value;
    }
  }
  return out;
}

export async function expandPattern(word, scope) {
  if (!word) return '';
  const parts = await expandTilde(word.parts || [], scope);
  let out = '';
  for (const part of parts) {
    if (part.t === 'lit') {
      if (part.q === 0) out += part.v;
      else out += quotePattern(part.v);
      continue;
    }
    const value = await expandSingle({ parts: [part] }, scope);
    if (part.q === 0 && part.t !== 'cmd') {
      if (part.t === 'param' || part.t === 'arith') out += value;
      else out += quotePattern(value);
    } else {
      out += quotePattern(value);
    }
  }
  return out;
}

function toBraceAtoms(parts) {
  const atoms = [];
  for (const part of parts) {
    if (part.t === 'lit' && part.q === 0) {
      for (const ch of part.v) atoms.push({ ch });
    } else {
      atoms.push({ part });
    }
  }
  return atoms;
}

function atomsToParts(atoms) {
  const out = [];
  let text = '';
  for (const atom of atoms) {
    if (atom.part) {
      if (text) { out.push({ t: 'lit', v: text, q: 0 }); text = ''; }
      out.push(atom.part);
    } else {
      text += atom.ch;
    }
  }
  if (text) out.push({ t: 'lit', v: text, q: 0 });
  return out;
}

function matchBrace(atoms, open) {
  let depth = 0;
  for (let i = open; i < atoms.length; i++) {
    const atom = atoms[i];
    if (atom.part) continue;
    if (atom.ch === '{') depth++;
    else if (atom.ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitAlternatives(atoms) {
  const alts = [];
  let cur = [];
  let depth = 0;
  let sawComma = false;
  for (const atom of atoms) {
    const ch = atom.part ? null : atom.ch;
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { alts.push(cur); cur = []; sawComma = true; continue; }
    cur.push(atom);
  }
  alts.push(cur);
  return sawComma ? alts : null;
}

function sequenceAlternatives(atoms) {
  let text = '';
  for (const atom of atoms) {
    if (atom.part) return null;
    text += atom.ch;
  }
  let match = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(text);
  if (match) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    let step = match[3] === undefined ? (to >= from ? 1 : -1) : Number(match[3]);
    if (!step) return null;
    const seq = [];
    const width = Math.max(match[1].replace(/^-/, '').length, match[2].replace(/^-/, '').length);
    const pad = /^-?0\d/.test(match[1]) || /^-?0\d/.test(match[2]);
    for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
      const raw = String(Math.abs(value)).padStart(pad ? width : 0, '0');
      seq.push((value < 0 ? '-' : '') + raw);
      if (seq.length > 10000) return null;
    }
    return seq.map((item) => Array.from(item).map((ch) => ({ ch })));
  }
  match = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(text);
  if (match) {
    const from = match[1].charCodeAt(0);
    const to = match[2].charCodeAt(0);
    let step = match[3] === undefined ? (to >= from ? 1 : -1) : Number(match[3]);
    if (!step) return null;
    const seq = [];
    for (let value = from; step > 0 ? value <= to : value >= to; value += step) {
      seq.push(String.fromCharCode(value));
      if (seq.length > 10000) return null;
    }
    return seq.map((item) => [{ ch: item }]);
  }
  return null;
}

function expandBraceAtoms(atoms) {
  let open = -1;
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    if (!atom.part && atom.ch === '{') { open = i; break; }
  }
  if (open === -1) return [atoms];
  const close = matchBrace(atoms, open);
  if (close === -1) return [atoms];
  const prefix = atoms.slice(0, open);
  const inner = atoms.slice(open + 1, close);
  const suffix = atoms.slice(close + 1);
  let alts = splitAlternatives(inner);
  if (!alts) alts = sequenceAlternatives(inner);
  if (!alts) {
    const rest = expandBraceAtoms(suffix);
    return rest.map((tail) => prefix.concat([{ ch: '{' }], inner, [{ ch: '}' }], tail));
  }
  const results = [];
  for (const alt of alts) {
    for (const expanded of expandBraceAtoms(alt)) {
      for (const tail of expandBraceAtoms(suffix)) {
        results.push(prefix.concat(expanded, tail));
        if (results.length > 4096) return [atoms];
      }
    }
  }
  return results;
}

export function braceExpandParts(parts) {
  const variants = expandBraceAtoms(toBraceAtoms(parts));
  return variants.map(atomsToParts);
}
export async function expandWord(word, scope, options = {}) {
  if (!word) return [];
  const baseParts = await expandTilde(word.parts || [], scope);
  const variants = braceExpandParts(baseParts);
  if (variants.length === 1) return expandWordCore(variants[0], scope, options);
  const out = [];
  for (const variant of variants) {
    const fields = await expandWordCore(variant, scope, options);
    for (const field of fields) out.push(field);
  }
  return out;
}

async function expandWordCore(parts, scope, options = {}) {
  const ifs = ifsOf(scope);
  const fields = [];
  let cur = '';
  let started = false;
  let globEligible = false;
  let anyQuoted = false;
  let pendingSep = false;
  let wordHasContent = false;

  const flush = () => {
    if (started) { fields.push(cur); cur = ''; started = false; wordHasContent = true; }
  };

  const feedLiteral = (text, quoted) => {
    pendingSep = false;
    cur += text;
    if (text.length) started = true;
    else if (quoted) started = true;
    if (started) wordHasContent = true;
    if (!quoted && MAGIC.test(text)) globEligible = true;
    if (quoted) anyQuoted = true;
  };

  const feedSplitItems = (items) => {
    // Each array/positional element starts a new field, but the final element
    // stays open so a suffix literal attaches to it (bash: pre${a[@]}post).
    let first = true;
    for (const item of items) {
      if (!first) flush();
      feedSplitText(item);
      first = false;
    }
    pendingSep = false;
  };

  const feedSplitText = (text) => {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const ch = text[i];
      if (isSep(ch, ifs)) {
        const ifsWhitespace = ch === ' ' || ch === '\t' || ch === '\n';
        if (ifsWhitespace) {
          flush();
          pendingSep = false;
          i++;
          continue;
        }
        if (started) { flush(); pendingSep = true; }
        else if (pendingSep || !wordHasContent) { fields.push(''); pendingSep = true; wordHasContent = true; }
        else pendingSep = true;
        i++;
        while (i < n && isSep(text[i], ifs) && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
        continue;
      }
      let j = i;
      while (j < n && !isSep(text[j], ifs)) j++;
      const chunk = text.slice(i, j);
      pendingSep = false;
      cur += chunk;
      started = true;
      wordHasContent = true;
      if (MAGIC.test(chunk)) globEligible = true;
      i = j;
    }
  };

  for (const part of parts) {
    if (part.t === 'lit') { feedLiteral(part.v, part.q !== 0); continue; }
    if (part.t === 'param' && (part.name === '@' || part.name === '*') && !part.len && !part.op) {
      const items = scope.positional ? scope.positional.slice() : [];
      const quoted = part.q !== 0;
      if (part.name === '*') {
        const joined = items.join(ifs.charAt(0) || ' ');
        if (quoted || options.noSplit) feedLiteral(joined, true);
        else feedSplitText(joined);
        continue;
      }
      if (!items.length) continue;
      if (!quoted && !options.noSplit) { feedSplitItems(items); continue; }
      cur += items[0];
      started = true;
      for (let k = 1; k < items.length; k++) { fields.push(cur); cur = items[k]; started = true; }
      anyQuoted = true;
      continue;
    }
    if (part.t === 'param' && part.index === '@' && !part.len && !part.op) {
      const items = await parameterValue(part, scope);
      const values = Array.isArray(items) ? items : (items === '' ? [] : [items]);
      if (!values.length) continue;
      if (part.q === 0 && !options.noSplit) { feedSplitItems(values); continue; }
      cur += values[0];
      started = true;
      for (let k = 1; k < values.length; k++) { fields.push(cur); cur = values[k]; started = true; }
      anyQuoted = true;
      continue;
    }
    let text;
    if (part.t === 'param') {
      const value = await parameterValue(part, scope);
      text = Array.isArray(value) ? value.join(' ') : value;
    } else if (part.t === 'cmd') {
      text = await expandSubstitution(part, scope);
    } else if (part.t === 'arith') {
      text = String(evalArith(await expandArithText(part.src, scope), scope));
    } else {
      continue;
    }
    const quoted = part.q !== 0 || options.noSplit;
    if (quoted) { feedLiteral(text, true); continue; }
    if (part.t === 'cmd' && MAGIC.test(text)) globEligible = true;
    feedSplitText(text);
  }
  flush();

  if (!fields.length && anyQuoted) fields.push('');

  const nextFields = [];
  for (const field of fields) {
    if (options.noGlob || !globEligible || !MAGIC.test(field)) { nextFields.push(field); continue; }
    if (field.indexOf('\x00') !== -1) { nextFields.push(field); continue; }
    let matches = [];
    try { matches = scope.fs.glob(field, scope.cwd, { globstar: !!(scope.opts && scope.opts.globstar) }); }
    catch { matches = []; }
    if (matches.length) nextFields.push.apply(nextFields, matches);
    else if (scope.opts && scope.opts.nullglob) continue;
    else if (scope.opts && scope.opts.failglob) throw new Error('no match: ' + field);
    else nextFields.push(field);
  }
  return nextFields;
}

export async function expandWords(words, scope, options = {}) {
  const out = [];
  for (const word of words || []) {
    const fields = await expandWord(word, scope, options);
    for (const field of fields) out.push(field);
  }
  return out;
}

export async function expandAssignmentWord(word, scope) {
  if (!word) return '';
  const parts = await expandTilde(word.parts || [], scope);
  let out = '';
  for (const part of parts) {
    if (part.t === 'lit') { out += part.v; continue; }
    if (part.t === 'arith') { out += String(evalArith(await expandArithText(part.src, scope), scope)); continue; }
    if (part.t === 'cmd') { out += await expandSubstitution(part, scope); continue; }
    if (part.t === 'param') {
      const value = await parameterValue(part, scope);
      out += Array.isArray(value) ? value.join(' ') : value;
    }
  }
  return out;
}
