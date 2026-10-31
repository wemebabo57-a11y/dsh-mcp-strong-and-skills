import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativePolicy, selectionForAssembly, POLICY_SECTION } from '../src/native-policy.mjs';
import { resolveConfig } from '../src/config.mjs';
import { buildPolicy } from '../src/engine.mjs';

test('native policy resolves accepted assembly variables before stale agent options and never a request header', () => {
  const context = { agent: { options: { model: 'deepseek-old' }, session: { requestHeader() { throw new Error('Previous route must not be consulted'); } } } };
  const assembly = { variables: { provider: 'proxy', model: 'another-model' } };
  assert.deepEqual(selectionForAssembly(assembly, context), { provider: 'proxy', model: 'another-model' });
  assert.equal(selectionForAssembly(assembly), undefined, 'An unscoped diagnostic is not a current Agent request');
  assert.deepEqual(selectionForAssembly({ variables: {} }, context), context.agent.options);
  const captured = Object.freeze({ model: 'captured-model' });
  assert.equal(selectionForAssembly(assembly, { ...context, modelSelection: captured }), captured);
  assert.equal(selectionForAssembly(assembly, { modelSelection: null }), null, 'An explicit missing selection must not inherit another route');
});

test('host post-assembly transformation reads live switches and captured variables without duplicate or cross-agent additions', async () => {
  const state = { weNeedToThinking: true };
  let registered, transform, registrationOptions;
  const ctx = {
    systemPrompt: { section(section) { registered = section; } },
    on(event, callback, options) { assert.equal(event, 'system-prompt/assemble'); transform = callback; registrationOptions = options; },
  };
  installNativePolicy(ctx, () => resolveConfig(state));
  assert.equal(registrationOptions.prepend, true);
  const context = { agent: { options: { model: 'stale-other' } } };
  const own = Object.freeze({ name: POLICY_SECTION, text: registered.text(context), interpolate: false });
  const other = Object.freeze({ name: 'another-plugin', text: 'Keep this contribution' });
  const assembly = Object.freeze({ sections: Object.freeze([other, own]), variables: Object.freeze({ model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', provider: 'proxy' }), tools: Object.freeze([]) });
  let nextCalls = 0;
  const result = await transform(undefined, context, async () => { nextCalls++; return assembly; });
  assert.equal(nextCalls, 1);
  assert.match(result.sections[1].text, /协作目标引导/);
  assert.equal(result.sections[1].text, buildPolicy(state, { selection: assembly.variables }));
  assert.equal(result.sections.filter(section => section.name === POLICY_SECTION).length, 1);
  assert.equal(result.sections[0], other);
  assert.equal(result.variables, assembly.variables);
  assert.equal(result.tools, assembly.tools);
  assert.match(own.text, /协作目标引导/, 'The live switch works before a route is captured');
  state.weNeedToThinking = false;
  assert.doesNotMatch((await transform(undefined, context, async () => assembly)).sections[1].text, /协作目标引导/);
  state.weNeedToThinking = true;
  const unrelated = { ...assembly, variables: { provider: 'deepseek', model: 'other' } };
  assert.match((await transform(undefined, context, async () => unrelated)).sections[1].text, /协作目标引导/);
  const missing = { sections: [other], variables: assembly.variables };
  assert.equal(await transform(undefined, context, async () => missing), missing, 'A removed policy is never forcibly reinserted');
});
