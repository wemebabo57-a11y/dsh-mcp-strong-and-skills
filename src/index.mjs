import * as fs from 'node:fs/promises';
import path from 'node:path';
import { StrongEngine, ALL_TOOLS, BASE_TOOLS } from './engine.mjs';
import { snapshotConfig, loadNativeConfigSchema } from './native-config.mjs';
import { registerSettingsHost } from './settings-host.mjs';
import { installNativePolicy } from './native-policy.mjs';
import { resolveShellSandbox } from './sandbox.mjs';
import { installShellAdoption } from './adoption.mjs';

export const name = 'strong-skills';
export const inject = ['tools', 'systemPrompt', 'workingDirectory'];
export const Config = await loadNativeConfigSchema();

const VISION_TTL = 5 * 60 * 1000;
const visionRoutes = new Map();
const screenshotBlocks = new WeakMap();

/** Accepts either a tool-activation context or a tool execution handle. */
function routeOf(context) {
  if (context?.modelSelection?.provider) return { provider: context.modelSelection.provider, model: context.modelSelection.model };
  const header = context?.agent?.session?.requestHeader?.()?.config;
  const options = context?.agent?.options ?? {};
  return { provider: header?.provider ?? options.provider, model: header?.model ?? options.model };
}

/** Cached route capability; undefined means not resolved yet, not false. */
function visionState(selection) {
  const provider = selection?.provider;
  const model = selection?.model;
  if (!provider || !model) return undefined;
  const entry = visionRoutes.get(provider + '\u0000' + model);
  if (!entry || entry.expires <= Date.now()) return undefined;
  return Boolean(entry.value);
}

/** Cache per route with TTL: activation runs on every step and must stay cheap. */
async function visionCapable(ctx, context) {
  const { provider, model } = routeOf(context);
  if (!provider || !model) return false;
  const key = provider + '\u0000' + model;
  const cached = visionRoutes.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (cached) visionRoutes.delete(key);
  try {
    const llm = ctx.get('llm');
    const info = await llm.resolveModelInfo(provider, model, context?.signal);
    const vision = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
    if (visionRoutes.size >= 64) {
      const oldest = visionRoutes.keys().next().value;
      if (oldest !== undefined) visionRoutes.delete(oldest);
    }
    visionRoutes.set(key, { value: vision, expires: Date.now() + VISION_TTL });
    return vision;
  } catch {
    return false;
  }
}

/** Turn a saved screenshot into an image block only when the current route accepts images. */
async function attachScreenshot(ctx, execution, value) {
  const image = value && typeof value === 'object' ? value.screenshot : null;
  if (!image?.path) return { value, blocks: [] };
  const copy = { ...value };
  delete copy.screenshot;
  const blocks = [];
  let attached = false;
  if (await visionCapable(ctx, execution)) {
    try {
      const attachments = ctx.get('attachments');
      const data = await fs.readFile(image.path);
      const ref = await attachments.saveImage({ data, mediaType: image.mediaType ?? 'image/png', name: path.basename(image.path) });
      blocks.push({ type: 'image', attachment: ref });
      attached = true;
    } catch {
      attached = false;
    }
  }
  copy.image = { path: image.path, width: image.width, height: image.height, attached };
  if (!attached) copy.imageHint = '当前模型不接受图片输入，只返回截图路径；需要文字请用 strong_web，或换视觉模型。';
  return { value: copy, blocks };
}

function expanded(config) { return config.toolSet === 'expanded' || config.unlimitedTokens; }

function registrationOptions(ctx, tool, currentConfig) {
  if (BASE_TOOLS.some(base => base.name === tool.name)) return undefined;
  if (tool.name === 'strong_shell') return { when: () => currentConfig().shellTool };
  if (tool.name === 'strong_web') return { when: () => expanded(currentConfig()) && currentConfig().webTool };
  if (tool.name === 'strong_browse') return { when: async context => {
    const config = currentConfig();
    if (!expanded(config) || config.browseTool === 'off') return false;
    if (config.browseTool === 'on') return true;
    // Auto keeps the browser off text-only routes; they use strong_web instead.
    // A caller without a route cannot answer the question yet, so keep it available.
    if (context?.modelSelection === undefined) return true;
    return visionCapable(ctx, context);
  } };
  return { when: () => currentConfig().toolSet === 'expanded' };
}

export function apply(ctx, options = {}) {
  snapshotConfig(options); // Fail invalid composition before contributing anything.
  const currentConfig = () => snapshotConfig(options);
  registerSettingsHost(ctx);
  installShellAdoption(ctx, currentConfig);
  installNativePolicy(ctx, currentConfig, { browseAvailable: selection => {
    const config = currentConfig();
    if (config.browseTool === 'on') return true;
    if (config.browseTool !== 'auto') return false;
    return visionState(selection);
  } });
  for (const tool of ALL_TOOLS) {
    ctx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
      output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }, ...(value && typeof value === 'object' ? screenshotBlocks.get(value) ?? [] : [])] },
      isConcurrencySafe: () => tool.name !== 'strong_shell',
      async execute(args, execution) {
        execution.signal.throwIfAborted();
        const root = execution.agent
          ? await ctx.workingDirectory.ensure(execution.agent, execution.signal)
          : ctx.workingDirectory.defaultDirectory;
        // Resolve caller cwd on each call: session directory changes must take effect.
        // Shell executions inherit the host session's sandbox policy; failures fail closed.
        const sandbox = tool.name === 'strong_shell' ? await resolveShellSandbox(ctx, execution, root) : null;
        let value = await new StrongEngine(root, currentConfig()).call(tool.name, args, { signal: execution.signal, sandbox });
        if (tool.name === 'strong_browse') {
          const attached = await attachScreenshot(ctx, execution, value);
          value = attached.value;
          if (attached.blocks.length) screenshotBlocks.set(value, attached.blocks);
        }
        return value;
      },
    }, registrationOptions(ctx, tool, currentConfig));
  }
}
