import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolveConfig } from '../src/config.mjs';
import { BASE_TOOLS, StrongEngine, budgetReport, buildPolicy, toolsForConfig } from '../src/engine.mjs';
import { createTailCollector, decodeBytes } from '../src/stream-output.mjs';
import { WAIT_SHORTCUTS, WaitGate } from '../src/browse.mjs';

// A config large enough that re-parsing it per call dominates the measurement:
// 50 project notes of 1200 characters plus 20 library entries (~64 KB).
const notes = 'x'.repeat(1200);
const knowledgeConfig = JSON.stringify({
  projects: Array.from({ length: 50 }, (_, index) => ({ root: 'F:/repo/p' + index, name: 'p' + index, notes })),
  libraries: Array.from({ length: 20 }, (_, index) => ({
    id: 'lib' + index, name: 'lib' + index, kind: 'github',
    location: 'https://github.com/owner/repo' + index, scope: 'global', ref: 'main',
  })),
});

const elapsed = (work, iterations) => {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) work(index);
  return performance.now() - started;
};
const bestOf = (work, iterations, runs = 3) => Math.min(...Array.from({ length: runs }, () => elapsed(work, iterations)));

test('a frozen resolved config is reused instead of re-parsed on every call', () => {
  const options = { knowledgeConfig };
  const resolved = resolveConfig(options);
  toolsForConfig(resolved);
  buildPolicy(resolved);
  budgetReport(resolved);
  const iterations = 40;
  const parseCost = bestOf(() => resolveConfig(options), iterations);
  const toolsCost = bestOf(() => toolsForConfig(resolved), iterations);
  const policyCost = bestOf(() => buildPolicy(resolved), iterations);
  assert.ok(toolsCost * 5 < parseCost,
    'cached toolsForConfig took ' + toolsCost.toFixed(2) + 'ms for ' + iterations + ' calls, re-resolving took ' + parseCost.toFixed(2) + 'ms');
  assert.ok(policyCost * 3 < parseCost,
    'cached buildPolicy took ' + policyCost.toFixed(2) + 'ms for ' + iterations + ' calls, re-resolving took ' + parseCost.toFixed(2) + 'ms');
  assert.deepEqual(toolsForConfig(resolved), toolsForConfig(options));
  assert.equal(buildPolicy(resolved), buildPolicy(options));
  assert.deepEqual(budgetReport(resolved), budgetReport(options));
});

test('mutable options are still resolved on every call', () => {
  const options = { knowledgeConfig };
  const resolved = resolveConfig(options);
  const copy = { ...resolved };
  assert.deepEqual(toolsForConfig(copy), toolsForConfig(resolved));
  copy.browseTool = 'off';
  assert.ok(!toolsForConfig(copy).some(tool => tool.name === 'strong_browse'), 'an edited copy must lose strong_browse');
  copy.toolSet = 'compact';
  assert.deepEqual(toolsForConfig(copy), BASE_TOOLS);
  const live = { maxFiles: 20 };
  assert.deepEqual(toolsForConfig(live), toolsForConfig());
  live.toolSet = 'compact';
  assert.deepEqual(toolsForConfig(live), BASE_TOOLS);
  const before = buildPolicy(resolved);
  options.knowledgeConfig = '';
  assert.equal(buildPolicy(resolved), before, 'a resolved revision must not change when its source object does');
  assert.ok(buildPolicy(options).length < before.length, 'clearing the knowledge config must shrink the policy');
});

test('complete configs are still validated once per revision', () => {
  const resolved = resolveConfig({});
  assert.throws(() => toolsForConfig(Object.freeze({ ...resolved, maxFiles: 3 })), /maxFiles/);
  assert.throws(() => toolsForConfig(Object.freeze({ ...resolved, bogus: true })), /Unknown config/);
  assert.throws(() => toolsForConfig(Object.freeze({ toolSet: 'nope' })), /toolSet/);
  assert.throws(() => new StrongEngine('.', Object.freeze({ ...resolved, profile: 'nope' })), /profile/);
  // The knowledge JSON is memoized, not skipped, so a broken one still throws.
  assert.throws(() => toolsForConfig(Object.freeze({ ...resolved, knowledgeConfig: '{not json' })), /Invalid knowledge\/project JSON/);
});

test('the engine keeps the resolved revision it was built from', async () => {
  const resolved = resolveConfig({ knowledgeConfig });
  const engine = new StrongEngine('.', resolved);
  assert.equal(engine.config, resolved);
  assert.deepEqual(toolsForConfig(engine.config), toolsForConfig(resolved));
  await assert.rejects(engine.call('strong_missing', {}), /Unknown tool/);
  const compact = new StrongEngine('.', { toolSet: 'compact' });
  await assert.rejects(compact.call('strong_web', {}), /Unknown tool/);
});

// The collector replaced by the ring buffer, kept as the reference behavior.
function referenceTextCollector(limit = 64 * 1024) {
  const total = Math.max(1024, limit);
  const headLimit = Math.floor(total / 4);
  const tailLimit = total - headLimit;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let bytes = 0;
  return {
    push(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (!value.length) return;
      bytes += value.length;
      if (head.length < headLimit) {
        const take = Math.min(headLimit - head.length, value.length);
        head = Buffer.concat([head, value.subarray(0, take)]);
        tail = Buffer.concat([tail, value.subarray(take)]);
      } else tail = Buffer.concat([tail, value]);
      if (tail.length > tailLimit) tail = tail.subarray(tail.length - tailLimit);
    },
    read() {
      const truncated = bytes > headLimit + tailLimit;
      const omitted = Math.max(0, bytes - head.length - tail.length);
      return {
        text: [
          decodeBytes(head, { trimTail: true }),
          truncated ? '\n…[truncated: 已省略 ' + omitted + ' 字节，保留开头与末尾]…\n' : '',
          decodeBytes(tail, { trimLead: true }),
        ].join(''),
        truncated, bytes, omitted,
      };
    },
  };
}

test('the ring collector returns exactly what the concatenating collector returned', () => {
  let seed = 20241112;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const samples = [
    Buffer.from('纯文本输出 ✓ '),
    Buffer.from([0xff, 0xfe, 0x00, 0x41]),
    Buffer.from('plain ascii line\n'),
    Buffer.from([0xe4, 0xb8]),
  ];
  for (const limit of [1024, 4096, 65536]) {
    for (let round = 0; round < 25; round += 1) {
      const expected = referenceTextCollector(limit);
      const actual = createTailCollector(limit);
      const chunks = Math.floor(random() * 24);
      for (let index = 0; index < chunks; index += 1) {
        const pick = random();
        let chunk;
        if (pick < 0.12) chunk = Buffer.alloc(0);
        else if (pick < 0.3) chunk = Buffer.alloc(Math.floor(random() * limit * 2) + 1, 0x61 + (index % 26));
        else if (pick < 0.4) chunk = '文字' + index;
        else {
          const base = samples[index % samples.length];
          chunk = Buffer.concat(Array.from({ length: Math.floor(random() * 40) + 1 }, () => base));
        }
        expected.push(chunk);
        actual.push(chunk);
        if (index % 4 === 0) assert.deepEqual(actual.read(), expected.read());
      }
      assert.deepEqual(actual.read(), expected.read());
    }
  }
});

test('the ring collector copies each byte once instead of per chunk', () => {
  const chunk = Buffer.from('line of shell output 0123456789 abcdef\n'.repeat(13).slice(0, 512));
  const concatenating = () => {
    const collector = referenceTextCollector();
    for (let index = 0; index < 512; index += 1) collector.push(chunk);
    return collector.read();
  };
  const ring = () => {
    const collector = createTailCollector();
    for (let index = 0; index < 512; index += 1) collector.push(chunk);
    return collector.read();
  };
  assert.deepEqual(ring(), concatenating());
  const slow = bestOf(concatenating, 1, 3);
  const fast = bestOf(ring, 1, 3);
  assert.ok(fast * 3 < slow,
    'ring collector took ' + fast.toFixed(2) + 'ms, concatenating collector took ' + slow.toFixed(2) + 'ms for 512 chunks of 512 B');
});

test('a wait that runs alone still sleeps for its duration', async () => {
  const gate = new WaitGate();
  assert.equal(gate.active, false);
  const outcome = await gate.wait(120);
  assert.equal(outcome.interrupted, false);
  assert.ok(outcome.waitedMs >= 100, 'waited ' + outcome.waitedMs + 'ms');
  assert.ok(outcome.waitedMs < 2000, 'waited ' + outcome.waitedMs + 'ms');
  assert.equal(gate.active, false);
});

test('a queued snapshot or screenshot wakes an in-flight wait', async () => {
  const gate = new WaitGate();
  const waiting = gate.wait(5000);
  assert.equal(gate.active, true);
  const started = performance.now();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(gate.wake(), true);
  const outcome = await waiting;
  const elapsedMs = performance.now() - started;
  assert.equal(outcome.interrupted, true);
  assert.ok(outcome.waitedMs < 1000, 'interrupted wait reported ' + outcome.waitedMs + 'ms');
  assert.ok(elapsedMs < 1000, 'wake took ' + elapsedMs.toFixed(1) + 'ms');
  assert.equal(gate.active, false);
  assert.equal(gate.wake(), false);
  assert.deepEqual([...WAIT_SHORTCUTS], ['snapshot', 'screenshot']);
});

test('a newer wait replaces the pending one and zero waits resolve immediately', async () => {
  const gate = new WaitGate();
  const first = gate.wait(5000);
  const second = gate.wait(5000);
  assert.equal((await first).interrupted, true);
  gate.wake();
  assert.equal((await second).interrupted, true);
  assert.deepEqual(await gate.wait(0), { waitedMs: 0, interrupted: false });
});

test('aborting a wait rejects with the abort reason and clears the gate', async () => {
  const gate = new WaitGate();
  const controller = new AbortController();
  const waiting = gate.wait(5000, controller.signal);
  controller.abort(new Error('stop now'));
  await assert.rejects(waiting, /stop now/);
  assert.equal(gate.active, false);
  const plain = new AbortController();
  const second = gate.wait(5000, plain.signal);
  plain.abort();
  await assert.rejects(second, error => error.name === 'AbortError');
  assert.equal(gate.active, false);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(gate.wait(5000, pre.signal), error => error.name === 'AbortError');
});
