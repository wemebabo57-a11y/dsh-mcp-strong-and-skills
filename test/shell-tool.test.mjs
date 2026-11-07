import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { SHELL_TOOL, buildShellPolicy, resolveShell, runShellTool } from '../src/shell-tool.mjs';

async function workspace(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'strong-shell-'));
  await fs.mkdir(path.join(root, 'src'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

async function bashShell(t) {
  let shell;
  try { shell = await resolveShell({ backend: 'auto' }); }
  catch { t.skip('No supported bash-like shell is installed on this host.'); return null; }
  if (!['git-bash', 'bash', 'wsl'].includes(shell.backend)) {
    t.skip('The automatic shell is not bash-like on this host.');
    return null;
  }
  return shell;
}

test('optional shell metadata and policy are explicit about backend and native-tool separation', async () => {
  assert.equal(SHELL_TOOL.name, 'strong_shell');
  assert.equal(SHELL_TOOL.inputSchema.required[0], 'command');
  assert.equal(SHELL_TOOL.inputSchema.properties.cwd.maxLength, 1000);
  const policy = buildShellPolicy({ shellBackend: 'git-bash' });
  assert.match(policy, /Git Bash/);
  assert.match(policy, /不会替换或改变 DSH 默认 shell/);
  const shell = await resolveShell({ backend: 'auto' });
  assert.ok(shell.executable);
  assert.ok(shell.args('printf ok').length > 0);
  await assert.rejects(resolveShell({ backend: 'fish' }), error => error.code === 'INVALID_SHELL_BACKEND');
  await assert.rejects(resolveShell({ backend: 'auto', executable: 'bash' }), error => error.code === 'SHELL_UNAVAILABLE');
  await assert.rejects(resolveShell({ backend: shell.backend === 'wsl' ? 'pwsh' : 'wsl', executable: shell.executable }), error => error.code === 'SHELL_UNAVAILABLE');
  await assert.rejects(resolveShell({ backend: shell.backend === 'cmd' ? 'pwsh' : 'cmd', executable: shell.executable }), error => error.code === 'SHELL_UNAVAILABLE');
});

test('runs a real command with its exit code, streams, and confined relative cwd', async t => {
  const root = await workspace(t);
  if (!(await bashShell(t))) return;
  const result = await runShellTool({ command: "printf 'out\\n'; printf 'err\\n' >&2; exit 7", cwd: 'src' }, { root });
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'out\n');
  assert.equal(result.stderr, 'err\n');
  assert.equal(result.cwd, 'src');
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.truncated, false);
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(result.shell.backend, (await resolveShell({ backend: 'auto' })).backend);
});

test('rejects absolute, parent, malformed, and missing working directories', async t => {
  const root = await workspace(t);
  if (!(await bashShell(t))) return;
  for (const cwd of [root, path.join(root, 'src'), '..', '../outside', '/etc']) {
    await assert.rejects(runShellTool({ command: 'printf no', cwd }, { root }), error => error.code === 'OUTSIDE_WORKSPACE', cwd);
  }
  await assert.rejects(runShellTool({ command: 'printf no', cwd: 'missing' }, { root }), error => error.code === 'INVALID_CWD');
  for (const args of [null, {}, { command: '' }, { command: 'x', extra: true }, { command: 'x', cwd: 'x'.repeat(1001) }, { command: 'x', timeoutMs: 999 }, { command: 'x', timeoutMs: 120001 }]) {
    await assert.rejects(runShellTool(args, { root }), error => error.code === 'INVALID_ARGUMENTS', JSON.stringify(args));
  }
});

test('filters secret environment variables and caps large output', async t => {
  const root = await workspace(t);
  if (!(await bashShell(t))) return;
  const marker = 'STRONG_SHELL_SECRET_MARKER';
  process.env[marker] = 'must-not-leak';
  try {
    const secret = await runShellTool({ command: 'printenv STRONG_SHELL_SECRET_MARKER || printf unset' }, { root });
    assert.equal(secret.stdout, 'unset');
    assert.equal(secret.stderr, '');
  } finally { delete process.env[marker]; }
  const capped = await runShellTool({ command: "head -c 70000 /dev/zero | tr '\\0' x" }, { root });
  assert.equal(capped.stdoutTruncated, true);
  assert.equal(capped.truncated, true);
  assert.ok(capped.stdout.length >= 64 * 1024);
  assert.match(capped.stdout, /\[truncated\]/);
});

test('times out and aborts real child processes without leaving the run pending', async t => {
  const root = await workspace(t);
  if (!(await bashShell(t))) return;
  const started = Date.now();
  const timedOut = await runShellTool({ command: 'sleep 5', timeoutMs: 1000 }, { root });
  assert.equal(timedOut.timedOut, true);
  assert.ok(Date.now() - started < 4500);
  const controller = new AbortController();
  const running = runShellTool({ command: 'sleep 5' }, { root, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('test abort')), 200);
  await assert.rejects(running, error => error.message === 'test abort');
});
