const DEFAULT_HINT = 'Output capped; narrow the path/query or request a smaller range.';
const PROTECTED = new Set(['action', 'name', 'path', 'scope', 'note', 'hint', 'truncated', 'reason', 'available', 'executed']);

const ELLIPSIS = '…';
const LONG_STRING = 80; // only strings longer than this are trimming candidates
const MIN_STRING_KEEP = 80; // a trimmed string keeps at least this many characters
const MAX_PASSES = 3; // measurement passes before the minimal object wins
const OMITTED = -1; // JSON drops undefined/function/symbol object members
const ESCAPED = /["\\\u0000-\u001f\ud800-\udfff]/;

function size(value) {
  try { return JSON.stringify(value)?.length ?? 0; }
  catch { return Number.POSITIVE_INFINITY; }
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Serialized length of a string without building a copy when nothing needs escaping.
function stringCost(text) {
  return ESCAPED.test(text) ? JSON.stringify(text).length : text.length + 2;
}

// Serialized length of one array element: JSON writes null for undefined/function/symbol.
function elementCost(value) {
  if (value === null) return 4;
  const type = typeof value;
  if (type === 'string') return stringCost(value);
  if (type === 'number') return Number.isFinite(value) ? String(value).length : 4;
  if (type === 'boolean') return value ? 4 : 5;
  if (type === 'object') {
    const text = JSON.stringify(value);
    return text === undefined ? 4 : text.length;
  }
  return 4;
}

// Copy the JSON-shaped part of a result once, so trimming never mutates the caller's
// value. Opaque values (Date, Map, Buffer, class instances) stay shared by reference
// because trimming never descends into them.
function copyValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let index = 0; index < value.length; index++) copy[index] = copyValue(value[index]);
    return copy;
  }
  if (!isPlainObject(value)) return value;
  const copy = {};
  for (const key of Object.keys(value)) {
    const child = copyValue(value[key]);
    if (key === '__proto__') Object.defineProperty(copy, key, { value: child, enumerable: true, writable: true, configurable: true });
    else copy[key] = child;
  }
  return copy;
}

// One walk records each trimmable candidate with its own serialized length, so the
// largest one is found without serializing a subtree per candidate.
function measure(root) {
  const candidates = [];
  function visit(value, parent, key, collect) {
    if (value === null) return 4;
    const type = typeof value;
    if (type === 'string') {
      const cost = stringCost(value);
      if (collect && value.length > LONG_STRING && !PROTECTED.has(key)) candidates.push({ kind: 'string', parent, key, value, cost });
      return cost;
    }
    if (type === 'number') return Number.isFinite(value) ? String(value).length : 4;
    if (type === 'boolean') return value ? 4 : 5;
    if (type !== 'object') return OMITTED;
    if (Array.isArray(value)) {
      // Any reached array of two or more items can lose its tail; protected keys stop
      // the walk instead of hiding the array itself (same rule as before).
      const record = collect && value.length > 1 ? { kind: 'array', parent, key, value, cost: 0 } : null;
      if (record) candidates.push(record);
      let cost = 2 + Math.max(0, value.length - 1);
      for (let index = 0; index < value.length; index++) {
        const item = visit(value[index], value, index, collect);
        cost += item === OMITTED ? 4 : item;
      }
      if (record) record.cost = cost;
      return cost;
    }
    if (isPlainObject(value) && typeof value.toJSON !== 'function') {
      let cost = 2;
      let first = true;
      for (const childKey of Object.keys(value)) {
        const child = visit(value[childKey], value, childKey, collect && !PROTECTED.has(childKey));
        if (child === OMITTED) continue;
        cost += (first ? 0 : 1) + stringCost(childKey) + 1 + child;
        first = false;
      }
      return cost;
    }
    const text = JSON.stringify(value);
    return text === undefined ? OMITTED : text.length;
  }
  const total = visit(root, null, null, true);
  return { candidates, total: total === OMITTED ? 0 : total };
}

// Drop the shortest tail of an array that frees at least `excess` characters: the
// prefix table and a binary search keep this O(items) instead of one pop per round.
function trimArray(record, excess) {
  const items = record.value;
  const length = items.length;
  if (length < 2) return 0;
  const prefix = new Float64Array(length + 1);
  let cost = 2 + (length - 1);
  for (let index = 0; index < length; index++) {
    const item = elementCost(items[index]);
    prefix[index + 1] = prefix[index] + item;
    cost += item;
  }
  const target = Math.max(2 + prefix[1], cost - excess);
  if (target >= cost) return 0;
  // An array of `kept` items costs 2 + prefix[kept] + (kept - 1) characters.
  let low = 1;
  let high = length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (1 + prefix[middle] + middle <= target) low = middle;
    else high = middle - 1;
  }
  const kept = Math.max(1, low);
  items.splice(kept);
  return cost - (1 + prefix[kept] + kept);
}

// Cut a long string down to the requested length and mark the cut with an ellipsis.
function trimString(record, excess) {
  const text = record.value;
  if (record.parent[record.key] !== text) return 0; // already removed by a batched array trim
  const cost = stringCost(text);
  const target = Math.max(stringCost(text.slice(0, MIN_STRING_KEEP) + ELLIPSIS), cost - excess);
  if (target >= cost) return 0;
  // Without escapes the trimmed text costs `kept` characters plus ellipsis and quotes.
  let kept = Math.min(text.length - 1, Math.max(MIN_STRING_KEEP, target - ELLIPSIS.length - 2));
  let next = stringCost(text.slice(0, kept) + ELLIPSIS);
  for (let guard = 0; guard < 8 && next > target && kept > MIN_STRING_KEEP; guard++) {
    kept = Math.max(MIN_STRING_KEEP, kept - Math.max(8, next - target));
    next = stringCost(text.slice(0, kept) + ELLIPSIS);
  }
  if (next >= cost) return 0;
  record.parent[record.key] = text.slice(0, kept) + ELLIPSIS;
  return cost - next;
}

// Remove at least `excess` characters, largest candidate first.
function trimCandidates(candidates, excess) {
  candidates.sort((left, right) => right.cost - left.cost);
  let remaining = excess;
  let freed = 0;
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    const removed = candidate.kind === 'array' ? trimArray(candidate, remaining) : trimString(candidate, remaining);
    remaining -= removed;
    freed += removed;
  }
  return freed;
}

function minimalResult(value, hint) {
  const minimal = { truncated: true, hint };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['action', 'path', 'query', 'scope']) if (typeof value[key] === 'string') minimal[key] = value[key];
  }
  return minimal;
}

// Trim the canonical result (never serialized text) to a character budget.
// One walk measures every candidate; batches then remove whole tails, so a result
// with thousands of items costs one pass instead of one serialization per item.
export function fitResult(value, maxChars, options = {}) {
  const hint = options.hint ?? DEFAULT_HINT;
  if (!Number.isFinite(maxChars)) return value;
  if (size(value) <= maxChars) return value;
  try {
    let out = copyValue(value);
    if (!out || typeof out !== 'object' || Array.isArray(out) || !isPlainObject(out)) out = { value: out };
    out.truncated = true;
    out.hint = hint;
    let state = measure(out);
    for (let pass = 0; pass < MAX_PASSES && state.total > maxChars; pass++) {
      if (!trimCandidates(state.candidates, state.total - maxChars)) break;
      state = measure(out);
    }
    if (state.total <= maxChars && size(out) <= maxChars) return out;
    // The walk only disagrees with JSON.stringify for exotic values (toJSON, BigInt)
    // and escape-heavy text, so retry once against the real serialized length.
    const exact = size(out);
    if (exact <= maxChars) return out;
    if (Number.isFinite(exact) && trimCandidates(measure(out).candidates, exact - maxChars) && size(out) <= maxChars) return out;
  } catch {
    // Cyclic values, BigInt and extreme nesting cannot be measured; fall back below.
  }
  return minimalResult(value, hint);
}
