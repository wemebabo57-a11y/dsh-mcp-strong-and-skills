import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { resolveConfig } from '../src/config.mjs';
import { createSettingsController, SETTINGS_FIELDS } from '../client/controller.mjs';
import { createClientPlugin } from '../client/index.mjs';
import { EN, ZH } from '../client/view.mjs';

const defaults = () => ({ ...resolveConfig(), allowBrandColors: false, brandIntent: '' });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(initial = { status: 'ready', writable: true, value: defaults() }) {
  let snapshot = { revision: 0, ...initial };
  const listeners = new Set();
  const writes = [];
  const form = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    publish(next) { snapshot = { ...snapshot, ...next }; for (const fn of [...listeners]) fn(); },
    async set(field, value) {
      writes.push({ field, value });
      form.publish({ value: { ...snapshot.value, [field]: value }, revision: snapshot.revision + 1 });
      return true;
    },
    async mutate(ops) {
      writes.push({ ops });
      form.publish({ value: defaults(), revision: snapshot.revision + 1 });
      return true;
    },
  };
  return { form, writes, listeners };
}

test('controller shows loading and read-only state without making persistence writes', async () => {
  const f = fixture({ status: 'loading', writable: false, value: undefined });
  const controller = createSettingsController(f.form);
  const changes = [];
  const off = controller.store.subscribe(() => { changes.push(controller.store.getSnapshot()); });
  assert.equal(controller.store.getSnapshot().status, 'loading');
  assert.equal(await controller.set('enhancedThinking', false), false);
  f.form.publish({ status: 'ready', writable: false, value: defaults() });
  assert.equal(controller.store.getSnapshot().value.enhancedThinking, true);
  assert.equal(await controller.reset(), false);
  assert.deepEqual(f.writes, []);
  assert.equal(changes.length, 1);
  off();
  controller.dispose();
  assert.equal(f.listeners.size, 0);
});

test('saving enhancedThinking adopts only the Host-accepted value and exposes pending state', async () => {
  const f = fixture();
  let settle;
  f.form.set = (field, value) => new Promise(resolve => { settle = () => {
    f.form.publish({ value: { ...f.form.getSnapshot().value, [field]: value } });
    resolve(true);
  }; });
  const controller = createSettingsController(f.form);
  const saved = controller.set('enhancedThinking', false);
  assert.equal(controller.store.getSnapshot().saving, true);
  assert.equal(controller.store.getSnapshot().value.enhancedThinking, true);
  settle();
  assert.equal(await saved, true);
  assert.equal(controller.store.getSnapshot().saving, false);
  assert.equal(controller.store.getSnapshot().value.enhancedThinking, false);
  assert.equal(controller.store.getSnapshot().notice, 'saved');
  controller.dispose();
});

test('host refusal/reconnect updates and transport errors preserve accepted settings', async () => {
  const f = fixture();
  const controller = createSettingsController(f.form);
  f.form.set = async () => false;
  assert.equal(await controller.set('thinkingLevel', 'deep'), false);
  assert.equal(controller.store.getSnapshot().value.thinkingLevel, 'balanced');
  assert.equal(controller.store.getSnapshot().error, 'refused');
  f.form.publish({ value: { ...defaults(), thinkingLevel: 'deep', enhancedThinking: false } });
  assert.equal(controller.store.getSnapshot().value.thinkingLevel, 'deep');
  f.form.set = async () => { throw new Error('network down'); };
  assert.equal(await controller.set('enhancedThinking', true), false);
  assert.equal(controller.store.getSnapshot().error, 'failed');
  assert.equal(controller.store.getSnapshot().value.enhancedThinking, false);
  controller.dispose();
});

test('invalid UI values never reach the Host and reset clears overrides atomically', async () => {
  const f = fixture();
  const controller = createSettingsController(f.form);
  for (const [field, value] of [['thinkingLevel', 'extreme'], ['enhancedThinking', 'false'], ['brandIntent', 'x'.repeat(201)], ['maxSkillLoads', 3], ['maxFiles', 1.5]]) {
    assert.equal(await controller.set(field, value), false);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(await controller.reset(), true);
  assert.deepEqual(f.writes[0], { ops: SETTINGS_FIELDS.map(field => ({ op: 'unset', path: [field] })) });
  controller.dispose();
});

test('optional numeric overrides display the same profile defaults as the runtime', async () => {
  const raw = { ...defaults() };
  for (const field of ['maxOutputChars', 'maxFiles', 'maxFileBytes', 'maxSkillLoads']) delete raw[field];
  const f = fixture({ status: 'ready', writable: true, value: raw });
  const controller = createSettingsController(f.form);
  for (const profile of ['lean', 'balanced', 'thorough']) {
    f.form.publish({ value: { ...raw, profile } });
    const display = controller.store.getSnapshot().value;
    const runtime = resolveConfig({ profile });
    for (const field of ['maxOutputChars', 'maxFiles', 'maxFileBytes', 'maxSkillLoads']) assert.equal(display[field], runtime[field]);
  }
  f.form.publish({ value: { ...raw, profile: 'lean', maxFiles: 45 } });
  assert.equal(controller.store.getSnapshot().value.maxFiles, 45);
  assert.equal(f.writes.length, 0);
  controller.dispose();
});

test('disposing a surface unsubscribes immediately and suppresses in-flight UI notifications', async () => {
  const f = fixture();
  let finish;
  f.form.set = () => new Promise(resolve => { finish = resolve; });
  const controller = createSettingsController(f.form);
  let notifications = 0;
  controller.store.subscribe(() => { notifications += 1; });
  const write = controller.set('toolSet', 'compact');
  assert.equal(notifications, 1);
  controller.dispose();
  controller.dispose();
  assert.equal(f.listeners.size, 0);
  finish(true);
  await write;
  f.form.publish({ value: { ...defaults(), toolSet: 'compact' } });
  assert.equal(notifications, 1);
  assert.equal(await controller.set('enhancedThinking', false), false);
});

const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter(child => child !== null && child !== undefined) });
function descendants(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...tree.children.flatMap(descendants)];
}
function control(tree, suffix) {
  return descendants(tree).find(node => node.props.id?.endsWith(`-${suffix}`));
}

function pluginFixture(form, plugin = createClientPlugin({ createElement: h })) {
  const effects = [];
  const registrations = new Map();
  let serve;
  let remove;
  const ctx = {
    effect(start) { const dispose = start(); if (typeof dispose === 'function') effects.push(dispose); },
    locale: {
      register(namespace, dictionaries) {
        assert.equal(namespace, 'settings.strongSkills');
        assert.equal(dictionaries.zh.enhanced, '增强思考');
        return () => {};
      },
      bind: () => key => EN[key] ?? key,
    },
    configForms: {
      get(entryId) { assert.equal(entryId, 'strong-skills'); return form; },
      whileServed(entries, register) {
        assert.deepEqual([...entries], ['strong-skills']);
        serve = () => { remove = register(new Set(entries)); };
        return () => { remove?.(); };
      },
    },
    slots: {
      inject(_slot, register) { return register(); },
      register(options, component) {
        registrations.set(options.name, { options, component });
        return () => { registrations.delete(options.name); };
      },
    },
  };
  plugin.apply(ctx);
  return {
    registrations, serve: () => serve(),
    render(name = 'settings.section') {
      const { options, component } = registrations.get(name);
      const face = options.inject();
      return component({ ...face, useStrongSettings: selector => selector(face.hooks.strongSettings.getSnapshot()), t: key => EN[key] ?? key });
    },
    dispose() { for (const dispose of effects.reverse()) dispose(); },
  };
}

test('actual plugin registers dedicated Settings and bundle slots only while Host settings are served', () => {
  const f = fixture();
  const ui = pluginFixture(f.form);
  assert.equal(ui.registrations.size, 0);
  ui.serve();
  const settings = ui.registrations.get('settings.section');
  const bundle = ui.registrations.get('plugins.bundle.config');
  assert.equal(settings.options.id, 'strong-skills');
  assert.equal(settings.options.label(), 'Strong Skills');
  assert.equal(bundle.options.key, 'dsh-strong-skills');
  assert.notEqual(settings.options.inject().surfaceId, bundle.options.inject().surfaceId);
  const tree = ui.render();
  for (const field of SETTINGS_FIELDS) assert.ok(control(tree, field), `missing control for ${field}`);
  ui.dispose();
  assert.equal(ui.registrations.size, 0);
  assert.equal(f.listeners.size, 0);
});

test('enhanced thinking and model controls persist through the injected Host form, with dependent controls disabled', async () => {
  const f = fixture();
  const ui = pluginFixture(f.form);
  ui.serve();
  let tree = ui.render();
  control(tree, 'enhancedThinking').props.onChange({ currentTarget: { checked: false } });
  await tick();
  tree = ui.render();
  assert.deepEqual(f.writes[0], { field: 'enhancedThinking', value: false });
  assert.equal(control(tree, 'enhancedThinking').props.checked, false);
  assert.equal(control(tree, 'thinkingLevel').props.disabled, true);
  assert.equal(control(tree, 'clarification').props.disabled, true);
  const select = control(tree, 'modelPreset');
  assert.equal(select.props.disabled, false);
  assert.deepEqual(select.children.map(node => node.props.value), ['auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'generic']);
  select.props.onChange({ currentTarget: { value: 'deepseek-v4.1-flash-1017' } });
  await tick();
  assert.equal(f.form.getSnapshot().value.modelPreset, 'deepseek-v4.1-flash-1017');
  ui.dispose();
  // A fresh page reads the persisted Host state, with no browser storage involved.
  const reopened = pluginFixture(f.form);
  reopened.serve();
  assert.equal(control(reopened.render(), 'enhancedThinking').props.checked, false);
  reopened.dispose();
});

test('number and text blur edits restore saved values on refusal and read-only form disables every control', async () => {
  const f = fixture();
  const ui = pluginFixture(f.form);
  ui.serve();
  f.form.set = async () => false;
  const number = { value: '100', checkValidity: () => true, reportValidity() {} };
  control(ui.render(), 'maxFiles').props.onBlur({ currentTarget: number });
  const text = { value: 'unsaved brand' };
  control(ui.render(), 'brandIntent').props.onBlur({ currentTarget: text });
  await tick();
  assert.equal(number.value, '800');
  assert.equal(text.value, '');
  f.form.publish({ writable: false });
  for (const node of descendants(ui.render()).filter(node => ['select', 'input', 'textarea', 'button'].includes(node.type))) {
    assert.equal(node.props.disabled, true);
  }
  ui.dispose();
});

test('English and Chinese copy have the same keys', () => {
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(ZH).sort());
});

test('packaged bundle is fresh, registers lazily, and runs the same client surfaces', async () => {
  execFileSync(process.execPath, ['scripts/build-ui.mjs', '--check'], { cwd: new URL('../', import.meta.url), stdio: 'pipe' });
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
  let entry;
  const requested = [];
  runInNewContext(source, { window: { __ModuleLoader__: { load(record) { entry = record; } } } });
  assert.equal(entry.id, 'dsh-strong-skills');
  assert.equal(requested.length, 0);
  const plugin = entry.factory(name => { requested.push(name); assert.equal(name, 'react'); return { createElement: h }; });
  assert.deepEqual(requested, ['react']);
  const f = fixture();
  const ui = pluginFixture(f.form, plugin);
  ui.serve();
  assert.ok(control(ui.render('plugins.bundle.config'), 'enhancedThinking'));
  ui.dispose();
});
