# AGENTS.md

本文件是给在这个仓库工作的 AI 代理的本地约定。开始修改前先读。

## 本机 DSH 插件自动更新（重要）

本机 DSH profile：`C:/Users/QQ201/.dsh/profiles/desktop`。

项目 0.4.1 发布后，本机曾停留在 0.4.0，原因是 profile 把依赖固定到了 tag：

```json
"dsh-strong-skills": "github:wemebabo57-a11y/dsh-mcp-strong-and-skills#0.4.0"
```

DSHMarket 检查 Git 安装更新时，会把 `#0.4.0` 当作要跟踪的 ref。此时 `current` 和 `latest` 都解析到同一个 tag commit（0.4.0 是 `19af22f`），所以 `updateAvailable=false`。核心插件管理器的 Versions 只对 registry 包生效，Git 安装的插件没有版本列表；Git 插件实际依赖 DSHMarket 的更新检查（无 ref 时按版本号，有 ref 时按 commit）。之前能自动更新，是因为当时依赖是浮动的，日志里记录的是按 commit 更新。

**本机 profile 必须保持浮动依赖，不要加 `#tag`，也不要写 `#main`：**

```json
"dsh-strong-skills": "github:wemebabo57-a11y/dsh-mcp-strong-and-skills"
```

原因：

- 无显式 ref 时，DSHMarket 会读取默认分支 HEAD 的 `package.json` 版本，与已安装版本比较。每次发版只要 main 上的 `version` 增加，就能自动识别更新。
- 写成 `#0.4.0` / `#0.4.1` 会固定到 tag，永远只比较该 tag 的 commit，不会再发现新版本。
- 写成 `#main` 虽然也会动，但它按 commit 比较，会把未发版的提交也当成更新；保持无 ref 才会按版本号比较。
- GitHub Release 页面和 tag 仍然要正常创建，但本机 DSH 的自动检查依据是默认分支上的 `package.json` 版本，不是 Release 资产。

### 每次发版的顺序

1. 修改 `package.json` 的 `version`，同步 CHANGELOG、README、docs。
2. 提交到 `main`。
3. 创建并推送 tag（例如 `0.4.2`）。
4. 推送 `main` 和 tag，创建 GitHub Release。
5. 本机 DSH 重新检查时会看到 main 上的版本增加；更新后重启 DSH 重新加载插件。

### 手动同步本机 profile

如果 DSH 界面暂时没有刷新，可在 profile 目录执行：

```powershell
cd C:/Users/QQ201/.dsh/profiles/desktop
& "D:/ai/ds/resources/runtime/primary-runtime/dependencies/node/bin/node.exe" `
  "D:/ai/ds/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" `
  install --ignore-scripts --no-frozen-lockfile
```

然后重启 DSH。`--no-frozen-lockfile` 只在依赖声明变化、lockfile 尚未更新时需要；正常安装可直接执行 `pnpm install`。

检查是否装对：

```powershell
(Get-Content C:/Users/QQ201/.dsh/profiles/desktop/node_modules/dsh-strong-skills/package.json | ConvertFrom-Json).version
```

## 本项目没有 dist

本项目源码直接运行，没有 `dist/` 构建产物：

- `package.json` 的 `main` 是 `./src/index.mjs`
- `exports` 指向 `./src/index.mjs` 和 `./client/client.js`
- `files` 不包含 `dist`
- 0.3.0、0.4.0、0.4.1 的 tag 树以及 0.1.0–0.5.0 的历史 tgz 都没有 `dist` 条目

不要为本项目创建 `dist`。如果看到 `dist`，那通常来自其他插件或 DSH 自身的构建/缓存；`src/workspace.mjs` 里的 `dist` 只是通用忽略目录名。
