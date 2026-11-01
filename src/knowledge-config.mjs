// Shared with the settings client. Keep this module browser-safe.
export const KNOWLEDGE_CONFIG_MAX = 65536;
export function normalizeProjectRoot(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\0\r\n]/.test(value)) throw new Error('Project/local root must be an absolute path');
  let path = value.trim().replace(/\\/g, '/');
  if (!/^(?:[a-z]:\/|\/(?!\/))/i.test(path)) throw new Error('Use an absolute local path');
  path = path.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  if (/^[a-z]:$/i.test(path)) path += '/';
  if (!/^(?:[a-z]:\/|\/(?!\/))/i.test(path) || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Use an absolute path without . or .. segments');
  return path;
}
export function githubSource(location) {
  const source = /^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(location);
  let owner, repo;
  if (source) [, owner, repo] = source;
  else {
    let url; try { url = new URL(location); } catch { throw new Error('Use https://github.com/owner/repo'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Use a public HTTPS github.com repository URL without credentials');
    const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (!match) throw new Error('Use the repository URL; enter a branch or commit in the ref field');
    [, owner, repo] = match;
  }
  if ([owner, repo].some(part => !part || part === '.' || part === '..')) throw new Error('Invalid GitHub repository');
  return { owner, repo };
}
export function parseKnowledgeConfig(text = '') {
  if (typeof text !== 'string' || text.length > KNOWLEDGE_CONFIG_MAX) throw new Error('knowledgeConfig must be a JSON string up to 65536 characters');
  let value; try { value = text.trim() ? JSON.parse(text) : {}; } catch { throw new Error('Invalid knowledge/project JSON'); }
  const plain = object => object && typeof object === 'object' && !Array.isArray(object);
  const keys = (object, allowed) => { if (!plain(object) || Object.keys(object).some(key => !allowed.includes(key))) throw new Error('Unknown knowledge/project field'); };
  const string = (value, max, label) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) throw new Error(`Invalid ${label}`); return value.trim(); };
  keys(value, ['projects', 'libraries']);
  const projects = value.projects ?? [], libraries = value.libraries ?? [];
  if (!Array.isArray(projects) || projects.length > 50 || !Array.isArray(libraries) || libraries.length > 80) throw new Error('Maximum 50 projects and 80 libraries');
  const identities = new Set();
  const roots = new Map();
  const canonical = root => /^[a-z]:/i.test(root) ? root.toLowerCase() : root;
  const result = { projects: projects.map(project => {
    keys(project, ['root', 'name', 'notes']);
    const root = normalizeProjectRoot(project.root), identity = canonical(root);
    if (roots.has(identity)) throw new Error('Duplicate project root');
    roots.set(identity, root);
    if (typeof (project.notes ?? '') !== 'string' || (project.notes ?? '').length > 1200 || /\0/.test(project.notes ?? '')) throw new Error('Project notes must be at most 1200 characters');
    return { root, name: string(project.name, 80, 'project name'), notes: project.notes ?? '' };
  }), libraries: libraries.map(library => {
    keys(library, ['id', 'name', 'kind', 'location', 'scope', 'ref']);
    const id = string(library.id, 48, 'library id');
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || identities.has(id)) throw new Error('Library IDs must be unique letters, digits, _ or -');
    identities.add(id);
    if (!['local', 'github'].includes(library.kind)) throw new Error('Choose a local or github library');
    const location = string(library.location, 1000, 'library location');
    if (library.kind === 'github') githubSource(location); else normalizeProjectRoot(location);
    let scope = library.scope === 'global' ? 'global' : normalizeProjectRoot(library.scope);
    if (scope !== 'global' && !roots.has(canonical(scope))) throw new Error('Create the project before assigning a private library');
    if (scope !== 'global') scope = roots.get(canonical(scope));
    const ref = library.ref ?? '';
    if (typeof ref !== 'string' || ref.length > 150 || /[\0\r\n]/.test(ref)) throw new Error('Invalid GitHub branch/commit');
    return { id, name: string(library.name, 80, 'library name'), kind: library.kind, location, scope, ref: ref.trim() };
  }) };
  return result;
}
export function projectForRoot(settings, root) {
  if (!root) return undefined;
  let normalized; try { normalized = normalizeProjectRoot(root); } catch { return undefined; }
  const windows = /^[a-z]:/i.test(normalized);
  const compare = value => windows ? value.toLowerCase() : value;
  const target = compare(normalized);
  return settings.projects.filter(project => target === compare(project.root) || target.startsWith(compare(project.root).replace(/\/$/, '') + '/')).sort((a, b) => b.root.length - a.root.length)[0];
}
export function librariesForRoot(settings, root) {
  const project = projectForRoot(settings, root);
  const identity = value => /^[a-z]:/i.test(value) ? value.toLowerCase() : value;
  return settings.libraries.filter(library => library.scope === 'global' || (project && identity(library.scope) === identity(project.root)))
    .sort((a, b) => Number(a.scope === 'global') - Number(b.scope === 'global'));
}
