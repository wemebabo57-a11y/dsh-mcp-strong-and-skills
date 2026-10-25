/** Browser-safe controller over Harness ConfigForms. No local persistence is used. */
export const SETTINGS_ENTRY = 'strong-skills';
export const SETTINGS_PACKAGE = 'dsh-strong-skills';
export const SETTINGS_FIELDS = Object.freeze([
  'enhancedThinking', 'thinkingLevel', 'clarification', 'modelPreset', 'toolSet',
  'profile', 'allowBrandColors', 'brandIntent', 'maxOutputChars', 'maxFiles',
  'maxFileBytes', 'maxSkillLoads',
]);

const CHOICES = Object.freeze({
  thinkingLevel: ['balanced', 'deep'],
  clarification: ['auto', 'more', 'few'],
  modelPreset: ['auto', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'generic'],
  toolSet: ['compact', 'expanded'],
  profile: ['lean', 'balanced', 'thorough'],
});

export const LIMITS = Object.freeze({
  maxOutputChars: [2000, 20000], maxFiles: [20, 5000],
  maxFileBytes: [1024, 262144], maxSkillLoads: [1, 2],
});

const PROFILE_LIMITS = Object.freeze({
  lean: { maxOutputChars: 4000, maxFiles: 400, maxSkillLoads: 1 },
  balanced: { maxOutputChars: 6000, maxFiles: 800, maxSkillLoads: 2 },
  thorough: { maxOutputChars: 12000, maxFiles: 2000, maxSkillLoads: 2 },
});

/** Config's optional limit overrides inherit their runtime defaults from the selected profile. */
function displaySettings(value) {
  if (value === undefined) return undefined;
  const defaults = { ...PROFILE_LIMITS[value.profile ?? 'balanced'], maxFileBytes: 262144 };
  const resolved = { ...value };
  for (const [field, fallback] of Object.entries(defaults)) {
    if (resolved[field] === undefined) resolved[field] = fallback;
  }
  return Object.freeze(resolved);
}

export function validateSetting(field, value) {
  if (!SETTINGS_FIELDS.includes(field)) throw new TypeError(`Unknown setting: ${field}`);
  if (field === 'enhancedThinking' || field === 'allowBrandColors') {
    if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
  } else if (field === 'brandIntent') {
    if (typeof value !== 'string' || value.length > 200) throw new TypeError('Brand intent must be at most 200 characters');
  } else if (Object.hasOwn(CHOICES, field)) {
    if (!CHOICES[field].includes(value)) throw new TypeError(`Invalid ${field}`);
  } else {
    const [min, max] = LIMITS[field];
    if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * A snapshot store compatible with the slot renderer's injected hooks.
 * ConfigForms owns loading, revision fencing, persistence, and recovery reads.
 * This controller owns only the surface's save/error state and subscription.
 */
export function createSettingsController(form) {
  const listeners = new Set();
  let disposed = false;
  let pending = 0;
  let notice = '';
  let error = '';
  let state;

  function publish() {
    if (disposed) return;
    const host = form.getSnapshot();
    state = Object.freeze({
      status: host.status,
      value: displaySettings(host.value),
      writable: host.status === 'ready' && host.writable === true,
      saving: pending > 0,
      notice,
      error,
    });
    for (const listener of [...listeners]) listener();
  }

  publish();
  const unsubscribe = form.subscribe(publish);

  async function write(operation) {
    if (disposed) return false;
    const host = form.getSnapshot();
    if (host.status !== 'ready' || host.writable !== true) return false;
    pending += 1;
    notice = '';
    error = '';
    publish();
    try {
      const accepted = await operation();
      if (!disposed) {
        if (accepted) notice = 'saved';
        else error = 'refused';
      }
      return accepted;
    } catch (cause) {
      if (!disposed) error = 'failed';
      return false;
    } finally {
      pending -= 1;
      publish();
    }
  }

  return {
    store: {
      getSnapshot: () => state,
      subscribe(listener) {
        if (disposed) return () => {};
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    async set(field, value) {
      if (disposed) return false;
      try { validateSetting(field, value); }
      catch (cause) {
        error = cause.message;
        notice = '';
        publish();
        return false;
      }
      return write(() => form.set(field, value));
    },
    reset() {
      return write(() => form.mutate(SETTINGS_FIELDS.map(field => ({ op: 'unset', path: [field] }))));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
