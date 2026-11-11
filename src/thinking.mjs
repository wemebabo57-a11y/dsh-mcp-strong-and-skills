import { getModelProfile } from './models.mjs';

// Task intake (conventions, implementations, callers, public API) and the
// truncation rule live in POLICY so they survive enhancedThinking: false and are
// not stated twice. This block is planning, review and delivery only.
const CORE = '简单任务直接做；复杂任务按依赖排序，写清可观察验收标准和至多 3 步计划。选最小完整改动，覆盖错误/边界/并发/兼容，不顺手重构。改完一次自审（正确性、失败路径、回归），按证据验证：定向测试→构建/类型检查→集成路径，失败先定位再重试。交付说明改动、验证和限制，不编造检查，不逐字复述内部推理。';

const CLARIFICATION = Object.freeze({
  more: '会改变实现范围、接口、兼容性或验收方式的信息缺失时，先查上下文，再一次问 1–3 个关键问题并说明影响；已有答案不重复问，只暂停依赖答案的部分；小事选可逆默认。',
  auto: '先查上下文；缺少会明显改变结果的决策时，一次问 1–3 个关键问题，只暂停依赖答案的部分；小事选可逆默认，已有答案不重复问。',
  few: '先查上下文；只有缺失决策阻塞正确实现，或后果不可逆时才提问，一次 1–3 个关键问题；其余选可逆默认并说明。',
});

const MODEL_POLICY = Object.freeze({
  generic: '',
  pro: 'Pro：改多个模块前先看依赖、兼容性和失败边界；有实质取舍时对比最多两个方案并说明理由，保持公共 API 与数据格式不变。',
  flash: 'Flash：大改拆成可验证的小步；先确认符号、类型和接口，每步检查；结果被截断就缩小范围，失败先看诊断再改一处，不整段重写。',
});

const DEEP = '一次有界反例检查：列出最可能的失败情形（输入边界、并发、权限、回滚、性能），逐项对照测试或证据，发现问题才补查，不无限重写计划。';

const UNLIMITED = '无限 token 模式：不截断、不摘要，按需完整读取文件、技能和上下文（单次最多 8 个技能）。复杂任务先写目标、约束、验收清单和至少两个方案再实现，完成后尽量全验证（单元、集成、构建、类型、边界、回归，必要时性能与安全），报告证据、风险和未覆盖项；可给完整代码和 diff，正确完整可维护优先。';

/**
 * Compact behavioral guidance; native thinking and effort remain host-owned.
 * Tool routing deliberately lives in buildPolicy(): per-model playbooks used to
 * repeat strong_code/strong_review hints per tool set, duplicating the routing
 * line and risking a mention of a tool the active tool set does not register.
 */
export function buildEnhancementPolicy(config = {}, { modelId, selection } = {}) {
  if (config.enhancedThinking === false) return '';
  const level = config.unlimitedTokens === true ? 'deep' : config.thinkingLevel ?? 'balanced';
  const clarification = config.clarification ?? 'more';
  if (!['balanced', 'deep'].includes(level)) throw new Error('Invalid thinkingLevel');
  if (!Object.hasOwn(CLARIFICATION, clarification)) throw new Error('Invalid clarification');
  const profile = getModelProfile(selection ?? modelId, config);
  const toolSet = config.toolSet ?? 'expanded';
  // Validated for configuration parity with buildPolicy/toolsForConfig; the
  // text itself no longer varies by tool set.
  if (!['compact', 'expanded'].includes(toolSet)) throw new Error('Invalid toolSet');
  return [CORE, CLARIFICATION[clarification], MODEL_POLICY[profile.family], level === 'deep' ? DEEP : ''].filter(Boolean).join('\n');
}

/** Optional maximum-effort mode. Independent of the enhanced-thinking master switch. */
export function buildUnlimitedPolicy(config = {}) {
  return config.unlimitedTokens === true ? UNLIMITED : '';
}
