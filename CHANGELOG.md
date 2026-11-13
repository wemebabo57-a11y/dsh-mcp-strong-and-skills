# 更新记录

## 0.4.3-preview.2 — 2026-11-13（内置 Bash 重写 + 全链路性能）

包版本：`0.4.3-preview.2`。工具面、开关与配置字段不变：默认 6 个入口，开启 Shell 后 7 个；本版把内置 Bash 从单行分词器重写为高保真解释器，并完成 P0–P4 五组性能优化。

- **内置 Bash 重写为分层解释器**：`src/builtin-shell.mjs` 只保留薄适配层，执行交给 `src/shell/`：完整脚本词法分析（注释、续行、heredoc、引号、`[[ ]]`）、递归下降语法树、参数/数组/花括号/通配/算术/命令替换展开、执行器（列表、`&&`/`||`、管道、重定向、函数、子 shell、`set -e/-u/-x/-o pipefail`、`trap ... EXIT`）。不再按行切分，多行脚本、函数、`if/for/while/case`、`case ;&/;;&`、`for ((...))`、`while read` 均按 bash 语义执行。
- **参数与文本语义补齐**：`$?`/`$#`/`$@`/`$*`/`$$`、`${v:-}`/`${v:=}`/`${v:?}`/`${v:+}`、`${#v}`、`${v#pat}`/`${v##pat}`/`${v%pat}`/`${v%%pat}`、`${v:off:len}`（含负偏移）、`${v/pat/rep}`/`${v//pat/rep}`、`${!v}`、`${v^^}`/`${v,,}`、数组 `a=(...)`/`a[1]=`/`a+=(...)`/`${a[i]}`/`${#a[@]}`；赋值先于展开、`$( )` 失败不中止整行、管道阶段子 shell、`local` 可见调用者旧值、`cd -` 打印目录、退出码 127/126 与中文错误提示保持。
- **48 个 coreutils 与 sed/awk**：新增 `ls/mkdir/rm/mv/cp/touch/ln/chmod/stat/readlink/du/env/uname/df`、`cat/head/tail/wc/cut/tr/tee/nl/tac/paste`、`grep/find/xargs`、`sort/uniq/comm/diff`、`sed`、`awk`；`grep -r/-l/-o/-w/-E`、`find -name/-type/-maxdepth`、`xargs -n/-I/-0`、`sort -k/-t/-u/-r`、`sed -n/-i/-E/s///`、`awk -F/-v/BEGIN/END/数组/函数/getline` 等常用形态可用。内置命令补齐 `printf`（宽度/精度/复用格式/`%q`/`-v`）、`read`（`-r/-p/-n/-N/-d/-a`）、`getopts`、`mapfile/readarray`、`command/type`、`source`、`umask`、`trap` 等。
- **真 Bash 差分对齐**：新增 `scripts/parity-shell.mjs`，用 Git Bash 5.2.37 作离线 oracle，对 172 个脚本同时比较 stdout 与退出码；当前 **172/172 一致**。它只用于开发期验证，运行时仍使用纯 JS 解释器。
- **P0 输出预算裁剪（`src/budget.mjs`）**：`fitResult` 改为前缀字节表 + 二分批量裁剪，避免逐项 `JSON.stringify`、`structuredClone` 与每轮 pop。5000 项 / 4000 字符从 **1620.6 ms 降到 2.78 ms（约 583×）**，5000 项 / 24000 字符从 **1486.9 ms 降到 2.85 ms（约 522×）**；同时修正旧实现在 n≥2000 时直接返回最小占位对象、并未真正裁剪的问题。
- **P1 工作区（`src/workspace.mjs`）**：`_resolve` 按操作记忆化、inventory 改为流式异步生成器、search 提升大小写与 needle 计算并增加整串快路径、`_text` 只做一次 lstat、Git 祖先检测避免多余 spawn。实测 `list` 463→117 ms（3.9×）、`map` 917→200 ms（4.6×）、完整 `search` 1202→286 ms（4.2×）、提前命中 453→7.9 ms（57×）、子目录 72.6→1.6 ms（44×）。
- **P2 代码工具（`src/code-tools.mjs`）**：imports 用一次构建的解析索引替代 O(n×候选)、注释/字符串遮罩改为单遍、symbols 到上限即 `break`、review 的 inventory 与 checks 并行。CPU 基准 symbols 13.20→0.63 ms（21×）、imports 8.15→1.88 ms（4.3×）、无限制 symbols 26.85→1.84 ms（14.6×）；端到端 review 491.4→374.8 ms（−24%）。
- **P3 运行时与流（`src/engine.mjs`/`src/stream-output.mjs`/`src/browse.mjs`）**：冻结配置按对象身份缓存，跳过重复 64 KB 知识库 JSON 解析（toolsForConfig 89.86→0.74 µs，约 121×；可变配置仍每次完整校验）；输出尾部收集改为环形缓冲（128 B×4096 从 84.9→0.19 ms，约 447×）；浏览器 `wait` 改为 WaitGate，排在后面的 snapshot/screenshot 约 31 ms 就能打断原需 5 秒的等待。
- **P4 网页缓存（`src/web-tools.mjs`）**：`open` 增加规范化 URL 缓存（去 utm/fbclid/gclid/spm/ref/source 与 fragment、参数排序、`public|`/`private|` 命名空间、10 分钟 TTL、20 条/16 MiB LRU），`search` 缓存键做 NFKC/空白/大小写/词序归一化但保留引号与搜索操作符。实测 open 20 次 78.8→6.7 ms（11.7×）、search 24 个变体 375.1→16.2 ms（23.2×），失败结果不缓存。
- **验证**：`node --test` **436 项全部通过**；`node scripts/check.mjs` 与 `node scripts/build-ui.mjs --check` 通过；`scripts/parity-shell.mjs` 172/172；新增预算、工作区、代码工具、运行时、网页缓存与词法/coreutils 测试。
- **已知边界**：进程替换、关联数组、`select`/`coproc`、作业控制与部分 GNU 扩展仍未实现，完整清单见 `docs/shell-design.md`；`sed`/`awk` 为常用子集。受限令牌下不能把 Git Bash 作为运行时后端，内置解释器仍是 Windows 沙箱内的默认路径。

## 0.4.3-preview.1 — 2026-11-12（0.4.3 预览版）

包版本：`0.4.3-preview.1`。工具面与开关不变：默认 6 个入口，开启 Shell 后 7 个；本版集中修复“装了插件但 AI 不用”、Shell 绕过沙箱、输出被二次截断、搜索等待过久与提示词常驻开销。

- **Shell 成为默认执行路径**：开启「Shell 工具」后，插件注册常驻路由说明；同时安装 `tools/pre-execute` 拦截，凡宿主原生 `bash`/`pwsh` 调用且 `strong_shell` 对当前 Agent 可见，一律拒绝并提示改用 `strong_shell` 与设置中的后端。Shell 关闭、工具被限制、没有 Agent 或宿主不提供事件服务时不拦截，避免影响 MCP/旧宿主。
- **Shell 继承 DSH 沙箱**：每次调用按当前会话解析 `sandboxPolicy`；`danger-full-access` 才无约束执行，`read-only`/`workspace-write` 通过宿主 `ctx.sandbox.confine` 生成的 `argv` 启动，并使用其拒绝签名与运行器失败规则。缺少沙箱服务或 `workspaceRoot` 时返回 `SANDBOX_UNAVAILABLE` 并拒绝执行，不再静默降级为当前用户权限。内置 Bash 的进程内写入在只读模式下直接拒绝，外部程序同样包装。
- **输出真正达到 64 KiB 且保留首尾**：每路仍收集 64 KiB，但改为保留前 1/4 与后 3/4，插入省略字节标记；`StrongEngine` 不再把 `strong_shell` 结果交给 `fitResult(maxOutputChars)` 二次截断，`thorough` 下不再只剩约 9.4K 字符。结果保持合法 JSON，`stdoutTruncated`/`stderrTruncated` 继续可用，hint 建议缩小命令或直接看尾部。
- **后台子进程不再拖住调用**：直接子进程退出后只留短暂排空窗口即完成，孙进程继续持有 stdout 时销毁管道；`sleep 4 & echo started` 可快速返回，`&` + `wait` 仍按超时处理。
- **编码回退**：输出先按严格 UTF-8 解码，失败后尝试 GBK，再退回有损 UTF-8；`chcp 936` 的中文输出不再变成乱码。
- **Windows 沙箱兼容**：DSH 的 Windows ACL 受限令牌运行器无法启动 Git Bash（MSYS 报 `couldn't create signal pipe, Win32 error 5`）。`auto` 在受限模式下改用插件内置 Bash；固定 `git-bash` 返回可操作的 `SHELL_UNAVAILABLE`，不再无约束执行或返回空输出。PowerShell 5.1 加入 `pwsh` 候选，Electron 宿主的沙箱运行器会保留 `ELECTRON_RUN_AS_NODE` 与宿主 `NODE_OPTIONS` preload。
- **内置 Bash 补齐常用命令**：新增 `printf`（格式、宽度、精度、转义）、`seq`（步长、补零、格式）与 `exit`，避免这些命令落到沙箱下无法启动的 MSYS 可执行文件。
- **搜索并发竞速**：`strong_web` 的 DuckDuckGo 与 Bing 改为同时发起，首个非空结果获胜并中止另一方；单引擎 4 秒、整体 8 秒上限。本机此前每次未命中缓存都要等 DuckDuckGo 连接超时约 11 秒，实测 5 个查询中位耗时从 11,079 ms 降到 251 ms，首条结果一致。页面打开仍保留 15 秒、2 MB、SSRF/DNS 检查与 10 分钟缓存。
- **提示词继续压缩**：常驻策略、设计/思考/模式块、PTC 与 Shell 说明合计从 1,403 字符 / 1,179 tokens 降到 1,094 字符 / 894 tokens（约 −22% / −24%）；含工具 schema 的默认扩展面从 1,561 降到 1,436（Pro 上下文），CLI 通用估算为 1,383。默认、精简、Shell、精简+Shell 分别为 1,383 / 517 / 1,753 / 888 tokens，仍低于 1,600 / 650 / 1,900 的静态门禁。
- **设置与文档口径修复**：设置页与重新生成的 `client/client.js` 明确说明开启后 AI 直接使用 `strong_shell`、原生 bash/pwsh 会被接管、命令继承沙箱；删除“不经过沙箱/审批”的旧文案。README 与兼容性记录同步更新。
- **MCP 边界标注**：独立 stdio MCP 服务没有 DSH 会话沙箱。显式 `--shell on` 时 `strong_shell` 仍可用，但初始化提示词现在明确说明它按当前用户权限运行，并建议需要沙箱时改用原生插件；README 的 MCP 与安全边界同步标注，不再写成继承 DSH 沙箱。
- **验证**：197 项自动化测试通过，覆盖路由拦截及跳过条件、沙箱包装/失败关闭、Windows 受限模式后端回退、Electron 运行器环境、只读写入拒绝、首尾截断、后台收尾、GBK 解码、内置 `printf`/`seq`/`exit` 与搜索竞速；`node scripts/check.mjs`、`node scripts/build-ui.mjs --check` 通过。真实网络 5 查询基准见上。另用 DSH 0.2.1-rc.3 无头会话与真实模型复验四次短指令：未点名工具时模型自行选择 `strong_shell`，内置 Bash 在 `workspace-write` 沙箱中返回正确输出；固定 `pwsh` 经 Windows PowerShell 5.1 在沙箱内成功；固定 `git-bash` 返回明确的 `SHELL_UNAVAILABLE` 并拒绝在沙箱外执行，模型未尝试绕过。详见发行说明。

## 0.4.2 — 2026-11-10（维护版）

包版本：`0.4.2`。本版不新增常驻工具，保持默认 6 个入口、开启附加 Shell 后 7 个入口；修复四项会在真实使用中直接暴露的正确性问题。

- **Bing 搜索解包**：`strong_web` 的 Bing 结果解析会识别 `bing.com/ck/a` 跳转，解出 `u=a1…` 的 base64url 目标、解码 HTML 实体，并只接受 http(s) 地址；无法解包时保留原链接。结果继续按规范化 URL 去重，搜索不再返回 Bing 跳转页。
- **`strong_shell` 超时收尾**：超时或取消后，除终止进程树外，还会在 750 ms 内强制完成结果，并监听子进程 `exit` 作为兜底；不再因孙进程持有 stdout 导致工具一直等到超时被外层截断。超时后会销毁输出流并 unref 子进程。
- **`strong_browse` 点击校验**：点击 DOM 谓词在找不到目标时返回 `false`，动作层抛出 `BROWSER_TARGET_MISSING`，不再把不存在元素的点击当成成功。
- **PTC 截图序列化**：截图附件的图像块改由模块级 `WeakMap` 按工具结果传递，`execute` 返回的 JSON 不再带有非枚举 `_imageBlocks`；`render` 仍会追加 image 块，PTC 不再因 “value is not lossless JSON” 拒绝截图结果。
- **验证**：168 项自动化测试、`node --test` 全部通过；`node scripts/check.mjs` 与 `node scripts/build-ui.mjs --check` 通过。真实网络复验 Bing 搜索与正文打开，真实 Edge 复验缺失元素报错和 1280×900 截图；PTC 真实截图需安装 0.4.2 后复验，序列化回归由原生工具测试覆盖。开发过程中未发送模型生成请求。

## 0.4.1 — 2026-11-10（维护版）

包版本：`0.4.1`。本版不新增常驻工具，保持默认 6 个入口、开启附加 Shell 后 7 个入口；集中修复安全、并发、路径与预算问题，并进一步压低常驻提示词。

- **`strong_web` 安全与缓存**：搜索缓存与 `r1…rN` 别名改为按项目根隔离，只解析该项目最近一次搜索，避免跨项目读取旧结果；增加根缓存 TTL/LRU 上限。默认拒绝 localhost、回环、私有、链路本地与云元数据地址，手动跟随重定向时逐跳复查，并提供 `webAllowPrivate` 显式开关。响应改为流式读取并在 2 MB 上限处中止，按响应头/meta 解码字符集；实体解码不再因非法码点抛错；搜索结果按规范化 URL 去重。
- **非 ASCII diff 路径**：`strong_review` 与 `strong_context diff` 使用 `core.quotePath=false`，并兼容 Git 的 C 引号八进制文件名；中文、空格与特殊字符路径不再被遗漏或误判。
- **`strong_browse` 生命周期**：并发打开同一项目复用同一个启动 Promise；启动超时/失败会杀掉子进程并清理临时 profile；关闭动作排入会话队列，避免与截图/点击并发；截图改为会话内的独立目录与递增文件名，关闭时随 profile 清理；`fullPage` 可按整页截图，`type` 改用 CDP `Input.insertText`，补充 PageUp/PageDown/Home/End/Delete，修正 `scroll y=0` 与 `wait` 实际等待时间。
- **工作区与代码工具**：新增无内容的 `list`/采样清单，`map`、代码 inventory 与 `strong_review` 不再为每个文件读取完整正文；统一 `fitResult` 输出预算，避免多次 JSON 序列化；`diff` 支持 `unstaged|staged|all`，`search` 支持 `literal|terms` 与 `caseSensitive`；符号扫描补充类/对象方法，截断提示改为按实际资源档位生成。
- **Shell 与 MCP**：Shell 后端探测按平台/后端/路径/WSL 发行版/PATH 缓存，减少每次命令重复探测；内置 Shell 的路径检查加入真实路径（realpath）校验，阻止目录链接逃逸，并新增 `sort`、`uniq`、`tr`、`cut`；MCP 输入改为分块收集后一次拼接，消除大帧的二次复杂度。
- **校验、策略与知识库**：引擎、代码工具与 Shell 共用同一套参数校验，覆盖 number/boolean/minLength 等类型与范围；浏览提示只在工具实际注册时出现，视觉能力缓存增加 TTL 与有界淘汰；知识库本地检索与 GitHub 一样按全部词匹配，本地扫描上限继承配置，项目设定解析增加记忆化；技能加载返回 `appliedLimit` 与 `limitReason`，不再静默截断。
- **CLI**：新增 `--version`/`-v`/`version`，参数解析支持 `--flag=value`，并新增 `--web-private on|off` 控制内网访问；同时保留重复参数与缺少值的报错。
- **预算**：常驻提示词、工具描述与策略提示进一步压缩。默认扩展工具约 **1,473 tokens**（6 个入口），精简 + 关闭增强思考约 **562 tokens**（2 个入口），附加 Shell 约 **1,798 tokens**（7 个入口），精简 + Shell 约 **886 tokens**（3 个入口）；静态门禁仍为默认 ≤1,600、精简 ≤650、Shell ≤1,900。
- **验证**：164 项自动化测试、`node --test` 全部通过；`node scripts/check.mjs` 通过。新增覆盖包括跨项目缓存、SSRF/实体解码、非 ASCII diff、diff scope、terms 搜索、代码方法、内置 Shell 文本命令与链接逃逸、Shell 缓存、CLI 版本/等号参数等。


## 0.4.0 — 2026-11-08（正式版）

包版本：`0.4.0`。

- **提示词工程重写**：通用增强、澄清策略、Pro/Flash 策略、深度检查、Claude 模式与 we need to 思维改用短句和常见词，删除重复要求与长定语，保留原有工作流、证据、自审与汇报边界。常驻提示词更短、更好读。
- **新增 `strong_web`（默认开启，扩展工具集）**：不启动浏览器的联网入口。`search` 返回 JSON 结果列表（`id`、标题、网址、域名、摘要），模型可挑选后用 `open` 按 `id` 或网址读正文、描述与前 40 条链接。DuckDuckGo HTML 搜索失败时回退 Bing；最近 10 次查询缓存 10 分钟；单页 2 MB、15 秒超时。
- **新增 `strong_browse`（视觉模型）**：用本机 Chrome/Edge/Brave 的 headless 模式与 CDP 驱动，后台运行、不显示窗口。支持 `open`、`snapshot`、`screenshot`、`click`、`type`、`press`、`scroll`、`wait`、`close`。截图保存到临时目录，并在模型支持图片输入时作为 image 内容返回；文本模型只得到路径与提示。`auto` 只给视觉路由注册，`on` 强制，`off` 关闭；`browserPath` 可指定浏览器路径。每个项目一个会话，动作串行，空闲 3 分钟关闭。
- **插件内置 Bash（`shellBackend: "builtin"`）**：插件内的 JavaScript POSIX 子集解释器，不要求系统已经安装 Bash。支持引号、变量、`$()`、管道、`&&`、`||`、`;`、`>`、`>>`、`<`、`2>`、`1>&2` 与通配符；内置 `echo`、`cd`、`pwd`、`ls`、`cat`、`head`、`tail`、`grep`、`wc`、`mkdir`、`touch`、`rm`、`cp`、`mv`、`test`/`[`、`env`、`export`、`sleep`、`which`、`basename`、`dirname` 等；外部程序按 PATH 直接启动，不再经过第二层 shell。`auto` 在 Windows 依次尝试 Git Bash → WSL → PowerShell 7 → cmd，最后落到内置 Bash；POSIX 先找 `bash`，再落到内置 Bash。其他后端行为不变。
- **PTC 模式优化**：新增 PTC 指导，说明工具就是 `run_code` 里的代码函数、独立查询用 `Promise.all` 并行、只返回筛选字段或短摘要、不要打印整份 JSON、浏览器用完 `close`、截图只在需要看页面时使用。DSH 暴露 `run_code` 时自动注入；`ptcMode` 支持 `auto`、`on`、`off`。新工具 schema 保持紧凑，结果有明确上限。
- **设置、CLI 与 MCP 全链路**：设置页新增联网开关、浏览器 auto/on/off、PTC auto/on/off、浏览器路径，Shell 后端下拉加入「内置 Bash」；CLI 新增 `--web`、`--browse`、`--ptc`、`--browser-path`；MCP 将 `strong_web` / `strong_browse` 标记为开放世界，`strong_shell` 继续标记为非只读、可破坏。
- **工具面与预算**：扩展模式默认 6 个入口（`strong_skill`、`strong_context`、`strong_code`、`strong_review`、`strong_web`、`strong_browse`），开启附加 Shell 后为 7 个；精简模式仍为 2 个。默认估算 1,560 tokens，精简 + 关闭增强思考 632 tokens，附加 Shell 1,886 tokens，均在静态预算门禁内。
- **兼容保留**：0.3.1 的项目设定与知识库、6000 字符知识预算、8 个按需技能、无限 token 模式、Claude 模式与 we need to 思维继续工作；旧 `bashTool` 继续迁移为 `shellTool`；运行时依赖仍为 0。
- 150 项自动化测试与静态预算检查通过；真实无头 Edge 页面与 1280×900 截图、真实 DuckDuckGo 搜索与正文打开已验证。开发过程中未发送模型生成请求。

## 0.4.0-preview.1 — 2026-11-07（0.4 预览版）

- **版本号校正**：本次功能以 0.4 线的预览版发布，不从 0.3.1 跳到更高版本；稳定后再发布 0.4.0，后续按 0.5.0 正常推进。

- **可选附加 Shell（默认关闭）**：新增第 5 个工具 `strong_shell`，后端可选 `auto`、`git-bash`、`wsl`、`bash`、`pwsh`、`cmd`。Windows 的 `auto` 依次尝试 Git Bash → WSL → PowerShell 7 → cmd；POSIX 使用 Bash。可另设 `shellPath` 绝对路径和 `wslDistro`。
- **真正使用 Bash**：命令用选定可执行文件直接启动，不通过 `shell:true` 交给 Windows 默认 shell 转义。Git Bash 和 WSL 均以非交互式 `bash --noprofile --norc -c` 执行，让模型直接使用 Bash 语法。
- **不替换原生能力**：DSH 默认 shell、原生命令与文件工具保持不变；`strong_shell` 只是用户显式开启的附加通道，不经过 DSH 原生沙箱或审批。设置页警告明确说明：工作目录从项目内开始，但命令以当前用户权限运行，可访问项目外文件，仅应在可信项目中开启。
- **边界控制**：相对 `cwd` 经过词法与真实路径校验；过滤明显敏感的环境变量；stdin 关闭；stdout/stderr 各限制 64 KiB；默认超时 60 秒（1–120 秒可调）；取消或超时终止子进程树。它是便捷命令通道，不是操作系统级隔离。
- **全链路开关**：设置页、原生 Config、CLI `--shell on|off`、`--shell-backend`、`--shell-path`、`--wsl-distro`、生成的 native/MCP patch 与独立 MCP 服务共用配置。MCP 将 `strong_shell` 标记为非只读、可破坏、非幂等、开放世界。
- **兼容迁移**：旧 profile 的 `bashTool` 迁移为 `shellTool`；显式 `shellTool` 优先。默认工具面仍为 4 个，开启后为 5 个；精简工具集下为 2 + 1 个。
- 0.4.0 与 0.5.0 的两次尝试及其发行版、标签均已撤回，不作为正式版本保留；本版以 0.4 预览版重新实现。
- 137 项自动化测试通过；静态检查覆盖默认与启用 Shell 的预算，真实 DSH 组件检查覆盖第 5 个工具的动态注册。未发送模型生成请求，也未访问真实联网仓库。

## 0.5.0 — 2026-11-07（已撤回，未作为正式版本发布）

> 本版直接移除 0.4.0 的 Bash 工具，未提供真正的可切换 Shell；其发行版与标签已删除。0.4.0-preview.1 以可选 `strong_shell` 取代本版方案，以下保留原始记录。


- **移除 0.4.0 的 `strong_bash` 与 `bashTool` 开关**：它并非“把默认 shell 改成 Bash”，而是在 DSH 原生 shell（Windows 为 `pwsh`）和文件工具之外额外注册的命令工具；Windows 上实际调用 `cmd.exe`，并绕过原生沙箱/审批。
- 旧提示“内置 Bash 已开启：模型可以执行命令并修改文件”把 DSH 已有能力说成新能力，已随工具一并删除；设置页、原生 Config、CLI `--bash`、MCP 暴露、文档与测试全部清理。
- 工具面恢复为 4 个；旧 profile 中残留的 `bashTool` 会被接受但忽略，避免升级后配置加载失败。
- 127 项自动化测试通过；未发送模型生成请求。

## 0.4.0 早期尝试 — 2026-11-07（已撤回，未作为正式版本发布）

> 本版 `strong_bash` 在 Windows 实际调用 `cmd.exe`，不能选择 Git Bash/WSL，也不改变 DSH 默认 shell；其发行版与标签已删除。0.4.0-preview.1 以可选多后端 `strong_shell` 取代本版方案，以下保留原始记录。

- **新增可选内置 Bash**（`bashTool`，默认关闭）：开启后原生插件注册第 5 个工具 `strong_bash`，模型可在工作区执行构建、测试、格式化、Git 等非交互命令，返回退出码、标准输出、错误输出与超时/截断状态。
- 设置页、原生 Config、CLI `--bash on|off`、`config` 生成的原生/MCP patch 与独立 MCP 服务共用同一开关；关闭时不注册、不列出、不执行该工具。默认工具面仍为 4 个。
- 命令限制在工作区根目录及相对 `cwd`，过滤明显敏感的环境变量，stdout/stderr 各限制 64 KiB，默认超时 60 秒（可设 1–120 秒），支持取消并终止子进程树。它继承当前用户权限，并非操作系统级沙箱。
- 134 项自动化测试通过；新增覆盖开关与工具发现、MCP 注解、CLI 往返、路径越界拒绝、超时、输出上限、取消与敏感环境变量不继承。未发送模型生成请求。

## 0.3.1 — 2026-11-01

- 在专用设置页加入本地目录、单个文本文件和公开 GitHub 仓库的来源登记，支持公共库与项目专属库、分支/提交、编辑和移除。
- 每个项目可保存最多 1200 字的设定卡片，按当前工作目录及最长父路径自动匹配，跨会话复用。修改根目录时迁移专属库关联，删除项目时保留公共来源。
- 复用 `strong_context` 的 `knowledge` / `project` action，目录、关键词命中、行范围逐级按需读取，输出来源与覆盖范围；不增加工具数量，不加载整库。
- 知识结果独立限制为最多 6000 字符，即使开启无限模式也保留预算；0.3.0 的全模型引导、原有工具及技能无限行为保留。
- 支持 CLI/MCP `--knowledge-file`；GitHub 延迟访问公开 API，进程内缓存 10 分钟，无嵌入模型或额外运行依赖。
- 126 项自动化测试、12 项真实 rc.3 组件检查通过；真实隔离设置页验证公共/专属来源与项目卡片保存和刷新保持，中英文移动预览无溢出。GitHub 读取使用模拟接口验证，未发送模型请求。

## 0.3.0 — 2026-10-31

包版本：`0.3.0`（次版本功能更新）。

- **修复 we need to 思维“勾选后没用”**：旧版同时要求增强思考开启且当前模型名称含 `deepseek`/「深度求索」，其他模型或关闭增强思考时完全无效。现在仅取决于 `weNeedToThinking` 开关：所有模型、有无模型名称、增强思考开启或关闭时都进入最终提示词，并明确要求先写下 `We need to …` 目标，再按目标、事实、证据、行动、验证与风险展开。
- 增强通用策略：要求先读约定、相关实现、调用方与公开契约；复杂任务按依赖排序并定义可观察验收标准；最小完整改动覆盖错误、边界、并发、兼容与可访问性；完成后自审并依次做定向测试、构建/类型检查、集成或手动验证。
- 加强 Pro 的依赖/兼容/取舍分析、Flash 的符号定位与小步验证，以及深度模式的有界反例检查；收紧“汇报简洁、不逐字复述内部推理”的边界。
- **新增无限 token 模式**（`unlimitedTokens`）：取消本插件默认输出与读取预算；工作区最多 5,000 文件、单文件 262,144 字节、读取最多 5,000 行且单行不截断；`strong_code`/`strong_review` 使用更高扫描与条目预算；强制 4 个工具入口；单次最多 8 个技能正文；要求完整目标、约束、验收矩阵、至少两个方案和尽可能全面的验证。
- 设置页新增第三个模式开关，中英文提示、旧 profile 默认值、Config 校验、CLI `--unlimited on|off`、MCP 参数转发与预算诊断全链路接通。
- 静态检查补充无限模式预算断言，真实宿主检查覆盖所有模型引导、增强思考关闭时继续生效与无限策略注入。
- 116 项自动化测试与 9 项真实 DSH rc.5 组件集成检查通过；未发起模型生成或付费请求，不声称已完成模型能力基准评测。

## 0.2.2previre.1 — 2026-10-26

包版本：`0.2.2-previre.1`。

- 修复 DSH rc.3 原生注入缺陷：原先读取不存在的 `context.modelSelection`，导致 we need to 开关已开启但引导未进入最终提示词。改为在组装瀑布流完成后读取宿主本步骤的 `variables.model`，只更新本插件自己的片段。
- 补充 `deepseek-ai/DeepSeek-V4.1-Flash-1017`、对应无前缀名称及 V4 Pro 0813 明确版本名称的专用策略匹配，不改写实际 API 模型名。
- 增加真实 DSH rc.3 模块集成脚本与 CI，验证最终提示词、模型切换、会话隔离、实时开关和完整自定义提示词优先级；修复前使用同一宿主路径可复现未注入，修复后通过。
- 111 项自动化测试及 7 项真实宿主组件集成检查通过；不据此声称模型能力已提升或保证思考句式改变。

## 0.2.2previre — 2026-10-25

包版本：`0.2.2-previre`（SemVer 预发行版本）；展示名保留 `0.2.2previre`。

- 独立设置页新增默认关闭的「Claude 模式」与「we need to 思维」，通过当前 DSH profile 保存并在下一次请求时读取。
- Claude 模式向所有模型提供简洁、温暖的前端设计方向，以及目标、证据、行动和验证驱动的任务处理指导；尊重用户要求与现有品牌。
- we need to 思维使用短示例引导共同目标与行动，不强制开头、不禁止特定措辞，也不要求展示内部推理。仅当前模型名称含 `deepseek` 或「深度求索」时启用，不依据 provider 或手动策略预设绕过检测。
- 关闭增强思考时暂停两个模式的推理指导，Claude 前端设计偏好仍可保留。旧配置默认不启用新模式。
- 为 CLI 添加模式参数与预算诊断，保持 4 个工具入口、按需技能加载及输出上限；不新增后台模型调用或运行依赖。
- 108 项自动化测试通过；在隔离的真实 DSH rc.3 中验证两个模式的开关保存、刷新保持与增强思考关闭时的暂停提示。当前中英文控件在 320–420px 预览无溢出。

## 0.2.1 — 2026-10-25

- 独立设置入口不再被宿主表单的就绪状态隐藏，中文名称改为「Strong Skills 编程增强」。
- 表单尚未可用或被撤下时，保留可见页面并提示连接、版本、当前配置及启用状态；恢复后自动显示可编辑控件。
- 增加设置入口的加载与恢复回归测试；补充 Desktop/web profile 区别与历史 CI 失败排查说明。

## 0.2.0 — 2026-10-25

- 所有模型共享增强编码流程，增加可关闭的规划、自审、澄清与深度检查。
- 为 DeepSeek V4 Pro 与 V4.1 Flash 1017 提供额外工作策略；自动识别当前步骤模型，保留其他模型的通用增强。
- 新增 Strong Skills 独立设置区域和插件配置面板，通过 DSH ConfigForms 持久保存并读取实时配置。
- 新增 `strong_code` 与 `strong_review`，提供符号、静态导入、诊断上下文与实际差异风险检查。
- 支持扩展/精简工具切换，保持原有按需技能与输出预算；增加 CLI 增强选项与模型策略诊断。
- 提交可直接加载的浏览器分发文件，新增设置保存、拒绝恢复、动态开关、模型策略及工具测试。

## 0.1.0 — 2026-10-24

- 首次开源：8 个按需技能、仓库上下文工具、原生 DSH 插件与独立 stdio MCP 服务。
- 加入默认设计风格约束、上下文预算与 GitHub 安装说明。