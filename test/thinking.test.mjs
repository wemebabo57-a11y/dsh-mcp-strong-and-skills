import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelProfile, MODEL_PRESETS, MODEL_SOURCES } from '../src/models.mjs';
import { buildEnhancementPolicy } from '../src/thinking.mjs';
import { estimateTokens } from '../src/policy.mjs';

test('exact official API aliases select rolling model policies without changing selection', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    const selection = Object.freeze({ provider: 'a-custom-route', model, reasoningEffort: 'low' });
    const profile = getModelProfile(selection);
    assert.equal(profile.id, 'deepseek-v4.1-flash-1017');
    assert.equal(profile.apiModel, 'deepseek-flash');
    assert.equal(profile.documentedVersion, 'DeepSeek-V4.1-Flash-1017');
    assert.equal(profile.rolling, true);
    assert.equal(profile.selectedModel, model);
    assert.equal(profile.detectedFrom, 'model');
    assert.deepEqual(selection, { provider: 'a-custom-route', model, reasoningEffort: 'low' });
  }
  const pro = getModelProfile('deepseek-v4-pro');
  assert.equal(pro.family, 'pro');
  assert.equal(pro.apiModel, 'deepseek-v4-pro');
  assert.equal(Object.isFrozen(pro), true);
  assert.match(MODEL_SOURCES.models, /^https:\/\/api-docs\.deepseek\.com\//);
});

test('unknown, absent and lookalike IDs use the generic policy', () => {
  for (const selection of [undefined, null, '', 17, {}, { provider: 'deepseek-official' }, 'other', 'vendor/deepseek-flash', 'not-deepseek-v4-pro', 'deepseek-v4.1-flash-1017']) {
    const profile = getModelProfile(selection);
    assert.equal(profile.id, 'generic');
    assert.equal(profile.apiModel, null);
    assert.equal(profile.detectedFrom, 'fallback');
  }
});

test('manual policy presets override auto detection without manufacturing an API snapshot ID', () => {
  const profile = getModelProfile({ provider: 'gateway', model: 'provider-owned-model' }, { modelPreset: 'deepseek-v4.1-flash-1017' });
  assert.equal(profile.family, 'flash');
  assert.equal(profile.selectedModel, 'provider-owned-model');
  assert.equal(profile.apiModel, 'deepseek-flash');
  assert.equal(profile.detectedFrom, 'preset');
  assert.equal(getModelProfile('deepseek-flash', { modelPreset: 'generic' }).family, 'generic');
  assert.throws(() => getModelProfile('deepseek-flash', { modelPreset: '__proto__' }), /modelPreset/);
});

test('model policies adapt per call and never retain a previous model', () => {
  const pro = buildEnhancementPolicy({}, { selection: { model: 'deepseek-v4-pro' } });
  const flash = buildEnhancementPolicy({}, { modelId: 'deepseek-flash' });
  const generic = buildEnhancementPolicy();
  assert.match(pro, /最多两个可行方案/);
  assert.doesNotMatch(pro, /Flash：/);
  assert.match(flash, /可验证小步/);
  assert.doesNotMatch(flash, /Pro：/);
  assert.doesNotMatch(generic, /Pro：|Flash：/);
  assert.equal(buildEnhancementPolicy({}, { selection: { model: 'deepseek-v4-pro' } }), pro);
});

test('all model routes receive the same universal core before any DeepSeek playbook', () => {
  const generic = buildEnhancementPolicy({ modelPreset: 'generic' });
  for (const selection of [{ provider: 'other', model: 'custom-model' }, undefined, { provider: 'proxy', model: 'deepseek-flash' }, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }]) {
    const policy = buildEnhancementPolicy({}, { selection });
    assert.equal(policy.split('\n').slice(0, 2).join('\n'), generic);
  }
  assert.ok(generic.length > 0);
  assert.doesNotMatch(generic, /Pro：|Flash：/);
});

test('DeepSeek playbooks use only tools available in their selected tool set', () => {
  for (const modelPreset of ['deepseek-v4-pro', 'deepseek-v4.1-flash-1017']) {
    const expanded = buildEnhancementPolicy({ modelPreset, toolSet: 'expanded' });
    const compact = buildEnhancementPolicy({ modelPreset, toolSet: 'compact' });
    assert.match(expanded, /strong_code/);
    assert.match(expanded, /strong_review/);
    assert.match(compact, /strong_context/);
    assert.doesNotMatch(compact, /strong_code|strong_review/);
    assert.notEqual(compact, expanded);
  }
});

test('off removes every added thinking, planning and clarification instruction', () => {
  for (const modelPreset of MODEL_PRESETS) {
    for (const clarification of ['auto', 'more', 'few']) {
      for (const toolSet of ['compact', 'expanded']) {
        assert.equal(buildEnhancementPolicy({ enhancedThinking: false, modelPreset, clarification, thinkingLevel: 'deep', toolSet }, { modelId: 'deepseek-flash' }), '');
      }
    }
  }
});

test('enhancement uses bounded review and material questions without demanding internal reasoning', () => {
  const normal = buildEnhancementPolicy();
  assert.match(normal, /简单任务直接实施/);
  assert.match(normal, /会改变实现/);
  assert.match(normal, /1–3个关键问题/);
  assert.match(normal, /一次自审/);
  assert.match(normal, /已有答案不重复问/);
  assert.match(normal, /不展示内部推理/);
  const deep = buildEnhancementPolicy({ thinkingLevel: 'deep' });
  assert.ok(deep.length > normal.length);
  assert.match(deep, /一次有界反例检查/);
  assert.match(buildEnhancementPolicy({ clarification: 'few' }), /只有缺失决策阻塞正确实现/);
  assert.notEqual(buildEnhancementPolicy({ clarification: 'auto' }), normal);
});

test('all default model presets stay within a small reproducible incremental token budget', () => {
  for (const modelPreset of MODEL_PRESETS) {
    for (const toolSet of ['compact', 'expanded']) {
      const config = Object.freeze({ modelPreset, toolSet });
      assert.ok(estimateTokens(buildEnhancementPolicy(config)) < 350, `${modelPreset}/${toolSet}`);
      assert.ok(estimateTokens(buildEnhancementPolicy({ ...config, thinkingLevel: 'deep' })) <= 400, `${modelPreset}/${toolSet}`);
      assert.deepEqual(config, { modelPreset, toolSet });
    }
  }
  for (const config of [{ thinkingLevel: 'infinite' }, { clarification: '__proto__' }, { toolSet: 'all' }]) assert.throws(() => buildEnhancementPolicy(config));
});
