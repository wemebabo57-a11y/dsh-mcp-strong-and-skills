import { parseKnowledgeConfig } from './knowledge-config.mjs';
import { SHELL_BACKENDS } from './shell-tool.mjs';

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
  const allowed = new Set(['profile', 'maxOutputChars', 'maxFiles', 'maxFileBytes', 'maxSkillLoads', 'brandIntent', 'allowBrandColors', 'enhancedThinking', 'thinkingLevel', 'clarification', 'modelPreset', 'toolSet', 'claudeMode', 'weNeedToThinking', 'unlimitedTokens', 'knowledgeConfig', 'shellTool', 'shellBackend', 'shellPath', 'wslDistro', 'bashTool', 'webTool', 'webAllowPrivate', 'browseTool', 'ptcMode', 'browserPath']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown config: ${key}`);
  const profile = input.profile === undefined ? 'balanced' : input.profile;
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) throw new Error('profile must be lean, balanced, or thorough');
  if (input.bashTool !== undefined && typeof input.bashTool !== 'boolean') throw new Error('bashTool must be boolean');
  if (input.shellTool !== undefined && typeof input.shellTool !== 'boolean') throw new Error('shellTool must be boolean');
  const shellBackend = input.shellBackend ?? 'auto';
  if (typeof shellBackend !== 'string' || !SHELL_BACKENDS.includes(shellBackend)) throw new Error('Invalid shellBackend');
  for (const [key, max] of [['shellPath', 1000], ['wslDistro', 100]]) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > max || /[\0\r\n]/.test(input[key]))) throw new Error(key + ' must be a single-line string up to ' + max + ' characters');
  }
  const config = { ...PROFILES[profile], maxFileBytes: 262144, enhancedThinking: true, thinkingLevel: 'balanced', clarification: 'more', modelPreset: 'auto', toolSet: 'expanded', claudeMode: false, weNeedToThinking: false, unlimitedTokens: false, knowledgeConfig: '', shellTool: false, shellBackend: 'auto', shellPath: '', wslDistro: '', webTool: true, webAllowPrivate: false, browseTool: 'auto', ptcMode: 'auto', browserPath: '', ...input, profile };
  // 0.4.x/0.5.x migration: bashTool was an extra unsandboxed Bash switch. It now
  // means "enable the selectable shell tool"; an explicit shellTool wins.
  if (input.shellTool === undefined && input.bashTool !== undefined) config.shellTool = input.bashTool;
  delete config.bashTool;
  parseKnowledgeConfig(config.knowledgeConfig);
  for (const [key, values] of Object.entries({ thinkingLevel: ['balanced', 'deep'], clarification: ['auto', 'more', 'few'], modelPreset: ['auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'generic'], toolSet: ['compact', 'expanded'] })) {
    if (typeof config[key] !== 'string' || !values.includes(config[key])) throw new Error(`Invalid ${key}`);
  }
  for (const key of ['enhancedThinking', 'claudeMode', 'weNeedToThinking', 'unlimitedTokens', 'shellTool', 'webTool', 'webAllowPrivate']) {
    if (typeof config[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  if (typeof config.shellBackend !== 'string' || !SHELL_BACKENDS.includes(config.shellBackend)) throw new Error('Invalid shellBackend');
  if (typeof config.shellPath !== 'string' || config.shellPath.length > 1000 || /[\0\r\n]/.test(config.shellPath)) throw new Error('shellPath must be a single-line string up to 1000 characters');
  if (typeof config.wslDistro !== 'string' || config.wslDistro.length > 100 || /[\0\r\n]/.test(config.wslDistro)) throw new Error('wslDistro must be a single-line string up to 100 characters');
  for (const [key, values] of Object.entries({ browseTool: ['auto', 'on', 'off'], ptcMode: ['auto', 'on', 'off'] })) {
    if (typeof config[key] !== 'string' || !values.includes(config[key])) throw new Error(`Invalid ${key}`);
  }
  if (typeof config.browserPath !== 'string' || config.browserPath.length > 1000 || /[\0\r\n]/.test(config.browserPath)) throw new Error('browserPath must be a single-line string up to 1000 characters');
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
