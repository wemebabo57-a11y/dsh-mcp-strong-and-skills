import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = fileURLToPath(new URL('../bin/strong.mjs', import.meta.url));
function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
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

test('optional shell flags round-trip through executable configuration', () => {
  const shellArgs = ['--shell', 'on', '--shell-backend', 'git-bash', '--wsl-distro', 'Ubuntu'];
  const native = run(['config', '--mode', 'native', '--root', root, ...shellArgs]);
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /shellTool: true/);
  assert.match(native.stdout, /shellBackend: "git-bash"/);
  assert.match(native.stdout, /wslDistro: "Ubuntu"/);
  const mcp = run(['config', '--mode', 'mcp', '--root', root, ...shellArgs]);
  assert.equal(mcp.status, 0, mcp.stderr);
  const args = JSON.parse(mcp.stdout.match(/args: (.+)/)[1]);
  for (const [flag, value] of [['--shell', 'on'], ['--shell-backend', 'git-bash'], ['--wsl-distro', 'Ubuntu']]) {
    const index = args.lastIndexOf(flag);
    assert.ok(index >= 0, flag);
    assert.equal(args[index + 1], value);
  }
  const budget = run(['budget', ...shellArgs]);
  assert.equal(budget.status, 0, budget.stderr);
  assert.equal(JSON.parse(budget.stdout).residentTools, 7);
  const off = run(['config', '--mode', 'native', '--root', root, '--shell', 'off']);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /shellTool: false/);
  const invalid = run(['budget', '--shell', 'maybe']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /must be on or off/);
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
  const modeArgs = ['--claude-mode', 'on', '--we-need-to', 'on', '--unlimited', 'on'];
  const native = run(['config', '--mode', 'native', '--root', root, ...modeArgs]);
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /claudeMode: true/);
  assert.match(native.stdout, /weNeedToThinking: true/);
  assert.match(native.stdout, /unlimitedTokens: true/);
  const mcp = run(['config', '--mode', 'mcp', '--root', root, ...modeArgs]);
  assert.equal(mcp.status, 0, mcp.stderr);
  const args = JSON.parse(mcp.stdout.match(/args: (.+)/)[1]);
  assert.deepEqual(args.slice(-6), modeArgs);
  // The generated server invocation must accept the same flags.
  const budget = run(['budget', ...modeArgs]);
  assert.equal(budget.status, 0, budget.stderr);
  assert.ok(JSON.parse(budget.stdout));
  const off = run(['config', '--mode', 'native', '--root', root, '--claude-mode', 'off', '--we-need-to', 'off', '--unlimited', 'off']);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /claudeMode: false/);
  assert.match(off.stdout, /weNeedToThinking: false/);
  assert.match(off.stdout, /unlimitedTokens: false/);
  for (const flag of ['--claude-mode', '--we-need-to', '--unlimited']) {
    const invalid = run(['budget', flag, 'true']);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /must be on or off/);
  }
});

test('network, browser and PTC flags round-trip without hidden network calls', () => {
  const args = ['--web', 'off', '--browse', 'off', '--ptc', 'off', '--browser-path', 'C:/Apps/chrome.exe'];
  const native = run(['config', '--mode', 'native', '--root', root, ...args]);
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /webTool: false/);
  assert.match(native.stdout, /browseTool: "off"/);
  assert.match(native.stdout, /ptcMode: "off"/);
  assert.match(native.stdout, /browserPath: "C:\/Apps\/chrome\.exe"/);
  const mcp = run(['config', '--mode', 'mcp', '--root', root, ...args]);
  assert.equal(mcp.status, 0, mcp.stderr);
  const mcpArgs = JSON.parse(mcp.stdout.match(/args: (.+)/)[1]);
  for (const [flag, value] of [['--web', 'off'], ['--browse', 'off'], ['--ptc', 'off'], ['--browser-path', 'C:/Apps/chrome.exe']]) {
    const index = mcpArgs.lastIndexOf(flag);
    assert.ok(index >= 0, flag);
    assert.equal(mcpArgs[index + 1], value);
  }
  const budget = run(['budget', '--web', 'off', '--browse', 'off']);
  assert.equal(budget.status, 0, budget.stderr);
  assert.equal(JSON.parse(budget.stdout).residentTools, 4);
  const withoutBrowser = run(['budget', '--web', 'on', '--browse', 'off']);
  assert.equal(JSON.parse(withoutBrowser.stdout).residentTools, 5);
  const privateNative = run(['config', '--mode', 'native', '--root', root, '--web-private', 'on']);
  assert.equal(privateNative.status, 0, privateNative.stderr);
  assert.match(privateNative.stdout, /webAllowPrivate: true/);
  const privateMcp = run(['config', '--mode', 'mcp', '--root', root, '--web-private', 'on']);
  assert.equal(privateMcp.status, 0, privateMcp.stderr);
  const privateArgs = JSON.parse(privateMcp.stdout.match(/args: (.+)/)[1]);
  assert.equal(privateArgs[privateArgs.lastIndexOf('--web-private') + 1], 'on');
  assert.equal(run(['budget', '--web', 'on', '--browse', 'on']).status, 0);
  for (const flag of ['--browse', '--ptc']) {
    const invalid = run(['budget', flag, 'always']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /auto\|on\|off/);
  }
  const invalidWeb = run(['budget', '--web', 'maybe']);
  assert.equal(invalidWeb.status, 1);
  assert.match(invalidWeb.stderr, /must be on or off/);
});

test('CLI supports version and --flag=value forms', () => {
  for (const args of [['--version'], ['-v'], ['version']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^dsh-strong \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n$/);
  }
  const equals = run(['budget', '--profile=lean']);
  assert.equal(equals.status, 0, equals.stderr);
  assert.equal(JSON.parse(equals.stdout).residentTools, 6);
  const separate = run(['budget', '--profile', 'lean']);
  assert.deepEqual(JSON.parse(equals.stdout), JSON.parse(separate.stdout));
});
