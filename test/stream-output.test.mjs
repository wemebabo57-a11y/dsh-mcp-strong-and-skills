import assert from 'node:assert/strict';
import test from 'node:test';
import { createTailCollector, decodeBytes, trimToLimit } from '../src/stream-output.mjs';

test('tail collector keeps both ends and reports the omitted middle', () => {
  const collector = createTailCollector(1024);
  collector.push(Buffer.from('HEAD-'.repeat(100)));
  collector.push(Buffer.from('x'.repeat(5000)));
  collector.push(Buffer.from('-TAIL-END'));
  const result = collector.read();
  assert.equal(result.truncated, true);
  assert.match(result.text, /^HEAD-/);
  assert.ok(result.text.endsWith('-TAIL-END'));
  assert.match(result.text, /\[truncated: 已省略 \d+ 字节/);
});

test('small output is returned unchanged and not marked truncated', () => {
  const collector = createTailCollector(1024);
  collector.push('中文输出\n');
  const result = collector.read();
  assert.equal(result.text, '中文输出\n');
  assert.equal(result.truncated, false);
});

test('decode falls back to GBK when bytes are not valid UTF-8', () => {
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文 in GBK
  assert.equal(decodeBytes(gbk), '中文');
  assert.equal(decodeBytes(Buffer.from('中文')), '中文');
});

test('trimToLimit trims a multibyte boundary without corrupting the tail', () => {
  const text = 'a'.repeat(2000) + '末尾标记';
  const result = trimToLimit(text, 1024);
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith('a'.repeat(100)));
  assert.ok(result.text.endsWith('末尾标记'));
});
