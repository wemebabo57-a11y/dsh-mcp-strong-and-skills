export const PROFILES = Object.freeze({
  lean: { maxOutputChars: 4000, maxFiles: 400, maxSkillLoads: 1 },
  balanced: { maxOutputChars: 6000, maxFiles: 800, maxSkillLoads: 2 },
  thorough: { maxOutputChars: 12000, maxFiles: 2000, maxSkillLoads: 2 },
});

export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object');
  const allowed = new Set(['profile', 'maxOutputChars', 'maxFiles', 'maxFileBytes', 'maxSkillLoads', 'brandIntent', 'allowBrandColors']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown config: ${key}`);
  const profile = input.profile === undefined ? 'balanced' : input.profile;
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) throw new Error('profile must be lean, balanced, or thorough');
  const config = { ...PROFILES[profile], maxFileBytes: 262144, ...input, profile };
  for (const [key, min, max] of [['maxOutputChars', 2000, 20000], ['maxFiles', 20, 5000], ['maxFileBytes', 1024, 262144], ['maxSkillLoads', 1, 2]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  }
  if (config.brandIntent !== undefined && (typeof config.brandIntent !== 'string' || config.brandIntent.length > 200)) throw new Error('brandIntent must be a string up to 200 characters');
  if (config.allowBrandColors !== undefined && typeof config.allowBrandColors !== 'boolean') throw new Error('allowBrandColors must be boolean');
  return Object.freeze(config);
}
