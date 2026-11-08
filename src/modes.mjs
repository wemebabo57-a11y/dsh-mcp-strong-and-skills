import { getSelectedModel } from './models.mjs';

// These are optional behavioral references, not claims about another model's internals.
const CLAUDE_DESIGN = '界面参考（前端任务）：可用暖白纸感底、深墨文字、少量陶土色强调，保持清楚的层级和留白；组件围绕主任务，补全键盘操作、窄屏布局和加载/错误状态。用户品牌和要求优先，深色界面保证对比度，不复制品牌标识。';
const CLAUDE_THINKING = '工作方法：用可观察的结果组织思路，区分已知事实和待验证假设；不确定时先找最能区分对错的证据，复杂改动按依赖拆开。说明关键取舍，最后用结论和验证证据收尾。';
const WE_NEED_TO = 'we need to 思维（所有模型）：开始前先在内部写一句“We need to …”，说清要交付的可观察结果；再按 目标 → 已知事实与假设 → 最少的必要证据 → 行动 → 验证 → 风险 推进。复杂任务按依赖排序，简单任务确认目标后直接做。思考语言跟随用户；需要时可以给简短思路摘要，但不逐字复述内部推理。';

/**
 * Read-only, per-request diagnostics. The we-need-to mode is a user-selected
 * behavior for every model; the current model is reported for diagnosis only.
 */
export function getModeState(config = {}, { selection, modelId } = {}) {
  const selectedModel = getSelectedModel(selection ?? modelId);
  const enhanced = config.enhancedThinking !== false;
  const claudeRequested = config.claudeMode === true;
  const weRequested = config.weNeedToThinking === true;
  return Object.freeze({
    claude: Object.freeze({ requested: claudeRequested, designActive: claudeRequested, thinkingActive: claudeRequested && enhanced }),
    weNeedTo: Object.freeze({ requested: weRequested, active: weRequested, reason: weRequested ? 'active' : 'disabled', selectedModel }),
  });
}

/** Design guidance is independent of the enhanced-thinking master switch. */
export function buildDesignModePolicy(config = {}) {
  return config.claudeMode === true ? CLAUDE_DESIGN : '';
}

/** The explicitly checked we-need-to mode always applies; Claude planning follows the master switch. */
export function buildThinkingModePolicy(config = {}, context = {}) {
  const modes = getModeState(config, context);
  return [modes.claude.thinkingActive ? CLAUDE_THINKING : '', modes.weNeedTo.active ? WE_NEED_TO : ''].filter(Boolean).join('\n');
}
