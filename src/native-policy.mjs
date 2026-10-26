import { buildPolicy } from './engine.mjs';

export const POLICY_SECTION = 'strong-skills:policy';

/** Resolve the route accepted by this assembly, never the previous request header. */
export function selectionForAssembly(assembly, context = {}) {
  // Hosts that explicitly capture a selection may pass it in their context.
  if (context.modelSelection !== undefined) return context.modelSelection;
  // DSH rc.3 installModelSelection publishes the captured route only after its
  // assembly waterfall returns. Section providers run too early to read it.
  if (context.agent && typeof assembly.variables?.model === 'string') {
    return { model: assembly.variables.model, provider: assembly.variables.provider };
  }
  // Entry points without an interactive selection use the AgentOptions route.
  return context.agent?.options;
}

/** Rebuild only our section after the host has resolved the current step's route. */
export function installNativePolicy(ctx, currentConfig) {
  ctx.systemPrompt.section({ name: POLICY_SECTION, order: 650,
    text: (context = {}) => buildPolicy(currentConfig(), { selection: context.modelSelection }), interpolate: false });
  if (typeof ctx.on !== 'function') return;
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (!assembly.sections.some(section => section.name === POLICY_SECTION)) return assembly;
    const text = buildPolicy(currentConfig(), { selection: selectionForAssembly(assembly, context) });
    return { ...assembly, sections: assembly.sections.map(section => section.name === POLICY_SECTION ? { ...section, text } : section) };
  }, { prepend: true });
}
