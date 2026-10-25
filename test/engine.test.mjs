import test from 'node:test';
import assert from 'node:assert/strict';
import { boundResult, budgetReport, StrongEngine, BASE_TOOLS, TOOLS, toolsForConfig, buildPolicy } from '../src/engine.mjs';
import { resolveConfig } from '../src/config.mjs';
import { snapshotConfig } from '../src/native-config.mjs';
import { POLICY } from '../src/policy.mjs';
import { parseArgs } from '../bin/strong.mjs';

test('bounded canonical results remain valid JSON and disclose truncation', () => {
  const large = { skills: [{ id: 'large', content: '中文😀'.repeat(10000) }], matches: Array.from({ length: 500 }, (_, line) => ({ line, text: 'x'.repeat(100) })) };
  const result = boundResult(large, 2000);
  assert.ok(JSON.stringify(result).length <= 2000);
  assert.equal(result.truncated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(large.skills[0].content.length, 40000, 'caller value stays intact');
});

test('profiles enforce hard bounds without hidden model calls', () => {
  for (const profile of ['lean', 'balanced', 'thorough']) {
    const report = budgetReport({ profile });
    assert.equal(report.residentTools, 4);
    assert.equal(report.residentSkillBodies, 0);
    assert.ok(report.approximateResidentTokens < 1600);
  }
  assert.equal(resolveConfig({ profile: undefined }).profile, 'balanced');
  for (const config of [{ profile: 'missing' }, { profile: null }, { profile: ['lean'] }, { maxSkillLoads: 3 }, { maxFiles: Infinity }, { maxOutputChars: 0 }, { maxFileBytes: 99999999 }, { enhancedThinking: 'false' }, { thinkingLevel: 'unbounded' }, { clarification: 'always' }, { modelPreset: 'deepseek-flash-api' }, { toolSet: 'all' }, { token: 'secret' }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => resolveConfig(config));
  }
  assert.ok(new StrongEngine('.') instanceof StrongEngine); // No network or project reads during construction.
});

test('expanded and compact budgets account for the active policy and schemas', async () => {
  const expanded = budgetReport();
  const compactOptions = { toolSet: 'compact', enhancedThinking: false };
  const compact = budgetReport(compactOptions);
  assert.deepEqual(toolsForConfig(), TOOLS);
  assert.deepEqual(toolsForConfig(compactOptions), BASE_TOOLS);
  assert.equal(compact.residentTools, 2);
  assert.equal(compact.policyChars, POLICY.length);
  assert.equal(buildPolicy(compactOptions), POLICY);
  assert.equal(compact.toolSchemaChars, JSON.stringify(BASE_TOOLS).length);
  assert.equal(expanded.toolSchemaChars, JSON.stringify(TOOLS).length);
  assert.ok(compact.approximateResidentTokens < expanded.approximateResidentTokens);
  assert.ok(expanded.approximateResidentTokens < 1600);
  const compactEngine = new StrongEngine('.', compactOptions);
  for (const [name, args] of [['strong_code', { action: 'symbols' }], ['strong_review', {}]]) {
    await assert.rejects(compactEngine.call(name, args), /Unknown tool/);
  }
});

test('fresh config snapshots update budgets and profile limits without retaining stale defaults', () => {
  const state = { profile: 'balanced', enhancedThinking: true, toolSet: 'expanded', maxFiles: undefined };
  const references = Object.fromEntries(Object.keys(state).map(key => [key, { get: () => state[key] }]));
  const initial = budgetReport(snapshotConfig(references));
  assert.equal(initial.maxResultChars, 6000);
  assert.equal(initial.maxFiles, 800);
  assert.equal(initial.residentTools, 4);
  state.profile = 'lean';
  state.enhancedThinking = false;
  state.toolSet = 'compact';
  const lean = budgetReport(snapshotConfig(references));
  assert.equal(lean.maxResultChars, 4000);
  assert.equal(lean.maxFiles, 400);
  assert.equal(lean.maxSkillLoads, 1);
  assert.equal(lean.residentTools, 2);
  assert.equal(lean.enhancedThinking, false);
  assert.ok(lean.approximateResidentTokens < initial.approximateResidentTokens);
  state.maxFiles = 123;
  state.profile = 'thorough';
  assert.equal(budgetReport(snapshotConfig(references)).maxFiles, 123);
  state.maxFiles = undefined;
  assert.equal(budgetReport(snapshotConfig(references)).maxFiles, 2000);
});

test('budget diagnostics identify policy profiles while preserving host reasoning choices', () => {
  const selection = Object.freeze({ provider: 'gateway', model: 'deepseek-flash', reasoningEffort: 'low' });
  const automatic = budgetReport({}, { selection });
  assert.equal(automatic.modelProfile.id, 'deepseek-v4.1-flash-1017');
  assert.equal(automatic.modelProfile.apiModel, 'deepseek-flash');
  assert.equal(automatic.nativeReasoning, 'host-controlled');
  const manual = budgetReport({ modelPreset: 'deepseek-v4-pro' }, { selection });
  assert.equal(manual.modelProfile.family, 'pro');
  assert.equal(manual.modelProfile.selectedModel, 'deepseek-flash');
  assert.equal(manual.modelProfile.detectedFrom, 'preset');
  assert.deepEqual(selection, { provider: 'gateway', model: 'deepseek-flash', reasoningEffort: 'low' });
});

test('CLI rejects missing values and duplicate options', () => {
  assert.deepEqual(parseArgs(['skill', '--id', 'debug']), { command: 'skill', options: { id: 'debug' } });
  assert.throws(() => parseArgs(['serve', '--root']));
  assert.throws(() => parseArgs(['serve', '--root', '.', '--root', 'src']));
});
