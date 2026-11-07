import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply, inject, name, Config } from '../src/index.mjs';
import { TOOLS, BASE_TOOLS, buildPolicy } from '../src/engine.mjs';
import { POLICY } from '../src/policy.mjs';
import { snapshotConfig } from '../src/native-config.mjs';

function host(ensure = async () => { throw new Error('Unexpected directory lookup'); }, defaultDirectory = process.cwd()) {
  const sections = [];
  const registrations = new Map();
  const conditions = new Map();
  const ctx = {
    systemPrompt: { section: section => sections.push(section) },
    tools: { register: (definition, options) => {
      assert.equal(registrations.has(definition.name), false, 'Tool names must be unique');
      registrations.set(definition.name, definition);
      conditions.set(definition.name, options?.when);
      return () => registrations.delete(definition.name);
    } },
    workingDirectory: { ensure, defaultDirectory },
  };
  const visibleNames = () => [...registrations.keys()].filter(tool => !conditions.get(tool) || conditions.get(tool)());
  return { ctx, sections, registrations, conditions, visibleNames };
}

async function temporaryWorkspace(t, marker) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'dsh-strong-native-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), temporaryRoot);
    assert.equal(path.basename(root).startsWith('dsh-strong-native-'), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'marker.txt'), marker, 'utf8');
  return root;
}

test('native plugin registers a dynamic policy and four canonical tools', () => {
  const { ctx, sections, registrations, conditions, visibleNames } = host();
  apply(ctx);
  assert.equal(name, 'strong-skills');
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'workingDirectory']);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'strong-skills:policy');
  assert.equal(sections[0].order, 650);
  assert.equal(sections[0].interpolate, false);
  assert.equal(typeof sections[0].text, 'function');
  assert.equal(sections[0].text(), buildPolicy());
  assert.deepEqual([...registrations.keys()], TOOLS.map(tool => tool.name));
  assert.deepEqual(visibleNames(), TOOLS.map(tool => tool.name));
  for (const tool of BASE_TOOLS) assert.equal(conditions.get(tool.name), undefined);
  for (const definition of registrations.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(definition.isConcurrencySafe({}), true);
    const canonical = { skills: [{ id: 'example', content: '中文\n"quoted"' }], truncated: false };
    const rendered = definition.output.render({}, canonical);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].type, 'text');
    assert.deepEqual(JSON.parse(rendered[0].text), canonical);
    assert.equal(Object.hasOwn(canonical, 'content'), false, 'Rendering must not mutate the canonical value');
  }
});

test('one native registration follows live thinking settings and keeps the base policy when off', () => {
  const state = { enabled: true, level: 'balanced', clarification: 'more' };
  const options = {
    enhancedThinking: { get: () => state.enabled },
    thinkingLevel: { get: () => state.level },
    clarification: { get: () => state.clarification },
    toolSet: 'compact',
  };
  const { ctx, sections } = host();
  apply(ctx, options);
  const render = sections[0].text;
  const enabled = render();
  assert.ok(enabled.startsWith(POLICY));
  assert.ok(enabled.length > POLICY.length);
  state.level = 'deep';
  assert.notEqual(render(), enabled);
  state.enabled = false;
  assert.equal(render(), POLICY);
  state.clarification = 'few';
  assert.equal(render(), POLICY, 'The off switch also disables clarification additions');
  state.enabled = true;
  assert.equal(render(), buildPolicy({ toolSet: 'compact', thinkingLevel: 'deep', clarification: 'few' }));
  assert.equal(sections.length, 1, 'Live updates do not add duplicate sections');
});

test('section provider accepts an explicitly supplied model-selection context without mutation', () => {
  const { ctx, sections } = host();
  apply(ctx);
  const pro = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' });
  const flash = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
  const render = sections[0].text;
  assert.match(render({ modelSelection: pro }), /Pro：/);
  assert.doesNotMatch(render({ modelSelection: pro }), /Flash：/);
  assert.match(render({ modelSelection: flash }), /Flash：/);
  assert.doesNotMatch(render({ modelSelection: flash }), /Pro：/);
  assert.doesNotMatch(render(), /Pro：|Flash：/);
  assert.deepEqual(pro, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'low' });
  assert.deepEqual(flash, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' });
});

test('section provider follows saved switches with an explicit model-selection fixture', () => {
  const state = { claudeMode: false, weNeedToThinking: false, enhancedThinking: true };
  const options = Object.fromEntries(Object.keys(state).map(key => [key, { get: () => state[key] }]));
  const { ctx, sections } = host();
  apply(ctx, options);
  const render = sections[0].text;
  const first = Object.freeze({ model: 'gateway/DeepSeek-R1', reasoningEffort: 'low' });
  const other = Object.freeze({ provider: 'deepseek', model: 'different-model', reasoningEffort: 'max' });
  assert.equal(render({ modelSelection: first }), buildPolicy({}, { selection: first }));
  state.claudeMode = true;
  state.weNeedToThinking = true;
  assert.equal(render({ modelSelection: first }), buildPolicy(state, { selection: first }));
  assert.equal(render({ modelSelection: other }), buildPolicy(state, { selection: other }));
  assert.match(render({ modelSelection: other }), /协作目标引导/);
  state.enhancedThinking = false;
  assert.equal(render({ modelSelection: first }), buildPolicy({ enhancedThinking: false, claudeMode: true, weNeedToThinking: true }));
  state.claudeMode = false;
  state.weNeedToThinking = false;
  assert.equal(render({ modelSelection: first }), buildPolicy({ enhancedThinking: false }));
  assert.equal(sections.length, 1);
  assert.deepEqual(first, { model: 'gateway/DeepSeek-R1', reasoningEffort: 'low' });
  assert.deepEqual(other, { provider: 'deepseek', model: 'different-model', reasoningEffort: 'max' });
});

test('live compact tools disappear from discovery and reject execution until expanded again', async t => {
  const root = await temporaryWorkspace(t, 'dynamic tools');
  await fs.writeFile(path.join(root, 'sample.mjs'), 'export function sample(value) { return value; }\n', 'utf8');
  let toolSet = 'expanded';
  const { ctx, registrations, visibleNames } = host(undefined, root);
  apply(ctx, { toolSet: { get: () => toolSet } });
  const execution = { signal: new AbortController().signal };
  const code = registrations.get('strong_code');
  const args = { action: 'symbols', path: 'sample.mjs' };
  const first = await code.execute(args, execution);
  assert.ok(JSON.stringify(first).includes('sample'));
  toolSet = 'compact';
  assert.deepEqual(visibleNames(), BASE_TOOLS.map(tool => tool.name));
  await assert.rejects(code.execute(args, execution), /Unknown tool/);
  await assert.rejects(registrations.get('strong_review').execute({}, execution), /Unknown tool/);
  const base = await registrations.get('strong_context').execute({ action: 'read', path: 'marker.txt' }, execution);
  assert.equal(base.lines[0].text, 'dynamic tools');
  toolSet = 'expanded';
  assert.deepEqual(visibleNames(), TOOLS.map(tool => tool.name));
  assert.deepEqual(await code.execute(args, execution), first);
});

test('unlimited native setting overrides compact discovery and stays live', async t => {
  const root = await temporaryWorkspace(t, 'unlimited native');
  const state = { unlimitedTokens: false };
  const { ctx, sections, visibleNames } = host(undefined, root);
  apply(ctx, { toolSet: 'compact', unlimitedTokens: { get: () => state.unlimitedTokens } });
  assert.deepEqual(visibleNames(), BASE_TOOLS.map(tool => tool.name));
  assert.doesNotMatch(sections[0].text(), /无限 token 模式/);
  state.unlimitedTokens = true;
  assert.deepEqual(visibleNames(), TOOLS.map(tool => tool.name));
  assert.match(sections[0].text(), /无限 token 模式/);
  const schema = TOOLS.find(tool => tool.name === 'strong_context').inputSchema;
  assert.equal(schema.properties.limit.maximum, 5000);
  assert.equal(TOOLS.find(tool => tool.name === 'strong_skill').inputSchema.properties.limit.maximum, 8);
});

test('native Standard Schema validates defaults and rejects invalid settings', async () => {
  const standard = Config['~standard'];
  assert.equal(standard.version, 1);
  const defaults = await standard.validate({});
  assert.equal(defaults.issues, undefined);
  const config = snapshotConfig(defaults.value);
  assert.equal(config.enhancedThinking, true);
  assert.equal(config.claudeMode, false);
  assert.equal(config.weNeedToThinking, false);
  assert.equal(config.thinkingLevel, 'balanced');
  assert.equal(config.clarification, 'more');
  assert.equal(config.modelPreset, 'auto');
  assert.equal(config.toolSet, 'expanded');
  assert.equal(config.unlimitedTokens, false);
  for (const invalid of [{ unlimitedTokens: 'true' }, { enhancedThinking: 'false' }, { claudeMode: 'true' }, { weNeedToThinking: 1 }, { thinkingLevel: 'unbounded' }, { toolSet: 'all' }, { modelPreset: 'deepseek-v4.1-flash-api' }, { maxFiles: 1 }]) {
    const result = await standard.validate(invalid);
    assert.ok(result.issues?.length, JSON.stringify(invalid));
  }
});

test('each native call resolves the current caller directory and forwards agent and signal', async t => {
  const first = await temporaryWorkspace(t, 'first session directory');
  const second = await temporaryWorkspace(t, 'second session directory');
  const calls = [];
  let currentDirectory = first;
  const agent = { session: { header: { cwd: 'original-project-is-not-current-directory' } } };
  const firstControl = new AbortController();
  const secondControl = new AbortController();
  const { ctx, registrations } = host(async (receivedAgent, signal) => {
    calls.push({ agent: receivedAgent, signal });
    return currentDirectory;
  });
  apply(ctx);
  const tool = registrations.get('strong_context');
  const firstResult = await tool.execute({ action: 'read', path: 'marker.txt' }, { agent, signal: firstControl.signal });
  currentDirectory = second;
  const secondResult = await tool.execute({ action: 'read', path: 'marker.txt' }, { agent, signal: secondControl.signal });
  assert.equal(firstResult.lines[0].text, 'first session directory');
  assert.equal(secondResult.lines[0].text, 'second session directory');
  assert.deepEqual(calls, [{ agent, signal: firstControl.signal }, { agent, signal: secondControl.signal }]);
  assert.equal(Object.hasOwn(firstResult, 'content'), false, 'Execute returns JSON, not an MCP envelope');
});

test('calls without an agent use the configured default directory', async t => {
  const root = await temporaryWorkspace(t, 'deployment default');
  const { ctx, registrations } = host(undefined, root);
  apply(ctx);
  const result = await registrations.get('strong_context').execute(
    { action: 'read', path: 'marker.txt' }, { signal: new AbortController().signal },
  );
  assert.equal(result.lines[0].text, 'deployment default');
});

test('native gateway validates model arguments instead of trusting raw tool schemas', async t => {
  const root = await temporaryWorkspace(t, 'safe');
  const { ctx, registrations } = host(async () => root);
  apply(ctx);
  const execution = { agent: {}, signal: new AbortController().signal };
  const context = registrations.get('strong_context');
  const skill = registrations.get('strong_skill');
  for (const args of [null, [], {}, { action: 'shell' }, { action: 'read', path: 17 }, { action: 'read', path: 'marker.txt', unknown: true }]) {
    await assert.rejects(context.execute(args, execution));
  }
  await assert.rejects(skill.execute({ id: '../debug' }, execution), /Invalid id/);
  await assert.rejects(skill.execute({ id: 'debug', query: 'error' }, execution), /id or query/);
});

test('pre-cancelled calls do not resolve directories or start work', async () => {
  let lookups = 0;
  const { ctx, registrations } = host(async () => { lookups++; return process.cwd(); });
  apply(ctx);
  const control = new AbortController();
  const reason = new Error('Cancelled before dispatch');
  control.abort(reason);
  await assert.rejects(
    registrations.get('strong_skill').execute({ id: 'debug' }, { agent: {}, signal: control.signal }),
    error => error === reason,
  );
  assert.equal(lookups, 0);
});

test('cancellation propagates to a pending directory resolution', async () => {
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const control = new AbortController();
  const agent = {};
  const reason = new Error('Cancelled while resolving caller');
  const { ctx, registrations } = host((receivedAgent, signal) => {
    assert.equal(receivedAgent, agent);
    assert.equal(signal, control.signal);
    entered();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  apply(ctx);
  const pending = registrations.get('strong_skill').execute({ id: 'debug' }, { agent, signal: control.signal });
  await enteredPromise;
  control.abort(reason);
  await assert.rejects(pending, error => error === reason);
});

test('directory provider failures propagate instead of falling back to the host cwd', async () => {
  const failure = new Error('Session workspace is unavailable');
  const { ctx, registrations } = host(async () => { throw failure; });
  apply(ctx);
  await assert.rejects(
    registrations.get('strong_skill').execute({ id: 'debug' }, { agent: {}, signal: new AbortController().signal }),
    error => error === failure,
  );
});

test('invalid native configuration fails before contributing prompts or tools', () => {
  for (const options of [null, [], { profile: 'unlimited' }, { maxSkillLoads: 3 }, { unknown: true }, { enhancedThinking: { get: () => 'false' } }, { toolSet: { get: () => 'all' } }]) {
    const { ctx, sections, registrations } = host();
    assert.throws(() => apply(ctx, options));
    assert.equal(sections.length, 0);
    assert.equal(registrations.size, 0);
  }
});
