import test from 'node:test';
import assert from 'node:assert/strict';
import { boundResult, budgetReport, StrongEngine, BASE_TOOLS, TOOLS, toolsForConfig, buildPolicy } from '../src/engine.mjs';
import { SHELL_TOOL, buildShellPolicy } from '../src/shell-tool.mjs';
import { resolveConfig } from '../src/config.mjs';
import { snapshotConfig } from '../src/native-config.mjs';
import { POLICY, SHELL_ROUTE, estimateTokens } from '../src/policy.mjs';
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
    assert.equal(report.residentTools, 6);
    assert.equal(report.residentSkillBodies, 0);
    assert.ok(report.approximateResidentTokens < 1600);
  }
  assert.equal(resolveConfig({ profile: undefined }).profile, 'balanced');
  for (const config of [{ profile: 'missing' }, { profile: null }, { profile: ['lean'] }, { maxSkillLoads: 3 }, { maxFiles: Infinity }, { maxOutputChars: 0 }, { maxFileBytes: 99999999 }, { enhancedThinking: 'false' }, { thinkingLevel: 'unbounded' }, { clarification: 'always' }, { modelPreset: 'deepseek-flash-api' }, { toolSet: 'all' }, { token: 'secret' }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => resolveConfig(config));
  }
  assert.ok(new StrongEngine('.') instanceof StrongEngine); // No network or project reads during construction.
});

test('legacy bashTool migrates to the optional shell while explicit shellTool wins', () => {
  const config = resolveConfig({ bashTool: true });
  assert.equal(config.shellTool, true);
  assert.equal(config.bashTool, undefined);
  assert.equal(config.toolSet, 'expanded');
  assert.equal(resolveConfig({ bashTool: true, shellTool: false }).shellTool, false);
  assert.throws(() => resolveConfig({ bashTool: 'yes' }), /bashTool/);
  assert.throws(() => resolveConfig({ shellTool: 'yes' }), /shellTool/);
  assert.throws(() => resolveConfig({ shellBackend: 'fish' }), /shellBackend/);
  assert.throws(() => resolveConfig({ shellPath: 'x'.repeat(1001) }), /shellPath/);
  assert.throws(() => resolveConfig({ wslDistro: 'x'.repeat(101) }), /wslDistro/);
});

test('expanded and compact budgets account for the active policy and schemas', async () => {
  const expanded = budgetReport();
  const compactOptions = { toolSet: 'compact', enhancedThinking: false };
  const compact = budgetReport(compactOptions);
  assert.deepEqual(toolsForConfig(), TOOLS);
  assert.deepEqual(toolsForConfig(compactOptions), BASE_TOOLS);
  assert.deepEqual(toolsForConfig({ shellTool: true }), [...TOOLS, SHELL_TOOL]);
  assert.deepEqual(toolsForConfig({ ...compactOptions, shellTool: true }), [...BASE_TOOLS, SHELL_TOOL]);
  const withShell = budgetReport({ shellTool: true, shellBackend: 'git-bash' });
  assert.equal(withShell.residentTools, 7);
  assert.match(buildPolicy({ shellTool: true, shellBackend: 'git-bash' }), /strong_shell/);
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

test('strong tools are the default route and an enabled shell is routed, not offered', () => {
  const base = buildPolicy();
  // The routing block opens the policy so the preference is read before any other rule.
  assert.ok(base.startsWith(POLICY));
  assert.match(POLICY, /工具选择：本插件工具优先/);
  assert.match(POLICY, /技能先用 strong_skill/);
  assert.match(POLICY, /仓库上下文用 strong_context/);
  assert.match(base, /代码用 strong_code\/strong_review/);
  assert.match(base, /联网先 strong_web search 再 open/);
  // Never advertise a tool the active configuration does not register.
  assert.doesNotMatch(base, /strong_shell/);
  assert.doesNotMatch(buildPolicy({ toolSet: 'compact' }), /strong_code|strong_review|strong_web|strong_browse|strong_shell/);
  // An enabled shell is an imperative route, placed before the descriptive block
  // that explains permissions, and it forbids silently falling back.
  const shellBlock = buildShellPolicy({ shellBackend: 'git-bash' });
  const withShell = buildPolicy({ shellTool: true, shellBackend: 'git-bash' });
  assert.ok(withShell.includes(SHELL_ROUTE));
  assert.ok(withShell.includes(shellBlock));
  // The route is read before the descriptive permission block that follows it.
  assert.ok(withShell.indexOf(SHELL_ROUTE) < withShell.indexOf(shellBlock));
  assert.match(withShell, /所有 shell 命令.*直接用 strong_shell 执行/);
  assert.match(withShell, /不要改用宿主原生 bash\/pwsh/);
  assert.match(withShell, /strong_shell 报错时按提示调整/);
});

test('resident policy text stays inside the published token ceiling', () => {
  const expanded = budgetReport();
  assert.ok(expanded.policyChars <= 600, String(expanded.policyChars));
  assert.ok(estimateTokens(buildPolicy()) <= 480, String(estimateTokens(buildPolicy())));
  assert.ok(expanded.approximateResidentTokens < 1500, String(expanded.approximateResidentTokens));
  assert.ok(budgetReport({ toolSet: 'compact' }).approximateResidentTokens < 850);
});

test('fresh config snapshots update budgets and profile limits without retaining stale defaults', () => {
  const state = { profile: 'balanced', enhancedThinking: true, toolSet: 'expanded', maxFiles: undefined };
  const references = Object.fromEntries(Object.keys(state).map(key => [key, { get: () => state[key] }]));
  const initial = budgetReport(snapshotConfig(references));
  assert.equal(initial.maxResultChars, 6000);
  assert.equal(initial.maxFiles, 800);
  assert.equal(initial.residentTools, 6);
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

test('web, browser and builtin shell are opt-in and independently gated', () => {
  const names = list => list.map(tool => tool.name);
  assert.ok(names(TOOLS).includes('strong_web'));
  assert.ok(names(TOOLS).includes('strong_browse'));
  assert.equal(names(toolsForConfig({ toolSet: 'compact' })).includes('strong_web'), false);
  assert.equal(names(toolsForConfig({ toolSet: 'compact', webTool: true })).includes('strong_web'), false);
  assert.equal(names(toolsForConfig({ webTool: false })).includes('strong_web'), false);
  assert.equal(names(toolsForConfig({ browseTool: 'off' })).includes('strong_browse'), false);
  assert.equal(names(toolsForConfig({ webTool: true, browseTool: 'auto', toolSet: 'expanded' })).filter(name => name === 'strong_web' || name === 'strong_browse').length, 2);
  assert.match(buildPolicy({}), /strong_web/);
  assert.match(buildPolicy({}), /strong_browse/);
  assert.doesNotMatch(buildPolicy({ webTool: false, browseTool: 'off' }), /strong_web|strong_browse/);
  assert.equal(resolveConfig({ shellBackend: 'builtin' }).shellBackend, 'builtin');
  assert.throws(() => resolveConfig({ browseTool: 'always' }), /browseTool/);
  assert.throws(() => resolveConfig({ ptcMode: 'always' }), /ptcMode/);
  assert.throws(() => resolveConfig({ webTool: 'yes' }), /webTool/);
  assert.throws(() => resolveConfig({ browserPath: 'x'.repeat(1001) }), /browserPath/);
});
