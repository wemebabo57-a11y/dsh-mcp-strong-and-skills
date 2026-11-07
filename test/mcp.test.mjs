import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import packageInfo from '../package.json' with { type: 'json' };
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const executable = fileURLToPath(new URL('../bin/strong.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

function client(t, profile = 'balanced', options = []) {
  const child = spawn(process.execPath, [executable, 'serve', '--root', root, '--profile', profile, ...options], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
  assert.deepEqual(init.serverInfo, { name: packageInfo.name, version: packageInfo.version });
  assert.ok(init.instructions.length < 1000);
  const listed = await c.request(2, 'tools/list', {});
  assert.equal(listed.result.tools.length, 4);
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

test('MCP compact/off removes optional tools and enhancement policy', async t => {
  const c = client(t, 'lean', ['--thinking', 'off', '--tools', 'compact']);
  const init = await initialize(c);
  const listed = await c.request(2, 'tools/list');
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['strong_skill', 'strong_context']);
  assert.equal(init.instructions.includes('增强编码'), false);
  assert.equal((await c.request(3, 'tools/call', { name: 'strong_code', arguments: { action: 'symbols' } })).error.code, -32602);
});

test('MCP shell tool is opt-in, honestly annotated, and executes a real command', async t => {
  const c = client(t, 'lean', ['--shell', 'on']);
  await initialize(c);
  const listed = await c.request(2, 'tools/list');
  assert.equal(listed.result.tools.length, 5);
  const shell = listed.result.tools.find(tool => tool.name === 'strong_shell');
  assert.deepEqual(shell.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  const result = await c.request(3, 'tools/call', { name: 'strong_shell', arguments: { command: 'printf shell-mcp' } });
  if (result.result.isError) {
    if (/未找到|未安装/.test(result.result.content[0].text)) { t.skip('No supported shell is installed on this host.'); return; }
    assert.fail(result.result.content[0].text);
  }
  const value = JSON.parse(result.result.content[0].text);
  assert.equal(value.exitCode, 0);
  assert.equal(value.stdout, 'shell-mcp');
  assert.equal(value.stderr, '');
  assert.ok(['git-bash', 'bash', 'wsl'].includes(value.shell.backend));
  assert.equal(c.stderr, '');
});

test('MCP reads a saved project card and retrieves local knowledge on demand through the same gateway', async t => {
  const parent = await fs.realpath(os.tmpdir()), temporary = await fs.mkdtemp(path.join(parent, 'strong-mcp-knowledge-'));
  t.after(async () => { assert.equal(path.dirname(temporary), parent); assert.ok(path.basename(temporary).startsWith('strong-mcp-knowledge-')); await fs.rm(temporary, { recursive: true, force: true }); });
  await fs.writeFile(path.join(temporary, 'guide.md'), 'ON_DEMAND_SOURCE_MARKER\n');
  const file = path.join(temporary, 'sources.json');
  await fs.writeFile(file, JSON.stringify({ projects: [{ root, name: 'Current', notes: 'PERSISTED_PROJECT_CARD' }], libraries: [{ id: 'shared', name: 'Docs', kind: 'local', location: path.join(temporary, 'guide.md'), scope: 'global' }, { id: 'remote', name: 'Remote', kind: 'github', location: 'https://github.com/example/docs', scope: 'global' }] }));
  const c = client(t, 'balanced', ['--knowledge-file', file]);
  const init = await initialize(c);
  assert.match(init.instructions, /PERSISTED_PROJECT_CARD/);
  assert.doesNotMatch(init.instructions, /ON_DEMAND_SOURCE_MARKER/);
  const catalog = await c.request(2, 'tools/call', { name: 'strong_context', arguments: { action: 'knowledge' } });
  assert.equal(JSON.parse(catalog.result.content[0].text).libraries[0].id, 'shared');
  const read = await c.request(3, 'tools/call', { name: 'strong_context', arguments: { action: 'knowledge', path: 'shared/guide.md', limit: 1 } });
  assert.equal(JSON.parse(read.result.content[0].text).lines[0].text, 'ON_DEMAND_SOURCE_MARKER');
  const tools = await c.request(4, 'tools/list');
  assert.equal(tools.result.tools.find(tool => tool.name === 'strong_context').annotations.openWorldHint, true);
});

test('MCP mode flags enable Claude guidance and all-model we-need-to guidance', async t => {
  const c = client(t, 'lean', ['--claude-mode', 'on', '--we-need-to', 'on', '--model', 'deepseek-v4-pro']);
  const init = await initialize(c);
  assert.match(init.instructions, /Claude 风格界面参考/);
  assert.match(init.instructions, /Claude 风格工作法/);
  assert.match(init.instructions, /协作目标引导/);
  const listed = await c.request(2, 'tools/list');
  assert.equal(listed.result.tools.length, 4);
});

test('MCP expanded coding tools return real bounded symbols and parsed diagnostics', async t => {
  const c = client(t);
  await initialize(c);
  const symbols = await c.request(2, 'tools/call', { name: 'strong_code', arguments: { action: 'symbols', path: 'src/engine.mjs' } });
  assert.equal(symbols.result.isError, false);
  assert.match(symbols.result.content[0].text, /StrongEngine/);
  const review = await c.request(3, 'tools/call', { name: 'strong_review', arguments: { path: 'src' } });
  assert.equal(review.result.isError, false);
  assert.ok(JSON.parse(review.result.content[0].text));
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
