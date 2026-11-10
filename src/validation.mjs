function fail(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENTS';
  throw error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Shared schema validator for the built-in, code, and shell tools.
export function validateArguments(schema, args) {
  if (!isPlainObject(args)) fail('Arguments must be an object');
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) fail(`Unknown argument: ${key}`);
  }
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key) || args[key] === undefined) fail(`Missing argument: ${key}`);
  for (const [key, rule] of Object.entries(properties)) {
    if (!Object.hasOwn(args, key) || args[key] === undefined) continue;
    const value = args[key];
    if (rule.type === 'string') {
      if (typeof value !== 'string') fail(`${key} must be a string`);
      if (rule.minLength !== undefined && value.length < rule.minLength) fail(`${key} is too short`);
      if (rule.maxLength !== undefined && value.length > rule.maxLength) fail(`${key} is too long`);
    } else if (rule.type === 'integer') {
      if (!Number.isInteger(value)) fail(`${key} must be an integer`);
    } else if (rule.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${key} must be a number`);
    } else if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') fail(`${key} must be a boolean`);
    }
    if (rule.enum && !rule.enum.includes(value)) fail(`Invalid ${key}`);
    if (typeof value === 'number') {
      if (rule.minimum !== undefined && value < rule.minimum) fail(`${key} is out of range`);
      if (rule.maximum !== undefined && value > rule.maximum) fail(`${key} is out of range`);
    }
  }
}
