import fsSync from 'node:fs';
import path from 'node:path';

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

function isInside(root, candidate) {
  if (!root) return false;
  const relative = path.relative(path.resolve(root), candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function executableNames(name) {
  if (process.platform !== 'win32') return [name];
  if (WINDOWS_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension))) return [name];
  return [name, ...WINDOWS_EXTENSIONS.map(extension => name + extension)];
}

function standardDirectories() {
  if (process.platform !== 'win32') return [];
  const directories = [];
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (systemRoot) directories.push(path.join(systemRoot, 'System32'));
  const programFiles = [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']];
  for (const base of programFiles) {
    if (base) directories.push(path.join(base, 'Git', 'cmd'), path.join(base, 'Git', 'bin'), path.join(base, 'Git', 'mingw64', 'bin'));
  }
  if (process.env.LOCALAPPDATA) directories.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'));
  return directories;
}

function trustedDirectories(env, workspaceRoot, extraDirectories) {
  const seen = new Set();
  const directories = [];
  const add = (directory) => {
    if (!directory || !path.isAbsolute(directory)) return;
    const resolved = path.resolve(directory);
    if (seen.has(resolved.toLowerCase())) return;
    if (workspaceRoot && isInside(workspaceRoot, resolved)) return;
    seen.add(resolved.toLowerCase());
    directories.push(resolved);
  };
  for (const directory of String(env.PATH || env.Path || '').split(path.delimiter)) add(directory);
  for (const directory of standardDirectories()) add(directory);
  for (const directory of extraDirectories || []) add(directory);
  return directories;
}

function isExecutableFile(candidate) {
  try {
    const stat = fsSync.statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') fsSync.accessSync(candidate, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a command to an absolute path from PATH/known system directories, never the cwd. */
export function findTrustedExecutable(name, { workspaceRoot, env = process.env, extraDirectories = [] } = {}) {
  if (typeof name !== 'string' || !name || /[\\/]/.test(name) || name === '.' || name === '..') return null;
  for (const directory of trustedDirectories(env, workspaceRoot, extraDirectories)) {
    for (const candidateName of executableNames(name)) {
      const candidate = path.join(directory, candidateName);
      if (!isExecutableFile(candidate)) continue;
      try { return fsSync.realpathSync(candidate); } catch { return candidate; }
    }
  }
  return null;
}
