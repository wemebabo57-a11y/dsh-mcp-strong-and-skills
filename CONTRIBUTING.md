# 参与贡献

欢迎通过 [Issues](https://github.com/wemebabo57-a11y/dsh-mcp-strong-and-skills/issues) 报告问题或讨论改进，再提交范围清晰的 Pull Request。安全问题请按 [SECURITY.md](SECURITY.md) 的方式报告。

## 本地开发

需要 Node.js 24.9 或更新版本。项目使用原生 ES modules 与 Node.js 内置测试运行器，没有第三方依赖，也不需要构建或运行 `npm install`。

```sh
git clone https://github.com/wemebabo57-a11y/dsh-mcp-strong-and-skills.git
cd dsh-mcp-strong-and-skills
npm run check
npm test
```

CI 在 Ubuntu、Windows 和 Node.js 24、26 上执行相同检查。检查通过不代表已完成真实 DSH 宿主集成测试；修改宿主契约或 MCP 行为时，请在 PR 中说明验证环境和仍未验证的部分。

## 提交改动

- 说明要解决的问题、修改后的行为和验证结果；修复问题时提供最小复现。
- 保持运行时零第三方依赖、按需加载技能和有限输出的设计。涉及路径、权限或协议边界时，补充能证明行为的回归测试。
- 功能、CLI 参数或配置改变时，同步更新相应文档和示例。
- 提交前运行 `npm run check` 和 `npm test`；涉及打包内容时，用 `npm pack --dry-run` 检查文件清单。
- 不要提交本机生成的 `strong.native.patch.yml`、`strong.mcp.patch.yml`、缓存、压缩包、个人路径或凭据。示例使用明显的占位路径和虚构数据。

请在 PR 中区分自动化检查、真实宿主验证与模型效果观察，避免把模拟测试描述为完整集成验证。
