#!/usr/bin/env node
// Throughput gate for fitResult: a bounded result must not cost more than a few
// milliseconds, no matter how many items the caller returned.
import { fitResult } from '../src/budget.mjs';

const ROUNDS = 3;
const GATE = { n: 5000, maxChars: 4000, limitMs: 100 };

// A realistic bound-result payload: many small records plus the identity keys
// callers rely on (action/path/query).
function payload(n) {
  const items = new Array(n);
  for (let index = 0; index < n; index++) {
    items[index] = {
      path: 'src/module-' + (index % 97) + '/file-' + index + '.mjs',
      line: index + 1,
      text: 'export const value' + index + ' = compute(' + index + ');',
    };
  }
  return { action: 'search', path: 'src', query: 'compute', items };
}

function measure(value, maxChars) {
  const times = [];
  let out = null;
  for (let round = 0; round < ROUNDS; round++) {
    const started = performance.now();
    out = fitResult(value, maxChars);
    times.push(performance.now() - started);
  }
  times.sort((left, right) => left - right);
  const text = JSON.stringify(out);
  return {
    best: times[0],
    median: times[times.length >> 1],
    chars: text.length,
    items: Array.isArray(out.items) ? out.items.length : 0,
    fits: text.length <= maxChars,
  };
}

function pad(text, width) {
  return String(text).padStart(width);
}

const rows = [];
for (const n of [200, 2000, 5000]) {
  for (const maxChars of [4000, 24000]) {
    rows.push({ n, maxChars, ...measure(payload(n), maxChars) });
  }
}

console.log('fitResult benchmark, node ' + process.version + ', rounds=' + ROUNDS + ' (best of rounds)');
console.log('');
console.log('    n  maxChars   best ms  median ms   out chars   items   fits');
for (const row of rows) {
  console.log(
    pad(row.n, 5) + pad(row.maxChars, 10) + pad(row.best.toFixed(2), 10) + pad(row.median.toFixed(2), 11) +
    pad(row.chars, 12) + pad(row.items, 8) + pad(row.fits ? 'yes' : 'no', 7),
  );
}
console.log('');

const gate = rows.find((row) => row.n === GATE.n && row.maxChars === GATE.maxChars);
const passed = gate !== undefined && gate.fits && gate.best < GATE.limitMs;
console.log(
  'gate: n=' + GATE.n + ' maxChars=' + GATE.maxChars + ' under ' + GATE.limitMs + 'ms: ' +
  (passed ? 'PASS' : 'FAIL') + ' (' + (gate === undefined ? 'n/a' : gate.best.toFixed(2) + 'ms') + ')',
);
if (!passed) process.exitCode = 1;
