// Integration check against published DSH modules, without a server, credentials,
// model inference, user profiles, or a bundled/imitated event dispatcher.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../src/index.mjs';
import { buildPolicy } from '../src/engine.mjs';
import { POLICY_SECTION } from '../src/native-policy.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--runtime') throw new Error('Usage: node scripts/check-host.mjs --runtime <isolated DSH installation directory>');
const require = createRequire(pathToFileURL(join(resolve(args[1]), 'package.json')));
const host = name => import(pathToFileURL(require.resolve(name)).href);
const { Context } = await host('@deepseek-ai/cordis');
const { SystemPrompt, renderPrompt } = await host('@deepseek-ai/dsh-system-prompt');
const { createScope } = await host('@deepseek-ai/dsh-scope');
const { assembleContextFor, installModelSelection } = await host('@deepseek-ai/dsh-agent');
const ctx = new Context();
new SystemPrompt(ctx, {});
const tools = [];
ctx.provide('tools', { register(tool) { tools.push(tool); } });
ctx.provide('workingDirectory', { defaultDirectory: process.cwd() });
const state = { weNeedToThinking: true, enhancedThinking: true, unlimitedTokens: false };
apply(ctx, Object.fromEntries(Object.keys(state).map(key => [key, { get: () => state[key] }])));
const scopes = [], disposers = [];
function agent(id, selected, staleModel = 'other') {
  const agent = { id, options: { provider: 'initial', model: staleModel } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  scopes.push(scope);
  const selection = { current: selected };
  disposers.push(installModelSelection(agent.ctx, selection));
  return { agent, selection };
}
const checks = [];
async function verify(label, entry, expectedSelection, active) {
  const context = assembleContextFor(entry.agent);
  const assembly = await ctx.systemPrompt.assemble(context);
  const policies = assembly.sections.filter(section => section.name === POLICY_SECTION);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].text, buildPolicy(state, { selection: expectedSelection }), label);
  assert.equal(policies[0].text.includes('协作目标引导'), active, label);
  assert.ok(renderPrompt(assembly).includes(policies[0].text), 'The final system prompt must contain the accepted policy');
  assert.equal(assembly.variables.model, expectedSelection.model);
  checks.push(label);
}
try {
  const deepseek = { provider: 'proxy', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' };
  const other = { provider: 'deepseek-official', model: 'unrelated-model' };
  const first = agent('strong-host-first', deepseek);
  const second = agent('strong-host-second', other, 'deepseek-stale-options');
  await verify('rc.3-compatible model variables activate all-model guidance in the final prompt', first, deepseek, true);
  await verify('a different agent also receives all-model guidance without inheriting a DeepSeek selection', second, other, true);
  first.selection.current = other;
  await verify('switching the current model keeps all-model guidance', first, other, true);
  first.selection.current = deepseek;
  state.enhancedThinking = false;
  await verify('the live enhanced-thinking switch keeps all-model guidance', first, deepseek, true);
  state.enhancedThinking = true;
  state.unlimitedTokens = true;
  await verify('unlimited token mode adds its policy without changing all-model guidance', first, deepseek, true);
  const unlimitedAssembly = await ctx.systemPrompt.assemble(assembleContextFor(first.agent));
  assert.match(unlimitedAssembly.sections.find(section => section.name === POLICY_SECTION).text, /无限 token 模式/);
  checks.push('unlimited token mode policy is present in the final prompt');
  state.unlimitedTokens = false;
  state.weNeedToThinking = false;
  await verify('the live mode switch removes the guidance', first, deepseek, false);
  state.weNeedToThinking = true;
  await verify('reenabling uses the current route', first, deepseek, true);
  first.agent.ctx.systemPrompt.section({ name: 'complete-user-prompt', order: 1, text: 'An explicit complete prompt', complete: true });
  const complete = await ctx.systemPrompt.assemble(assembleContextFor(first.agent));
  assert.equal(renderPrompt(complete), 'An explicit complete prompt', 'The plugin must respect a complete user-owned prompt');
  checks.push('complete user prompts retain host precedence');
  assert.equal(tools.length, 4);
  console.log(JSON.stringify({ hostVersion: require('@deepseek-ai/dsh-agent/package.json').version, checks, inferenceRequests: 0 }, null, 2));
} finally {
  for (const dispose of disposers.reverse()) dispose();
  for (const scope of scopes.reverse()) scope.dispose();
}
