// Shared allowlist for host environment variables passed to shells and children.
export const SAFE_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL', 'TERM', 'SHELL',
  'USER', 'USERNAME', 'LOGNAME', 'PWD',
  'ELECTRON_RUN_AS_NODE',
]);

export function safeEnv(env = process.env) {
  const safe = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (typeof value !== 'string') continue;
    if (SAFE_ENV.has(upper) || upper.startsWith('LC_')) safe[key] = value;
  }
  return safe;
}
