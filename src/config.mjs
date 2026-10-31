export const PROFILES = Object.freeze({
  lean: { maxOutputChars: 4000, maxFiles: 400, maxSkillLoads: 1 },
  balanced: { maxOutputChars: 6000, maxFiles: 800, maxSkillLoads: 2 },
  thorough: { maxOutputChars: 12000, maxFiles: 2000, maxSkillLoads: 2 },
});

/** Effective limits when the user explicitly asks for maximum capability. */
export const UNLIMITED_LIMITS = Object.freeze({
  maxOutputChars: 20000, maxFiles: 5000, maxFileBytes: 262144, maxSkillLoads: 8,
});

export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be an object');
  const allowed = new Set(['profile', 'maxOutputChars', 'maxFiles', 'maxFileBytes', 'maxSkillLoads', 'brandIntent', 'allowBrandColors', 'enhancedThinking', 'thinkingLevel', 'clarification', 'modelPreset', 'toolSet', 'claudeMode', 'weNeedToThinking', 'unlimitedTokens']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown config: ${key}`);
  const profile = input.profile === undefined ? 'balanced' : input.profile;
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) throw new Error('profile must be lean, balanced, or thorough');
  const config = { ...PROFILES[profile], maxFileBytes: 262144, enhancedThinking: true, thinkingLevel: 'balanced', clarification: 'more', modelPreset: 'auto', toolSet: 'expanded', claudeMode: false, weNeedToThinking: false, unlimitedTokens: false, ...input, profile };
  for (const [key, values] of Object.entries({ thinkingLevel: ['balanced', 'deep'], clarification: ['auto', 'more', 'few'], modelPreset: ['auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'generic'], toolSet: ['compact', 'expanded'] })) {
    if (typeof config[key] !== 'string' || !values.includes(config[key])) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['enhancedThinking', 'claudeMode', 'weNeedToThinking', 'unlimitedTokens']) {
    if (typeof config[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  const skillLoadMax = config.unlimitedTokens ? 8 : 2;
  for (const [key, min, max] of [['maxOutputChars', 2000, 20000], ['maxFiles', 20, 5000], ['maxFileBytes', 1024, 262144], ['maxSkillLoads', 1, skillLoadMax]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  }
  if (config.brandIntent !== undefined && (typeof config.brandIntent !== 'string' || config.brandIntent.length > 200)) throw new Error('brandIntent must be a string up to 200 characters');
  if (config.allowBrandColors !== undefined && typeof config.allowBrandColors !== 'boolean') throw new Error('allowBrandColors must be boolean');
  // Maximum capability wins over every lower budget and over compact tools.
  if (config.unlimitedTokens) Object.assign(config, UNLIMITED_LIMITS, { toolSet: 'expanded' });
  return Object.freeze(config);
}
