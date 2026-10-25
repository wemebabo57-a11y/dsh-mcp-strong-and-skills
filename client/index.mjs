import { createSettingsController, SETTINGS_ENTRY, SETTINGS_PACKAGE } from './controller.mjs';
import { createSettingsSection, SETTINGS_CSS, EN, ZH } from './view.mjs';

export const inject = ['slots', 'locale', 'configForms'];

/** Dependency injection keeps source tests and the installed bundle on the same implementation. */
export function createClientPlugin(React) {
  const StrongSettings = createSettingsSection(React.createElement);
  return {
    name: 'strong-skills-settings',
    inject,
    apply(ctx) {
      const localeNamespace = 'settings.strongSkills';
      ctx.effect(() => ctx.locale.register(localeNamespace, { en: EN, zh: ZH }), 'strong-skills: settings dictionaries');
      if (typeof document !== 'undefined') {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = SETTINGS_PACKAGE;
          style.textContent = SETTINGS_CSS;
          document.head.appendChild(style);
          return () => { style.remove(); };
        }, 'strong-skills: settings styles');
      }
      const controller = createSettingsController(ctx.configForms.get(SETTINGS_ENTRY));
      ctx.effect(() => () => { controller.dispose(); }, 'strong-skills: settings subscription');
      const t = ctx.locale.bind(localeNamespace);
      const face = surfaceId => ({
        hooks: { strongSettings: controller.store },
        surfaceId,
        set: controller.set,
        reset: controller.reset,
      });
      // Keep the plugin's own page discoverable before its Host namespace is
      // served, and when it disappears. The form store drives availability;
      // gating the registrations with whileServed would hide the diagnosis.
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: SETTINGS_ENTRY, order: 35, label: () => t('title'),
        locale: localeNamespace, inject: () => face('strong-skills-settings'),
      }, StrongSettings)), 'strong-skills: dedicated settings section');
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: SETTINGS_PACKAGE,
        locale: localeNamespace, inject: () => face('strong-skills-plugin'),
      }, StrongSettings)), 'strong-skills: plugin settings surface');
    },
  };
}
