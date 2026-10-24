# DeepSeek Harness compatibility

Checked on 2026-10-24 against official upstream source and the npm registry. This is a contract review, not a claim that a full Harness instance has been started locally.

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

Install a local checkout with `dsh plugin --profile web add /absolute/path/to/package`, inspect with `dsh --profile web --dump-config`, then restart the selected profile. For a temporary overlay use an absolute plugin module path and launch `dsh web --patch /absolute/path/to/overlay.yml`. A patch replaces a row's whole `config`; it does not recursively merge it. Shared DSH runtime imports belong in `peerDependencies` and `devDependencies`; independent schema validators belong in `dependencies`. [Official packaging and profile tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

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
        args: ['/absolute/path/to/package/bin/mcp.mjs']
        cwd: '/absolute/path/to/project'
```

Model-visible names are `mcp__enhancement__<tool>`. No MCP server is enabled by default. Server instructions consume system-prompt space, so keep them short and let the discovery gateway return detailed skills only when requested. Install either the native gateway or the MCP gateway for a task to avoid duplicate schemas. [Official MCP bridge reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md).

## Integration verification

Run the plugin's local unit and stdio-protocol tests first. With a pinned Harness installation, inspect the composed profile, activate the plugin, assemble the prompt, and execute its gateway through the native executor; verify cancellation and canonical output. Repeat via the official MCP bridge against the same embedded server. Local stubs establish the plugin's contract shape but cannot establish compatibility with a real Harness release.
