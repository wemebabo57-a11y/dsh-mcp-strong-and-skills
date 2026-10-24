import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const executable = fileURLToPath(new URL('../bin/strong.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

function client(t, profile = 'balanced') {
  const child = spawn(process.execPath, [executable, 'serve', '--root', root, '--profile', profile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let stderr = '';
  const waiting = new Map();
  const all = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      all.push(message);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const request = (id, method, params) => {
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No MCP response for ${method}: ${stderr}`)), 5000);
      waiting.set(id, message => { clearTimeout(timeout); resolve(message); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    return response;
  };
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null) await once(child, 'exit');
    assert.equal(child.exitCode, 0, stderr);
    assert.equal(buffer, '', 'stdout must contain only complete JSON-RPC lines');
  });
  return { child, request, notify, all, get stderr() { return stderr; } };
}

async function initialize(c, version = '2025-11-25') {
  const response = await c.request(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } });
  assert.equal(response.result.protocolVersion, version === '2099-01-01' ? '2025-11-25' : version);
  c.notify('notifications/initialized');
  return response.result;
}

test('stdio initialize, tool discovery, on-demand skills, resources and bounded context', async t => {
  const c = client(t, 'lean');
  const init = await initialize(c);
  assert.deepEqual(init.capabilities, { tools: {}, resources: {} });
  assert.ok(init.instructions.length < 500);
  const listed = await c.request(2, 'tools/list', {});
  assert.equal(listed.result.tools.length, 2);
  assert.equal(JSON.stringify(listed).includes('先理解用户'), false, 'skill bodies stay out of discovery');
  const loaded = await c.request(3, 'tools/call', { name: 'strong_skill', arguments: { query: '修复崩溃错误' } });
  assert.equal(loaded.result.isError, false);
  const skills = JSON.parse(loaded.result.content[0].text);
  assert.equal(skills.skills[0].id, 'debug');
  assert.ok(skills.skills[0].content.length > 100);
  const resources = await c.request(4, 'resources/list');
  assert.equal(resources.result.resources.length, 8);
  const body = await c.request(5, 'resources/read', { uri: 'strong://skills/frontend-design' });
  assert.match(body.result.contents[0].text, /深蓝/);
  const context = await c.request(6, 'tools/call', { name: 'strong_context', arguments: { action: 'read', path: 'package.json', limit: 3 } });
  const value = JSON.parse(context.result.content[0].text);
  assert.equal(value.lines.length, 3);
  assert.ok(context.result.content[0].text.length <= 4000);
  assert.equal(c.stderr, '');
});

test('stdio reports protocol errors separately from tool execution errors', async t => {
  const c = client(t);
  assert.equal((await c.request(0, 'tools/list')).error.code, -32002);
  await initialize(c, '2024-11-05');
  assert.equal((await c.request(2, 'no-such-method')).error.code, -32601);
  assert.equal((await c.request(3, 'tools/call', { name: 'unknown' })).error.code, -32602);
  assert.equal((await c.request(4, 'resources/read', { uri: 'file:///etc/passwd' })).error.code, -32002);
  const denied = await c.request(5, 'tools/call', { name: 'strong_context', arguments: { action: 'read', path: '../outside' } });
  assert.equal(denied.result.isError, true);
  const invalid = await c.request(6, 'tools/call', { name: 'strong_skill', arguments: { limit: 99 } });
  assert.equal(invalid.result.isError, true);
  const proto = await c.request(7, 'tools/call', { name: 'strong_skill', arguments: JSON.parse('{"__proto__":{}}') });
  assert.equal(proto.result.isError, true);
  const nullArgs = await c.request(9, 'tools/call', { name: 'strong_skill', arguments: null });
  assert.equal(nullArgs.result.isError, true);
  assert.equal((await c.request(8, 'ping')).result.constructor, Object);
});

test('version negotiation falls back to a supported protocol', async t => {
  const c = client(t);
  await initialize(c, '2099-01-01');
  assert.deepEqual((await c.request(2, 'resources/templates/list')).result, { resourceTemplates: [] });
});

test('stdio handles UTF-8 split between chunks, malformed JSON, oversized frames and recovery', async t => {
  const c = client(t);
  await initialize(c);
  c.child.stdin.write('{bad}\n');
  await c.request(2, 'ping');
  assert.ok(c.all.some(message => message.error?.code === -32700));
  const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'strong_skill', arguments: { query: '界面设计' } } }) + '\n');
  const point = frame.indexOf(Buffer.from('界')) + 1;
  c.child.stdin.write(frame.subarray(0, point));
  c.child.stdin.write(frame.subarray(point));
  await c.request(4, 'ping');
  // Work finishes asynchronously; a subsequent request still sees a usable transport.
  const loaded = await c.request(5, 'tools/call', { name: 'strong_skill', arguments: { id: 'frontend-design' } });
  assert.equal(JSON.parse(loaded.result.content[0].text).skills[0].id, 'frontend-design');
  c.child.stdin.write('x'.repeat(1024 * 1024 + 1) + '\n');
  await c.request(6, 'ping');
  assert.ok(c.all.some(message => message.error?.message === 'Message exceeds 1 MiB'));
});
