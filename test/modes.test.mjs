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
  assert.equal(buildDesignModePolicy(defaults), '');
  assert.equal(buildThinkingModePolicy(defaults, { modelId: 'deepseek-flash' }), '');
  assert.equal(buildPolicy(), buildPolicy({ claudeMode: false, weNeedToThinking: false }));
  assert.deepEqual(toolsForConfig(enabled), toolsForConfig());
  for (const key of ['claudeMode', 'weNeedToThinking']) {
    for (const value of ['true', 1, null, {}]) assert.throws(() => resolveConfig({ [key]: value }), new RegExp(key));
  }
});

test('we need to activates on actual current DeepSeek model names including proxy routes', () => {
  for (const model of ['deepseek-v4-pro', 'DeepSeek-V4.1-Flash-1017', 'vendor/DEEPSEEK-R1:latest', '深度求索-V4']) {
    const selection = Object.freeze({ provider: 'custom', model, reasoningEffort: 'low' });
    const state = getModeState(enabled, { selection });
    assert.equal(state.weNeedTo.active, true, model);
    assert.equal(state.weNeedTo.reason, 'active');
    assert.equal(state.weNeedTo.selectedModel, model);
    assert.equal(buildPolicy(enabled, { selection }), buildPolicy(enabled, { modelId: model }));
    assert.deepEqual(selection, { provider: 'custom', model, reasoningEffort: 'low' });
  }
});

test('provider names and policy presets never bypass the actual-model gate', () => {
  for (const selection of [undefined, null, {}, { provider: 'deepseek' }, { model: '' }, { model: 17 }]) {
    const config = { ...enabled, modelPreset: 'deepseek-v4-pro' };
    assert.equal(getModeState(config, { selection }).weNeedTo.reason, 'model-unavailable');
    assert.equal(buildThinkingModePolicy(config, { selection }), buildThinkingModePolicy({ claudeMode: true }));
  }
  for (const modelPreset of ['auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'generic']) {
    const context = { selection: { provider: 'deepseek-official', model: 'another-model' } };
    const state = getModeState({ ...enabled, modelPreset }, context);
    assert.equal(state.weNeedTo.active, false);
    assert.equal(state.weNeedTo.reason, 'model-not-deepseek');
  }
  assert.equal(getModeState({ weNeedToThinking: true, modelPreset: 'generic' }, { modelId: 'deepseek-custom' }).weNeedTo.active, true, 'Generic playbook does not erase actual model identity');
  assert.equal(getModeState(enabled, { selection: { model: 'other' }, modelId: 'deepseek-flash' }).weNeedTo.active, false, 'Captured current selection takes priority over a fallback modelId');
});

test('turning off enhanced thinking removes both optional thought modes while keeping Claude design', () => {
  const context = { modelId: 'deepseek-flash' };
  const config = { ...enabled, enhancedThinking: false };
  const state = getModeState(config, context);
  assert.deepEqual(state.claude, { requested: true, designActive: true, thinkingActive: false });
  assert.equal(state.weNeedTo.requested, true);
  assert.equal(state.weNeedTo.active, false);
  assert.equal(state.weNeedTo.reason, 'enhancement-off');
  assert.equal(buildThinkingModePolicy(config, context), '');
  assert.equal(buildEnhancementPolicy(config, context), '');
  const baseline = buildPolicy({ enhancedThinking: false });
  assert.equal(buildPolicy(config, context), baseline + '\n' + buildDesignModePolicy(config));
  assert.equal(buildPolicy({ enhancedThinking: false, weNeedToThinking: true }, context), baseline);
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
  for (const modelId of ['custom-model', 'claude-sonnet', 'deepseek-flash']) {
    const state = getModeState({ claudeMode: true }, { modelId });
    assert.equal(state.claude.designActive, true);
    assert.equal(state.claude.thinkingActive, true);
  }
  const policy = buildPolicy({ ...enabled, brandIntent: 'Use our orange brand', allowBrandColors: true }, { modelId: 'deepseek-flash' });
  assert.match(policy, /不展示内部推理/);
  assert.doesNotMatch(policy, /必须.*[Ww]e need to|以.*[Ww]e need to.*开头|禁止.*let me|我是Claude|你是Claude/);
});

test('mode composition is stateless and diagnostics distinguish requested from applied guidance', () => {
  const deepseek = { modelId: 'deepseek-flash' };
  const other = { modelId: 'other-model' };
  const first = buildPolicy(enabled, deepseek);
  const second = buildPolicy(enabled, other);
  assert.notEqual(first, second);
  assert.equal(buildPolicy(enabled, deepseek), first);
  const report = budgetReport(enabled, deepseek);
  assert.equal(report.modes.weNeedTo.active, true);
  assert.equal(report.modes.claude.thinkingActive, true);
  assert.equal(budgetReport(enabled, other).modes.weNeedTo.reason, 'model-not-deepseek');
  assert.equal(budgetReport(enabled).modes.weNeedTo.reason, 'model-unavailable');
  assert.equal(budgetReport({}).modes.weNeedTo.reason, 'disabled');
  assert.equal(report.nativeReasoning, 'host-controlled');
  assert.equal(report.residentSkillBodies, 0);
  assert.ok(Object.isFrozen(getModeState(enabled, deepseek).weNeedTo));
});

test('both modes add one bounded block each without increasing the default token budget', () => {
  for (const modelId of ['other-model', 'deepseek-v4-pro', 'deepseek-flash']) {
    for (const toolSet of ['compact', 'expanded']) {
      for (const enhancedThinking of [true, false]) {
        const config = { toolSet, enhancedThinking };
        const baseline = buildPolicy(config, { modelId });
        const active = buildPolicy({ ...config, ...enabled }, { modelId });
        assert.ok(estimateTokens(active) - estimateTokens(baseline) <= 300);
        const design = buildDesignModePolicy(enabled);
        assert.equal(active.split(design).length, 2, 'Design block appears exactly once');
        const thought = buildThinkingModePolicy({ ...config, ...enabled }, { modelId });
        if (thought) assert.equal(active.split(thought).length, 2, 'Thinking mode block appears exactly once');
      }
    }
  }
});
