import test from 'node:test';
import assert from 'node:assert/strict';
import { fitResult } from '../src/budget.mjs';

const DEFAULT_HINT = 'Output capped; narrow the path/query or request a smaller range.';

// The payload shape the engine/workspace/code-tools wrappers actually pass in.
function searchPayload(n) {
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

test('fitResult leaves a small payload untouched', () => {
  const value = searchPayload(20);
  const out = fitResult(value, 4000);
  assert.equal(out, value);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'truncated'), false);
});

test('fitResult trims one huge string to the budget and marks the cut', () => {
  const text = 'x'.repeat(50000);
  const value = { action: 'read', path: 'notes.md', text };
  const out = fitResult(value, 4000);
  assert.notEqual(out, value);
  assert.equal(out.truncated, true);
  assert.equal(out.hint, DEFAULT_HINT);
  assert.equal(out.action, 'read');
  assert.equal(out.path, 'notes.md');
  assert.ok(JSON.stringify(out).length <= 4000);
  assert.ok(out.text.length < text.length);
  assert.ok(out.text.endsWith('\u2026'));
  assert.equal(value.text.length, 50000);
});

test('fitResult trims a long array in one batch and keeps the prefix', () => {
  const value = searchPayload(5000);
  const out = fitResult(value, 4000);
  assert.ok(Array.isArray(out.items));
  assert.equal(out.truncated, true);
  assert.ok(JSON.stringify(out).length <= 4000);
  assert.ok(out.items.length > 10);
  assert.ok(out.items.length < 5000);
  for (let index = 0; index < out.items.length; index++) assert.equal(out.items[index].path, value.items[index].path);
  assert.equal(value.items.length, 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('fitResult never trims protected keys or their subtrees', () => {
  const path = 'p'.repeat(300);
  const note = 'n'.repeat(200);
  const scope = { ids: [1, 2, 3], label: 'n'.repeat(100) };
  const value = { action: 'read', path, note, scope, data: 'd'.repeat(4000) };
  const out = fitResult(value, 1200);
  assert.equal(out.action, 'read');
  assert.equal(out.path, path);
  assert.equal(out.note, note);
  assert.deepEqual(out.scope, scope);
  assert.ok(out.data.length < 4000);
  assert.ok(out.data.endsWith('\u2026'));
  assert.ok(JSON.stringify(out).length <= 1200);
});

test('fitResult keeps a custom hint', () => {
  const out = fitResult({ text: 'x'.repeat(5000) }, 200, { hint: 'custom hint' });
  assert.equal(out.hint, 'custom hint');
  assert.equal(out.truncated, true);
  assert.ok(JSON.stringify(out).length <= 200);
});

test('fitResult falls back to the minimal object for an empty object over budget', () => {
  const out = fitResult({}, 1);
  assert.deepEqual(out, { truncated: true, hint: DEFAULT_HINT });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  const empty = {};
  assert.equal(fitResult(empty, 2), empty);
});

test('fitResult treats the exact serialized size as fitting', () => {
  const value = { text: 'x'.repeat(300) };
  const exact = JSON.stringify(value).length;
  assert.equal(fitResult(value, exact), value);
  const tight = fitResult(value, exact - 1);
  assert.notEqual(tight, value);
  assert.equal(tight.truncated, true);
  assert.ok(JSON.stringify(tight).length <= exact - 1);
  assert.equal(value.text.length, 300);
});

test('fitResult returns the value unchanged for non-finite budgets', () => {
  const value = { text: 'x'.repeat(500) };
  for (const maxChars of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(fitResult(value, maxChars), value);
  }
});

test('fitResult terminates on pathological nesting', () => {
  let deep = { leaf: 'x'.repeat(200) };
  for (let index = 0; index < 20000; index++) deep = [deep];
  const started = performance.now();
  const out = fitResult({ data: deep }, 64);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000);
  assert.equal(out.truncated, true);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(Object.keys(out).length <= 5);
});

test('fitResult keeps multi-byte text within the budget', () => {
  const text = '\u4e2d\u6587\ud83d\ude00'.repeat(20000);
  const value = { text };
  const out = fitResult(value, 5000);
  assert.ok(JSON.stringify(out).length <= 5000);
  assert.ok(out.text.endsWith('\u2026'));
  assert.equal(value.text.length, text.length);
});

test('fitResult trims 5000 items far below the CI-safe limit', () => {
  const value = searchPayload(5000);
  const started = performance.now();
  const out = fitResult(value, 4000);
  const elapsed = performance.now() - started;
  assert.ok(JSON.stringify(out).length <= 4000);
  assert.equal(out.truncated, true);
  assert.ok(elapsed < 300, 'trimming 5000 items took ' + elapsed.toFixed(1) + 'ms');
});
