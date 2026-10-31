# 通用增强与 DeepSeek 专用策略

所有模型共享工具、按需技能和增强编码流程。模型策略是在这些能力之上增加有针对性的工作方法，不是模型白名单，也不限制其他模型。

| 层 | 行为 |
| --- | --- |
| 通用增强 | 先读约定、相关实现、调用方与公开契约；复杂任务按依赖排序并定义可观察验收标准；最小完整改动覆盖错误、边界、并发与兼容；完成后自审并按证据验证 |
| V4 Pro | 跨模块改动先看依赖图与兼容性，比较最多两个方案，结合实际差异检查风险 |
| V4.1 Flash 1017 | 先以符号、导入和诊断工具确认精确位置，再做可验证的小步修改；截断时缩小范围，失败时根据证据调整 |

每套专用策略都会检查工具集；精简模式不会要求调用被关闭的扩展工具。没有匹配到支持的 API 别名或明确版本名称时，自动使用通用增强。自托管或代理的其他自定义名称可以手动选择模型策略。热修版识别 `DeepSeek-V4.1-Flash-1017`、`DeepSeek-V4-Pro-0813` 及其 `deepseek-ai/` 前缀形式，不区分大小写。

## 模型名称与原生推理

截至 2026-10-25，官方公开 API 使用 `deepseek-v4-pro` 与 `deepseek-flash`；Flash 别名对应 V4.1-Flash-1017，Pro 对应 V4-Pro-0813。别名随服务商更新，插件无法固定远端权重。本地策略 ID `deepseek-v4.1-flash-1017` 只用于选择指导文本，绝不替换 API 请求的模型名。[官方模型与定价](https://api-docs.deepseek.com/quick_start/pricing/)、[更新记录](https://api-docs.deepseek.com/updates/)。

DeepSeek 的 API thinking 与 reasoning effort 由宿主模型设置控制。插件不接管或私自修改模型、provider、temperature 或 reasoning effort。[官方 thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode/)、[DSH 模型选择契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts)。

## 增强开关

`enhancedThinking: false` 删除插件额外的规划、自审、澄清与模型专用指导。基础工具和技能依然可用；模型本身的 API thinking 设置保持宿主管理。

`clarification` 支持 `auto`、`more`、`few`。即使选择多问，也只在缺少会改变实现的决策时合并询问 1–3 个问题；不会对每个小改动例行提问，或要求用户重复已提供的信息。

`thinkingLevel: deep` 增加一次有上限的反例检查，发现具体问题才扩大调查。插件不要求展示内部推理，不在后台发送模型请求，也不承诺未经测量的能力或基准提升。

## 0.3.0 三种增强模式

三项配置都默认为 `false`，旧 profile 升级后不自动增加指导。Claude 模式与 we need to 模式是行为引导，无限 token 模式是预算与完整度档位；三者都不切换模型、不修改 API 的 thinking/reasoning effort。

| 配置 | 生效条件 | 追加指导 |
| --- | --- | --- |
| `claudeMode` | 开启，所有模型可用 | 前端参考清晰层级、留白、温暖中性色和克制强调色；用户与品牌优先。增强思考开启时，还引导明确目标、依据证据分解行动并验证 |
| `weNeedToThinking` | **仅需开启；所有模型生效，不依赖增强思考或模型名称** | 先写下 `We need to …` 目标，再按目标、事实与假设、最小证据、行动、验证、风险展开 |
| `unlimitedTokens` | **仅需开启；所有模型生效，独立于增强思考** | 取消本插件输出/读取预算，强制 4 个工具与最多 8 个技能，要求完整规划、实现与尽可能全面的验证 |

### we need to 思维

旧版有一个实际缺陷：只有增强思考开启且当前模型名称含 `deepseek` 或「深度求索」时才注入。其他模型，以及关闭增强思考的用户，勾选后完全看不到效果。0.3.0 删除了这个门禁；`getModeState()` 只读取开关，模型信息仅用于诊断。

引导不要求固定输出英语，也不要求展示隐藏推理；它要求模型先在内部建立 `We need to …` 目标，需要时给出简短思路摘要。插件只能添加上下文引导，不能改写模型权重，也不能保证每种模型都逐字复制该格式。能力收益应由具体任务评测判断。

### 无限 token 模式

开启后强制扩展工具集，普通模式的 `lean`/`balanced`/`thorough` 输出与扫描上限被绕过：工具结果不截断，工作区最多 5,000 文件、单文件 262,144 字节、读取最多 5,000 行，`strong_code`/`strong_review` 使用更高预算，单次最多读取 8 个技能正文。增强思考开启时自动按 `deep` 处理。

“无限”仅指本插件不再主动节省 token；服务商上下文窗口、API 计费、宿主权限和模型自身输出限制仍然存在。它适合完整阅读、系统重构和深度审查，不建议作为日常默认。

### 预算

上下文增量采用字符启发式估算，不是 tokenizer 或计费统计：

- 默认均衡扩展配置约 **1,270 tokens**；`lean` + 精简工具 + 关闭增强思考约 **643 tokens**。
- Claude 模式约增加 **173 tokens**；we need to 模式约增加 **157 tokens**；两者同时开启约增加 **330 tokens**，总计约 **1,600 tokens**。
- `deepseek-flash` 均衡扩展配置约 **1,358 tokens**，同时开启两个模式约 **1,689 tokens**。
- 无限模式默认约 **1,550 tokens**；精简工具并关闭增强思考时约 **1,172 tokens**，但结果与读取范围不再截断。

模式默认关闭，因此普通默认预算不受影响。`budgetReport` 会区分“请求开启”和“实际生效”，无限模式还报告 `maxResultChars: "unlimited"`、`maxFiles: 5,000` 与 `maxSkillLoads: 8`。

### 模型选择与 MCP

原生插件在宿主提示词组装完成后读取本步骤接受的 `variables.model`；没有交互选择的宿主可使用本 Agent 的 `options.model`，不会回退到上一次请求头。显式提供 `context.modelSelection` 的宿主优先使用该值。每次重新计算，不保留上一个模型。

we need to 与无限模式不依赖模型名称，因此独立 stdio MCP 服务也可以通过 `--we-need-to on` / `--unlimited on` 启用；`--model` 仍只选择 Pro/Flash 专用策略。

0.2.2-previre.1 的模型检测热修仍是 0.3.0 的基础：它修正了 DSH rc.3 中 `context.modelSelection` 不存在、开关已保存却未注入的问题。`scripts/check-host.mjs` 使用真实宿主组件验证该路径；检查通过只证明提示词包含引导，不证明一定改变推理句式或提高代码质量。
