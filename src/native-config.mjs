import { resolveConfig } from './config.mjs';

// Host-only peer. The standalone CLI/MCP core does not import Schemastery.
export function createConfigSchema(z) {
  const choices = (values, fallback, description) => z.union(values.map(value => z.const(value))).default(fallback).description(description).volatile();
  const integer = (min, max, description) => z.number().min(min).max(max).step(1).description(description).volatile();
  return z.object({
    profile: choices(['lean', 'balanced', 'thorough'], 'balanced', '上下文预算档位'),
    enhancedThinking: z.boolean().default(true).description('增强思考：方案、边界检查与必要澄清').volatile(),
    claudeMode: z.boolean().default(false).description('Claude 模式：前端视觉参考与结构化解题；思考部分受增强思考总开关控制').volatile(),
    weNeedToThinking: z.boolean().default(false).description('we need to 思维：仅名称含 DeepSeek 或深度求索的当前模型启用协作目标引导').volatile(),
    thinkingLevel: choices(['balanced', 'deep'], 'balanced', '增强程度；不改写模型 API reasoning effort'),
    clarification: choices(['auto', 'more', 'few'], 'more', '关键信息不明时的澄清偏好'),
    modelPreset: choices(['auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'generic'], 'auto', '模型指导预设；不切换实际模型'),
    toolSet: choices(['compact', 'expanded'], 'expanded', '工具集合：基础 2 个或扩展 4 个'),
    allowBrandColors: z.boolean().default(false).description('尊重指定品牌的蓝紫配色').volatile(),
    brandIntent: z.string().max(200).default('').description('已有品牌或用户配色要求').volatile(),
    maxOutputChars: integer(2000, 20000, '单次结果字符上限；留空跟随预算档位'),
    maxFiles: integer(20, 5000, '最多扫描文件；留空跟随预算档位'),
    maxFileBytes: integer(1024, 262144, '单个文件字节上限'),
    maxSkillLoads: integer(1, 2, '单次最多加载技能；留空跟随预算档位'),
  });
}

export function snapshotConfig(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return resolveConfig(options);
  const plain = {};
  for (const [key, reference] of Object.entries(options)) {
    const value = reference && typeof reference === 'object' && typeof reference.get === 'function' ? reference.get() : reference;
    if (value !== undefined) Object.defineProperty(plain, key, { value, enumerable: true });
  }
  return resolveConfig(plain);
}

export async function loadNativeConfigSchema() {
  try {
    const { default: z } = await import('@deepseek-ai/schemastery');
    if (typeof z.boolean().volatile !== 'function') throw new Error('Strong Skills settings require a DSH release with volatile Config support.');
    return createConfigSchema(z);
  } catch (error) {
    // Dependency-free contract tests / consumers without a Harness host. A real
    // Harness supplies the optional peer through its shared module resolver.
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('@deepseek-ai/schemastery')) throw error;
    return { '~standard': { version: 1, vendor: 'dsh-strong-skills', validate(value) {
      try { return { value: resolveConfig(value) }; } catch (cause) { return { issues: [{ message: cause.message }] }; }
    } } };
  }
}
