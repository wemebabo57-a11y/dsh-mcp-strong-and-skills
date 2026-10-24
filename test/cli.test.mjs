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
  assert.match(mcp.stdout, /--profile, lean/);
});

test('invalid CLI usage fails visibly on stderr', () => {
  for (const args of [['serve'], ['config', '--mode', 'wrong', '--root', root], ['skill', '--id', '../debug'], ['inspect', '--root', root, '--action', 'run'], ['budget', '--profile', 'unknown'], ['budget', '--__proto__', 'x'], ['unknown']]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /^dsh-strong: /);
    assert.equal(result.stdout, '');
  }
});
