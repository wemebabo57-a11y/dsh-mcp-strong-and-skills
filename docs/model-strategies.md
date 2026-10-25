# 通用增强与 DeepSeek 专用策略

所有模型共享工具、按需技能和增强编码流程。模型策略是在这些能力之上增加有针对性的工作方法，不是模型白名单，也不限制其他模型。

| 层 | 行为 |
| --- | --- |
| 通用增强 | 查约定、核对调用契约，复杂任务给简短计划，确认失败边界并适度验证；信息缺失时询问会改变实现的关键问题 |
| V4 Pro | 跨模块改动先看依赖图与兼容性，比较最多两个方案，结合实际差异检查风险 |
| V4.1 Flash 1017 | 先以符号、导入和诊断工具确认精确位置，再做可验证的小步修改；截断时缩小范围，失败时根据证据调整 |

每套专用策略都会检查工具集；精简模式不会要求调用被关闭的扩展工具。没有匹配到 DeepSeek 官方别名时，自动使用通用增强。自托管或代理的自定义名称可以手动选择模型策略。

## 模型名称与原生推理

截至 2026-10-25，官方公开 API 使用 `deepseek-v4-pro` 与 `deepseek-flash`；Flash 别名对应 V4.1-Flash-1017，Pro 对应 V4-Pro-0813。别名随服务商更新，插件无法固定远端权重。本地策略 ID `deepseek-v4.1-flash-1017` 只用于选择指导文本，绝不替换 API 请求的模型名。[官方模型与定价](https://api-docs.deepseek.com/quick_start/pricing/)、[更新记录](https://api-docs.deepseek.com/updates/)。

DeepSeek 的 API thinking 与 reasoning effort 由宿主模型设置控制。当前 DSH 在每步准备阶段捕获模型选择，并拒绝准备后改写推理强度。插件因此不接管或私自修改模型、provider、temperature 或 reasoning effort。[官方 thinking 指南](https://api-docs.deepseek.com/guides/thinking_mode/)、[DSH 模型选择契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts)。

## 增强开关

`enhancedThinking: false` 删除插件额外的规划、自审、澄清与模型专用指导。基础工具和技能依然可用；模型本身的 API thinking 设置保持宿主管理。

`clarification` 支持 `auto`、`more`、`few`。即使选择多问，也只在缺少会改变实现的决策时合并询问 1–3 个问题；不会对每个小改动例行提问，或要求用户重复已提供的信息。

`thinkingLevel: deep` 增加一次有上限的反例检查，发现具体问题才扩大调查。插件不要求展示内部推理，不在后台发送模型请求，也不承诺未经测量的能力或基准提升。

## 0.2.2previre 可选模式

展示名为 `0.2.2previre`，运行包版本为合法 SemVer 预发行版本 `0.2.2-previre`。两项新配置都默认为 `false`，旧 profile 升级后不自动增加模式指导。

| 配置 | 生效条件 | 追加指导 |
| --- | --- | --- |
| `claudeMode` | 开启，所有模型可用 | 前端参考清晰层级、留白、温暖中性色和克制强调色；用户与品牌优先。增强思考开启时，还引导明确目标、依据证据分解行动并验证 |
| `weNeedToThinking` | 开启、增强思考开启，且当前实际模型名称含 `deepseek`（不区分大小写）或「深度求索」 | 以共同目标、所需证据、最小行动和验证的简短示例，引导任务导向的工作方式 |

Claude 模式是视觉偏好与任务处理方式的参考，不切换模型、不模仿 Claude 身份，也不声称知道其内部思维链。关闭 `enhancedThinking` 后仍可使用 Claude 前端设计偏好，其任务处理指导停止。

we need to 模式不要求固定开头，不禁止 `let me`，不强制输出英语，不要求展示隐藏推理。插件只能添加上下文引导，不能改写模型权重或保证把内部思考转变为某种语言。能力收益应由具体任务评测判断。

检测仅读取当前步骤捕获的 `modelSelection.model`（或诊断调用提供的 `modelId`），每次重新计算，不保留上一个模型。`vendor/DeepSeek-R1` 可匹配；provider 名称含 DeepSeek、手选 `modelPreset: deepseek-v4-pro`，或没有当前模型名称，均不构成启用条件。这个名称检测只决定可选模式是否适用，不用于推断模型 API 能力；Pro/Flash 专用策略的自动检测仍使用官方精确别名。

原生插件可以从 DSH 获得当前步骤的模型选择。独立 stdio MCP 服务没有这项信息，不能仅凭 `--model` 策略预设启用 we need to 引导；Claude 模式仍可使用。

上下文增量采用字符启发式估算：增强思考开启时 Claude 模式约增加 173 tokens，已匹配当前 DeepSeek 模型的 we need to 模式约增加 99 tokens，两者同时生效约增加 272 tokens。数字不是 tokenizer 或计费统计；模式默认关闭，因此原默认预算不变。`budgetReport` 的模式诊断区分开关偏好与实际生效状态，便于检查模型不匹配、缺少模型信息或增强思考关闭的情况。
