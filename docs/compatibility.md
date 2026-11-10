# DeepSeek Harness compatibility

Initial contract review on 2026-10-24; updated for v0.4.1 on 2026-11-10 against official upstream source and real DSH 0.2.1-rc.3/rc.5 components (rc.3-compatible contracts).

## 0.4.1 security, lifecycle and budget hardening — 2026-11-10

Version 0.4.1 is a maintenance release with no new resident tools. The expanded surface remains six entries by default and seven with the optional shell. It fixes cross-project state, untrusted network and path handling, browser lifecycle races, and duplicated validation/output budgeting while preserving the 0.4.0 feature set.

`strong_web` now scopes search cache entries and `r1…rN` aliases to each workspace root and resolves aliases only from that root's latest search; the root cache has TTL and LRU bounds. By default it rejects localhost, loopback, RFC1918/private, link-local, and cloud metadata addresses, rechecks every redirect hop, and exposes `webAllowPrivate` as an explicit opt-in. Responses are streamed with a 2 MB abort bound and decoded using the HTTP/meta charset; entity decoding is safe for invalid code points; search results are deduplicated by canonical URL.

`strong_review` and `strong_context diff` pass `core.quotePath=false` and decode Git C-quoted octal paths, so non-ASCII, spaced, and escaped filenames remain visible. `strong_browse` deduplicates concurrent launches with a pending-session promise, kills the child and removes the temporary profile on launch failure, serializes `close` through the session queue, keeps screenshots in a per-session directory with sequence names, and removes them with the profile. `type` uses CDP `Input.insertText`, `fullPage` is supported, and PageUp/PageDown/Home/End/Delete plus corrected scroll/wait semantics are available.

Workspace and code tools use a content-free listing/sampling path for maps and inventories instead of reading every file, share a single output budgeter, expose `diff` scopes (`unstaged`, `staged`, `all`) and search modes (`literal`, `terms`, `caseSensitive`), and derive symbol-limit notes from the active profile. Engine, code, and shell tools share one argument validator. Shell backend probing is cached by platform/backend/executable/WSL distribution/PATH, the builtin shell resolves real paths before allowing file operations and adds `sort`, `uniq`, `tr`, and `cut`, and MCP frames are collected in chunks and joined once. Vision capability caching has a five-minute TTL with bounded eviction, and browse policy hints follow actual registration. The CLI supports `--version`, `-v`, `version`, `--flag=value`, and `--web-private on|off`; skills report `appliedLimit` and `limitReason`; local knowledge search uses all-term matching, inherits configured scan limits, and memoizes project policy parsing.

Verification in this working copy: **164 automated tests**, including cross-root web cache isolation, SSRF and entity safety, non-ASCII diff paths, diff scopes, terms search, code methods, builtin text helpers and link-escape rejection, shell cache identity, browser schema, CLI version/equals forms, and knowledge term matching. `node scripts/check.mjs` passes with 6 tools / 1,473 estimated tokens, 2 tools / 562 tokens, 7 tools / 1,798 tokens, and 3 tools / 886 tokens. No model inference was sent.

## 0.4.0 web, headless browser, built-in Bash and PTC — 2026-11-08

Version 0.4.0 keeps the 0.3.1 knowledge tools and the selectable shell, and adds three surfaces. The expanded tool set now registers six entries by default — `strong_skill`, `strong_context`, `strong_code`, `strong_review`, `strong_web`, `strong_browse` — while `strong_shell` remains an explicit seventh entry. Compact mode stays at two entries.

`strong_web` is a plain fetch-based reader, not a browser. `search` posts to DuckDuckGo HTML, falls back to Bing, and returns JSON items with stable aliases (`r1`, `r2`, …), title, URL, domain and snippet. `open` accepts an alias from the per-root cache (10-minute TTL, last 10 queries) or an absolute http(s) URL, and returns title, description, extracted text and up to 40 links. Per-request limits are 15 seconds and 2 MB; non-HTML responses are rejected with an explicit error. Page scripts are not executed.

`strong_browse` discovers a local Chrome, Edge, Brave or Chromium binary (or `browserPath`), launches it with `--headless=new --remote-debugging-port=0 --user-data-dir=<temp>`, and drives it over CDP using Node's global WebSocket. Supported actions are open, snapshot, screenshot, click, type, press, scroll, wait and close. Sessions are per workspace root, serialize actions, and close after three minutes idle. Screenshots are written under the OS temp directory. When the active route reports `image` in `resolveModelInfo(...).inputModalities`, the PNG is saved through `ctx.get('attachments').saveImage(...)` and emitted as an image content block; otherwise only the path and a hint are returned. Registration is gated on that same capability check when `browseTool === 'auto'`; `on` forces registration and `off` disables it.

The new `builtin` shell backend is a JavaScript POSIX-subset interpreter inside the plugin. It supports quoting, variables, `$()`, pipelines, `&&`/`||`/`;`, `>`/`>>`/`<`/`2>`/`1>&2` and globbing, plus built-ins such as echo, cd, pwd, ls, cat, head, tail, grep, wc, mkdir, touch, rm, cp, mv, test/[, env, export, sleep, which, basename and dirname. External programs are resolved through PATH plus PATHEXT and spawned without a second shell. With `shellBackend: 'auto'`, Windows tries Git Bash → WSL → PowerShell 7 → cmd and then falls back to `builtin`; POSIX tries `bash` and then `builtin`, so an OS shell is no longer required. Built-in path resolution rejects escapes from the workspace root; external commands and the command itself still run with the current user's permissions and are not an OS sandbox.

PTC guidance is emitted when `ptcMode` is `on`, or when it is `auto` and the host exposes a `run_code` tool through `ctx.tools.get('run_code')`. It explains that registered tools are code functions, that independent calls can run under `Promise.all`, that results should be narrowed rather than printed whole, and that browser sessions should be closed. Tool schemas remain compact and results stay bounded.

Verification in this working copy: **150 automated tests**, including stub-fetch search parsing/caching, real built-in-shell execution and Windows PATH casing, PTC gating, web/browser registration gates, CLI round-trip and MCP annotations. `node scripts/check.mjs` passes with 6 tools / 1,560 estimated tokens, 2 tools / 632 tokens and 7 tools / 1,886 tokens. A real headless Edge run opened example.com and produced a 1280×900 PNG that was visually checked; live DuckDuckGo search and page open were exercised. No model inference was sent.

## 0.4.0-preview.1 selectable shell tool — 2026-11-07

Version 0.4.0-preview.1 is the 0.4-line preview of the selectable shell. The earlier 0.4.0 and 0.5.0 attempts were withdrawn and are not part of the formal release line. The optional `strong_shell` tool is **off by default** and is registered only when `shellTool === true`; the default plugin surface remains four tools. It is an additional command path, not a switch for the DSH native shell: DSH still owns its native command/file tools, and neither their configuration nor their sandbox/approval behavior is changed by this plugin.

The plugin resolves and launches the selected executable directly (`shell:false`), so Windows command quoting is not delegated to `cmd.exe`. Available backends are `auto`, `git-bash`, `wsl`, `bash`, `pwsh` and `cmd`. On Windows, `auto` tries Git Bash (the standard `C:\Program Files\Git\bin\bash.exe` location and `PATH`), then probes WSL with `wsl -l -q`, then PowerShell 7, then `ComSpec`. On POSIX, `auto` uses Bash. `shellPath` may pin an absolute executable and must agree with an explicit backend; `wslDistro` selects a WSL distribution. Git Bash and WSL execute `bash --noprofile --norc -c <command>`; PowerShell uses `-NoLogo -NoProfile -NonInteractive -Command`, and cmd uses `/d /s /c`.

The working directory starts at the workspace root or a validated relative `cwd`. Lexical and realpath checks reject absolute paths, parent traversal, symlinks/junctions and missing directories. The child receives an allowlisted non-secret environment, no stdin, and stdout/stderr are each capped at 64 KiB. The default timeout is 60 seconds (1–120 seconds configurable); timeout or cancellation kills the process tree with `taskkill /T /F` on Windows and a POSIX process-group signal. These are convenience bounds, not an OS sandbox: the command runs with the current user's permissions and can access paths outside the project. It does not pass through DSH native sandboxing or approval, so the UI warns users to enable it only in trusted projects.

The native Config adds volatile `shellTool`, `shellBackend`, `shellPath` and `wslDistro` fields. Legacy profiles with `bashTool` are migrated to `shellTool` when the latter is absent; an explicit `shellTool` wins. The CLI accepts `--shell on|off`, `--shell-backend`, `--shell-path` and `--wsl-distro`; generated native/MCP patches forward the same values. MCP lists `strong_shell` only when enabled and annotates it as non-read-only, destructive, non-idempotent and open-world.

Verification in this working copy: **137 automated tests**, including real Git Bash/Bash execution, exit codes, relative cwd, path-escape rejection, secret-environment filtering, 64 KiB truncation, timeout/abort tree termination, config migration, native live registration, CLI round-trip and MCP discovery/call. Static checking covers both default and shell-enabled budgets. The real-host component check expects five registrations while the default visible surface stays four. No live model inference or remote repository request was used. This establishes contract and execution behavior, not model response quality.

## 0.5.0 removal of redundant Bash tool — 2026-11-07（已撤回，未作为正式版本发布）

> The 0.4.0 and 0.5.0 attempts were deleted and are not kept as formal releases or tags. The corrected implementation is published as `0.4.0-preview.1`; the notes below are retained as history.


Version 0.5.0 removes the `strong_bash` tool introduced in 0.4.0. DSH already exposes native command execution and file editing: `dsh-tool-pwsh` is active on Windows, `dsh-tool-bash` is active on POSIX, and the file tools are always available. Enabling the plugin's extra tool did not grant those capabilities. It also did not change the default shell; on Windows it ran through `cmd.exe`, and it bypassed the native sandbox/approval path. The `bashTool` setting, CLI flag, MCP exposure and native config field were removed. Legacy `bashTool` values are accepted and ignored so existing profiles still load. Verification: 127 automated tests and 12 real rc.3 component checks; no model inference or live network access.

## 0.4.0 optional built-in Bash — 2026-11-07（已撤回，未作为正式版本发布）

The new volatile boolean `bashTool` defaults to false and reuses the existing ConfigForms/native/CLI/MCP configuration path. When enabled, the native plugin registers a fifth tool, `strong_bash`, through a live `when` predicate; MCP lists it only in that case and marks it non-read-only/destructive/open-world; the CLI accepts `--bash on|off` and the dedicated `bash` subcommand requires the flag. Default tool discovery remains four tools.

Execution is intentionally a bounded convenience shell rather than an OS sandbox: commands inherit the user's permissions, run with stdin closed in the workspace root (or a validated relative `cwd`), receive only an allowlisted non-secret environment, and are capped at 64 KiB per output stream. The default timeout is 60 seconds (1–120 seconds configurable) and cancellation kills the child process tree. Symlink/junction cwd escapes, parent traversal, absolute paths, NUL bytes and malformed arguments are rejected. This does not prevent a command from accessing resources allowed by the user's OS account; only enable it for trusted projects.

Verification in this working copy: **134 automated tests**, including five Bash tests that exercise opt-in discovery, exit codes, relative cwd, escape rejection, output truncation, timeout termination, abort handling and secret-like environment filtering. No live model inference or remote repository request was used.

## 0.3.1 projects and on-demand knowledge — 2026-11-01

The new `knowledgeConfig` volatile string persists project cards and source registrations through the existing ConfigForms surface. Native final assembly resolves the current working directory only when this configuration is present; the matching card and a short source-count hint are injected without reading library bodies. The existing `strong_context` gateway handles project cards, catalog, search and line reads. Project sources are filtered at every call, including cache hits. MCP uses its configured root and marks the gateway open-world when an available source uses GitHub.

Verification in this working copy: 126 automated tests; 12 real published rc.3 component checks including final project cards, per-Agent isolation, current-directory consistency and live edits; an isolated rc.3 Web browser verifies adding project cards plus shared/private sources, reload persistence and reset with no runtime errors. EN/ZH component previews at 320/360/420px have no horizontal overflow. GitHub HTTP paths, excluded files, caching, errors and caps are tested with mock responses, not a live remote repository. No user profile or model inference was used. The rc.5 results below are the historical 0.3.0 record, not a new claim of rc.5 retesting. See [knowledge usage and limits](knowledge.md).

## 0.3.0 all-model guidance and unlimited mode — 2026-10-31

Version 0.3.0 changes the optional we-need-to mode from a model-gated hint into an explicitly selected, all-model behavioral instruction. In 0.2.2 it required both `enhancedThinking` and a current model name containing `deepseek` or 「深度求索」; every other model, and every session with enhanced thinking off, silently ignored the checked switch. That gate was the reported “勾选后没用” defect. `getModeState()` now activates the guidance whenever `weNeedToThinking === true`; model selection is diagnostic only. The policy explicitly asks the model to write “We need to …” as an internal goal, then work through goal, known facts/assumptions, minimum evidence, action, verification, and risk, while allowing the user's language and a short public rationale. This is still prompt guidance: it does not change model weights or guarantee a visible chain of thought.

`unlimitedTokens` is a new volatile boolean, default false, using the same ConfigForms/native/CLI/MCP path. It forces the expanded four-tool surface, disables plugin output truncation, expands workspace reads to 5,000 files / 262,144 bytes per file / 5,000 lines, permits up to eight complete skill bodies, and raises `strong_code`/`strong_review` scan budgets. It is independent of `enhancedThinking`; when enhanced thinking is on, it forces the deep level. “Unlimited” means this plugin stops imposing its own savings budgets; it does not create provider context, bypass host permissions, or change billing.

Verification: **116 automated tests** plus **9 real-host component checks** in `scripts/check-host.mjs`. The host script imports published Cordis, Agent, Scope and SystemPrompt implementations, calls the real `assembleContextFor()` and `installModelSelection()`, and checks the final rendered prompt, current model changes, cross-Agent isolation, live switches, all-model guidance, enhanced-thinking-off behavior, unlimited policy injection, and complete user-prompt precedence. It uses no credentials, user profile, server or model inference. It verifies injection and configuration behavior, not model response quality.

## 0.2.2-previre.1 prompt-injection correction — 2026-10-26（历史）

> This section records the previous hotfix. Its DeepSeek-only mode gate was removed in 0.3.0; the current all-model behavior is described above.


The original native callback incorrectly expected `context.modelSelection`. The published rc.3 `assembleContextFor()` supplies only Agent, scope, and optional signal. Its real `installModelSelection()` captures the current route and publishes `variables.model` / `variables.provider` after its assembly waterfall delegates. As a result, the original mode could be saved and enabled but absent from the final policy. This was reproduced with the user's exact model name, `deepseek-ai/DeepSeek-V4.1-Flash-1017`; the desktop app's packaged rc.3 Agent code was also inspected read-only and uses the same contract. Earlier UI and hand-built context fixtures did not cover this defect.

The hotfix registers an outer assembly waterfall, waits for the real host to finish, then rebuilds only `strong-skills:policy` using that accepted route. It preserves other sections, variables, tools, and host complete-prompt precedence. An explicit context selection is supported when supplied; Agent options are the fallback for entry points without captured variables. Previous request headers and global default-model settings are not used as a current-model substitute. Explicit version names also map to their matching Pro/Flash guides without changing the API route.

Verification: 111 automated tests plus 7 real-host component checks in `scripts/check-host.mjs`. The integration script imports the published Cordis, Agent, Scope and SystemPrompt implementations, calls the real `assembleContextFor()` and `installModelSelection()`, and checks the final rendered prompt, current model changes, cross-Agent isolation, live switches and complete prompts. It uses no credentials, user profile, server or model inference. This checks injection, not the model's response quality or wording.

Reproduce locally after installing an isolated pinned host, with no installation scripts:

```sh
npm install --prefix .tmp/host-contract --no-package-lock --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.3
node scripts/check-host.mjs --runtime .tmp/host-contract
```

CI runs the same check in a temporary directory independently of the four existing OS/Node checks. It fails when host dependencies are absent rather than substituting an invented context fixture.

## 0.2.2previre mode boundary（历史）

> Superseded by 0.3.0. The gate below no longer exists; `weNeedToThinking` now applies to every model and does not depend on enhanced thinking.


The release display name is `0.2.2previre`; its package version is the SemVer prerelease `0.2.2-previre`. The two optional boolean fields `claudeMode` and `weNeedToThinking` default to false and reuse the existing volatile Config and native settings form. No new tool or runtime dependency is required.

Claude mode applies frontend design preferences across models and adds goal/evidence/action/verification guidance when enhanced thinking is enabled. Disabling enhanced thinking removes its planning guidance while retaining its frontend preference. The mode does not select Claude or claim access to Claude's internal reasoning.

The we need to guidance is active only when its preference and enhanced thinking are enabled and the actual current step's captured model name contains `deepseek`, case-insensitively, or `深度求索`. Provider names and manually selected policy presets do not bypass this gate; missing model context leaves it inactive. Model switching is evaluated on each prompt assembly. This is a guidance example, not a required reasoning prefix, a ban on `let me`, or a request to reveal private reasoning. It makes no measured model-quality claim. Standalone MCP initialization has no current-step model selection and therefore does not activate this guidance based on a policy preset alone.

The original preview passed 108 local automated tests, covering mode logic, accepted-value persistence, defaults, model gates, and bundle behavior. In an isolated real DSH 0.2.1-rc.3 Web host, both modes initially defaulted to false with enhanced thinking true. Both were enabled and remained true after reload; disabling enhanced thinking retained both preferences and displayed the paused notice. Enhanced thinking was then restored and both modes disabled, with false/false/true confirmed after reload. Runtime browser errors were empty, requests stayed on localhost, and no model generation or chat message was sent. Current controls were also rendered with real React at 320, 360, and 420px in both languages without horizontal overflow. This establishes settings behavior, not a model-quality or provider-inference benchmark.

## v0.2 live configuration and client surface

The native entry now exports a Schemastery `Config`. Each editable field is `.volatile()` and the runtime reads its stable reference with `.get()` for every prompt assembly and tool call. The native integration declares `@deepseek-ai/schemastery@~3.18.5` as an optional host peer; CLI/MCP do not import it. Real Schemastery 3.18.5 was used to validate volatile fields, defaults, and conversion to effective runtime settings. Without a Harness host, the entry supplies a Standard Schema fallback for standalone contract tests; that fallback is not a substitute for a live settings form.

The browser entry is a committed lazy client-factory bundle at `client/client.js`, declared by `dsh.client` and `exports["./client"]`. It uses host-provided React and the existing `slots`, `locale`, and `configForms` services. There is no installation-time build or bundled second copy of React.

The page registers both `settings.section` (`strong-skills`) and keyed `plugins.bundle.config` (`dsh-strong-skills`). Since v0.2.1 these contributions remain registered for the client's lifetime, independently of whether the Host currently serves the `strong-skills` Config form. An unavailable form renders a diagnostic page; its store subscription restores the controls when the form becomes ready. Writes remain restricted to ready, writable forms. Reads, writes, resets, revision fencing, and accepted-value recovery go through the real ConfigForms contract; no localStorage or private HTTP API is used. The optional host settings presentation policy is registered against the owning plugin fiber. [Settings Config projection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/settings/settings/README.md), [client form contracts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings/src/client/config-form-types.ts), [Settings slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings/src/client/contract/slots.ts), [plugin configuration slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md).

Since the hotfix, the post-assembly callback uses the current step's captured model variables as described above. Optional tools have live registration `when` predicates, and their dispatch is also rejected when disabled. Reasoning effort and actual model/provider selection stay host-owned. Older Harness versions lacking volatile Config or these client contracts cannot provide this settings surface and should be upgraded before use.

Verification covers the real schema library, controller and slot integration fixtures, generated bundle freshness, real React rendering in desktop/mobile browser previews, native execution contracts and stdio protocol subprocesses. The actual rc.3 Web host was also installed under an isolated DSH_HOME, the bundle linked with `dsh plugin`, and the dedicated Settings page opened in a real browser. The enhanced-thinking switch changed true → false, remained false after reload, and was restored to true. Runtime browser errors were empty. Test browser requests stayed on localhost; no model generation or chat message was sent. This confirms settings-page loading and persistence, not a coding benchmark or exhaustive provider integration.

The v0.2 package declares `engines.dsh: ">=0.2.1-rc.3 <0.3.0"`. rc.2 remains the initial npm latest observation below, not a claim of v0.2 surface compatibility. Launcher options must precede application arguments: use `dsh --profile web --patch /absolute/path/to/overlay.yml`, rather than appending `--patch` after the `web` shorthand in this tested release.

## Version boundary

The npm `latest` manifest reports `@deepseek-ai/dsh@0.2.1-rc.2`, `@deepseek-ai/cordis@~4.0.5`, `@deepseek-ai/schemastery@~3.18.5`, and DSH dependencies pinned to `0.2.1-rc.2`. Upstream `master` already contains some `0.2.1-rc.3` packages. Pin a coherent DSH release for integration testing; do not treat `master` or a broad prerelease range as a tested version. [Registry manifest](https://registry.npmjs.org/@deepseek-ai/dsh/latest), [tools manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/package.json).

## Native plugin contract

A module exports `name`, `inject`, and `apply(ctx, config)`. Required services in `inject` are available before `apply`. Context registrations are disposed with the plugin. An exported `Config` must implement Standard Schema; a plain configuration object is invalid. A dependency-free JavaScript plugin may omit `Config` and validate/default its supplied configuration inside `apply`. Use `@deepseek-ai/schemastery` when a generated settings schema is needed. [Lifecycle tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md), [configuration tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md).

This raw registration avoids runtime schema-library imports. Raw tools must validate their arguments themselves:

```js
export const name = 'example-enhancement'
export const inject = ['tools', 'systemPrompt', 'workingDirectory']

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'example-enhancement:policy', order: 650, interpolate: false,
    text: 'Inspect the project, make focused changes, and verify the result.',
  })
  ctx.tools.register({
    name: 'enhancement_cwd',
    description: 'Return the current session working directory.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).length !== 0) throw new Error('Expected empty arguments')
      exec.signal.throwIfAborted()
      return exec.agent
        ? ctx.workingDirectory.ensure(exec.agent, exec.signal)
        : ctx.workingDirectory.defaultDirectory
    },
  })
}
```

`output.schema` and `output.render(args, value)` are mandatory. `execute` returns a lossless JSON value matching that schema; the renderer returns content blocks. It does not return an MCP result envelope. Tool bodies must honor `exec.signal`. `defineTool` from `@deepseek-ai/dsh-tools` is an alternative with validated argument inference; its authoring DSL uses a property map with per-property `required: true`, whereas raw registration uses ordinary JSON Schema. [Tool contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/contracts.ts), [tool helper](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/schema.ts), [prompt registry](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/src/index.ts).

`ctx.workingDirectory.get(exec.agent.session)` reads the committed session directory without I/O. `ensure(agent, signal)` validates it and handles recovery. `exec.agent.session.header.cwd` is the original project directory and is not the current session directory. Do not substitute the Harness process's `process.cwd()` for caller state. [Working-directory implementation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/working-directory/src/index.ts), [first-party caller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/src/session-cwd.ts).

## Installation and overlays

An installable package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` and publishes the patch and plugin entry. Bundle rows reference the installed package name:

```yaml
- insert:
    - id: example-enhancement
      name: dsh-example-enhancement
```

Install a local checkout with `dsh plugin --profile web add /absolute/path/to/package`, inspect with `dsh --profile web --dump-config`, then restart the selected profile. For a temporary overlay use an absolute plugin module path and launch `dsh --profile web --patch /absolute/path/to/overlay.yml`. A patch replaces a row's whole `config`; it does not recursively merge it. Shared DSH runtime imports belong in `peerDependencies` and `devDependencies`; independent schema validators belong in `dependencies`. [Official packaging and profile tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

## Built-in MCP bridge

Harness supports one `@deepseek-ai/dsh-mcp-client` row per server. A local embedded MCP server can be run as a separate stdio process:

```yaml
- insert:
    - id: example-enhancement-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: enhancement
        transport: stdio
        command: node
        args: ['/absolute/path/to/package/bin/strong.mjs', serve, --root, '/absolute/path/to/project']
        cwd: '/absolute/path/to/project'
```

Model-visible names are `mcp__enhancement__<tool>`. No MCP server is enabled by default. Server instructions consume system-prompt space, so keep them short and let the discovery gateway return detailed skills only when requested. Install either the native gateway or the MCP gateway for a task to avoid duplicate schemas. [Official MCP bridge reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md).

## Integration verification

Run the plugin's local unit and stdio-protocol tests first. With a pinned Harness installation, inspect the composed profile, activate the plugin, assemble the prompt, and execute its gateway through the native executor; verify cancellation and canonical output. Repeat via the official MCP bridge against the same embedded server. Local stubs establish the plugin's contract shape but cannot establish compatibility with a real Harness release.
