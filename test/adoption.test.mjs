import test from 'node:test';
import assert from 'node:assert/strict';
import { installShellAdoption } from '../src/adoption.mjs';

function harness(config = { shellTool: true }, visible = ['strong_shell']) {
  let listener;
  const ctx = {
    on(event, fn) { assert.equal(event, 'tools/pre-execute'); listener = fn; },
    tools: { schemas() { return visible.map(name => ({ name })); } },
  };
  installShellAdoption(ctx, () => config);
  const run = (name, agent = {}) => {
    let allowed = false;
    const decision = listener({ name, agent }, () => { allowed = true; return { kind: 'allow' }; });
    return decision.kind === 'deny' ? 'deny' : allowed ? 'allow' : 'none';
  };
  return { run };
}

test('every native one-shot shell call is redirected while strong_shell is enabled', () => {
  const { run } = harness();
  assert.equal(run('bash'), 'deny');
  assert.equal(run('pwsh'), 'deny');
  assert.equal(run('read'), 'allow');
  assert.equal(run('strong_shell'), 'allow');
  assert.equal(run('bash'), 'deny', 'the route stays enforced after strong_shell runs');
});

test('the gate stays out of the way when the shell is disabled or not visible', () => {
  assert.equal(harness({ shellTool: false }).run('bash'), 'allow');
  assert.equal(harness({ shellTool: true }, ['strong_context']).run('bash'), 'allow');
  assert.equal(harness({ shellTool: true }).run('bash', null), 'allow');
});
