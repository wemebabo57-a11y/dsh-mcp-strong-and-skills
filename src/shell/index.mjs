// Public entry point of the shell interpreter: assembles fs + coreutils + exec.
import { createFs } from './fs.mjs';
import { createCoreutils } from './coreutils/registry.mjs';
import { createShell, runScript } from './exec.mjs';

export { createShell, createFs, createCoreutils };
export { lex } from './lexer.mjs';
export { parseScript } from './parser.mjs';
export { ShellExit, ShellBreak, ShellContinue, ShellReturn, ShellAbort } from './errors.mjs';

/**
 * Run a bash script against a sandboxed fs.
 * options: { command, root, mode, cwd, stdin, env, timeoutMs, maxOutput, signal, coreutils }
 * returns { stdout, stderr, exitCode, aborted, truncated, cwd }
 */
export async function runShell(options = {}) {
  const fs = options.fs || createFs({ root: options.root, mode: options.mode, cwd: options.cwdV || '/' });
  const coreutils = options.coreutils || createCoreutils();
  const merged = Object.assign({}, options, { fs, coreutils });
  if (options.cwd && !merged.cwdV) merged.cwdV = options.cwd;
  return runScript(merged);
}
