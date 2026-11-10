import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSE_TOOL, findBrowser, runBrowseTool } from '../src/browse.mjs';

test('strong_browse schema stays compact and action-oriented', () => {
  assert.equal(BROWSE_TOOL.name, 'strong_browse');
  assert.deepEqual(BROWSE_TOOL.inputSchema.required, ['action']);
  assert.deepEqual(BROWSE_TOOL.inputSchema.properties.action.enum, ['open', 'snapshot', 'screenshot', 'click', 'type', 'press', 'scroll', 'wait', 'close']);
  assert.equal(BROWSE_TOOL.inputSchema.properties.url.maxLength, 2000);
  assert.equal(BROWSE_TOOL.inputSchema.properties.ms.maximum, 30000);
  assert.equal(BROWSE_TOOL.inputSchema.properties.fullPage.type, 'boolean');
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
