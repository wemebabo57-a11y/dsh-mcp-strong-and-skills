import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_TOOL, runDesktopTool, closeDesktopSession } from '../src/desktop.mjs';
import { validateArguments } from '../src/engine.mjs';

const win32 = process.platform === 'win32';

test('desktop schema exposes the full Windows action set and is closed to extra input', () => {
  assert.equal(DESKTOP_TOOL.name, 'strong_desktop');
  assert.equal(DESKTOP_TOOL.inputSchema.additionalProperties, false);
  assert.deepEqual(DESKTOP_TOOL.inputSchema.required, ['action']);
  for (const action of ['screenshot', 'windows', 'cursor', 'move', 'click', 'drag', 'scroll', 'type', 'press', 'activate', 'minimize', 'maximize', 'restore', 'close', 'launch', 'wait']) {
    assert.ok(DESKTOP_TOOL.inputSchema.properties.action.enum.includes(action), action);
  }
  assert.equal(DESKTOP_TOOL.inputSchema.properties.text.maxLength, 4000);
  assert.equal(DESKTOP_TOOL.inputSchema.properties.clickCount.maximum, 3);
  assert.equal(DESKTOP_TOOL.inputSchema.properties.quality.minimum, 30);
});

test('desktop argument validation rejects unknown fields and out-of-range coordinates', () => {
  assert.doesNotThrow(() => validateArguments(DESKTOP_TOOL.inputSchema, { action: 'wait', ms: 1 }));
  for (const args of [{ action: 'invented' }, { action: 'click', extra: true }, { action: 'move', x: 100001 }, { action: 'wait', ms: 30001 }, { action: 'type', text: 'x'.repeat(4001) }, { action: 'screenshot', quality: 10 }]) {
    assert.throws(() => validateArguments(DESKTOP_TOOL.inputSchema, args), JSON.stringify(args));
  }
});

test('desktop malformed actions fail before a PowerShell host is started', { skip: !win32 }, async () => {
  await assert.rejects(runDesktopTool({ action: 'move', x: 1 }), /x 和 y/);
  await assert.rejects(runDesktopTool({ action: 'drag', x: 1, y: 2, toX: 3 }), /x、y、toX、toY/);
  await assert.rejects(runDesktopTool({ action: 'press' }), /press 需要 key/);
  await assert.rejects(runDesktopTool({ action: 'activate' }), /target 或 hwnd/);
  await assert.rejects(runDesktopTool({ action: 'launch', path: 'relative.exe' }), /绝对路径/);
  await closeDesktopSession();
});

test('desktop wait is cancellable and does not touch the host desktop', { skip: !win32 }, async () => {
  assert.deepEqual(await runDesktopTool({ action: 'wait', ms: 5 }), { action: 'wait', waitedMs: 5 });
  await assert.rejects(runDesktopTool({ action: 'wait', ms: 1000 }, { signal: AbortSignal.abort() }), /cancelled|ABORTED/i);
  await closeDesktopSession();
});
