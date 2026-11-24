import test from 'node:test';
import assert from 'node:assert/strict';
import { portableSchema } from '../src/schema-portable.mjs';
import { ALL_TOOLS } from '../src/engine.mjs';

// Keywords the DSH PTC type generator accepts. Anything else makes the whole
// schema degrade to `unknown`, so the registered copy must contain only these.
const SUPPORTED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);

function offenders(schema, path = '') {
  const found = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return found;
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED.has(key)) found.push(path + '/' + key);
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) found.push(...offenders(child, path + '/properties/' + name));
    } else if (key === 'items') found.push(...offenders(value, path + '/items'));
    else if (key === 'oneOf' && Array.isArray(value)) value.forEach((child, index) => found.push(...offenders(child, path + '/oneOf/' + index)));
  }
  return found;
}

test('portable schemas keep argument names, drop constraints and never mutate the source', () => {
  const original = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'search'] },
      limit: { type: 'integer', minimum: 1, maximum: 10, description: 'max 10' },
    },
    required: ['action'],
    additionalProperties: false,
    title: 'demo',
    examples: [{ action: 'search' }],
  };
  const snapshot = JSON.stringify(original);
  const portable = portableSchema(original);
  assert.deepEqual(Object.keys(portable.properties), ['action', 'limit']);
  assert.deepEqual(portable.properties.limit, { type: 'integer', description: 'max 10' });
  assert.deepEqual(portable.examples, [{ action: 'search' }]);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal('minLength' in portable.properties.limit, false);
});

test('every registered tool schema stays inside the PTC-supported keyword set', () => {
  for (const tool of ALL_TOOLS) {
    const portable = portableSchema(tool.inputSchema);
    assert.deepEqual(offenders(portable), [], tool.name);
    assert.deepEqual(Object.keys(portable.properties ?? {}), Object.keys(tool.inputSchema.properties ?? {}), tool.name);
  }
});
