import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveShellSandbox, runnerEnvironment } from '../src/sandbox.mjs';
import { resolveShell, runShellTool } from '../src/shell-tool.mjs';

function context(mode, provider, root) {
  return {
    get(name) {
      if (name === 'sandbox') return provider;
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode, workspaceRoot: root }) };
      if (name === 'shell') return { sandboxMode: mode };
      return undefined;
    },
  };
}

test('confining policy wraps argv through the host sandbox provider', async t => {
  const root = process.cwd();
  const calls = [];
  const provider = {
    async confine(argv, policy, signal) {
      calls.push({ argv, policy, aborted: signal?.aborted });
      return { argv: [process.execPath, '-e', 'process.stdout.write("wrapped")'], enforcement: 'full', denialSignatures: ['access is denied'], runnerFailureRules: [] };
    },
  };
  const sandbox = await resolveShellSandbox(context('workspace-write', provider, root), {}, root);
  assert.equal(sandbox.enforce, true);
  const result = await runShellTool({ command: `node -e "process.stdout.write('native')"` }, { root, sandbox });
  assert.equal(result.stdout, 'wrapped');
  assert.equal(result.sandbox.mode, 'workspace-write');
  assert.equal(result.sandbox.enforced, true);
  assert.equal(result.sandbox.denied, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].policy.mode, 'workspace-write');
});

test('runner environment preserves the Electron-as-Node marker and host preload', () => {
  const prepared = { argv: [process.execPath, 'runner.js'] };
  const env = runnerEnvironment({ PATH: 'x' }, prepared, {
    electron: true,
    execPath: process.execPath,
    parentEnvironment: { NODE_OPTIONS: '--require=patch.cjs' },
  });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.NODE_OPTIONS, '--require=patch.cjs');
  const unconfined = runnerEnvironment({ PATH: 'x' }, null, { parentEnvironment: { NODE_OPTIONS: '--require=patch.cjs' } });
  assert.equal(unconfined.NODE_OPTIONS, undefined);
});

test('Windows confinement resolves auto to builtin and rejects fixed Git Bash', async () => {
  if (process.platform !== 'win32') return;
  const auto = await resolveShell({ backend: 'auto', confined: true });
  assert.equal(auto.backend, 'builtin');
  await assert.rejects(resolveShell({ backend: 'git-bash', confined: true }), error => error.code === 'SHELL_UNAVAILABLE');
});

test('confined auto still runs builtin commands', async t => {
  const root = (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'strong-auto-'));
  const realRoot = await root;
  t.after(async () => { await (await import('node:fs/promises')).rm(realRoot, { recursive: true, force: true }); });
  const sandbox = await resolveShellSandbox(context('workspace-write', { async confine(argv) { return { argv, denialSignatures: [], runnerFailureRules: [] }; } }, realRoot), {}, realRoot);
  const result = await runShellTool({ command: 'printf confined-auto' }, { root: realRoot, sandbox });
  assert.equal(result.shell.backend, 'builtin');
  assert.equal(result.stdout, 'confined-auto');
});

test('missing provider fails closed for a confining mode', async () => {
  const root = process.cwd();
  await assert.rejects(resolveShellSandbox(context('read-only', undefined, root), {}, root), error => error.code === 'SANDBOX_UNAVAILABLE');
});

test('danger-full-access remains unconfined but labelled', async () => {
  const root = process.cwd();
  const sandbox = await resolveShellSandbox(context('danger-full-access', undefined, root), {}, root);
  assert.equal(sandbox.enforce, false);
  assert.equal((await sandbox.wrap(['echo'])).argv[0], 'echo');
});

test('builtin shell refuses writes in read-only mode', async t => {
  const root = (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'strong-sandbox-'));
  const realRoot = await root;
  t.after(async () => { await (await import('node:fs/promises')).rm(realRoot, { recursive: true, force: true }); });
  const sandbox = await resolveShellSandbox(context('read-only', { async confine(argv) { return { argv, denialSignatures: [], runnerFailureRules: [] }; } }, realRoot), {}, realRoot);
  const result = await runShellTool({ command: 'printf nope > denied.txt' }, { root: realRoot, config: { shellBackend: 'builtin' }, sandbox });
  assert.equal(result.sandbox.denied, true);
  assert.match(result.stderr, /read-only|SANDBOX_DENIED|沙箱/);
  await assert.rejects((await import('node:fs/promises')).stat((await import('node:path')).join(realRoot, 'denied.txt')));
});
