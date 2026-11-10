import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinShell } from '../src/builtin-shell.mjs';

async function makeRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-builtin-'));
}

test('builtin shell covers variables, pipes, redirects and builtins without a system shell', async () => {
  const root = await makeRoot();
  try {
    const run = (command, extra = {}) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env }, ...extra });
    const echo = await run('echo hi');
    assert.equal(echo.shell.backend, 'builtin');
    assert.equal(echo.shell.label, '内置 Bash');
    assert.equal(echo.exitCode, 0);
    assert.equal(echo.stdout, 'hi\n');

    const variable = await run('X=5; echo $X');
    assert.equal(variable.stdout, '5\n');
    const substituted = await run('echo $(echo nested)');
    assert.equal(substituted.stdout, 'nested\n');
    assert.ok((await run('echo $PATH')).stdout.trim().length > 0, 'PATH must survive Windows casing');

    await run('echo alpha > note.txt');
    assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'alpha\n');
    const pipe = await run('cat note.txt | grep -n alpha');
    assert.equal(pipe.stdout, '1:alpha\n');
    const listing = await run('ls');
    assert.match(listing.stdout, /note\.txt/);

    assert.equal((await run('mkdir -p deep/dir')).exitCode, 0);
    assert.equal((await run('test -d deep/dir')).exitCode, 0);
    assert.equal((await run('test -f note.txt')).exitCode, 0);
    assert.equal((await run('false || echo recovered')).stdout, 'recovered\n');

    const merged = await run('echo hi 1>&2');
    assert.equal(merged.stdout, '');
    assert.equal(merged.stderr, 'hi\n');
    const background = await run('echo hi &');
    assert.equal(background.exitCode, 1);
    assert.match(background.stderr, /后台执行/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builtin shell rejects paths outside the project and enforces timeouts', async () => {
  const root = await makeRoot();
  try {
    const run = (command, extra = {}) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env }, ...extra });
    const outside = await run('cat ../outside.txt');
    assert.equal(outside.exitCode, 1);
    assert.match(outside.stderr, /路径超出项目目录/);
    const timeout = await run('sleep 2', { timeoutMs: 1000 });
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.exitCode, 124);
    assert.ok(timeout.durationMs >= 900);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builtin shell falls back to real executables on PATH', async () => {
  const root = await makeRoot();
  try {
    const result = await runBuiltinShell({ command: 'node --version', cwd: root, root, env: { ...process.env } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^v\d+\./);
    const missing = await runBuiltinShell({ command: 'definitely-not-a-command', cwd: root, root, env: { ...process.env } });
    assert.equal(missing.exitCode, 127);
    assert.match(missing.stderr, /command not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builtin shell adds sort, uniq, tr and cut text helpers', async () => {
  const root = await makeRoot();
  try {
    const run = (command, extra = {}) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env }, ...extra });
    await run('echo b > words.txt');
    await run('echo a >> words.txt');
    await run('echo a >> words.txt');
    assert.equal((await run('sort -u words.txt')).stdout, 'a\nb\n');
    assert.equal((await run('sort -r words.txt')).stdout, 'b\na\na\n');
    assert.match((await run('uniq -c words.txt')).stdout, /1 b\n\s*2 a\n/);
    assert.equal((await run('tr a-z A-Z < words.txt')).stdout, 'B\nA\nA\n');
    await run('echo left,right > fields.csv');
    assert.equal((await run('cut -d , -f 2 fields.csv')).stdout, 'right\n');
    assert.equal((await run('cut --delimiter=, --fields=1 fields.csv')).stdout, 'left\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builtin shell rejects reads and writes that escape through directory links', async () => {
  const root = await makeRoot();
  const outside = await makeRoot();
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE');
    const link = path.join(root, 'linked');
    await symlink(outside, link, 'junction');
    const run = (command) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env } });
    const read = await run('cat linked/secret.txt');
    assert.equal(read.exitCode, 1);
    assert.match(read.stderr, /符号链接|路径/);
    assert.equal(read.stdout.includes('OUTSIDE'), false);
    const write = await run('echo changed > linked/new.txt');
    assert.equal(write.exitCode, 1);
    assert.match(write.stderr, /符号链接|路径/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
