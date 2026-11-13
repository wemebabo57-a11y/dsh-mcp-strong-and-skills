import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.mjs';

async function makeRoot(label) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-workspace-'));
  const root = path.join(base, label);
  await fs.mkdir(root, { recursive: true });
  return { base, root };
}

async function cleanup(base) {
  await fs.rm(base, { recursive: true, force: true, maxRetries: 3 });
}

function clipText(text, max = 500) {
  if (text.length <= max) return text;
  let end = max;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + '…';
}

// Reference implementation of the documented line-oriented search contract.
// The optimized fast path must agree with it exactly, including excerpt
// clipping, one match per line, and case handling.
function referenceMatches(name, content, { query, caseSensitive, mode }) {
  const terms = mode === 'terms' ? query.trim().split(/\s+/).filter(Boolean) : [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const lines = content.split(/\r?\n/);
  const found = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const haystack = caseSensitive ? line : line.toLowerCase();
    let column;
    if (terms.length) {
      const hit = terms.every((term) => haystack.includes(caseSensitive ? term : term.toLowerCase()));
      column = hit ? haystack.indexOf(caseSensitive ? terms[0] : terms[0].toLowerCase()) : -1;
    } else {
      column = haystack.indexOf(needle);
    }
    if (column === -1) continue;
    const offset = Math.max(0, column - 200);
    found.push({ path: name, line: index + 1, column: column + 1, text: (offset ? '…' : '') + clipText(line.slice(offset), 700) });
  }
  return found;
}

async function trickyFixture() {
  const { base, root } = await makeRoot('tricky');
  const files = new Map();
  files.set('a.txt', ['alpha beta', 'ALPHA BETA', 'middle alpha', '\u0130stanbul alpha', '', 'alpha at end alpha'].join('\n'));
  files.set('b.txt', 'x\r\nneedle here\r\nzzz');
  files.set('c.txt', ['first needle', 'second NEEDLE', 'no match'].join('\n'));
  files.set('long.txt', 'p'.repeat(900) + 'needle' + 'q'.repeat(96));
  files.set('nested/deep/d.txt', ['deep needle', 'deep needle again', 'tail'].join('\n'));
  for (const [name, content] of files) {
    const target = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return { base, root, files };
}

test('literal search streams and stops as soon as the limit is met', async () => {
  const { base, root } = await makeRoot('stream');
  try {
    const filler = ['import x from "./y.mjs";', 'export function value0() { return 0; }', 'const needle_line = 1;', 'export default value0;'].join('\n');
    for (let directory = 0; directory < 30; directory++) {
      const folder = path.join(root, 'd' + String(directory).padStart(2, '0'));
      await fs.mkdir(folder, { recursive: true });
      for (let file = 0; file < 20; file++) await fs.writeFile(path.join(folder, 'f' + String(file).padStart(2, '0') + '.mjs'), filler);
    }
    const workspace = new Workspace(root, { maxFiles: 5000, maxOutputChars: 20000 });
    const started = Date.now();
    const early = await workspace.run({ action: 'search', query: 'needle_line', limit: 3 });
    const elapsed = Date.now() - started;
    assert.equal(early.matches.length, 3);
    assert.equal(early.truncated, true);
    // Streaming stops reading files once the limit is satisfied; a full-tree
    // scan would report 600.
    assert.equal(early.scannedFiles, 3);
    assert.deepEqual(early.matches.map((match) => match.path), ['d00/f00.mjs', 'd00/f01.mjs', 'd00/f02.mjs']);
    assert.ok(elapsed < 5000, 'early exit should not read the whole tree: ' + elapsed + 'ms');

    const full = await workspace.run({ action: 'search', query: 'needle_line', limit: 200 });
    assert.equal(full.matches.length, 200);
    assert.ok(full.scannedFiles > early.scannedFiles);
    assert.deepEqual(full.matches.slice(0, 3), early.matches);

    const listed = await workspace.list('.');
    assert.equal(listed.files.length, 600);
    assert.deepEqual(listed.files, [...listed.files].sort());
    assert.equal(listed.truncated, false);
  } finally { await cleanup(base); }
});

test('literal search agrees with the line-oriented reference implementation', async () => {
  const { base, root, files } = await trickyFixture();
  try {
    const workspace = new Workspace(root, { maxOutputChars: 20000 });
    const names = [...files.keys()].sort();
    for (const options of [{ query: 'needle' }, { query: 'needle', caseSensitive: true }, { query: 'alpha' }, { query: 'ALPHA', caseSensitive: true }]) {
      const result = await workspace.run({ action: 'search', ...options, limit: 200 });
      const expected = names.flatMap((name) => referenceMatches(name, files.get(name), { query: options.query, caseSensitive: options.caseSensitive === true, mode: undefined }));
      assert.deepEqual(result.matches, expected, JSON.stringify(options));
    }
  } finally { await cleanup(base); }
});

test('all-terms mode keeps per-line semantics after the streaming rewrite', async () => {
  const { base, root, files } = await trickyFixture();
  try {
    const workspace = new Workspace(root, { maxOutputChars: 20000 });
    const names = [...files.keys()].sort();
    for (const caseSensitive of [false, true]) {
      const result = await workspace.run({ action: 'search', query: 'alpha beta', mode: 'terms', caseSensitive, limit: 200 });
      const expected = names.flatMap((name) => referenceMatches(name, files.get(name), { query: 'alpha beta', caseSensitive, mode: 'terms' }));
      assert.deepEqual(result.matches, expected, 'caseSensitive=' + caseSensitive);
    }
  } finally { await cleanup(base); }
});

test('excerpt clipping, CRLF handling and long lines stay byte-identical', async () => {
  const { base, root } = await trickyFixture();
  try {
    const workspace = new Workspace(root, { maxOutputChars: 20000 });
    const crlf = await workspace.run({ action: 'search', path: 'b.txt', query: 'needle' });
    assert.deepEqual(crlf.matches, [{ path: 'b.txt', line: 2, column: 1, text: 'needle here' }]);
    assert.equal(crlf.truncated, false);

    const long = await workspace.run({ action: 'search', path: 'long.txt', query: 'needle', limit: 200 });
    assert.equal(long.matches.length, 1);
    assert.equal(long.matches[0].column, 901);
    assert.ok(long.matches[0].text.startsWith('…'));
    // Excerpt starts 200 characters before the match: 200 p + needle + 96 q, plus the ellipsis.
    assert.equal(long.matches[0].text.length, 303);
    assert.equal(long.truncated, true);

    // A leading ellipsis plus the 700 character excerpt is the documented cap.
    const capped = await workspace.run({ action: 'search', query: 'needle', limit: 200 });
    for (const match of capped.matches) {
      assert.ok(match.text.length <= 702);
      assert.ok(!match.text.includes('\r'));
    }
  } finally { await cleanup(base); }
});

const CONTENT_ONE = ['a { background: linear-gradient(#1d4ed8, #fff); }', 'b { background: linear-gradient(#000, #fff); }', 'c { color: #1d4ed8; }'].join('\n');
const CONTENT_TWO = ['x { color: #7c3aed; background: linear-gradient(#fff, #000); }', 'y { color: #fff; }'].join('\n');

// The pre-optimization implementation built fresh regexes per line: one match
// per pattern per line, generic palette first. Keep that exact contract.
function referenceStyle(name, content, { allowBrandColors }) {
  const patterns = [];
  if (!allowBrandColors) patterns.push({ kind: 'generic-palette', regex: /#(?:0f172a|1e293b|172554|1e3a8a|1d4ed8|2563eb|3b82f6|4f46e5|6366f1|7c3aed|8b5cf6)\b|\b(?:bg|from|via|to)-(?:blue|indigo|violet|purple)-(?:[1-9]00|950)\b|\bnavy\b/gi });
  patterns.push({ kind: 'gradient', regex: /(?:linear|radial|conic)-gradient\s*\(|\bbg-gradient-to-[a-z]+\b|\bbg-linear-to-[a-z]+\b/gi });
  const found = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(lines[index]);
      if (match) found.push([name, pattern.kind, index + 1, match.index + 1]);
    }
  }
  return found;
}

test('style pattern state is reused without leaking matches across lines', async () => {
  const { base, root } = await makeRoot('style');
  try {
    await fs.writeFile(path.join(root, 'one.css'), CONTENT_ONE);
    await fs.writeFile(path.join(root, 'two.scss'), CONTENT_TWO);
    await fs.writeFile(path.join(root, 'script.js'), 'color: #1d4ed8; background: linear-gradient(#000,#fff);');
    const workspace = new Workspace(root, { maxOutputChars: 20000 });
    const result = await workspace.run({ action: 'style', limit: 200 });
    assert.equal(result.advisory, true);
    const expected = [
      ...referenceStyle('one.css', CONTENT_ONE, { allowBrandColors: false }),
      ...referenceStyle('two.scss', CONTENT_TWO, { allowBrandColors: false }),
    ];
    assert.deepEqual(result.warnings.map((warning) => [warning.path, warning.kind, warning.line, warning.column]), expected);
    assert.equal(result.warnings.some((warning) => warning.path === 'script.js'), false);

    const brand = await workspace.run({ action: 'style', allowBrandColors: true });
    assert.equal(brand.warnings.some((warning) => warning.kind === 'generic-palette'), false);
    assert.ok(brand.warnings.some((warning) => warning.kind === 'gradient'));
  } finally { await cleanup(base); }
});

test('per-operation caches never hide later tree changes', async () => {
  const { base, root } = await makeRoot('changes');
  const outside = path.join(base, 'outside');
  try {
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'private.txt'), 'outside needle');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.js'), 'needle one');
    const workspace = new Workspace(root, { maxOutputChars: 20000 });
    const first = await workspace.run({ action: 'search', query: 'needle' });
    assert.deepEqual(first.matches.map((match) => match.path), ['src/a.js']);
    assert.equal(first.scannedFiles, 1);

    await fs.writeFile(path.join(root, 'src', 'b.js'), 'needle two');
    await fs.symlink(outside, path.join(root, 'linked'), 'junction');
    const second = await workspace.run({ action: 'search', query: 'needle' });
    assert.deepEqual(second.matches.map((match) => [match.path, match.text]), [['src/a.js', 'needle one'], ['src/b.js', 'needle two']]);
    assert.ok(second.skipped.symlink >= 1);
    assert.equal(second.matches.some((match) => match.text.includes('outside')), false);

    const listed = await workspace.list('.');
    assert.deepEqual(listed.files, ['src/a.js', 'src/b.js']);
    assert.ok(listed.stats.skipped.symlink >= 1);
  } finally { await cleanup(base); }
});
