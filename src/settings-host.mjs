/** Opt out of the generated form while the package's own settings surface is active. */
export function installSettingsPolicy(ctx) {
  // Settings is optional: the stdio/MCP and headless plugin entry need no UI service.
  if (typeof ctx?.inject !== 'function') return;
  const owner = ctx.fiber;
  return ctx.inject(['settings'], (scope) => {
    if (typeof scope?.settings?.configure !== 'function' || typeof scope.effect !== 'function') return;
    scope.effect(
      () => scope.settings.configure({ auto: false }, owner),
      'strong-skills: custom settings surface',
    );
  });
}

export const registerSettingsHost = installSettingsPolicy;
