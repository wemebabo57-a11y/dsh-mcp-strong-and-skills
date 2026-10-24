import test from 'node:test';
import assert from 'node:assert/strict';
import { boundResult, budgetReport, StrongEngine } from '../src/engine.mjs';
import { resolveConfig } from '../src/config.mjs';
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
    assert.equal(report.residentTools, 2);
    assert.equal(report.residentSkillBodies, 0);
    assert.ok(report.approximateResidentTokens < 1600);
  }
  assert.equal(resolveConfig({ profile: undefined }).profile, 'balanced');
  for (const config of [{ profile: 'missing' }, { profile: null }, { profile: ['lean'] }, { maxSkillLoads: 3 }, { maxFiles: Infinity }, { maxOutputChars: 0 }, { maxFileBytes: 99999999 }, { token: 'secret' }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => resolveConfig(config));
  }
  assert.ok(new StrongEngine('.') instanceof StrongEngine); // No network or project reads during construction.
});

test('CLI rejects missing values and duplicate options', () => {
  assert.deepEqual(parseArgs(['skill', '--id', 'debug']), { command: 'skill', options: { id: 'debug' } });
  assert.throws(() => parseArgs(['serve', '--root']));
  assert.throws(() => parseArgs(['serve', '--root', '.', '--root', 'src']));
});
