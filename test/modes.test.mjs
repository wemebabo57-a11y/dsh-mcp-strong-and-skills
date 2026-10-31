import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, budgetReport, toolsForConfig } from '../src/engine.mjs';
import { buildEnhancementPolicy } from '../src/thinking.mjs';
import { getModeState, buildDesignModePolicy, buildThinkingModePolicy } from '../src/modes.mjs';
import { resolveConfig } from '../src/config.mjs';
import { estimateTokens } from '../src/policy.mjs';

const enabled = Object.freeze({ claudeMode: true, weNeedToThinking: true });

test('new modes default off and leave the previous policy and tool surfaces unchanged', () => {
  const defaults = resolveConfig();
  assert.equal(defaults.claudeMode, false);
  assert.equal(defaults.weNeedToThinking, false);
  assert.equal(defaults.unlimitedTokens, false);
  assert.equal(buildDesignModePolicy(defaults), '');
  assert.equal(buildThinkingModePolicy(defaults, { modelId: 'deepseek-flash' }), '');
  assert.equal(buildPolicy(), buildPolicy({ claudeMode: false, weNeedToThinking: false }));
  assert.deepEqual(toolsForConfig(enabled), toolsForConfig());
  for (const key of ['claudeMode', 'weNeedToThinking', 'unlimitedTokens']) {
    for (const value of ['true', 1, null, {}]) assert.throws(() => resolveConfig({ [key]: value }), new RegExp(key));
  }
});

test('we need to activates for every model, including missing and non-DeepSeek selections', () => {
  for (const model of ['deepseek-v4-pro', 'DeepSeek-V4.1-Flash-1017', 'vendor/DEEPSEEK-R1:latest', '深度求索-V4', 'glm-5.3', 'gpt-5', 'kimi-k3']) {
    const selection = Object.freeze({ provider: 'custom', model, reasoningEffort: 'low' });
    const state = getModeState(enabled, { selection });
    assert.equal(state.weNeedTo.active, true, model);
    assert.equal(state.weNeedTo.reason, 'active');
    assert.equal(state.weNeedTo.selectedModel, model);
    assert.equal(buildPolicy(enabled, { selection }), buildPolicy(enabled, { modelId: model }));
    assert.match(buildThinkingModePolicy(enabled, { selection }), /We need to/);
    assert.deepEqual(selection, { provider: 'custom', model, reasoningEffort: 'low' });
  }
  for (const context of [undefined, {}, { selection: null }, { selection: { provider: 'deepseek' } }, { selection: { model: '' } }, { selection: { model: 17 } }]) {
    assert.equal(getModeState(enabled, context).weNeedTo.active, true, JSON.stringify(context));
    assert.equal(getModeState(enabled, context).weNeedTo.selectedModel, null);
  }
  assert.equal(getModeState({ ...enabled, modelPreset: 'generic' }, { modelId: 'deepseek-custom' }).weNeedTo.active, true);
  assert.equal(getModeState({ ...enabled, modelPreset: 'deepseek-v4-pro' }, { modelId: 'another-model' }).weNeedTo.active, true);
});

test('the checked we need to mode is independent of enhanced thinking and keeps Claude design only', () => {
  const context = { modelId: 'glm-5.3' };
  const config = { ...enabled, enhancedThinking: false };
  const state = getModeState(config, context);
  assert.deepEqual(state.claude, { requested: true, designActive: true, thinkingActive: false });
  assert.equal(state.weNeedTo.requested, true);
  assert.equal(state.weNeedTo.active, true);
  assert.equal(state.weNeedTo.reason, 'active');
  assert.match(buildThinkingModePolicy(config, context), /We need to/);
  assert.doesNotMatch(buildThinkingModePolicy(config, context), /Claude 风格工作法/);
  assert.equal(buildEnhancementPolicy(config, context), '');
  const policy = buildPolicy(config, context);
  assert.match(policy, /We need to/);
  assert.match(policy, /Claude 风格界面参考/);
  assert.doesNotMatch(policy, /通用增强|一次自审/);
  assert.equal(buildPolicy({ enhancedThinking: false, weNeedToThinking: true }, context), buildPolicy({ enhancedThinking: false }, context) + '\n' + buildThinkingModePolicy({ weNeedToThinking: true }, context));
});

test('Claude guidance covers generated frontends and observable work without replacing user branding', () => {
  const design = buildDesignModePolicy(enabled);
  const thinking = buildThinkingModePolicy({ claudeMode: true });
  assert.match(design, /前端任务/);
  assert.match(design, /已有品牌和用户要求优先/);
  assert.match(design, /键盘/);
  assert.match(design, /对比/);
  assert.match(thinking, /可观察/);
  assert.match(thinking, /验证证据/);
  for (const modelId of ['custom-model', 'claude-sonnet', 'deepseek-flash', 'glm-5.3']) {
    const state = getModeState({ claudeMode: true }, { modelId });
    assert.equal(state.claude.designActive, true);
    assert.equal(state.claude.thinkingActive, true);
  }
  const policy = buildPolicy({ ...enabled, brandIntent: 'Use our orange brand', allowBrandColors: true }, { modelId: 'deepseek-flash' });
  assert.match(policy, /不逐字复述内部推理/);
  assert.doesNotMatch(policy, /禁止.*let me|我是Claude|你是Claude/);
});

test('mode composition is stateless and diagnostics distinguish requested from applied guidance', () => {
  const first = buildPolicy(enabled, { modelId: 'deepseek-flash' });
  const second = buildPolicy(enabled, { modelId: 'glm-5.3' });
  assert.equal(buildPolicy(enabled, { modelId: 'deepseek-flash' }), first);
  const report = budgetReport(enabled, { modelId: 'deepseek-flash' });
  assert.equal(report.modes.weNeedTo.active, true);
  assert.equal(report.modes.claude.thinkingActive, true);
  assert.equal(budgetReport(enabled, { modelId: 'glm-5.3' }).modes.weNeedTo.reason, 'active');
  assert.equal(budgetReport(enabled).modes.weNeedTo.reason, 'active');
  assert.equal(budgetReport({}).modes.weNeedTo.reason, 'disabled');
  assert.equal(report.nativeReasoning, 'host-controlled');
  assert.equal(report.residentSkillBodies, 0);
  assert.ok(Object.isFrozen(getModeState(enabled, { modelId: 'glm-5.3' }).weNeedTo));
  // Model-specific guidance still follows the actual route.
  assert.notEqual(first, second);
  assert.match(first, /Flash：/);
  assert.doesNotMatch(second, /Pro：|Flash：/);
});

test('both modes add one bounded block each without increasing the default token budget', () => {
  for (const modelId of ['other-model', 'deepseek-v4-pro', 'deepseek-flash']) {
    for (const toolSet of ['compact', 'expanded']) {
      for (const enhancedThinking of [true, false]) {
        const config = { toolSet, enhancedThinking };
        const baseline = buildPolicy(config, { modelId });
        const active = buildPolicy({ ...config, ...enabled }, { modelId });
        assert.ok(estimateTokens(active) - estimateTokens(baseline) <= 400);
        const design = buildDesignModePolicy(enabled);
        assert.equal(active.split(design).length, 2, 'Design block appears exactly once');
        const thought = buildThinkingModePolicy({ ...config, ...enabled }, { modelId });
        if (thought) assert.equal(active.split(thought).length, 2, 'Thinking mode block appears exactly once');
      }
    }
  }
});
