import { getSelectedModel } from './models.mjs';

// These are optional behavioral references, not claims about another model's internals.
const CLAUDE_DESIGN = 'Claude 风格界面参考（前端任务）：可借鉴纸感暖白、墨色文字、克制的陶土强调色、清楚的排版层级与留白；组件围绕主任务，补全键盘、窄屏及加载/错误状态。已有品牌和用户要求优先，深色界面保留足够对比，不复制品牌标识。';
const CLAUDE_THINKING = 'Claude 风格工作法：以可观察的验收结果组织解题，区分已知事实与待验证假设；不确定时先找最有判别力的证据，复杂改动按依赖拆解。解释关键取舍，以简洁结论和验证证据收束。';
const WE_NEED_TO = '协作目标引导：可借鉴“We need to make this work reliably”的视角，把任务理解为共同要达成的结果。例如修复登录：目标是恢复登录并保留权限边界，接着查失败证据、做最小修复、验证关键路径。措辞与语言随任务自然选择，简单任务直接完成。';

/** Read-only, per-request diagnostics. Presets cannot opt an unrelated model into this mode. */
export function getModeState(config = {}, { selection, modelId } = {}) {
  const selectedModel = getSelectedModel(selection ?? modelId);
  const deepseekModel = selectedModel !== null && /deepseek|深度求索/i.test(selectedModel);
  const enhanced = config.enhancedThinking !== false;
  const claudeRequested = config.claudeMode === true;
  const weRequested = config.weNeedToThinking === true;
  const reason = !weRequested ? 'disabled' : !enhanced ? 'enhancement-off' : selectedModel === null ? 'model-unavailable' : !deepseekModel ? 'model-not-deepseek' : 'active';
  return Object.freeze({
    claude: Object.freeze({ requested: claudeRequested, designActive: claudeRequested, thinkingActive: claudeRequested && enhanced }),
    weNeedTo: Object.freeze({ requested: weRequested, active: reason === 'active', reason, selectedModel }),
  });
}

/** Design guidance is independent of the enhanced-thinking master switch. */
export function buildDesignModePolicy(config = {}) {
  return config.claudeMode === true ? CLAUDE_DESIGN : '';
}

/** No forced prefix or chain-of-thought disclosure; the ordinary concise-report rule still applies. */
export function buildThinkingModePolicy(config = {}, context = {}) {
  const modes = getModeState(config, context);
  return [modes.claude.thinkingActive ? CLAUDE_THINKING : '', modes.weNeedTo.active ? WE_NEED_TO : ''].filter(Boolean).join('\n');
}
