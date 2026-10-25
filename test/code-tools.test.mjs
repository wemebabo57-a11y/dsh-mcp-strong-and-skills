import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Workspace } from '../src/workspace.mjs';
import { EXTRA_TOOLS, runCodeTool } from '../src/code-tools.mjs';

async function fixture(t, files = {}) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'strong-code-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('strong-code-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const code = (workspace, args, options = {}) => runCodeTool('strong_code', args, { workspace, ...options });

test('extra gateways have compact schemas and validate direct callers/prototypes', async (t) => {
  assert.equal(EXTRA_TOOLS.length, 2);
  assert.ok(JSON.stringify(EXTRA_TOOLS).length <= 1500);
  const root = await fixture(t, { 'a.js': 'export function safe() {}' });
  const workspace = new Workspace(root);
  for (const args of [[], null, { action: 'unknown' }, { action: 'symbols', limit: 0 }, { action: 'symbols', path: 5 }, { action: 'diagnostics', text: 'x'.repeat(5001) }, JSON.parse('{"action":"symbols","__proto__":{}}'), Object.create({ action: 'symbols' })]) {
    await assert.rejects(code(workspace, args), { code: 'INVALID_ARGUMENTS' });
  }
  await assert.rejects(runCodeTool('__proto__', {}, { workspace }), { code: 'INVALID_TOOL' });
  const args = Object.assign(Object.create(null), { action: 'symbols' });
  assert.equal((await code(workspace, args)).items[0].name, 'safe');
  assert.equal(Object.prototype.polluted, undefined);
});

test('symbols return declarations, exports and real line positions while excluding comments/literals', async (t) => {
  const root = await fixture(t, {
    'src/app.ts': [
      '// function Comment() {}',
      'const text = "class Pretend {}";',
      '/* interface Hidden {} */',
      'export async function load() {}',
      'export class Model {}',
      'export interface Options {}',
      'type Result = string;',
      'const convert = (x: string) => x;',
      'export { convert as transform };',
      'export const arrow = (x: number) => x;',
    ].join('\n'),
    'python/example.py': '"""\ndef FalsePositive():\n    pass\n"""\ndef calculate(x):\n    return x\n',
    '.env': 'export function TOP_SECRET() {}',
  });
  const result = await code(new Workspace(root), { action: 'symbols' });
  assert.deepEqual(result.items.filter((item) => item.path === 'src/app.ts').map(({ name, line }) => [name, line]), [['load', 4], ['Model', 5], ['Options', 6], ['Result', 7], ['convert', 8], ['transform', 9], ['arrow', 10]]);
  assert.ok(result.items.some((item) => item.name === 'calculate' && item.line === 5));
  for (const name of ['Comment', 'Pretend', 'Hidden', 'FalsePositive', 'TOP_SECRET']) assert.equal(result.items.some((item) => item.name === name), false);
  assert.equal(result.truncated, false);
});

test('symbol paging preserves line numbers and reports scan/result limits', async (t) => {
  const root = await fixture(t, {
    'late.ts': '\n'.repeat(250) + 'export function later() {}\n',
    'many.ts': Array.from({ length: 200 }, (_, index) => `export function value${index}() {}`).join('\n'),
  });
  const workspace = new Workspace(root);
  const late = await code(workspace, { action: 'symbols', path: 'late.ts' });
  assert.equal(late.items[0].line, 251);
  const small = await code(workspace, { action: 'symbols', path: 'many.ts', limit: 2 });
  assert.equal(small.items.length, 2);
  assert.equal(small.truncated, true);
  const bounded = await code(workspace, { action: 'symbols' }, { config: { maxOutputChars: 1000 } });
  assert.ok(JSON.stringify(bounded).length <= 1000);
  assert.equal(bounded.truncated, true);
});

test('imports resolve static local edges and count external packages without evaluating dynamic imports', async (t) => {
  const root = await fixture(t, {
    'src/main.ts': [
      'import { value } from "./value.js";',
      'import { other } from "./folder";',
      'export { value } from "./value.js";',
      'const cjs = require("./legacy.cjs");',
      'import fs from "node:fs";',
      'import one from "@scope/pkg/one";',
      'import two from "@scope/pkg/two";',
      'import "side-effect";',
      'import(packageName);',
      'require(packageName);',
      'const fake = "import x from \'hidden\'";',
      '// require("hidden-comment")',
      'import bad from "../../outside.js";',
    ].join('\n'),
    'src/value.ts': 'export const value = 1;',
    'src/folder/index.ts': 'export const other = 2;',
    'src/legacy.cjs': 'module.exports = {};',
    '.env': 'SECRET_IMPORT=hidden',
  });
  const result = await code(new Workspace(root), { action: 'imports' });
  assert.equal(result.staticImports, 9);
  assert.equal(result.dynamicImportsExcluded, 2);
  assert.equal(result.edges.length, 5);
  assert.equal(result.edges[0].to, 'src/value.ts');
  assert.equal(result.edges[0].line, 1);
  assert.equal(result.edges[1].to, 'src/folder/index.ts');
  assert.equal(result.edges[3].to, 'src/legacy.cjs');
  assert.equal(result.edges[4].status, 'outside-workspace');
  assert.deepEqual(result.external, [{ name: '@scope/pkg', references: 2 }, { name: 'node:fs', references: 1 }, { name: 'side-effect', references: 1 }]);
  assert.equal(result.truncated, false);
  assert.equal(JSON.stringify(result).includes('hidden-comment'), false);
  const selected = await code(new Workspace(root), { action: 'imports', path: 'src/main.ts' });
  assert.equal(selected.edges[0].to, 'src/value.ts');
  assert.equal(selected.scannedFiles, 1);
});

test('imports do not attribute a later multiline import to an earlier exported declaration', async (t) => {
  const root = await fixture(t, {
    'main.ts': 'export const answer = 42\nimport {\n  value\n} from "./value"\n',
    'value.ts': 'export const value = 1\n',
  });
  const result = await code(new Workspace(root), { action: 'imports' });
  assert.equal(result.edges[0].line, 2);
  assert.equal(result.edges[0].to, 'value.ts');
});

test('diagnostics parse common formats and enrich only safely readable workspace files', async (t) => {
  const root = await fixture(t, { 'src/app.ts': 'one\ntwo\nthree\nfour', 'script.py': 'first\nsecond\nthird', '.env': 'NEVER_READ_SECRET' });
  const outside = await fixture(t, { 'outside.ts': 'NEVER_READ_OUTSIDE' });
  const link = path.join(root, 'linked');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const input = [
    'src/app.ts:2:4: error Bad type',
    'src/app.ts(3,1): error TS2322: wrong value',
    `${path.join(root, 'src/app.ts')}:1:1: warning local`,
    'src/app.ts',
    '  4:2  warning  unused name',
    '  File "script.py", line 2, in run',
    '.env:1:1: error hidden',
    '../outside.ts:1:1: error escaped',
    `${path.join(outside, 'outside.ts')}:1:1: error outside`,
    'linked/outside.ts:1:1: error symlink',
  ].join('\n');
  const result = await code(new Workspace(root), { action: 'diagnostics', text: input });
  assert.equal(result.parsed, 9);
  assert.equal(result.excluded, 4);
  assert.equal(result.items.length, 5);
  assert.deepEqual(result.items[0].context, [{ line: 1, text: 'one' }, { line: 2, text: 'two' }, { line: 3, text: 'three' }]);
  assert.equal(result.items[1].line, 3);
  assert.equal(result.items[3].line, 4);
  assert.equal(result.items[4].path, 'script.py');
  assert.equal(result.executed, false);
  assert.equal(JSON.stringify(result).includes('NEVER_READ'), false);
  const limited = await code(new Workspace(root), { action: 'diagnostics', text: input, limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.equal(limited.truncated, true);
  await fs.writeFile(path.join(root, 'src/long.ts'), 'x'.repeat(1000) + '\n' + 'y'.repeat(1000) + '\n' + 'z'.repeat(1000));
  const budgeted = await code(new Workspace(root), { action: 'diagnostics', text: 'src/long.ts:2:1: error ' + 'message'.repeat(60) }, { config: { maxOutputChars: 1000 } });
  assert.ok(JSON.stringify(budgeted).length <= 1000);
  assert.equal(budgeted.items.length, 1);
  assert.ok(budgeted.items[0].context.length >= 1);
  assert.equal(budgeted.truncated, true);
  await assert.rejects(code(new Workspace(root), { action: 'diagnostics' }), { code: 'INVALID_ARGUMENTS' });
});

test('code gateways inherit workspace path exclusions and preempt cancellation', async (t) => {
  const root = await fixture(t, { 'safe.js': 'function safe() {}', '.env': 'private' });
  const workspace = new Workspace(root);
  for (const selected of ['../outside', '..\\outside', '/etc/passwd', 'C:\\Windows', '.git/config', '.env']) {
    await assert.rejects(code(workspace, { action: 'symbols', path: selected }), (error) => ['PATH_ESCAPE', 'INVALID_PATH', 'SECRET_PATH'].includes(error.code));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(code(workspace, { action: 'symbols' }, { signal: controller.signal }), { code: 'ABORTED' });
  let calls = 0;
  const during = new AbortController();
  const cancelling = { maxOutputChars: 6000, run: async () => { calls++; during.abort(); return { files: ['safe.js'] }; } };
  await assert.rejects(code(cancelling, { action: 'symbols' }, { signal: during.signal }), { code: 'ABORTED' });
  assert.equal(calls, 1);
});

test('review reports actual changed lines, related existing tests and checks without running them', { skip: !hasGit }, async (t) => {
  const root = await fixture(t, {
    'src/math.js': 'export function calculate(value) { return value; }\n',
    'test/math.test.js': 'test("calculate", () => {});',
    'test/unrelated.test.js': 'test("other", () => {});',
    'package.json': JSON.stringify({ scripts: { test: 'node -e "throw Error(\'MUST_NOT_RUN\')"', lint: 'eslint .', start: 'node server.js' } }),
  });
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Strong Test', '-c', 'user.email=strong@example.invalid', 'commit', '-qm', 'fixture');
  await fs.writeFile(path.join(root, 'src/math.js'), 'export async function calculate(value) {\n  const parsed = JSON.parse(value);\n  return fetch(parsed.url);\n}\n');
  const result = await runCodeTool('strong_review', {}, { workspace: new Workspace(root) });
  assert.equal(result.executed, false);
  assert.equal(result.advisory, true);
  assert.deepEqual(result.files.map(({ path: name }) => name), ['src/math.js']);
  assert.ok(result.findings.some((item) => item.kind === 'network-boundary' && item.line === 3 && item.side === 'right'));
  assert.ok(result.findings.some((item) => item.kind === 'input-parsing' && item.line === 2));
  assert.deepEqual(result.relatedTests, ['test/math.test.js']);
  assert.deepEqual(result.suggestedChecks.map(({ script }) => script), ['lint', 'test']);
  assert.match(result.scope, /changes/);
  assert.match(result.note, /No test, build or lint command was run/);
  const bounded = await runCodeTool('strong_review', {}, { workspace: new Workspace(root), config: { maxOutputChars: 1000 } });
  assert.ok(JSON.stringify(bounded).length <= 1000);
  assert.equal(bounded.truncated, true);
  await fs.unlink(path.join(root, 'src/math.js'));
  const deleted = await runCodeTool('strong_review', { path: 'src/math.js' }, { workspace: new Workspace(root) });
  assert.deepEqual(deleted.files, [{ path: 'src/math.js', added: 0, removed: 1 }]);
  assert.ok(deleted.findings.some((item) => item.kind === 'public-interface' && item.side === 'left' && item.line === 1));
  assert.deepEqual(deleted.relatedTests, ['test/math.test.js']);
});

test('review handles unavailable diffs without claiming verification', async (t) => {
  const root = await fixture(t, { 'safe.js': 'safe' });
  const result = await runCodeTool('strong_review', {}, { workspace: new Workspace(root) });
  assert.equal(result.available, false);
  assert.equal(result.executed, false);
  assert.deepEqual(result.findings, []);
});

test('review distinguishes diff-like source lines and records mode-only files with spaces', async () => {
  const diff = [
    'diff --git a/source file.js b/source file.js',
    '--- a/source file.js',
    '+++ b/source file.js',
    '@@ -1 +1,3 @@',
    '-old',
    '+++ b/spoof.js',
    '+fetch(url)',
    '+done',
    'diff --git a/mode only.js b/mode only.js',
    'old mode 100644',
    'new mode 100755',
  ].join('\n');
  const workspace = { maxOutputChars: 6000, run: async ({ action }) => action === 'diff' ? { available: true, diff, scope: 'fixture diff' } : action === 'map' ? { files: [] } : { packages: [], configs: [] } };
  const result = await runCodeTool('strong_review', {}, { workspace });
  assert.deepEqual(result.files, [{ path: 'source file.js', added: 3, removed: 1 }, { path: 'mode only.js', added: 0, removed: 0 }]);
  assert.equal(result.findings[0].path, 'source file.js');
  assert.equal(result.findings[0].line, 2);
});
