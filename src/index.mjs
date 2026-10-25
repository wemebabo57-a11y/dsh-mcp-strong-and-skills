import { StrongEngine, TOOLS, BASE_TOOLS, buildPolicy } from './engine.mjs';
import { snapshotConfig, loadNativeConfigSchema } from './native-config.mjs';
import { registerSettingsHost } from './settings-host.mjs';

export const name = 'strong-skills';
export const inject = ['tools', 'systemPrompt', 'workingDirectory'];
export const Config = await loadNativeConfigSchema();

export function apply(ctx, options = {}) {
  snapshotConfig(options); // Fail invalid composition before contributing anything.
  const currentConfig = () => snapshotConfig(options);
  registerSettingsHost(ctx);
  ctx.systemPrompt.section({ name: 'strong-skills:policy', order: 650,
    text: (context = {}) => buildPolicy(currentConfig(), { selection: context.modelSelection }), interpolate: false });
  for (const tool of TOOLS) {
    ctx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        execution.signal.throwIfAborted();
        const root = execution.agent
          ? await ctx.workingDirectory.ensure(execution.agent, execution.signal)
          : ctx.workingDirectory.defaultDirectory;
        // Resolve caller cwd on each call: session directory changes must take effect.
        return new StrongEngine(root, currentConfig()).call(tool.name, args, { signal: execution.signal });
      },
    }, BASE_TOOLS.some(base => base.name === tool.name) ? undefined : { when: () => currentConfig().toolSet === 'expanded' });
  }
}
