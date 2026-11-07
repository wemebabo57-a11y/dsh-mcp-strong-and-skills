import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig } from '../src/config.mjs';
import { budgetReport, buildPolicy, TOOLS, toolsForConfig } from '../src/engine.mjs';
import { runBashTool, BASH_TOOL } from '../src/bash-tool.mjs';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'strong-bash-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('strong-bash-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

const command = (source) => `"${process.execPath}" -e "${source}"`;

test('bash is opt-in, validated, and visible only when enabled', () => {
  assert.equal(resolveConfig().bashTool, false);
  assert.equal(toolsForConfig().length, 4);
  assert.equal(toolsForConfig({ bashTool: true }).length, 5);
  assert.equal(toolsForConfig({ bashTool: true }).at(-1).name, 'strong_bash');
  assert.equal(toolsForConfig({ toolSet: 'compact', bashTool: true }).length, 3);
  assert.ok(budgetReport({ bashTool: true }).residentTools === 5);
  assert.match(buildPolicy({ bashTool: true }), /内置 Bash 已开启/);
  assert.doesNotMatch(buildPolicy(), /内置 Bash 已开启/);
  assert.throws(() => resolveConfig({ bashTool: 'true' }));
  assert.equal(BASH_TOOL.readOnly, false);
  assert.equal(TOOLS.some(tool => tool.name === 'strong_bash'), false);
});

test('runs a command in the workspace and reports exit status and output', async (t) => {
  const root = await fixture(t);
  const ok = await runBashTool({ command: 'echo strong-bash' }, { workspace: { root } });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /strong-bash/);
  assert.equal(ok.truncated, false);
  assert.equal(ok.timedOut, false);
  const failed = await runBashTool({ command: command('process.exit(3)') }, { workspace: { root } });
  assert.equal(failed.exitCode, 3);
});

test('honors relative cwd and rejects escapes and malformed arguments', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  const result = await runBashTool({ command: command('process.stdout.write(process.cwd())'), cwd: 'src' }, { workspace: { root } });
  assert.equal(await fs.realpath(result.stdout), await fs.realpath(path.join(root, 'src')));
  for (const cwd of ['..', '../outside', path.resolve(root, 'src'), 'missing']) {
    await assert.rejects(runBashTool({ command: 'echo x', cwd }, { workspace: { root } }), error => ['PATH_ESCAPE', 'INVALID_PATH'].includes(error.code));
  }
  for (const args of [{}, { command: '' }, { command: 'x', extra: 1 }, { command: 'x'.repeat(4001) }, null, []]) {
    await assert.rejects(runBashTool(args, { workspace: { root } }), { code: 'INVALID_ARGUMENTS' });
  }
});

test('captures are bounded and timeouts terminate the shell', async (t) => {
  const root = await fixture(t);
  const large = await runBashTool({ command: command("process.stdout.write('x'.repeat(200000))") }, { workspace: { root } });
  assert.equal(large.stdoutTruncated, true);
  assert.equal(large.truncated, true);
  assert.ok(large.stdout.length <= 65536);
  const timeout = await runBashTool({ command: command('setTimeout(() => {}, 5000)'), timeoutMs: 1000 }, { workspace: { root } });
  assert.equal(timeout.timedOut, true);
  assert.ok(timeout.durationMs >= 900 && timeout.durationMs < 4500);
});

test('does not inherit token-like environment variables and cancels active commands', async (t) => {
  const root = await fixture(t);
  const key = 'STRONG_TEST_API_TOKEN';
  const previous = process.env[key];
  process.env[key] = 'do-not-leak';
  try {
    const result = await runBashTool({ command: command(`process.stdout.write(process.env.${key} || 'absent')`) }, { workspace: { root } });
    assert.equal(result.stdout, 'absent');
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
  const controller = new AbortController();
  const pending = runBashTool({ command: command('setTimeout(() => {}, 5000)') }, { workspace: { root }, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(pending, { code: 'ABORTED' });
});
