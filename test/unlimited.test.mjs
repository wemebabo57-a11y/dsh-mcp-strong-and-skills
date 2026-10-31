import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig } from '../src/config.mjs';
import { StrongEngine, buildPolicy, budgetReport, toolsForConfig } from '../src/engine.mjs';
import { Workspace } from '../src/workspace.mjs';
import { runCodeTool } from '../src/code-tools.mjs';

async function fixture(t, files = {}) {
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const root = await fsp.mkdtemp(path.join(temporaryRoot, 'strong-unlimited-'));
  t.after(async () => {
    const resolved = await fsp.realpath(root);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.equal(path.basename(resolved).startsWith('strong-unlimited-'), true);
    await fsp.rm(resolved, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(root, name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, value);
  }
  return root;
}

const unlimited = (root) => new Workspace(root, { unlimitedTokens: true });

test('unlimited mode overrides compact profiles, exposes every tool and reports effective limits', () => {
  const options = { profile: 'lean', toolSet: 'compact', enhancedThinking: false, weNeedToThinking: true, unlimitedTokens: true };
  const config = resolveConfig(options);
  assert.equal(config.unlimitedTokens, true);
  assert.equal(config.toolSet, 'expanded');
  assert.equal(config.maxOutputChars, 20000);
  assert.equal(config.maxFiles, 5000);
  assert.equal(config.maxFileBytes, 262144);
  assert.equal(config.maxSkillLoads, 8);
  assert.equal(toolsForConfig(options).length, 4);
  const policy = buildPolicy(options);
  assert.match(policy, /无限 token 模式/);
  assert.match(policy, /协作目标引导/);
  const report = budgetReport(options);
  assert.equal(report.unlimitedTokens, true);
  assert.equal(report.residentTools, 4);
  assert.equal(report.maxResultChars, 'unlimited');
  assert.equal(report.maxFiles, 5000);
  assert.equal(report.maxSkillLoads, 8);
  assert.equal(budgetReport({ toolSet: 'compact', enhancedThinking: false }).maxResultChars, 6000);
  assert.throws(() => resolveConfig({ unlimitedTokens: 'true' }));
});

test('unlimited mode can load all eight skill bodies while normal mode keeps its cap', async () => {
  const query = '实现 调试 重构 测试 前端 安全 性能 文档';
  const engine = new StrongEngine('.', { unlimitedTokens: true });
  const loaded = await engine.call('strong_skill', { query, limit: 8 });
  assert.equal(loaded.skills.length, 8);
  assert.equal(new Set(loaded.skills.map(skill => skill.id)).size, 8);
  const normal = await new StrongEngine('.', { maxSkillLoads: 2 }).call('strong_skill', { query, limit: 8 });
  assert.equal(normal.skills.length, 2);
});

test('unlimited workspace reads every line and full search excerpts without clipping', async (t) => {
  const longLine = 'A'.repeat(2000) + 'NEEDLE' + 'B'.repeat(2500);
  const lines = Array.from({ length: 250 }, (_, index) => index === 0 ? longLine : 'line ' + String(index + 1).repeat(3));
  const root = await fixture(t, { 'large.txt': lines.join('\n'), 'package.json': JSON.stringify({ scripts: Object.fromEntries(Array.from({ length: 60 }, (_, index) => ['task-' + String(index).padStart(2, '0'), 'node run.js ' + 'x'.repeat(400)])) }) });
  const wide = unlimited(root);
  const read = await wide.run({ action: 'read', path: 'large.txt' });
  assert.equal(read.lines.length, 250);
  assert.equal(read.lines[0].text, longLine);
  assert.equal(read.truncated, false);
  const search = await wide.run({ action: 'search', query: 'needle' });
  assert.equal(search.matches[0].text, longLine);
  assert.equal(search.truncated, false);
  const checks = await wide.run({ action: 'checks' });
  assert.equal(Object.keys(checks.packages[0].scripts).length, 60);
  assert.ok(checks.packages[0].scripts['task-00'].length > 300);

  const normal = new Workspace(root);
  const clipped = await normal.run({ action: 'read', path: 'large.txt', start: 1, limit: 1 });
  assert.ok(clipped.lines[0].text.length <= 1201);
  assert.equal(clipped.truncated, true);
  const normalSearch = await normal.run({ action: 'search', query: 'needle' });
  assert.ok(normalSearch.matches[0].text.length <= 702);
  assert.equal(normalSearch.matches[0].text.startsWith('…'), true);
  assert.equal(normalSearch.truncated, true);
  const normalChecks = await normal.run({ action: 'checks' });
  assert.equal(Object.keys(normalChecks.packages[0].scripts).length, 40);
  assert.ok(normalChecks.packages[0].scripts['task-00'].length <= 301);
});

test('unlimited code scans use wider file and item budgets and accept larger explicit limits', async (t) => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['src/file' + String(index).padStart(3, '0') + '.js', 'export function fn' + index + '() {}\n']));
  files['z-long.js'] = Array.from({ length: 899 }, (_, index) => '// line ' + (index + 1)).join('\n') + '\nexport function late() {}\n';
  const root = await fixture(t, files);
  const workspace = unlimited(root);
  const wide = await runCodeTool('strong_code', { action: 'symbols', path: '.' }, { workspace, config: { unlimitedTokens: true }, signal: new AbortController().signal });
  assert.equal(wide.items.length, 101);
  assert.ok(wide.items.some(item => item.name === 'fn99'));
  assert.ok(wide.items.some(item => item.name === 'late' && item.line === 900));
  assert.equal(wide.truncated, false);
  assert.ok(JSON.stringify(wide).length > 6000);

  const narrowWorkspace = new Workspace(root);
  const narrow = await runCodeTool('strong_code', { action: 'symbols', path: '.' }, { workspace: narrowWorkspace, signal: new AbortController().signal });
  assert.equal(narrow.truncated, true);
  assert.ok(narrow.items.length <= 32);
  assert.equal(narrow.items.some(item => item.name === 'fn99' || item.name === 'late'), false);

  await assert.rejects(runCodeTool('strong_code', { action: 'symbols', limit: 501 }, { workspace, config: { unlimitedTokens: true } }), { code: 'INVALID_ARGUMENTS' });
});

test('unlimited engine returns complete workspace results instead of applying the normal output cap', async (t) => {
  const text = 'Z'.repeat(7000);
  const root = await fixture(t, { 'huge.txt': text });
  const wide = await new StrongEngine(root, { unlimitedTokens: true }).call('strong_context', { action: 'read', path: 'huge.txt', limit: 1 });
  assert.equal(wide.lines[0].text, text);
  assert.equal(wide.truncated, false);
  assert.ok(JSON.stringify(wide).length > 7000);
  const normal = await new StrongEngine(root, { maxOutputChars: 2000 }).call('strong_context', { action: 'read', path: 'huge.txt', limit: 1 });
  assert.equal(normal.lines[0].text.length, 1201);
  assert.equal(normal.truncated, true);
});
