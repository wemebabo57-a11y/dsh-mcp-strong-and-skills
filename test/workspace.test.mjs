import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Workspace } from '../src/workspace.mjs';

async function fixture(t, files = {}) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'harness-workspace-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('harness-workspace-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, shell: false });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

test('literal case insensitive search and numbered Unicode excerpts', async (t) => {
  const root = await fixture(t, { 'src/example.js': '你好世界\nA literal [TEST] token\nThird line\n', '.env': 'TOP_SECRET=1', '.env.example': 'TOKEN=example' });
  const workspace = new Workspace(root);
  const search = await workspace.run({ action: 'search', query: '[test]' });
  assert.deepEqual(search.matches, [{ path: 'src/example.js', line: 2, column: 11, text: 'A literal [TEST] token' }]);
  assert.equal(JSON.stringify(search).includes('TOP_SECRET'), false);
  const read = await workspace.run({ action: 'read', path: 'src/example.js', start: 1, limit: 2 });
  assert.deepEqual(read.lines, [{ line: 1, text: '你好世界' }, { line: 2, text: 'A literal [TEST] token' }]);
  assert.equal(read.totalLines, 4);
  assert.equal(read.truncated, true);
  const example = await workspace.run({ action: 'read', path: '.env.example' });
  assert.equal(example.lines[0].text, 'TOKEN=example');
});

test('rejects traversal, absolute paths, Git metadata, secrets, symlinks, and junctions', async (t) => {
  const root = await fixture(t, { 'safe.txt': 'safe', '.env': 'private', 'credentials.json': '{"key":"secret"}', 'server.pem': 'private' });
  const workspace = new Workspace(root);
  for (const name of ['../outside', '..\\outside', '/etc/passwd', 'C:\\Windows', '.git/config', '.env', '.env.local', 'credentials.json', '.credentials-cache', '.credentials.json', '.npmrc', '.netrc', '.ssh/config', '.aws/credentials', 'server.pem', 'key.key']) {
    await assert.rejects(workspace.run({ action: 'read', path: name }), (error) => ['INVALID_PATH', 'PATH_ESCAPE', 'SECRET_PATH'].includes(error.code), name);
  }
  const outside = await fixture(t, { 'private.txt': 'OUTSIDE_SECRET' });
  const link = path.join(root, 'linked');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.run({ action: 'read', path: 'linked/private.txt' }), { code: 'DISALLOWED_SYMLINK' });
  const map = await workspace.run({ action: 'map' });
  assert.equal(JSON.stringify(map).includes('OUTSIDE_SECRET'), false);
  assert.equal(map.files.includes('linked/private.txt'), false);
  assert.ok(map.skipped.symlink >= 1);
});

test('caps scan, output, excerpts, huge lines, and binary/large files', async (t) => {
  const files = { 'a.txt': 'x'.repeat(20000), 'binary.bin': Buffer.from([0, 1, 2, 3]), 'large.txt': 'z'.repeat(262145) };
  for (let i = 0; i < 40; i++) files[`src/file-${String(i).padStart(2, '0')}.js`] = 'needle\n'.repeat(20);
  const root = await fixture(t, files);
  const workspace = new Workspace(root, { maxFiles: 10, maxOutputChars: 1000 });
  const read = await workspace.run({ action: 'read', path: 'a.txt', limit: 100000 });
  assert.ok(JSON.stringify(read).length <= 1000);
  assert.equal(read.truncated, true);
  assert.equal(read.lines.length, 1);
  assert.match(read.lines[0].text, /^x/);
  const search = await workspace.run({ action: 'search', query: 'needle', limit: 100000 });
  assert.ok(JSON.stringify(search).length <= 1000);
  assert.ok(search.scannedFiles <= 10);
  assert.equal(search.truncated, true);
  const map = await new Workspace(root, { maxFiles: 100 }).run({ action: 'map' });
  assert.equal(map.skipped.binary, 1);
  assert.equal(map.skipped.largeFile, 1);
  assert.equal(map.files.includes('large.txt'), false);
  const skipped = await workspace.run({ action: 'read', path: 'large.txt' });
  assert.deepEqual(skipped.lines, []);
  assert.equal(skipped.skipped.largeFile, 1);
});

test('checks report scripts and configs without executing commands', async (t) => {
  const root = await fixture(t, {
    'package.json': JSON.stringify({ scripts: { test: 'node -e "throw new Error(\'NEVER_EXECUTE\')"', build: 'vite build' } }),
    'vite.config.ts': 'export default {};',
    'tsconfig.json': '{}',
    'bad/package.json': '{',
    'node_modules/hidden/package.json': '{"scripts":{"bad":"not allowed"}}',
    '.npm-cache/package.json': '{"scripts":{"bad":"not allowed"}}',
  });
  const result = await new Workspace(root).run({ action: 'checks' });
  assert.equal(result.executed, false);
  assert.equal(result.packages.length, 1);
  assert.deepEqual(Object.keys(result.packages[0].scripts), ['build', 'test']);
  assert.deepEqual(result.configs, ['tsconfig.json', 'vite.config.ts']);
  assert.equal(result.skipped.invalidJson, 1);
  assert.equal(result.ignoreSource, 'built-in');
  assert.match(result.ignoreLimitation, /Git ignore rules/);
  assert.equal(result.skipped.excludedDirectory, 2);
});

test('style warnings remain advisory and respect intentional brand colors', async (t) => {
  const root = await fixture(t, {
    'src/page.tsx': '<main className="bg-blue-900 bg-gradient-to-r">Hello</main>',
    'style.css': 'body { color: #0f172a; background: linear-gradient(red, blue); }',
    'script.js': 'const color = "#0f172a";',
  });
  const workspace = new Workspace(root);
  const result = await workspace.run({ action: 'style' });
  assert.equal(result.advisory, true);
  assert.ok(result.warnings.some((entry) => entry.kind === 'generic-palette' && entry.path === 'style.css' && entry.line === 1));
  assert.ok(result.warnings.some((entry) => entry.kind === 'gradient'));
  assert.equal(result.warnings.some((entry) => entry.path === 'script.js'), false);
  const intentional = await new Workspace(root, { brandIntent: 'Customer brand uses navy blue.' }).run({ action: 'style' });
  assert.equal(intentional.warnings.some((entry) => entry.kind === 'generic-palette'), false);
  assert.equal(intentional.warnings.some((entry) => entry.kind === 'gradient'), true);
});

test('cancellation and argument validation', async (t) => {
  const root = await fixture(t, { 'a.txt': 'hello' });
  const workspace = new Workspace(root);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(workspace.run({ action: 'map' }, { signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(workspace.run({ action: 'execute' }), { code: 'INVALID_ACTION' });
  await assert.rejects(workspace.run({ action: 'search', query: '' }), { code: 'INVALID_QUERY' });
  await assert.rejects(workspace.run({ action: 'read', path: '.' }), { code: 'INVALID_PATH' });
});

test('git ignore rules and safe bounded diff exclude tracked secrets and shell helpers', { skip: !hasGit }, async (t) => {
  const root = await fixture(t, {
    'app.js': 'const value = 1;\n',
    '.env': 'API_KEY=BEFORE_SECRET\n',
    'credentials.json': '{"token":"BEFORE_CREDENTIAL"}',
    '.gitignore': 'ignored.txt\n',
    '.gitattributes': '*.js filter=danger diff=danger\n',
  });
  git(root, ['init', '--quiet']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  await fs.writeFile(path.join(root, 'app.js'), 'const value = 2;\n');
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=AFTER_SECRET\n');
  await fs.writeFile(path.join(root, 'credentials.json'), '{"token":"AFTER_CREDENTIAL"}');
  await fs.writeFile(path.join(root, 'ignored.txt'), 'HIDDEN_NEEDLE');
  await fs.writeFile(path.join(root, 'visible.txt'), 'VISIBLE_NEEDLE');
  // If external diff were invoked, this deliberately invalid command would fail.
  git(root, ['config', 'diff.external', 'must-never-be-executed-workspace-helper']);
  git(root, ['config', 'diff.danger.textconv', 'must-never-be-executed-textconv-helper']);
  git(root, ['config', 'filter.danger.clean', 'must-never-be-executed-clean-helper']);
  git(root, ['config', 'filter.danger.process', 'must-never-be-executed-process-helper']);
  git(root, ['config', 'filter.danger.required', 'true']);
  const workspace = new Workspace(root);
  const map = await workspace.run({ action: 'map' });
  assert.equal(map.ignoreSource, 'git');
  assert.equal(map.files.includes('ignored.txt'), false);
  assert.equal(map.files.includes('visible.txt'), true);
  const diff = await workspace.run({ action: 'diff' });
  assert.equal(diff.available, true);
  assert.match(diff.diff, /const value = 2/);
  assert.equal(diff.diff.includes('SECRET'), false);
  assert.equal(diff.diff.includes('CREDENTIAL'), false);
  assert.ok(diff.skipped.secret >= 2);
  assert.equal(diff.diff.includes('visible.txt'), false);
  await fs.rm(path.join(root, 'app.js'));
  const deleted = await workspace.run({ action: 'diff', path: 'app.js' });
  assert.match(deleted.diff, /deleted file mode/);
});

test('nested workspace diffs remain scoped to that workspace', { skip: !hasGit }, async (t) => {
  const root = await fixture(t, { 'nested/app.js': 'const nested = 1;\n', 'outside.js': 'OUTSIDE_OLD\n' });
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  await fs.writeFile(path.join(root, 'nested/app.js'), 'const nested = 2;\n');
  await fs.writeFile(path.join(root, 'outside.js'), 'OUTSIDE_NEW\n');
  const workspace = new Workspace(path.join(root, 'nested'));
  const result = await workspace.run({ action: 'diff' });
  assert.equal(result.available, true);
  assert.match(result.diff, /const nested = 2/);
  assert.equal(result.diff.includes('OUTSIDE'), false);
  const map = await workspace.run({ action: 'map' });
  assert.deepEqual(map.files, ['app.js']);
});

test('ambient Git redirection, injected config, external helpers, and trace logging are scrubbed', { skip: !hasGit }, async (t) => {
  const root = await fixture(t, { 'app.js': 'const value = 1;\n' });
  const other = await fixture(t, { 'app.js': 'PRIVATE_OUTSIDE_WORKSPACE\n' });
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  await fs.writeFile(path.join(root, 'app.js'), 'const value = 2;\n');
  const variables = {
    GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, 'not-an-index'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: other,
    GIT_EXTERNAL_DIFF: 'must-never-execute', GIT_DIFF_OPTS: '--stat', GIT_TRACE: path.join(other, 'trace.log'),
  };
  const saved = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, variables);
  const workspace = new Workspace(root);
  const result = await workspace.run({ action: 'diff' });
  assert.equal(result.available, true);
  assert.match(result.diff, /const value = 2/);
  assert.equal(result.diff.includes('PRIVATE_OUTSIDE_WORKSPACE'), false);
  await assert.rejects(fs.access(path.join(other, 'trace.log')), { code: 'ENOENT' });
  const map = await workspace.run({ action: 'map' });
  assert.equal(map.ignoreSource, 'git');
});
