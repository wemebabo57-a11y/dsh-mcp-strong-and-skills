// Policy presets never select a provider or change the request's model ID.
// Official API aliases are rolling endpoints, not a way to pin model weights.
export const MODEL_PRESETS = Object.freeze(['auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'generic']);

export const MODEL_SOURCES = Object.freeze({
  models: 'https://api-docs.deepseek.com/quick_start/pricing/',
  updates: 'https://api-docs.deepseek.com/updates/',
  thinking: 'https://api-docs.deepseek.com/guides/thinking_mode/',
  checkedAt: '2026-10-25',
});

const PROFILES = Object.freeze({
  generic: Object.freeze({ id: 'generic', family: 'generic', label: 'Generic', apiModel: null, documentedVersion: null, rolling: false }),
  'deepseek-v4-pro': Object.freeze({
    id: 'deepseek-v4-pro', family: 'pro', label: 'DeepSeek V4 Pro',
    apiModel: 'deepseek-v4-pro', documentedVersion: 'DeepSeek-V4-Pro-0813', rolling: true,
  }),
  'deepseek-v4.1-flash-1017': Object.freeze({
    id: 'deepseek-v4.1-flash-1017', family: 'flash', label: 'DeepSeek V4.1 Flash 1017',
    apiModel: 'deepseek-flash', documentedVersion: 'DeepSeek-V4.1-Flash-1017', rolling: true,
  }),
});

// Exact API aliases and explicitly recognized version names select guidance.
// Never infer a model's capabilities from its provider name or a loose substring.
const API_PROFILES = new Map([
  ['deepseek-v4-pro', 'deepseek-v4-pro'],
  ['deepseek-flash', 'deepseek-v4.1-flash-1017'],
  ['deepseek-v4-flash', 'deepseek-v4.1-flash-1017'],
  ['deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash-1017'],
  ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash-1017'],
  ['deepseek-ai/deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash-1017'],
  ['deepseek-v4-pro-0813', 'deepseek-v4-pro'],
  ['deepseek-ai/deepseek-v4-pro-0813', 'deepseek-v4-pro'],
]);

/** Model identity comes only from the actual selection, never a provider or policy preset. */
export function getSelectedModel(selection) {
  const value = typeof selection === 'string' ? selection : selection?.model;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Return descriptive policy metadata without mutating the host's selection. */
export function getModelProfile(selection, config = {}) {
  const preset = config.modelPreset ?? 'auto';
  if (!MODEL_PRESETS.includes(preset)) throw new Error('Invalid modelPreset');
  const selectedModel = getSelectedModel(selection);
  const detected = selectedModel ? API_PROFILES.get(selectedModel.toLowerCase()) : undefined;
  const id = preset === 'auto' ? detected ?? 'generic' : preset;
  return Object.freeze({
    ...PROFILES[id], selectedModel,
    detectedFrom: preset !== 'auto' ? 'preset' : detected ? 'model' : 'fallback',
  });
}
