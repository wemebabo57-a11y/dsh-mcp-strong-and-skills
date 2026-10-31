import { getModelProfile } from './models.mjs';

const CORE = '通用增强（所有模型）：先读项目约定、相关实现、调用方与公开契约，不凭猜测改代码。简单任务直接实施；复杂任务按依赖排序，先定可观察的验收标准，再给至多3步计划。选择最小完整改动，覆盖错误路径、边界、并发、兼容与可访问性；不顺手重构无关代码。完成后一次自审正确性、边界、失败路径与回归风险，再按证据验证：定向测试→构建/类型检查→相关集成或手动路径；失败先定位原因再重试，禁止盲目反复修改。交付时说明改动、验证结果与剩余限制，不编造未执行的检查；汇报保持简洁，不逐字复述内部推理。';

const CLARIFICATION = Object.freeze({
  more: '缺少会改变实现的范围、接口、兼容或验收决策时，优先合并询问1–3个关键问题，解释影响；只暂停依赖答案的部分。先查上下文，已有答案不重复问；小事采用可逆默认并说明，无需例行确认。',
  auto: '先查上下文；缺少会明显改变结果的决策时，合并询问1–3个关键问题，只暂停依赖答案的部分。小事采用可逆默认并说明，已有答案不重复问。',
  few: '先查上下文；只有缺失决策阻塞正确实现或涉及不可逆后果时，合并询问1–3个关键问题。其余采用可逆默认并说明，已有答案不重复问。',
});

const MODEL_POLICY = Object.freeze({
  generic: '',
  pro: 'Pro：跨模块变更先核对依赖图、兼容性与失败边界；有实质取舍时比较最多两个可行方案并说明依据，优先保持公共 API、数据格式与部署行为稳定。',
  flash: 'Flash：复杂改动拆成可验证小步；先确认符号、类型与接口再修改，逐步检查；结果截断先缩小范围，失败先看诊断与源码再重试，不要一次重写大段代码。',
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

const DEEP = '深度增强：完成后做一次有界反例检查：列出最可能的失败情形（输入边界、并发、权限、回滚、性能），逐项对照测试或证据；发现具体问题才补充调查，避免无限重写计划。';

const UNLIMITED = '无限 token 模式：不受本插件输出与读取预算约束，按最大范围完整读取相关文件、技能与上下文（单次最多8个技能），不因篇幅压缩、截断或摘要掉细节。复杂任务先列出完整目标、约束、验收矩阵与至少两个可行方案再实现；实现后执行尽可能全面的验证（单元、集成、构建、类型、边界、回归与必要的性能/安全检查），完整报告证据、风险与未覆盖项。可输出完整代码、完整 diff 说明和示例，不要为简短省略步骤、命令或文件。token 消耗不是约束，正确性、完整性与可维护性优先。';

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
