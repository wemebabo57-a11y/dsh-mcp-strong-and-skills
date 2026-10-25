import { getModelProfile } from './models.mjs';
import { buildThinkingModePolicy } from './modes.mjs';

const CORE = '通用增强编码（所有模型）：简单任务直接实施；复杂任务先在内部确认目标、约束、依赖和验收，再给出至多3步简要计划。选择最小完整改动，先核对调用方与契约；完成后一次自审正确性、边界、失败路径和回归风险，用适当检查验证。检查通过即交付，证据不足才继续；汇报结果、验证和剩余限制，不展示内部推理。';

const CLARIFICATION = Object.freeze({
  more: '缺少会改变实现的范围、接口、兼容或验收决策时，优先合并询问1–3个关键问题，解释影响；只暂停依赖答案的部分。先查上下文，已有答案不重复问；小事采用可逆默认并说明，无需例行确认。',
  auto: '先查上下文；缺少会明显改变结果的决策时，合并询问1–3个关键问题，只暂停依赖答案的部分。小事采用可逆默认并说明，已有答案不重复问。',
  few: '先查上下文；只有缺失决策阻塞正确实现或涉及不可逆后果时，合并询问1–3个关键问题。其余采用可逆默认并说明，已有答案不重复问。',
});

const MODEL_POLICY = Object.freeze({
  generic: '',
  pro: 'Pro：跨模块变更先核对依赖、兼容性与失败边界；有实质取舍时比较最多两个可行方案再实施。',
  flash: 'Flash：复杂改动分成可验证小步；先从源码或诊断确认符号与接口，再逐步修改检查。结果截断先缩小范围，检查失败先定位原因再重试。',
});

const MODEL_TOOLS = Object.freeze({
  pro: Object.freeze({
    expanded: '必要时用strong_code(imports)追踪依赖，改后用strong_review定位风险，再按证据补查验证。',
    compact: '必要时用strong_context定向检索调用方与diff，再按证据补查验证。',
  }),
  flash: Object.freeze({
    expanded: '必要时用strong_code(symbols/diagnostics)定位，strong_review补充差异风险。',
    compact: '必要时用strong_context(search/read/diff)定向定位。',
  }),
});

const DEEP = '复杂任务再做一次有界反例检查：优先挑最可能的失败情形，比较测试与验收；发现具体问题才补充调查或验证，避免反复重写计划。';

/** Compact behavioral guidance; native thinking and effort remain host-owned. */
export function buildEnhancementPolicy(config = {}, { modelId, selection } = {}) {
  if (config.enhancedThinking === false) return '';
  const level = config.thinkingLevel ?? 'balanced';
  const clarification = config.clarification ?? 'more';
  if (!['balanced', 'deep'].includes(level)) throw new Error('Invalid thinkingLevel');
  if (!Object.hasOwn(CLARIFICATION, clarification)) throw new Error('Invalid clarification');
  const profile = getModelProfile(selection ?? modelId, config);
  const toolSet = config.toolSet ?? 'expanded';
  if (!['compact', 'expanded'].includes(toolSet)) throw new Error('Invalid toolSet');
  const modelPolicy = MODEL_POLICY[profile.family] + (MODEL_TOOLS[profile.family]?.[toolSet] ?? '');
  return [CORE, CLARIFICATION[clarification], modelPolicy, level === 'deep' ? DEEP : '', buildThinkingModePolicy(config, { modelId, selection })].filter(Boolean).join('\n');
}
