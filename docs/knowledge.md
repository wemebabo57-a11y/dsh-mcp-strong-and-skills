# 项目设定与按需知识库（0.3.1）

在「设置 → Strong Skills 编程增强 → 项目设定与知识库」管理。来源与项目卡片通过 ConfigForms 保存在当前 Harness profile，刷新、新建会话或重启后仍可使用；桌面与 web profile 各自独立。

## 项目卡片

展开「添加项目」，填写名称、宿主电脑上的项目根目录绝对路径，以及最多 1200 字的项目设定。建议包含技术栈、目录职责、关键接口、编码约定、构建和测试命令，然后点击「保存项目」。

当前工作目录或其子目录自动匹配对应项目；嵌套项目优先匹配最长根目录，不会加入其他项目的卡片。设定变更在下一次请求中生效，不需要模型再次扫描整个仓库来了解基本约定。

卡片由用户维护，不会自动学习或同步代码变化；模型仍须核对任务相关源码。卡片会占用请求上下文，并非“永久记住后零 token”；架构和命令改变后请更新。插件不自动生成项目文件或提交 Git。

## 导入来源与作用域

展开「导入知识来源」，填写唯一 ID（字母、数字、`_`、`-`）、名称、类型、位置及适用范围。

| 来源 | 示例 | 行为 |
| --- | --- | --- |
| 本地目录 | `D:/docs/team` 或 `/home/me/docs` | 只读引用原位置，可导入代码目录 |
| 单个文本文件 | `D:/docs/contracts.md` | 只暴露该文件，不读取相邻文件 |
| GitHub | `https://github.com/owner/repo` 或 `github:owner/repo` | 公开仓库，分支/提交填写在 ref，留空使用默认分支 |

保存的是**来源登记**，不扫描或下载整库。第一次目录、检索或读取调用才访问 GitHub API 和相关正文，不执行仓库代码、安装脚本或 shell。私有仓库请先自行克隆，再填本地路径；插件不读取账号令牌。

支持 UTF-8 文本和代码；PDF、图片及二进制没有 OCR/文档转换。敏感文件、Git 元数据、依赖/构建目录、符号链接与远端 submodule 不作为知识正文。网络失败、权限不足或限流时，会返回对应来源的错误。

公共库适用于此 profile 的所有项目；专属库只通过本插件暴露给当前匹配项目，检索顺序先专属、后公共。这是资料筛选，不替代操作系统权限。模型工具不能修改来源或项目设定。

编辑项目根目录会同时迁移其专属库关联；删除项目会移除它的专属来源登记，公共库保留。移除来源不删除原文件或仓库。

## 按需工具调用

仍使用原来的四个默认工具入口（开启内置 Bash 后另有 `strong_bash`），精简模式也可调用知识库。

```json
{"action":"knowledge"}
```

以上作为 `strong_context` 参数，只返回当前项目可用来源的小目录（最多 20 项），不含正文、不联网；用 `start` 分页。

```json
{"action":"knowledge","query":"authentication"}
{"action":"knowledge","path":"shop-reference","query":"authentication"}
{"action":"knowledge","path":"shop-reference"}
{"action":"knowledge","path":"shop-reference/docs/auth.md","start":20,"limit":40}
{"action":"project"}
```

依次为综合检索、指定库检索、文件目录、行范围读取、当前项目卡片。命中包含库 ID、路径、行号，GitHub 结果还包含树版本 SHA。检索正文作为资料，不可覆盖用户指令。

## 独立上下文预算

- 常驻只加入当前项目卡片、可用公共/专属库数量和简短调用提示，不加入全部来源名称、路径或正文。
- 搜索默认 6 条命中，最多 12 条；读取最多 80 行；知识结果最多 6000 字符，轻量档还受较低结果上限约束。**包括无限模式也遵守此预算**，原有其他工具与技能的无限行为保留。
- 综合搜索最多访问 8 个来源。本地每库最多扫描 200 文件，单文件最多 128 KiB。
- GitHub 元数据最多 2 MiB、保留最多 5000 个可用文件。每库按路径/文档名排序后最多检查 8 个候选文件，一次调用最多下载 12 个正文。`coverage` 和 `truncated` 表明覆盖不完整；无命中不代表全仓不存在，请指定库或文件继续。
- 本地沿用字面检索，GitHub 按词做字面匹配，没有向量模型或嵌入费用。资料不触发后台模型调用。
- GitHub 已读正文和元数据只在当前进程缓存 10 分钟、最多 64 项；重启后按需获取，不是离线镜像。ref 填提交可固定资料版本。

## CLI / MCP

复制 [knowledge.json 示例](../examples/knowledge.json)，替换路径和仓库地址：

```sh
node bin/strong.mjs inspect --root /work/shop --knowledge-file ./knowledge.json --action knowledge
node bin/strong.mjs inspect --root /work/shop --knowledge-file ./knowledge.json --action knowledge --query authentication
node bin/strong.mjs serve --root /work/shop --knowledge-file ./knowledge.json
node bin/strong.mjs config --mode native --root /work/shop --knowledge-file ./knowledge.json
```

CLI/MCP 的 `--root` 决定项目匹配，原生模式使用宿主当前会话目录。原生 patch 嵌入 `knowledgeConfig` 字符串；MCP patch 转发配置文件绝对路径。MCP 初始化包含匹配卡片，正文仍按需读取。

## 验证范围

本轮 126 项自动化测试含跨项目隔离、本地来源、模拟 GitHub、路径过滤、限额、错误、原生/MCP 与表单。12 项真实 DSH rc.3 组件检查含最终项目卡片、目录一致性和实时更新。

隔离的真实 rc.3 Web 设置页已验证添加项目、公共/专属来源、刷新保持和恢复默认，浏览器错误为空；中英文 320/360/420px 组件预览无横向溢出。GitHub 未用真实联网仓库做端到端测试，未发送模型生成请求。0.3.0 的 rc.5 记录属于历史验证，不计作本轮复测。
