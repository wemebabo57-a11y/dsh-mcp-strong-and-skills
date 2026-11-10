const DEFAULT_HINT = 'Output capped; narrow the path/query or request a smaller range.';
const PROTECTED = new Set(['action', 'name', 'path', 'scope', 'note', 'hint', 'truncated', 'reason', 'available', 'executed']);

function clone(value) {
  try { return structuredClone(value); }
  catch { return JSON.parse(JSON.stringify(value)); }
}

function size(value) {
  try { return JSON.stringify(value)?.length ?? 0; }
  catch { return Number.POSITIVE_INFINITY; }
}

function bestCandidate(root) {
  let best = null;
  function visit(parent, key, value) {
    if (value && typeof value === 'object') {
      if (Array.isArray(value) && value.length > 1) {
        const bytes = size(value);
        if (!best || bytes > best.bytes) best = { kind: 'array', parent, key, value, bytes };
      }
      for (const [childKey, child] of Object.entries(value)) {
        if (PROTECTED.has(childKey)) continue;
        visit(value, childKey, child);
      }
      return;
    }
    if (typeof value === 'string' && value.length > 80 && !PROTECTED.has(key)) {
      const bytes = size(value);
      if (!best || bytes > best.bytes) best = { kind: 'string', parent, key, value, bytes };
    }
  }
  for (const [key, value] of Object.entries(root)) {
    if (!PROTECTED.has(key)) visit(root, key, value);
  }
  return best;
}

// Trim the canonical result (never serialized text) to a character budget.
// One pass locates the largest trimmable value; at most a few passes are needed
// even for deeply nested search results.
export function fitResult(value, maxChars, options = {}) {
  const hint = options.hint ?? DEFAULT_HINT;
  if (!Number.isFinite(maxChars)) return value;
  if (size(value) <= maxChars) return value;
  let out = clone(value);
  if (!out || typeof out !== 'object' || Array.isArray(out)) out = { value: out };
  out.truncated = true;
  out.hint = hint;
  for (let guard = 0; guard < 1000 && size(out) > maxChars; guard++) {
    const candidate = bestCandidate(out);
    if (!candidate) break;
    if (candidate.kind === 'string') {
      const excess = size(out) - maxChars;
      const ratio = candidate.bytes / Math.max(1, candidate.value.length);
      const drop = Math.max(40, Math.ceil(excess / Math.max(ratio, 0.1)));
      const keep = Math.max(80, candidate.value.length - drop);
      candidate.parent[candidate.key] = candidate.value.slice(0, keep) + '…';
    } else {
      candidate.value.pop();
    }
  }
  if (size(out) <= maxChars) return out;
  const minimal = { truncated: true, hint };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['action', 'path', 'query', 'scope']) if (typeof value[key] === 'string') minimal[key] = value[key];
  }
  return minimal;
}
