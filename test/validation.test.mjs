import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArguments } from '../src/validation.mjs';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 10 },
    count: { type: 'integer', minimum: 1, maximum: 5 },
    ratio: { type: 'number', minimum: 0 },
    enabled: { type: 'boolean' },
    mode: { type: 'string', enum: ['a', 'b'] },
  },
};

test('shared validation enforces object shape, types, ranges and unknown keys', () => {
  assert.doesNotThrow(() => validateArguments(schema, { name: 'ok', count: 2, ratio: 1.5, enabled: true, mode: 'a' }));
  const bad = [
    null, [], 'text', Object.create({ name: 'ok' }),
    { count: 1 },
    { name: undefined },
    { name: '' },
    { name: 'x'.repeat(11) },
    { name: 'ok', count: 1.5 },
    { name: 'ok', count: 0 },
    { name: 'ok', ratio: Number.NaN },
    { name: 'ok', enabled: 1 },
    { name: 'ok', mode: 'c' },
    { name: 'ok', extra: true },
  ];
  for (const value of bad) {
    assert.throws(() => validateArguments(schema, value), (error) => error.code === 'INVALID_ARGUMENTS', JSON.stringify(value));
  }
});
