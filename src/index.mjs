import { StrongEngine, TOOLS } from './engine.mjs';
import { resolveConfig } from './config.mjs';
import { POLICY } from './policy.mjs';

export const name = 'strong-skills';
export const inject = ['tools', 'systemPrompt', 'workingDirectory'];

export function apply(ctx, options = {}) {
  const config = resolveConfig(options);
  ctx.systemPrompt.section({ name: 'strong-skills:policy', order: 650, text: POLICY, interpolate: false });
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
        return new StrongEngine(root, config).call(tool.name, args, { signal: execution.signal });
      },
    });
  }
}
