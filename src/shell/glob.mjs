// POSIX glob primitives: brace expansion, segment compilation, matching.
// Pure functions; no filesystem access. Shared by fs.mjs and expand.mjs.

// No /g flag: a stateful lastIndex made escapeRegex skip every other special
// character, so patterns such as a..* matched names they should not.
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

function escapeRegex(ch) {
  return REGEX_SPECIAL.test(ch) ? '\\' + ch : ch;
}

function findBrace(pattern, start) {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitAlternatives(body) {
  const out = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') { current += ch + (body[i + 1] ?? ''); i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out;
}

export const BRACE_MAX_EXPANSIONS = 4096;
export const BRACE_MAX_LENGTH = 65536;

/** Expand the first top-level {a,b} group, recursively. Returns at least [pattern]. */
export function braceExpand(pattern, budget = { remaining: BRACE_MAX_EXPANSIONS }) {
  if (String(pattern).length > BRACE_MAX_LENGTH) throw new RangeError('brace pattern too long');
  function expand(current) {
    for (let i = 0; i < current.length; i++) {
      if (current[i] === '\\') { i++; continue; }
      if (current[i] !== '{') continue;
      const end = findBrace(current, i);
      if (end < 0) return [current];
      const alts = splitAlternatives(current.slice(i + 1, end));
      if (alts.length < 2) continue;
      const head = current.slice(0, i);
      const tail = current.slice(end + 1);
      const out = [];
      for (const alt of alts) {
        for (const expanded of expand(head + alt + tail)) {
          if (--budget.remaining < 0) throw new RangeError('brace expansion too large');
          out.push(expanded);
        }
      }
      return out;
    }
    return [current];
  }
  return expand(pattern);
}

/** Compile one path segment into a matcher. Returns null when the segment has no magic. */
export function compileSegment(segment) {
  if (!/[*?[]/.test(segment)) return null;
  let re = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') { re += '[^/]*'; continue; }
    if (ch === '?') { re += '[^/]'; continue; }
    if (ch === '[') {
      let j = i + 1;
      let cls = '';
      if (segment[j] === '!' || segment[j] === '^') { cls += '^'; j++; }
      if (segment[j] === ']') { cls += '\\]'; j++; }
      let closed = false;
      for (; j < segment.length; j++) {
        const c = segment[j];
        if (c === ']') { closed = true; break; }
        cls += c === '\\' ? '\\\\' : c === '^' ? '\\^' : c;
      }
      if (!closed) { re += '\\['; continue; }
      re += '[' + cls + ']';
      i = j;
      continue;
    }
    re += escapeRegex(ch);
  }
  try {
    return new RegExp('^' + re + '$');
  } catch {
    return null;
  }
}

export function hasMagic(segment) {
  return /[*?[]/.test(segment);
}

/** True when the name matches the segment, honouring the leading-dot rule. */
export function matchSegment(segment, name, allowLeadingDot) {
  if (name.startsWith('.') && !allowLeadingDot) {
    if (!segment.startsWith('.') && segment !== '.*') return false;
  }
  const compiled = compileSegment(segment);
  if (!compiled) return segment === name;
  return compiled.test(name);
}

/** Literal-prefix scan: returns the count of leading segments without magic. */
export function literalPrefix(segments) {
  let n = 0;
  while (n < segments.length && !hasMagic(segments[n]) && segments[n] !== '**') n++;
  return n;
}
