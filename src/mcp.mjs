import { StrongEngine, TOOLS, boundResult } from './engine.mjs';
import { SKILL_CATALOG, loadSkill } from './skills.mjs';
import { POLICY } from './policy.mjs';

// A small, dependency-free stdio implementation of the negotiated MCP subset.
// No HTTP listener, sampling, prompts, subscriptions, or arbitrary command tool.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 16;

export function startMcp({ root, config = {}, input = process.stdin, output = process.stdout }) {
  const engine = new StrongEngine(root, config);
  const active = new Map();
  let state = 'new';
  let buffer = Buffer.alloc(0);
  let dropping = false;
  let closed = false;

  const send = message => { if (!closed) output.write(JSON.stringify(message) + '\n'); };
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const resources = SKILL_CATALOG.map(skill => ({ uri: `strong://skills/${skill.id}`, name: skill.id, description: skill.description, mimeType: 'text/markdown' }));

  async function dispatch(method, params, signal) {
    signal.throwIfAborted();
    if (method === 'ping') return {};
    if (method === 'initialize') {
      if (state !== 'new') throw Object.assign(new Error('Already initialized'), { rpcCode: -32600 });
      if (!params || typeof params.protocolVersion !== 'string' || !params.clientInfo || typeof params.clientInfo.name !== 'string'
        || typeof params.clientInfo.version !== 'string' || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)) {
        throw Object.assign(new Error('Invalid initialize parameters'), { rpcCode: -32602 });
      }
      state = 'initializing';
      return { protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'dsh-strong-skills', version: '0.1.0' }, instructions: POLICY };
    }
    if (state !== 'ready') throw Object.assign(new Error('Send initialize and notifications/initialized first'), { rpcCode: -32002 });
    if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params))) throw Object.assign(new Error('Parameters must be an object'), { rpcCode: -32602 });
    if (method === 'tools/list') {
      if (params?.cursor !== undefined) throw Object.assign(new Error('This static list has no cursor'), { rpcCode: -32602 });
      return { tools: TOOLS.map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) };
    }
    if (method === 'tools/call') {
      if (!params || typeof params.name !== 'string' || !TOOLS.some(tool => tool.name === params.name)) throw Object.assign(new Error('Unknown tool'), { rpcCode: -32602 });
      try {
        const value = await engine.call(params.name, Object.hasOwn(params, 'arguments') ? params.arguments : {}, { signal });
        return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
      } catch (cause) {
        if (signal.aborted) throw cause;
        return { content: [{ type: 'text', text: String(cause.message ?? cause).slice(0, 1000) }], isError: true };
      }
    }
    if (method === 'resources/list') {
      if (params?.cursor !== undefined) throw Object.assign(new Error('This static list has no cursor'), { rpcCode: -32602 });
      return { resources };
    }
    if (method === 'resources/templates/list') return { resourceTemplates: [] };
    if (method === 'resources/read') {
      const resource = resources.find(resource => resource.uri === params?.uri);
      if (!resource) throw Object.assign(new Error('Unknown resource URI'), { rpcCode: -32002 });
      const skill = await loadSkill(resource.name, signal);
      const value = boundResult({ content: skill.content }, engine.config.maxOutputChars - 400);
      return { contents: [{ uri: resource.uri, mimeType: 'text/markdown', text: value.content ?? value.hint }] };
    }
    throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
  }

  function accept(line) {
    if (!line.length) return;
    let message;
    try { message = JSON.parse(line.toString('utf8')); } catch { error(null, -32700, 'Parse error'); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // Ignore responses: this server does not issue client requests.
      if (message?.jsonrpc === '2.0' && typeof message.id !== 'undefined' && ('result' in message || 'error' in message)) return;
      error(null, -32600, 'Invalid request'); return;
    }
    const hasId = Object.hasOwn(message, 'id');
    if (!hasId) {
      if (message.method === 'notifications/initialized' && state === 'initializing') state = 'ready';
      if (message.method === 'notifications/cancelled') active.get(message.params?.requestId)?.abort(new Error('Request cancelled'));
      return;
    }
    const { id } = message;
    if (typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id))) { error(null, -32600, 'Invalid request id'); return; }
    if (active.has(id)) { error(id, -32600, 'Duplicate active request id'); return; }
    if (active.size >= MAX_IN_FLIGHT) { error(id, -32000, 'Too many in-flight requests'); return; }
    const controller = new AbortController();
    active.set(id, controller);
    void dispatch(message.method, message.params, controller.signal)
      .then(result => { if (!controller.signal.aborted) send({ jsonrpc: '2.0', id, result }); })
      .catch(cause => { if (!controller.signal.aborted) error(id, cause.rpcCode ?? -32603, String(cause.message ?? cause).slice(0, 1000)); })
      .finally(() => active.delete(id));
  }

  function onData(chunk) {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (bytes.length) {
      const newline = bytes.indexOf(10);
      const fragment = newline < 0 ? bytes : bytes.subarray(0, newline);
      if (!dropping && buffer.length + fragment.length > MAX_FRAME_BYTES) {
        error(null, -32600, 'Message exceeds 1 MiB'); buffer = Buffer.alloc(0); dropping = true;
      }
      if (!dropping) buffer = Buffer.concat([buffer, fragment]);
      if (newline < 0) break;
      if (!dropping) accept(buffer);
      buffer = Buffer.alloc(0); dropping = false; bytes = bytes.subarray(newline + 1);
    }
  }
  function close() {
    closed = true;
    for (const controller of active.values()) controller.abort(new Error('Transport closed'));
    input.off('data', onData);
    input.off('end', close);
    input.off('error', close);
  }
  input.on('data', onData);
  input.once('end', close);
  input.once('error', close);
  return { close, engine };
}
