// Registers every coreutil module into one Map<name, main(prog, argv, ctx)>.
import * as fsutil from './fsutil.mjs';
import * as misc from './misc.mjs';
import * as text from './text.mjs';
import * as filter from './filter.mjs';
import * as sort from './sort.mjs';
import * as sed from './sed.mjs';
import * as awk from './awk.mjs';

const MODULES = [fsutil, misc, text, filter, sort, sed, awk];

export function createCoreutils() {
  const map = new Map();
  for (const mod of MODULES) {
    if (!mod || !Array.isArray(mod.names) || typeof mod.main !== 'function') continue;
    for (const name of mod.names) {
      if (typeof name === 'string' && !map.has(name)) map.set(name, mod.main);
    }
  }
  return map;
}

export function coreutilNames() {
  return Array.from(createCoreutils().keys()).sort();
}
