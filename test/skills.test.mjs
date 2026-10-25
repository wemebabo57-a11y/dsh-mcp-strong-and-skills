import test from 'node:test';
import assert from 'node:assert/strict';
import { StrongEngine, TOOLS, BASE_TOOLS, budgetReport, buildPolicy } from '../src/engine.mjs';
import { loadSkill, selectSkills, SKILL_CATALOG } from '../src/skills.mjs';
import { resolveConfig } from '../src/config.mjs';
import { POLICY } from '../src/policy.mjs';

const balanced = resolveConfig();
const engine = new StrongEngine(process.cwd());

test('catalog and unmatched queries expose metadata without loading skill bodies', async () => {
  for (const args of [{}, { query: '' }, { query: '   ' }, { query: 'aardvark telescope porcelain' }]) {
    const result = await engine.call('strong_skill', args);
    assert.deepEqual(result.skills, SKILL_CATALOG);
    assert.equal(result.skills.length, 8);
    for (const skill of result.skills) {
      assert.deepEqual(Object.keys(skill).sort(), ['description', 'id']);
      assert.equal(Object.hasOwn(skill, 'content'), false);
    }
  }
  assert.equal((await engine.call('strong_skill', { query: 'aardvark telescope porcelain' })).matched, false);
});

test('explicit ids load exactly one complete skill and preserve its identity', async () => {
  for (const { id, description } of SKILL_CATALOG) {
    const result = await engine.call('strong_skill', { id });
    assert.equal(result.skills.length, 1);
    const [skill] = result.skills;
    assert.equal(skill.id, id);
    assert.equal(skill.description, description);
    assert.equal(typeof skill.content, 'string');
    assert.ok(skill.content.length > 80);
    assert.equal(skill.content.startsWith('---'), false, 'Frontmatter is not sent as body text');
    assert.deepEqual(skill, await loadSkill(id));
  }
});

const routingCases = [
  ['实现新增功能接口并交付', 'code-delivery'],
  ['调试报错崩溃，排查异常根因', 'debug'],
  ['拆分重构和迁移现有模块', 'refactor'],
  ['测试回归覆盖边界', 'testing'],
  ['重新设计前端界面配色与无障碍', 'frontend-design'],
  ['安全漏洞鉴权权限注入', 'security-review'],
  ['测量性能瓶颈、内存与延迟', 'performance'],
  ['调研官方文档资料和版本兼容', 'research'],
  ['IMPLEMENT a new API feature', 'code-delivery'],
  ['Debug a crash and fix the error', 'debug'],
  ['Refactor a module for migration', 'refactor'],
  ['Regression test coverage', 'testing'],
  ['Frontend CSS layout design accessibility', 'frontend-design'],
  ['Security auth vulnerability injection', 'security-review'],
  ['Performance latency memory benchmark', 'performance'],
  ['Research documentation version compatibility', 'research'],
];

test('Chinese and English task queries route to the most relevant skill', async t => {
  for (const [query, expected] of routingCases) {
    await t.test(query, async () => {
      const result = await engine.call('strong_skill', { query });
      assert.equal(result.skills.length, 1, 'Default routing loads one body');
      assert.equal(result.skills[0].id, expected);
      assert.ok(result.skills[0].content.length > 80);
      for (const alternative of result.alternatives ?? []) assert.equal(Object.hasOwn(alternative, 'content'), false);
    });
  }
});

test('ranking selects top skills, balances at two, and defaults lean to one', async () => {
  const query = 'debug crash error regression testing performance';
  const result = await engine.call('strong_skill', { query, limit: 2 });
  assert.deepEqual(result.skills.map(skill => skill.id), ['debug', 'testing']);
  assert.equal(result.alternatives[0].id, 'performance');
  assert.equal(Object.hasOwn(result.alternatives[0], 'content'), false);
  const lean = new StrongEngine(process.cwd(), { profile: 'lean' });
  const leanResult = await lean.call('strong_skill', { query, limit: 2 });
  assert.deepEqual(leanResult.skills.map(skill => skill.id), ['debug']);
  const direct = await selectSkills({ query, limit: 20 }, balanced);
  assert.equal(direct.skills.length, 2, 'The selector respects the configured body cap');
});

test('English keywords respect word boundaries and accept simple suffixes', async () => {
  for (const query of ['prefix', 'buildkite', 'authenticationish', 'fixedness', 'testament']) {
    const result = await engine.call('strong_skill', { query });
    assert.equal(result.matched, false, query);
    assert.equal(result.skills.every(skill => !Object.hasOwn(skill, 'content')), true);
  }
  assert.equal((await engine.call('strong_skill', { query: 'fixing crashes' })).skills[0].id, 'debug');
});

test('engine rejects invalid skill ids, traversal, mixed selectors and invalid limits', async () => {
  for (const id of ['unknown', '../debug', '..\\debug', '../../README.md', '/etc/passwd', 'C:\\secrets', '__proto__']) {
    await assert.rejects(engine.call('strong_skill', { id }), /Invalid id/);
  }
  for (const limit of [0, -1, 3, 1.5, '2', null]) {
    await assert.rejects(engine.call('strong_skill', { query: 'debug', limit }));
  }
  for (const args of [null, [], 'debug', { id: 4 }, { query: 7 }, { query: 'x'.repeat(501) }, { unknown: true }]) {
    await assert.rejects(engine.call('strong_skill', args));
  }
  await assert.rejects(engine.call('strong_skill', { id: 'debug', query: 'error' }), /id or query/);
  await assert.rejects(engine.call('invented_tool', {}), /Unknown tool/);
  await assert.rejects(loadSkill('../debug'), /Unknown skill/);
});

test('raw argument validation rejects keys inherited from Object.prototype', async () => {
  for (const key of ['toString', 'constructor', '__proto__']) {
    const args = JSON.parse(`{"${key}":true}`);
    await assert.rejects(engine.call('strong_skill', args), /Unknown argument/);
  }
});

test('cancelled skill calls never return a successful body', async () => {
  const control = new AbortController();
  const reason = new Error('Skill cancelled');
  control.abort(reason);
  await assert.rejects(engine.call('strong_skill', { id: 'debug' }, { signal: control.signal }), error => error === reason);
  await assert.rejects(loadSkill('debug', control.signal), error => error === reason);
});

test('resident budget contains only the selected tool schemas and zero complete skill bodies', async () => {
  const budget = budgetReport();
  assert.equal(budget.residentTools, 4);
  assert.equal(budget.residentTools, TOOLS.length);
  assert.equal(budget.residentSkillBodies, 0);
  const policy = buildPolicy();
  assert.equal(budget.policyChars, policy.length);
  assert.equal(budget.toolSchemaChars, JSON.stringify(TOOLS).length);
  assert.ok(budget.toolSchemaChars < 5000, 'Gateway schemas should remain compact');
  assert.ok(budget.approximateResidentTokens < 1600, 'Resident instructions should not grow into a skill dump');
  const compact = budgetReport({ toolSet: 'compact', enhancedThinking: false });
  assert.equal(compact.residentTools, BASE_TOOLS.length);
  assert.equal(compact.policyChars, POLICY.length);
  assert.equal(compact.toolSchemaChars, JSON.stringify(BASE_TOOLS).length);
  assert.equal(budget.maxSkillLoads, 2);
  assert.equal(budgetReport({ profile: 'lean' }).maxSkillLoads, 1);
  for (const { id } of SKILL_CATALOG) {
    const { content } = await loadSkill(id);
    assert.equal(policy.includes(content), false);
    assert.equal(JSON.stringify(TOOLS).includes(content), false);
  }
});
