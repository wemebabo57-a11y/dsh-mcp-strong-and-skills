import test from 'node:test';
import assert from 'node:assert/strict';
import { PTC_GUIDE, buildPtcPolicy } from '../src/ptc.mjs';
import { buildPolicy } from '../src/engine.mjs';

test('PTC guide is short, concrete and only active in PTC mode', () => {
  assert.ok(PTC_GUIDE.length > 80);
  assert.ok(PTC_GUIDE.length < 400);
  for (const fact of ['run_code', 'Promise.all', 'close', '整个 JSON']) assert.match(PTC_GUIDE, new RegExp(fact.replace('.', '\\.')));
  assert.equal(buildPtcPolicy({ ptcMode: 'auto' }, { available: false }), '');
  assert.equal(buildPtcPolicy({ ptcMode: 'auto' }, { available: true }), PTC_GUIDE);
  assert.equal(buildPtcPolicy({}, { available: true }), PTC_GUIDE);
  assert.equal(buildPtcPolicy({ ptcMode: 'on' }, { available: false }), PTC_GUIDE);
  assert.equal(buildPtcPolicy({ ptcMode: 'off' }, { available: true }), '');
  assert.throws(() => buildPtcPolicy({ ptcMode: 'maybe' }), /Invalid ptcMode/);
});

test('engine policy wires PTC detection without leaking the guide into normal sessions', () => {
  assert.match(buildPolicy({ ptcMode: 'on' }), /PTC 模式/);
  assert.doesNotMatch(buildPolicy({ ptcMode: 'auto' }, { ptcAvailable: false }), /PTC 模式/);
  assert.match(buildPolicy({ ptcMode: 'auto' }, { ptcAvailable: true }), /PTC 模式/);
  assert.doesNotMatch(buildPolicy({ ptcMode: 'off' }, { ptcAvailable: true }), /PTC 模式/);
});
