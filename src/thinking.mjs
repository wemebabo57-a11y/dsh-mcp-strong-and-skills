import { getModelProfile } from './models.mjs';

const CORE = '先读项目约定、相关实现、调用方和公开接口，不凭猜测改代码。简单任务直接做；复杂任务按依赖排序，写清可观察验收标准和至多3步计划；选最小完整改动，覆盖错误、边界、并发和兼容性，不顺手重构。改完做一次自审，检查正确性、失败路径和回归风险，再按证据验证：定向测试→构建或类型检查→集成或手动路径；失败先定位再重试。交付说明改动、验证和限制，不编造未做检查，不逐字复述内部推理。';

const CLARIFICATION = Object.freeze({
  more: '缺少会改变实现范围、接口、兼容性或验收方式的信息时，一次问 1–3 个关键问题并说明影响；先查上下文，已有答案不重复问，只暂停依赖答案的部分。小事选可逆默认并说明。',
  auto: '先查上下文；缺少会明显改变结果的决策时，一次问 1–3 个关键问题，只暂停依赖答案的部分。小事选可逆默认并说明，已有答案不重复问。',
  few: '先查上下文；只有缺失决策阻塞正确实现，或会造成不可逆后果时才提问，一次 1–3 个关键问题。其余选可逆默认并说明。',
});

const MODEL_POLICY = Object.freeze({
  generic: '',
  pro: 'Pro：改多个模块前先看依赖、兼容性和失败边界；有实质取舍时对比最多两个方案并说明理由，尽量保持公共 API、数据格式和部署行为不变。',
  flash: 'Flash：大改拆成可验证的小步；先确认符号、类型和接口再改，每步检查；结果被截断就缩小范围，失败先看诊断和源码再改一次，不要整段重写。',
});

const MODEL_TOOLS = Object.freeze({
  pro: Object.freeze({
    expanded: '需要时用 strong_code(imports) 查依赖，改完用 strong_review 查风险，再补验证。',
    compact: '需要时用 strong_context 查调用方和 diff，再按证据补验证。',
  }),
  flash: Object.freeze({
    expanded: '需要时用 strong_code(symbols/diagnostics) 定位，strong_review 补差异风险。',
    compact: '需要时用 strong_context(search/read/diff) 定位。',
  }),
});

const DEEP = '一次有界反例检查：列出最可能的失败情形，如输入边界、并发、权限、回滚、性能，逐项对照测试或证据；只有发现具体问题才补查，不要无限重写计划。';

const UNLIMITED = '无限 token 模式：不受本插件预算限制，按需完整读取文件、技能和上下文（单次最多 8 个技能），不要为省篇幅截断或摘要掉细节。复杂任务先写清目标、约束、验收清单和至少两个方案，再实现；实现后尽量做全验证（单元、集成、构建、类型、边界、回归，必要时性能与安全），完整报告证据、风险和未覆盖项。可以给出完整代码和 diff，不为简短省略步骤；正确、完整、可维护优先。';

/** Compact behavioral guidance; native thinking and effort remain host-owned. */
export function buildEnhancementPolicy(config = {}, { modelId, selection } = {}) {
  if (config.enhancedThinking === false) return '';
  const level = config.unlimitedTokens === true ? 'deep' : config.thinkingLevel ?? 'balanced';
  const clarification = config.clarification ?? 'more';
  if (!['balanced', 'deep'].includes(level)) throw new Error('Invalid thinkingLevel');
  if (!Object.hasOwn(CLARIFICATION, clarification)) throw new Error('Invalid clarification');
  const profile = getModelProfile(selection ?? modelId, config);
  const toolSet = config.toolSet ?? 'expanded';
  if (!['compact', 'expanded'].includes(toolSet)) throw new Error('Invalid toolSet');
  const modelPolicy = MODEL_POLICY[profile.family] + (MODEL_TOOLS[profile.family]?.[toolSet] ?? '');
  return [CORE, CLARIFICATION[clarification], modelPolicy, level === 'deep' ? DEEP : ''].filter(Boolean).join('\n');
}

/** Optional maximum-effort mode. Independent of the enhanced-thinking master switch. */
export function buildUnlimitedPolicy(config = {}) {
  return config.unlimitedTokens === true ? UNLIMITED : '';
}
