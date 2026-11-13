import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { runCodeTool } from '../src/code-tools.mjs';

// Guards for the code-tool hot paths (masking, symbol scanning, import
// resolution and review concurrency). These are CPU-shape tests: the workspace
// is an in-memory stub so timings do not depend on disk or git. The ceilings are
// deliberately loose (roughly two orders of magnitude above the measured cost on
// a laptop) so a loaded CI box still passes while a regression to per-line
// masking or per-specifier resolution blows the budget.

const CPU_BUDGET_MS = 2000;

function stub(files, { listDelay = 0, checksDelay = 0, diff = null } = {}) {
  const calls = [];
  return {
    calls,
    maxOutputChars: 6000,
    async list() {
      calls.push('list');
      if (listDelay) await new Promise((resolve) => setTimeout(resolve, listDelay));
      return { files: Object.keys(files), stats: {}, truncated: false };
    },
    async run(args) {
      calls.push(args.action);
      if (args.action === 'read') {
        const all = files[args.path].split('\n');
        const start = args.start ?? 1;
        const limit = args.limit ?? 200;
        const lines = [];
        for (let index = start - 1; index < Math.min(all.length, start - 1 + limit); index++) lines.push({ line: index + 1, text: all[index] });
        return { lines, totalLines: all.length };
      }
      if (args.action === 'diff') return diff ?? { available: false, reason: 'no git' };
      if (args.action === 'checks') {
        if (checksDelay) await new Promise((resolve) => setTimeout(resolve, checksDelay));
        return { packages: [{ path: 'package.json', scripts: { lint: 'eslint .', test: 'node --test' } }], configs: [], executed: false };
      }
      throw new Error('unexpected action ' + args.action);
    },
  };
}

function moduleBody(index) {
  const lines = [];
  for (let n = 0; n < 200; n++) {
    const tag = index * 200 + n;
    switch (n % 10) {
      case 0: lines.push('// helper ' + tag + ' explains the flow / and keeps a slash'); break;
      case 1: lines.push('const text' + tag + ' = "a literal with class Fake' + tag + ' {} and // slashes";'); break;
      case 2: lines.push('export function fn' + tag + '(value: number): number { return value + ' + tag + '; }'); break;
      case 3: lines.push('const tpl' + tag + ' = `template ' + tag + ' ${value} /* not a comment */ end`;'); break;
      case 4: lines.push('class Service' + tag + ' {'); break;
      case 5: lines.push('  async load' + tag + '(id: string) { return fetch("/api/" + id); }'); break;
      case 6: lines.push('}'); break;
      case 7: lines.push('const arrow' + tag + ' = (input: string) => input.trim();'); break;
      case 8: lines.push(''); break;
      default: lines.push("import { helper" + tag + " } from './module" + ((index + 1) % 24) + ".js';");
    }
  }
  return lines.join('\n') + '\n';
}

function bigTree() {
  const files = {};
  for (let index = 0; index < 24; index++) files['src/module' + index + '.ts'] = moduleBody(index);
  files['test/module0.test.ts'] = 'import { fn0 } from "../src/module0.js";\n';
  files['package.json'] = '{}\n';
  return files;
}

async function timed(work) {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}

test('symbols keeps exact declaration output while scanning a large tree inside the CPU budget', async () => {
  const workspace = stub(bigTree());
  const { value, ms } = await timed(() => runCodeTool('strong_code', { action: 'symbols' }, { workspace }));
  assert.equal(value.action, 'symbols');
  assert.equal(value.items.length, 40);
  assert.equal(value.truncated, true);
  assert.equal(value.items[0].path, 'src/module0.ts');
  assert.equal(value.items[0].kind, 'function');
  assert.equal(value.items[0].name, 'fn2');
  assert.equal(value.items[0].line, 3);
  assert.equal(value.items[0].exported, true);
  // Literals and comments are still masked out after the single-pass rewrite.
  assert.equal(value.items.some((item) => item.name.startsWith('Fake')), false);
  assert.equal(value.items.some((item) => item.name.startsWith('text')), false);
  assert.ok(ms < CPU_BUDGET_MS, 'symbols took ' + ms.toFixed(1) + 'ms, over the ' + CPU_BUDGET_MS + 'ms budget');
});

test('symbols stops at the requested limit instead of scanning every declaration', async () => {
  const lines = [];
  for (let index = 0; index < 4000; index++) lines.push('export function generated' + index + '() {}');
  const workspace = stub({ 'src/generated.ts': lines.join('\n') + '\n' });
  const { value, ms } = await timed(() => runCodeTool('strong_code', { action: 'symbols', limit: 1 }, { workspace }));
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].name, 'generated0');
  assert.equal(value.truncated, true);
  assert.ok(ms < CPU_BUDGET_MS, 'early-exit symbols took ' + ms.toFixed(1) + 'ms');
});

test('imports resolves local edges through the inventory index and ignores strings and comments', async () => {
  const workspace = stub({
    'src/a.ts': [
      "import { b } from './b.js';",
      "import fs from 'node:fs';",
      "export { c } from './c';",
      "const lazy = import('./b.js');",
      "const quoted = \"require('./ghost.js')\";",
      "// import hidden from './comment.js';",
      '',
    ].join('\n'),
    'src/b.ts': 'export const b = 1;\n',
    'src/c/index.ts': 'export const c = 2;\n',
    'src/legacy.cjs': "const d = require('./b.js');\nmodule.exports = { d };\n",
    'package.json': '{}\n',
  });
  const { value, ms } = await timed(() => runCodeTool('strong_code', { action: 'imports' }, { workspace }));
  assert.deepEqual(value.edges, [
    { from: 'src/a.ts', line: 1, specifier: './b.js', to: 'src/b.ts', status: 'resolved' },
    { from: 'src/a.ts', line: 3, specifier: './c', to: 'src/c/index.ts', status: 'resolved' },
    { from: 'src/legacy.cjs', line: 1, specifier: './b.js', to: 'src/b.ts', status: 'resolved' },
  ]);
  assert.deepEqual(value.external, [{ name: 'node:fs', references: 1 }]);
  assert.equal(value.staticImports, 4);
  assert.equal(value.dynamicImportsExcluded, 1);
  assert.equal(value.truncated, false);
  assert.ok(ms < CPU_BUDGET_MS, 'imports took ' + ms.toFixed(1) + 'ms');
});

test('imports resolves hundreds of local specifiers without rescanning the inventory', async () => {
  const imports = [];
  for (let index = 0; index < 100; index++) imports.push("import { value" + index + " } from './mod" + index + ".js';");
  const files = { 'src/index.ts': imports.join('\n') + '\n' };
  for (let index = 0; index < 100; index++) files['src/mod' + index + '.ts'] = 'export const value' + index + ' = ' + index + ';\n';
  const workspace = stub(files);
  const { value, ms } = await timed(() => runCodeTool('strong_code', { action: 'imports', limit: 500 }, { workspace, config: { unlimitedTokens: true } }));
  assert.equal(value.edges.length, 100);
  assert.equal(value.staticImports, 100);
  assert.equal(value.truncated, false);
  for (const [index, edge] of value.edges.entries()) {
    assert.equal(edge.to, 'src/mod' + index + '.ts');
    assert.equal(edge.status, 'resolved');
    assert.equal(edge.line, index + 1);
  }
  assert.ok(ms < CPU_BUDGET_MS, 'bulk imports took ' + ms.toFixed(1) + 'ms');
});

test('masking stays byte-identical on comment and literal heavy sources', async () => {
  const lines = [];
  for (let index = 0; index < 199; index++) {
    if (index % 3 === 0) lines.push('// comment ' + index + ' ' + 'x'.repeat(700));
    else if (index % 3 === 1) lines.push('const s' + index + ' = "' + 'y'.repeat(700) + '";');
    else lines.push('/* block ' + index + ' ' + 'z'.repeat(700) + ' */');
  }
  const workspace = stub({ 'stress.ts': lines.join('\n') + '\n' });
  const { value, ms } = await timed(() => runCodeTool('strong_code', { action: 'symbols' }, { workspace }));
  assert.equal(value.items.length, 0);
  assert.equal(value.truncated, false);
  assert.ok(ms < CPU_BUDGET_MS, 'masking took ' + ms.toFixed(1) + 'ms');
});

test('review overlaps the inventory and checks listings instead of serialising them', async () => {
  const delay = 200;
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,2 @@',
    ' export const a = 1;',
    '+export const b = JSON.parse(localStorage.getItem("b") ?? "1");',
    '',
  ].join('\n');
  const workspace = stub(
    { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': 'test("a", () => {});\n', 'package.json': '{}\n' },
    { listDelay: delay, checksDelay: delay, diff: { available: true, diff, truncated: false, scope: 'unstaged' } },
  );
  const { value, ms } = await timed(() => runCodeTool('strong_review', {}, { workspace }));
  assert.equal(value.available, true);
  assert.deepEqual(value.files, [{ path: 'src/a.ts', added: 1, removed: 0 }]);
  assert.deepEqual(value.relatedTests, ['test/a.test.ts']);
  assert.deepEqual(value.suggestedChecks, [
    { package: 'package.json', script: 'lint', command: 'eslint .' },
    { package: 'package.json', script: 'test', command: 'node --test' },
  ]);
  assert.equal(value.findings[0].kind, 'input-parsing');
  // Two 200ms listings run concurrently, so the whole call stays well under the
  // 400ms a sequential implementation would need.
  assert.ok(ms < delay * 2 - 60, 'review took ' + ms.toFixed(1) + 'ms; inventory and checks look serialised');
});
