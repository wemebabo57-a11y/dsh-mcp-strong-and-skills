import { resolveConfig } from './config.mjs';

// Host-only peer. The standalone CLI/MCP core does not import Schemastery.
export function createConfigSchema(z) {
  const choices = (values, fallback, description) => z.union(values.map(value => z.const(value))).default(fallback).description(description).volatile();
  const integer = (min, max, description) => z.number().min(min).max(max).step(1).description(description).volatile();
  return z.object({
    profile: choices(['lean', 'balanced', 'thorough'], 'balanced', '上下文预算档位'),
    enhancedThinking: z.boolean().default(true).description('增强思考：方案、边界检查与必要澄清').volatile(),
    claudeMode: z.boolean().default(false).description('Claude 模式：前端视觉参考与结构化解题；思考部分受增强思考总开关控制').volatile(),
    weNeedToThinking: z.boolean().default(false).description('we need to 思维：所有模型可用，以“We need to …”目标、证据、行动与验证引导思考').volatile(),
    unlimitedTokens: z.boolean().default(false).description('无限 token 模式：不截断输出，按最大范围读取上下文与技能，要求穷尽式规划与验证；消耗显著增加').volatile(),
    thinkingLevel: choices(['balanced', 'deep'], 'balanced', '增强程度；不改写模型 API reasoning effort'),
    clarification: choices(['auto', 'more', 'few'], 'more', '关键信息不明时的澄清偏好'),
    modelPreset: choices(['auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'generic'], 'auto', '模型指导预设；不切换实际模型'),
    toolSet: choices(['compact', 'expanded'], 'expanded', '工具集合：基础 2 个或扩展 6 个；可选 Shell 另计'),
    webTool: z.boolean().default(true).description('扩展模式下提供 strong_web：搜索返回 JSON 结果，open 按 id 或网址抓正文').volatile(),
    webAllowPrivate: z.boolean().default(false).description('允许 strong_web 访问 localhost/内网；默认关闭以防 SSRF').volatile(),
    browseTool: choices(['auto', 'on', 'off'], 'auto', 'strong_browse 真实无头浏览器：auto 只给视觉模型注册并返回截图，off 关闭，on 强制开启'),
    ptcMode: choices(['auto', 'on', 'off'], 'auto', 'PTC 模式提示：auto 只在宿主提供 run_code 时附加'),
    browserPath: z.string().max(1000).default('').description('可选：Chrome/Edge/Brave 可执行文件绝对路径；留空自动发现').volatile(),
    // No schema default: an old profile with bashTool: true must arrive with
    // shellTool undefined so resolveConfig can migrate it. The core default is false.
    shellTool: z.boolean().description('启用附加 Shell 工具 strong_shell（默认关闭）；不替换 DSH 默认 shell，也不改变原生命令与文件工具').volatile(),
    shellBackend: choices(['auto', 'git-bash', 'wsl', 'bash', 'pwsh', 'cmd', 'builtin'], 'auto', 'Shell 后端；内置 Bash 不依赖系统 Shell；自动在 Windows 优先 Git Bash，其次 WSL、PowerShell、cmd，最后内置 Bash'),
    shellPath: z.string().max(1000).default('').description('可选：Shell 可执行文件的绝对路径；留空自动发现').volatile(),
    wslDistro: z.string().max(100).default('').description('可选：WSL 发行版名称；留空使用默认发行版').volatile(),
    bashTool: z.boolean().description('旧版兼容字段；等价于 shellTool，显式 shellTool 优先').volatile(),
    allowBrandColors: z.boolean().default(false).description('尊重指定品牌的蓝紫配色').volatile(),
    brandIntent: z.string().max(200).default('').description('已有品牌或用户配色要求').volatile(),
    knowledgeConfig: z.string().max(65536).default('').description('公共/项目知识来源与项目设定；通过插件专用面板编辑').volatile(),
    maxOutputChars: integer(2000, 20000, '单次结果字符上限；无限 token 模式下自动取最大值'),
    maxFiles: integer(20, 5000, '最多扫描文件；留空跟随预算档位'),
    maxFileBytes: integer(1024, 262144, '单个文件字节上限'),
    maxSkillLoads: integer(1, 2, '单次最多加载技能；无限 token 模式下自动放宽到 8'),
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
