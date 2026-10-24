import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply, inject, name } from '../src/index.mjs';
import { TOOLS } from '../src/engine.mjs';
import { POLICY } from '../src/policy.mjs';

function host(ensure = async () => { throw new Error('Unexpected directory lookup'); }, defaultDirectory = process.cwd()) {
  const sections = [];
  const registrations = new Map();
  const ctx = {
    systemPrompt: { section: section => sections.push(section) },
    tools: { register: definition => {
      assert.equal(registrations.has(definition.name), false, 'Tool names must be unique');
      registrations.set(definition.name, definition);
      return () => registrations.delete(definition.name);
    } },
    workingDirectory: { ensure, defaultDirectory },
  };
  return { ctx, sections, registrations };
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

test('native plugin registers the compact policy and both canonical tools', () => {
  const { ctx, sections, registrations } = host();
  apply(ctx);
  assert.equal(name, 'strong-skills');
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'workingDirectory']);
  assert.deepEqual(sections, [{ name: 'strong-skills:policy', order: 650, text: POLICY, interpolate: false }]);
  assert.deepEqual([...registrations.keys()], TOOLS.map(tool => tool.name));
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
  for (const options of [null, [], { profile: 'unlimited' }, { maxSkillLoads: 3 }, { unknown: true }]) {
    const { ctx, sections, registrations } = host();
    assert.throws(() => apply(ctx, options));
    assert.equal(sections.length, 0);
    assert.equal(registrations.size, 0);
  }
});
