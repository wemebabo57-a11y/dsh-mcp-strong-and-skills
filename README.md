<div align="center">

# dsh-strong-skills

**让方法按需到场，让上下文保持轻量。**  
On-demand skills. Bounded context. Built for DeepSeek Harness.

[![Node.js ≥24.9](https://img.shields.io/badge/Node.js-%E2%89%A524.9-6d7950?style=flat-square)](https://nodejs.org/)
[![CI](https://github.com/wemebabo57-a11y/dsh-mcp-strong-and-skills/actions/workflows/ci.yml/badge.svg)](https://github.com/wemebabo57-a11y/dsh-mcp-strong-and-skills/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-cb603f?style=flat-square)](LICENSE)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime_dependencies-0-242720?style=flat-square)](package.json)
[![Tests: Node.js](https://img.shields.io/badge/tests-Node.js-6d7950?style=flat-square)](test)

[快速开始](#快速开始) · [插件设置](#插件设置与增强思考) · [能力一览](#能力一览) · [MCP 接入](#mcp-接入) · [上下文预算](#上下文预算)

</div>

![8 个按需技能、4 个工具入口、轻量上下文](docs/assets/hero.svg)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的轻量编码增强插件。**所有模型共享通用增强，DeepSeek V4 Pro 与 V4.1 Flash 1017 再获得专用工作策略**。内置 8 个按需技能、4 个工具入口、可关闭的增强思考，以及独立的 stdio MCP 服务。

模型继续使用宿主当前 profile 启用的编辑、终端、联网、浏览器与子代理工具。本插件在本地加载技能、检索文件，不在后台发起模型请求。

> **验证状态：** 自动化测试覆盖独立入口、设置保存、模型策略与工具；已在真实 DSH 0.2.1-rc.3 中验证设置页，以及增强开关关闭、刷新保持与恢复开启。中英文 320–420px 组件预览无溢出。没有发起付费模型请求，尚未进行模型能力基准评测，见[兼容性记录](docs/compatibility.md)。

## 快速开始

需要 **Node.js 24.9+**；原生插件要求 **DSH 0.2.1-rc.3 或同一兼容版本范围内的更新版本**。CLI/MCP 无第三方运行依赖；原生设置复用宿主提供的 Schemastery 配置库。浏览器分发文件已提交，安装时无需构建。旧宿主应先升级，以获得 volatile Config 与当前客户端插槽。

### 直接从 GitHub 安装（推荐）

确保 `dsh` 和 `pnpm` 都在 PATH 中（可先运行 `dsh --help` 与 `pnpm --version` 检查），即可直接从本仓库拉取并安装，无需先手动克隆：

```sh
# 下载仓库，并把插件加入 web profile
dsh plugin --profile web add github:wemebabo57-a11y/dsh-mcp-strong-and-skills

# 检查配置中出现 strong-skills / dsh-strong-skills
dsh --profile web --dump-config

# 启动；已有 DSH 进程请先退出再重新启动
dsh --profile web
```

这是 [DSH 官方支持的 GitHub 安装方式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md#installing-from-github-the-build-script-catch)。DSH 会下载源码、安装包并加载其 `dsh.bundle` 配置；本项目入口是可直接运行的 `.mjs`，不需要编译。仓库名是 `dsh-mcp-strong-and-skills`，安装后的包名是 **`dsh-strong-skills`**。

使用其他 profile 时，将以上三条命令中的 `web` 一起替换为实际名称。插件安装在 profile 中，不需要在每个代码项目里重复安装。

从旧版升级时，重新执行上面的 GitHub 安装命令，再重启相同 profile，即可拉取当前分支的更新。v0.2 新增独立设置页与扩展工具；完整变化见[更新记录](CHANGELOG.md)。

需要固定代码版本时，可在仓库来源后追加 `#提交SHA`，例如安装已发布的初始代码提交：

```sh
dsh plugin --profile web add github:wemebabo57-a11y/dsh-mcp-strong-and-skills#ebbe74359123ddf4c6cf6559a31abea2674eaa64
```

卸载时使用包名，然后重启对应 profile：

```sh
dsh plugin --profile web remove dsh-strong-skills
```

### 本地体验与源码安装

想先检查源码、体验 CLI 或参与开发时，可以手动克隆后安装本地目录：

```sh
git clone https://github.com/wemebabo57-a11y/dsh-mcp-strong-and-skills.git
cd dsh-mcp-strong-and-skills

# 先在本地体验技能与仓库检索
node bin/strong.mjs skill --query "排查登录报错并修复"
node bin/strong.mjs inspect --root . --action map --limit 30

# 将本地插件安装到 web profile，然后检查并启动
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh --profile web
```

安装命令会修改所选 DSH profile。原生模式会在每次调用时解析 **DSH 当前会话的工作目录**，适合多项目使用与目录切换。

若想先用临时覆盖配置试用，在仓库目录执行：

```sh
node bin/strong.mjs config --mode native --root . > strong.native.patch.yml
dsh --profile web --patch /absolute/path/to/strong.native.patch.yml
```

将 `/absolute/path/to/…` 替换为本机绝对路径；Windows 可用 `C:/path/to/…`。生成配置只创建本地 patch，不改 DSH 用户配置。已安装原生插件时，不要再叠加同一原生 patch。原生模式中的 `--root` 仅验证目录，不固定会话目录。

## 插件设置与增强思考

原生插件启用后，打开 **设置 → Strong Skills 编程增强**（英文界面显示 Strong Skills）。也可从 **插件 → dsh-strong-skills** 查看同一配置面板。更改通过 DSH 的 ConfigForms 保存至当前 profile，并在下一次请求/工具调用时读取；不使用浏览器本地存储代替宿主设置。表单保留只读、保存中、写入被拒绝和连接失败状态。

**v0.2.1 修复了入口被隐藏的问题：** 浏览器客户端加载后，独立设置入口立即注册；不再等待宿主设置表单才显示。表单暂不可用时，页面显示检查提示，恢复后自动显示控件。整个原生插件未安装、被停用或客户端加载失败时，仍需先恢复插件加载。

![真实 DSH rc.3 中的 Strong Skills 独立设置页](docs/assets/settings.png)

上图来自隔离的真实 DSH rc.3 测试实例，界面继承宿主主题。测试已验证关闭后刷新仍保持关闭，再恢复开启。

### 桌面端没有看到设置入口

桌面应用通常使用 **desktop profile**，终端示例中的 **web profile** 是另一个配置。安装到 web 不会替桌面应用安装插件。请在桌面侧栏的「插件」页面，确认 `dsh-strong-skills` 已安装并启用，然后通过「添加插件」重新安装当前来源，以更新到 v0.2.1 或之后版本：

```text
github:wemebabo57-a11y/dsh-mcp-strong-and-skills#main
```

安装完成后，完全退出并重新打开桌面应用，再打开「设置」，查找「Strong Skills 编程增强」。Desktop profile 由 Electron 应用管理，请从桌面端安装/更新，不要把 web profile 的 CLI 命令当作桌面安装命令。仅通过外部 MCP 客户端接入时，使用的是独立服务，不会给 DSH 桌面程序安装原生设置页。

### GitHub 显示旧 CI 失败

`b45707c` 的历史 CI #5 因 Windows LF/CRLF 换行比较失败；`f771abf` 已修复。GitHub 保留旧运行记录和旧通知，重新运行旧提交仍会检查旧代码。请查看 [main 的最新 CI](https://github.com/wemebabo57-a11y/dsh-mcp-strong-and-skills/actions/workflows/ci.yml?query=branch%3Amain)，而不是以历史通知判断当前版本。

| 设置 | 默认值 | 效果 |
| --- | --- | --- |
| 增强思考 | 开启 | 所有模型获得规划、契约核对、失败边界检查与有依据的验证指导 |
| 思考等级 | 均衡 | 深度模式增加一次有上限的反例检查，避免无限自审 |
| 澄清频率 | 多问一些 | 缺少会影响实现的关键信息时，合并询问 1–3 个问题；简单任务继续执行 |
| 模型策略 | 自动 | 识别官方 DeepSeek 别名使用专用策略；其他模型使用完整通用增强 |
| 工具集 | 扩展 | 4 个入口；精简模式保留 `strong_skill` 与 `strong_context` |
| 资源档位 | 均衡 | 控制扫描与输出上限；高级限制可单独覆盖 |

**关闭“增强思考”会移除插件额外的规划、自审、模型专用指导与澄清策略**，基础技能和工具仍可使用。插件的增强开关不改写服务商原生的 thinking / reasoning effort 参数；实际模型与 API 推理强度仍由 DSH 的模型设置决定。

通用增强对任何模型开放，不以 DeepSeek 为使用条件。Pro 专用策略侧重依赖关系、架构取舍与兼容性；Flash 专用策略侧重符号/诊断定位、小步验证和有依据的失败恢复。专用策略会遵循当前可用工具集，不引用已关闭的工具。

官方 API 的 `deepseek-v4-pro` 与 `deepseek-flash` 是滚动别名；截至 2026-10-25，后者对应 V4.1 Flash 1017。设置中的 `deepseek-v4.1-flash-1017` 是本插件的策略标识，**不会作为不存在的官方 API 模型名发送**，也不能锁定远端权重。自托管或代理使用其他模型标识时，可手动选择策略。详见[模型策略说明](docs/model-strategies.md)与[官方模型文档](https://api-docs.deepseek.com/quick_start/pricing/)。

## 能力一览

### 8 个按需技能

| 技能 | 帮助模型完成什么 |
| --- | --- |
| `code-delivery` | 理解现有实现、检查接口，按验收依据交付功能 |
| `debug` | 复现问题、缩小范围、定位根因，验证回归修复 |
| `refactor` | 保护已有行为，控制迁移范围与兼容性 |
| `testing` | 按风险选择测试，覆盖可观察行为与失败路径 |
| `frontend-design` | 根据内容确定布局、配色、交互和可访问性 |
| `security-review` | 按任务需要检查输入、权限与数据边界 |
| `performance` | 测量瓶颈，以前后证据评估优化 |
| `research` | 查阅官方文档，核对版本与技术适配 |

`strong_skill` 无参数时只列目录；`id` 精确读取技能，`query` 通过本地关键词匹配，默认只读最相关的一个。显式传 `limit: 2` 可读取两个，仍受 profile 限制。无匹配时返回简短目录，交由模型选择；已加载的正文保留在会话历史中。

前端技能优先尊重用户要求与现有品牌。新界面默认避免深蓝底、蓝紫渐变、无意义光晕和重复的大标题卡片，鼓励根据内容选择视觉方向。这些是指令与启发式建议，不能保证模型每次都遵守。

### 4 个工具入口

| 工具 | 调用方式 | 返回内容 |
| --- | --- | --- |
| `strong_skill` | `id` / `query` / 无参数 | 指定技能、相关技能或简短目录 |
| `strong_context` | `action: "map"` | 限量文件列表与文件类型计数 |
| ↳ | `action: "search"` | 字面关键词匹配的文件、行号与片段 |
| ↳ | `action: "read"` | 指定文件从 `start` 行开始的片段 |
| ↳ | `action: "diff"` | Git 工作树中未暂存的跟踪文件差异 |
| ↳ | `action: "checks"` | 已有项目脚本与验证配置，供模型选择执行 |
| ↳ | `action: "style"` | 常见默认配色与渐变的启发式建议，附文件位置 |
| `strong_code` | `action: "symbols"` | 有行号的声明、类、函数与导出索引 |
| ↳ | `action: "imports"` | 有界的静态 JS/TS 导入图与外部包摘要 |
| ↳ | `action: "diagnostics"` + `text` | 解析构建/检查报错，并补充安全可读的源码位置 |
| `strong_review` | 可选 `path` | 实际 diff 的风险位置、相关测试与已有检查建议 |

原生工具的参数示例：

```json
{"query": "排查登录报错并修复", "limit": 1}
```

上面的参数传给 `strong_skill`；下面的参数传给 `strong_context`：

```json
{"action": "search", "path": "src", "query": "StrongEngine", "limit": 10}
```

## MCP 接入

原生插件和 MCP 接入选择一种即可，避免重复工具与指令。

**DSH 内置 MCP 桥：** 在仓库目录生成配置，将 `--root` 指向目标项目。生成结果会填入当前 Node 与插件入口的绝对路径。

```sh
node bin/strong.mjs config --mode mcp --root /absolute/path/to/your-project > strong.mcp.patch.yml
dsh --profile web --patch /absolute/path/to/strong.mcp.patch.yml
```

官方桥给工具添加 `mcp__strong__` 前缀，例如 `mcp__strong__strong_code`。默认扩展模式提供 4 个工具，详见 [DSH MCP 桥文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)。

**其他 MCP 客户端：** 参考[完整配置示例](examples/mcp-client.json)，将以下路径替换为本机绝对路径：

```json
{
  "mcpServers": {
    "strong": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-mcp-strong-and-skills/bin/strong.mjs",
               "serve", "--root", "/absolute/path/to/your-project", "--profile", "lean"]
    }
  }
}
```

完成协议初始化后，客户端可发送以下 `tools/call` 请求：

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {"name": "strong_skill", "arguments": {"id": "debug"}}
}
```

服务只读取启动时指定的项目根目录；切换项目需重启服务。stdout 专用于 JSON-RPC，诊断写入 stderr。支持 tools、resources 与 `strong://skills/<id>` 技能资源；支持协商 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05` 协议版本。

独立 MCP 服务不继承 DSH 的设置页状态。可用启动参数选择增强方式，例如关闭额外思考并使用精简工具，或为自定义路由指定 Flash 策略：

```sh
node bin/strong.mjs serve --root /absolute/path/to/project --thinking off --tools compact
node bin/strong.mjs serve --root /absolute/path/to/project --model deepseek-v4.1-flash-1017 --thinking-level deep
```

## 上下文预算

默认扩展工具与均衡增强约 **1,104 tokens**；切换为精简工具并关闭增强思考可回到约 **606 tokens**。所有模式都**不预载技能正文**，不会后台调用模型或运行隐藏的多轮评审。数字为字符启发式估算，不是 DeepSeek tokenizer 或账单测量，也未计入宿主上下文与 MCP 包装，可自行复算：

```sh
node bin/strong.mjs budget
node bin/strong.mjs budget --thinking off --tools compact
```

| Profile | 单次结果字符上限 | 最多扫描文件 | 每次最多加载技能 |
| --- | ---: | ---: | ---: |
| `lean` | 4,000 | 400 | 1 |
| `balanced`（默认） | 6,000 | 800 | 2 |
| `thorough` | 12,000 | 2,000 | 2 |

表中上限是 **字符数**。默认检索只返回片段；过长结果保留合法 JSON 并标注截断，模型应缩小范围或按行读取。

原生插件配置还支持 `maxOutputChars`（2,000–20,000）、`maxFiles`（20–5,000）、`maxFileBytes`（1,024–262,144）、`maxSkillLoads`（1–2），均可在设置页的高级限制中修改。通过 `brandIntent` 描述既有品牌，或设置 `allowBrandColors: true`，可让样式检查尊重品牌配色。

## 工作方式与边界

```mermaid
flowchart LR
    Host[DSH / MCP 客户端] --> Gateway[通用增强 + 可选 DeepSeek 策略]
    Gateway --> Skills[strong_skill · 按需加载技能]
    Gateway --> Context[strong_context · 限量读取仓库]
    Gateway --> Code[strong_code / strong_review]
    Skills --> Model[模型结合宿主工具完成任务]
    Context --> Model
    Code --> Model
```

- 仓库工具只读，不执行项目脚本或任意命令。`checks` 返回的建议由模型结合任务与宿主权限决定是否执行。
- 默认排除生成目录、二进制、大文件和常见敏感路径，拒绝目录穿越与符号链接。Git 可用时遵循其 ignore 规则，否则明确说明仅使用内置排除规则。普通源码中的敏感信息仍可能被读取。
- `diff` 不含暂存区或未跟踪文件；不支持的 Git 环境会返回原因。`style` 是启发式建议，不是 CSS 解析器或品牌判定器。
- 插件不会安装外部 MCP 服务、改变模型权限或替代 DSH 的安全边界。

## 开发与验证

```sh
node bin/strong.mjs skill --id frontend-design
node bin/strong.mjs inspect --root . --action read --path package.json --start 1 --limit 20
node bin/strong.mjs inspect --root . --action checks
node bin/strong.mjs code --root . --action symbols --path src/engine.mjs
node bin/strong.mjs review --root . --path src
npm run check
npm test
npm run budget
```

测试覆盖中英文技能路由、原生宿主契约模拟、真实 stdio 子进程往返、路径边界、取消与输出上限。本地检查不等于真实 DSH 集成测试或模型能力评测。DSH 契约参考版本、上游链接与待验证项目见[兼容性记录](docs/compatibility.md)。

修改 `client/*.mjs` 后运行 `npm run build:ui` 更新已提交的浏览器分发文件；静态检查会拒绝过期 bundle。无需额外构建依赖。运行 `npm pack` 可生成本地分发 tarball，打包前会自动执行静态检查和测试；安装时无需构建。

## 参与贡献

欢迎通过 [Issues](https://github.com/wemebabo57-a11y/dsh-mcp-strong-and-skills/issues) 提交复现步骤、兼容性反馈或技能建议，也欢迎提交 Pull Request。修改后请运行 `npm run check` 与 `npm test`；涉及预算或工具 schema 时，再运行 `npm run budget`。更多说明见[贡献指南](CONTRIBUTING.md)；漏洞报告方式见[安全说明](SECURITY.md)。

本项目采用 [MIT License](LICENSE)。
