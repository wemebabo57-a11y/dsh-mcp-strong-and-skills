import test from 'node:test';
import assert from 'node:assert/strict';
import { installSettingsPolicy, registerSettingsHost } from '../src/settings-host.mjs';

test('settings presentation is optional for headless/stdio contexts', () => {
  assert.equal(registerSettingsHost, installSettingsPolicy);
  assert.equal(installSettingsPolicy({}), undefined);
  assert.doesNotThrow(() => installSettingsPolicy({ inject(_keys, callback) { callback({}); } }));
});

test('settings presentation belongs to the plugin owner fiber and disposes with the injected scope', () => {
  const owner = { uid: 'strong-owner' };
  const child = { uid: 'settings-injection' };
  let activate;
  let disposed = 0;
  const calls = [];
  const effects = [];
  const token = {};
  const ctx = {
    fiber: owner,
    inject(keys, callback) {
      assert.deepEqual(keys, ['settings']);
      activate = callback;
      return token;
    },
  };
  assert.equal(installSettingsPolicy(ctx), token);
  assert.deepEqual(calls, []);
  activate({
    fiber: child,
    settings: { configure(policy, fiber) { calls.push({ policy, fiber }); return () => { disposed += 1; }; } },
    effect(start) { effects.push(start()); },
  });
  assert.deepEqual(calls, [{ policy: { auto: false }, fiber: owner }]);
  effects.pop()();
  assert.equal(disposed, 1);
});
