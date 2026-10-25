import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = fileURLToPath(new URL('../bin/strong.mjs', import.meta.url));
function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
}

test('CLI runs locally and emits parseable skill, budget and project outputs', () => {
  for (const args of [['skill', '--query', '修复报错'], ['budget', '--profile', 'lean'], ['inspect', '--root', root, '--action', 'checks']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(JSON.parse(result.stdout));
  }
  assert.equal(JSON.parse(run(['skill', '--id', 'debug']).stdout).skills[0].id, 'debug');
});

test('generated patches contain real executable/module paths with YAML-safe quoting', () => {
  const native = run(['config', '--mode', 'native', '--root', root]);
  assert.equal(native.status, 0, native.stderr);
  const modulePath = JSON.parse(native.stdout.match(/name: ("[^\n]+")/)[1]);
  assert.ok(path.isAbsolute(modulePath));
  assert.ok(existsSync(modulePath));
  const mcp = run(['config', '--mode', 'mcp', '--root', root, '--profile', 'lean']);
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(JSON.parse(mcp.stdout.match(/command: ("[^\n]+")/)[1]), process.execPath);
  const args = JSON.parse(mcp.stdout.match(/args: (.+)/)[1]);
  assert.deepEqual(args.slice(-2), ['--profile', 'lean']);
});

test('CLI enhancement flags and generated patches preserve effective options', () => {
  const budget = run(['budget', '--thinking', 'off', '--tools', 'compact', '--model', 'deepseek-v4-pro']);
  assert.equal(budget.status, 0, budget.stderr);
  const value = JSON.parse(budget.stdout);
  assert.equal(value.enhancedThinking, false);
  assert.equal(value.residentTools, 2);
  assert.equal(value.modelProfile.apiModel, 'deepseek-v4-pro');
  const native = run(['config', '--mode', 'native', '--root', root, '--thinking', 'off', '--model', 'deepseek-v4.1-flash-1017']);
  assert.match(native.stdout, /enhancedThinking: false/);
  assert.match(native.stdout, /modelPreset: "deepseek-v4\.1-flash-1017"/);
  const code = run(['code', '--root', root, '--action', 'symbols', '--path', 'src/engine.mjs']);
  assert.equal(code.status, 0, code.stderr);
  assert.match(code.stdout, /StrongEngine/);
  assert.equal(run(['budget', '--thinking', 'invalid']).status, 1);
});

test('invalid CLI usage fails visibly on stderr', () => {
  for (const args of [['serve'], ['config', '--mode', 'wrong', '--root', root], ['skill', '--id', '../debug'], ['inspect', '--root', root, '--action', 'run'], ['budget', '--profile', 'unknown'], ['budget', '--__proto__', 'x'], ['unknown']]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /^dsh-strong: /);
    assert.equal(result.stdout, '');
  }
});

test('optional mode flags round-trip through native and MCP configuration without coercing values', () => {
  const modeArgs = ['--claude-mode', 'on', '--we-need-to', 'on'];
  const native = run(['config', '--mode', 'native', '--root', root, ...modeArgs]);
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /claudeMode: true/);
  assert.match(native.stdout, /weNeedToThinking: true/);
  const mcp = run(['config', '--mode', 'mcp', '--root', root, ...modeArgs]);
  assert.equal(mcp.status, 0, mcp.stderr);
  const args = JSON.parse(mcp.stdout.match(/args: (.+)/)[1]);
  assert.deepEqual(args.slice(-4), modeArgs);
  // The generated server invocation must accept the same flags.
  const budget = run(['budget', ...modeArgs]);
  assert.equal(budget.status, 0, budget.stderr);
  assert.ok(JSON.parse(budget.stdout));
  const off = run(['config', '--mode', 'native', '--root', root, '--claude-mode', 'off', '--we-need-to', 'off']);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /claudeMode: false/);
  assert.match(off.stdout, /weNeedToThinking: false/);
  for (const flag of ['--claude-mode', '--we-need-to']) {
    const invalid = run(['budget', flag, 'true']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /must be on or off/);
  }
});
