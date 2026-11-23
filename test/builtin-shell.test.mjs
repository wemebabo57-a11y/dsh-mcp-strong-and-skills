import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinShell } from '../src/builtin-shell.mjs';
import { globFind } from '../src/shell/expand.mjs';

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

test('builtin shell refuses recursive root deletion', async () => {
  const root = await makeRoot();
  try {
    await writeFile(path.join(root, 'keep.txt'), 'KEEP');
    const run = (command) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env } });
    for (const command of ['rm -rf /', 'rm -rf .', 'rm -rf --no-preserve-root /']) {
      const result = await run(command);
      assert.equal(result.exitCode, 1, command);
      assert.match(result.stderr, /dangerous|Operation not permitted|根/, command);
      assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'KEEP', command);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builtin shell wraps external commands and hides process environment', async () => {
  const root = await makeRoot();
  const previous = process.env.REVIEW_SECRET;
  process.env.REVIEW_SECRET = 'LEAKED';
  let wraps = 0;
  const sandbox = { enforce: true, wrap: async (argv) => { wraps++; return { argv }; } };
  try {
    const run = (command) => runBuiltinShell({ command, cwd: root, root, sandbox });
    const command = await run('command node -e "process.stdout.write(process.env.REVIEW_SECRET || \'missing\')"');
    assert.equal(command.exitCode, 0, command.stderr);
    assert.equal(command.stdout, 'missing');
    assert.ok(wraps >= 1);
    const exec = await run('exec node -e "process.stdout.write(process.env.REVIEW_SECRET || \'missing\')"');
    assert.equal(exec.exitCode, 0, exec.stderr);
    assert.equal(exec.stdout, 'missing');
    assert.ok(wraps >= 2);
  } finally {
    if (previous === undefined) delete process.env.REVIEW_SECRET;
    else process.env.REVIEW_SECRET = previous;
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
test('builtin shell splits unquoted arrays and keeps later local declarations', async () => {
  const root = await makeRoot();
  try {
    const run = (command) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env } });
    assert.equal((await run("a=('x y' z); printf '<%s>' ${a[@]}")).stdout, '<x><y><z>');
    assert.equal((await run("a=('x y' z); printf '<%s>' \"${a[@]}\"")).stdout, '<x y><z>');
    assert.equal((await run("a=('x y' z); printf '<%s>' pre${a[@]}post")).stdout, '<prex><y><zpost>');
    assert.equal((await run("a=('x y' z); printf '<%s>' \"pre${a[@]}post\"")).stdout, '<prex y><zpost>');
    assert.equal((await run("a=('x,y' 'z'); IFS=,; printf '<%s>' ${a[@]}")).stdout, '<x><y><z>');
    assert.equal((await run("set -- 'x y' z; printf '<%s>' $@")).stdout, '<x><y><z>');
    assert.equal((await run("set -- 'x y' z; printf '<%s>' \"$@\"")).stdout, '<x y><z>');
    assert.equal((await run("f(){ local a=(1 2) b=3; echo \"${a[0]}:$b\"; }; f; echo \"${b-unset}\"")).stdout, '1:3\nunset\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builtin shell refuses writes through a final symlink to an outside file', async (t) => {
  const root = await makeRoot();
  const outside = await makeRoot();
  try {
    const target = path.join(outside, 'secret.txt');
    await writeFile(target, 'SECRET');
    const link = path.join(root, 'link.txt');
    try { await symlink(target, link, 'file'); }
    catch (error) { t.skip('file symlinks unavailable: ' + error.code); return; }
    const run = (command) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env } });
    const before = await stat(target);
    const touched = await run('touch link.txt');
    assert.equal(touched.exitCode, 1);
    assert.match(touched.stderr, /符号链接|路径/);
    const chmod = await run('chmod 600 link.txt');
    assert.equal(chmod.exitCode, 1);
    const after = await stat(target);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.mode & 0o777, before.mode & 0o777);

    const dirLink = path.join(root, 'dirlink');
    try { await symlink(outside, dirLink, 'junction'); }
    catch (error) { t.skip('directory symlinks unavailable: ' + error.code); return; }
    const nestedLink = path.join(outside, 'nested-link.txt');
    await symlink(target, nestedLink, 'file');
    const removed = await run('rm dirlink/nested-link.txt');
    assert.equal(removed.exitCode, 1);
    assert.match(removed.stderr, /符号链接|路径/);
    assert.ok(await stat(nestedLink));
    const moved = await run('mv dirlink/nested-link.txt stolen.txt');
    assert.equal(moved.exitCode, 1);
    assert.ok(await stat(nestedLink));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test('builtin shell times out and aborts asynchronous external commands', async () => {
  const root = await makeRoot();
  try {
    const run = (command, extra = {}) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env }, ...extra });
    const started = Date.now();
    const timedOut = await run('node -e "setTimeout(() => process.exit(0), 5000)"', { timeoutMs: 500 });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.exitCode, 124);
    assert.ok(Date.now() - started < 3500);
    const controller = new AbortController();
    const running = run('node -e "setTimeout(() => {}, 5000)"', { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(running, (error) => error.name === 'AbortError');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('builtin shell covers printf, seq and exit without falling back to MSYS tools', async () => {
  const root = await makeRoot();
  try {
    const run = (command, extra = {}) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env }, ...extra });
    assert.equal((await run("printf 'a\\tb\\n'")).stdout, 'a\tb\n');
    assert.equal((await run("printf '%s:%03d\\n' x 7")).stdout, 'x:007\n');
    assert.equal((await run('seq 3')).stdout, '1\n2\n3\n');
    assert.equal((await run('seq -w 8 10')).stdout, '08\n09\n10\n');
    assert.equal((await run('seq 1 2 5')).stdout, '1\n3\n5\n');
    const stopped = await run("printf 'out\\n'; printf 'err\\n' >&2; exit 7; echo unreachable");
    assert.equal(stopped.exitCode, 7);
    assert.equal(stopped.stdout, 'out\n');
    assert.equal(stopped.stderr, 'err\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parameter substitution uses bounded glob matching', () => {
  assert.deepEqual(globFind('*b', 'abcabc'), { start: 0, end: 5 });
  assert.deepEqual(globFind('b*', 'abcabc'), { start: 1, end: 6 });
  assert.deepEqual(globFind('??', 'abcabc'), { start: 0, end: 2 });
  assert.equal(globFind('x', 'abcabc'), null);
  const adversarial = '*a'.repeat(40) + '*b';
  const started = Date.now();
  assert.equal(globFind(adversarial, 'a'.repeat(2000)), null);
  assert.ok(Date.now() - started < 2000, 'glob search must stay bounded');
});

test('builtin shell keeps exec redirection, errexit and indexed assignment semantics', async () => {
  const root = await makeRoot();
  try {
    const run = (command, extra = {}) => runBuiltinShell({ command, cwd: root, root, env: { ...process.env }, ...extra });
    const redirected = await run('exec >out.txt\necho one\necho two');
    assert.equal(redirected.exitCode, 0, redirected.stderr);
    assert.equal(redirected.stdout, '');
    assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), 'one\ntwo\n');

    const andOr = await run('set -e\nfalse && true\necho after');
    assert.equal(andOr.exitCode, 0, andOr.stderr);
    assert.equal(andOr.stdout, 'after\n');
    const final = await run('set -e\ntrue && false\necho after');
    assert.equal(final.exitCode, 1);
    assert.equal(final.stdout, '');
    const condition = await run('set -e\nif false && true; then :; fi\nfalse\necho after');
    assert.equal(condition.exitCode, 1);
    assert.equal(condition.stdout, '');

    const indexed = await run('i=1\na[i]=x\na[$((1+1))]="two words"\necho "${a[1]}|${a[2]}"');
    assert.equal(indexed.exitCode, 0, indexed.stderr);
    assert.equal(indexed.stdout, 'x|two words\n');

    const hugeNl = await run('nl -w 999999999 /dev/null');
    assert.equal(hugeNl.exitCode, 1);
    assert.match(hugeNl.stderr, /invalid line number field width/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
