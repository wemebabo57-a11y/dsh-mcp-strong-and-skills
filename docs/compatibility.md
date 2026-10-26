# DeepSeek Harness compatibility

Initial contract review on 2026-10-24; updated for v0.2 on 2026-10-25 against official upstream source and an isolated real DSH 0.2.1-rc.3 Web instance.

## 0.2.2-previre.1 prompt-injection correction — 2026-10-26

The original native callback incorrectly expected `context.modelSelection`. The published rc.3 `assembleContextFor()` supplies only Agent, scope, and optional signal. Its real `installModelSelection()` captures the current route and publishes `variables.model` / `variables.provider` after its assembly waterfall delegates. As a result, the original mode could be saved and enabled but absent from the final policy. This was reproduced with the user's exact model name, `deepseek-ai/DeepSeek-V4.1-Flash-1017`; the desktop app's packaged rc.3 Agent code was also inspected read-only and uses the same contract. Earlier UI and hand-built context fixtures did not cover this defect.

The hotfix registers an outer assembly waterfall, waits for the real host to finish, then rebuilds only `strong-skills:policy` using that accepted route. It preserves other sections, variables, tools, and host complete-prompt precedence. An explicit context selection is supported when supplied; Agent options are the fallback for entry points without captured variables. Previous request headers and global default-model settings are not used as a current-model substitute. Explicit version names also map to their matching Pro/Flash guides without changing the API route.

Verification: 111 automated tests plus 7 real-host component checks in `scripts/check-host.mjs`. The integration script imports the published Cordis, Agent, Scope and SystemPrompt implementations, calls the real `assembleContextFor()` and `installModelSelection()`, and checks the final rendered prompt, current model changes, cross-Agent isolation, live switches and complete prompts. It uses no credentials, user profile, server or model inference. This checks injection, not the model's response quality or wording.

Reproduce locally after installing an isolated pinned host, with no installation scripts:

```sh
npm install --prefix .tmp/host-contract --no-package-lock --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.1-rc.3
node scripts/check-host.mjs --runtime .tmp/host-contract
```

CI runs the same check in a temporary directory independently of the four existing OS/Node checks. It fails when host dependencies are absent rather than substituting an invented context fixture.

## 0.2.2previre mode boundary

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
