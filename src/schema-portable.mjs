// The DSH PTC type generator accepts only a whitelist of JSON Schema keywords;
// anything else (minLength, maxLength, minimum, maximum, pattern, ...) makes
// the whole parameters schema degrade to `unknown` in run_code. Registration
// therefore receives a portable copy with constraint keywords stripped, while
// the engine keeps validating the original schema with the full constraint set.
const PORTABLE_KEYS = Object.freeze(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
const DATA_KEYS = new Set(['const', 'enum', 'default', 'examples']);

function portable(value, data) {
  if (Array.isArray(value)) return value.map((item) => portable(item, data));
  if (!value || typeof value !== 'object') return value;
  if (data) return structuredClone(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!PORTABLE_KEYS.includes(key)) continue;
    // `properties` maps argument names to schemas: keep every name, sanitize
    // only the schema values. Data keys (enum/default/...) are copied verbatim.
    if (key === 'properties' && item && typeof item === 'object') {
      const props = {};
      for (const [name, schema] of Object.entries(item)) props[name] = portable(schema, false);
      out[key] = props;
      continue;
    }
    out[key] = portable(item, DATA_KEYS.has(key));
  }
  return out;
}

export function portableSchema(schema) {
  return portable(schema, false);
}
