import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BROWSE_TOOL, findBrowser, parseKey, runBrowseTool, selectorExpression } from '../src/browse.mjs';

test('strong_browse schema stays compact and action-oriented', () => {
  assert.equal(BROWSE_TOOL.name, 'strong_browse');
  assert.deepEqual(BROWSE_TOOL.inputSchema.required, ['action']);
  assert.deepEqual(BROWSE_TOOL.inputSchema.properties.action.enum, ['open', 'snapshot', 'view', 'screenshot', 'click', 'hover', 'drag', 'mouse', 'type', 'press', 'scroll', 'wait', 'close']);
  assert.equal(BROWSE_TOOL.inputSchema.properties.url.maxLength, 2000);
  assert.equal(BROWSE_TOOL.inputSchema.properties.ms.maximum, 30000);
  assert.equal(BROWSE_TOOL.inputSchema.properties.fullPage.type, 'boolean');
  assert.deepEqual(BROWSE_TOOL.inputSchema.properties.button.enum, ['left', 'right', 'middle']);
  assert.equal(BROWSE_TOOL.inputSchema.properties.clickCount.maximum, 3);
  assert.match(BROWSE_TOOL.description, /真实鼠标/);
  assert.match(BROWSE_TOOL.description, /截图/);
  assert.equal(BROWSE_TOOL.inputSchema.additionalProperties, false);
  for (const key of Object.values(BROWSE_TOOL.inputSchema.properties)) assert.equal(key.description, undefined);
  assert.equal(typeof findBrowser(), 'string');
});

test('strong_browse handles missing and idle sessions without launching a browser', async () => {
  await assert.rejects(() => runBrowseTool({}, { root: 'no-session-root' }), /需要 action/);
  const closed = await runBrowseTool({ action: 'close' }, { root: 'no-session-root' });
  assert.equal(closed.closed, true);
  assert.match(closed.note, /没有运行中的浏览器/);
  const again = await runBrowseTool({ action: 'close' }, { root: 'no-session-root' });
  assert.match(again.note, /没有运行中的浏览器/);
});

test('click picks the first visible match, supports a 1-based index and reports missing targets', () => {
  const rect = (width, height) => () => ({ width, height });
  const hidden = { getBoundingClientRect: rect(0, 0) };
  const first = { getBoundingClientRect: rect(10, 10), click() { this.hits = (this.hits ?? 0) + 1; } };
  const second = { getBoundingClientRect: rect(10, 10), click() { this.hits = (this.hits ?? 0) + 1; } };
  const elements = [hidden, first, second];
  const click = index => vm.runInNewContext(selectorExpression('.item', '', 'click', index), { document: { querySelectorAll: () => elements } });
  assert.equal(click(), true);
  assert.equal(first.hits, 1);
  assert.equal(second.hits, undefined);
  assert.equal(click(2), true);
  assert.equal(second.hits, 1);
  assert.equal(vm.runInNewContext(selectorExpression('#nope', '', 'click'), { document: { querySelectorAll: () => [] } }), false);
  assert.equal(vm.runInNewContext(selectorExpression(undefined, 'Nope', 'click'), { document: { querySelectorAll: () => [] } }), false);
});

test('parseKey supports modifier combos, named keys and plain letters', () => {
  const combo = parseKey('Ctrl+A');
  assert.equal(combo.key, 'a');
  assert.equal(combo.code, 65);
  assert.equal(combo.mask, 2);
  assert.equal(combo.text, undefined);
  const enter = parseKey('Ctrl+Enter');
  assert.equal(enter.key, 'Enter');
  assert.equal(enter.code, 13);
  assert.equal(enter.mask, 2);
  const shifted = parseKey('Shift+a');
  assert.equal(shifted.key, 'A');
  assert.equal(shifted.text, 'A');
  assert.equal(parseKey('Enter').code, 13);
  assert.throws(() => parseKey('Bogus+A'), /修饰键/);
  assert.throws(() => parseKey('Ctrl+F12'), /不支持的按键/);
});
