import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceError } from './workspace.mjs';

export const BASH_TOOL = Object.freeze({
  name: 'strong_bash',
  description: '在工作区执行一条 shell 命令（需在设置中开启内置 Bash）。返回退出码、标准输出与错误输出；命令在超时或取消时终止。',
  inputSchema: { type: 'object', properties: {
    command: { type: 'string', maxLength: 4000, description: '要执行的命令；非交互式，stdin 已关闭' },
    cwd: { type: 'string', maxLength: 1000, description: '相对工作区的目录，默认工作区根目录' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: '超时毫秒，默认 60000' },
  }, required: ['command'], additionalProperties: false },
  readOnly: false,
});

export const BASH_POLICY = '内置 Bash 已开启：可用 strong_bash 执行构建、测试、格式化与 Git 等命令。运行前确认工作目录和影响范围；优先使用项目已有脚本，避免破坏性、交互式或长时间驻留的命令。执行后核对退出码、输出与测试证据。';

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 120000;
const SAFE_ENV = /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES(?:\(X86\))?|OS|SHELL|TERM|LANG|LANGUAGE|LC_[A-Z_]+|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|USERNAME|USER|LOGNAME|HOSTNAME|PWD|OLDPWD|XDG_[A-Z_]+|JAVA_HOME|CARGO_HOME|RUSTUP_HOME|GOPATH|GOROOT|PNPM_HOME|NPM_CONFIG_PREFIX|VOLTA_HOME|NVM_HOME|NVM_SYMLINK|CHROME_EXECUTABLE|PLAYWRIGHT_BROWSERS_PATH|CI|NODE_ENV|DISPLAY)$/i;
const SECRET_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

const own = (object, key) => Object.hasOwn(object, key);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validate(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || ![null, Object.prototype].includes(Object.getPrototypeOf(args))) {
    throw new WorkspaceError('INVALID_ARGUMENTS', 'Arguments must be a plain object.');
  }
  const schema = BASH_TOOL.inputSchema;
  for (const key of schema.required) if (!own(args, key)) throw new WorkspaceError('INVALID_ARGUMENTS', `Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (!own(schema.properties, key)) throw new WorkspaceError('INVALID_ARGUMENTS', `Unknown argument: ${key}`);
    const rule = schema.properties[key];
    if (rule.type === 'string' && (typeof value !== 'string' || Array.from(value).length > rule.maxLength)) throw new WorkspaceError('INVALID_ARGUMENTS', `Invalid argument: ${key}`);
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw new WorkspaceError('INVALID_ARGUMENTS', `Invalid argument: ${key}`);
  }
  if (!args.command.trim()) throw new WorkspaceError('INVALID_ARGUMENTS', 'Command must not be empty.');
  if (args.command.includes('\0')) throw new WorkspaceError('INVALID_ARGUMENTS', 'Command must not contain NUL bytes.');
}

async function workspaceRoot(workspace) {
  if (!workspace || typeof workspace.root !== 'string') throw new WorkspaceError('INVALID_ROOT', 'A workspace root is required.');
  const stat = await fs.lstat(workspace.root);
  if (stat.isSymbolicLink()) throw new WorkspaceError('DISALLOWED_SYMLINK', 'Workspace roots cannot be symbolic links or junctions.');
  if (!stat.isDirectory()) throw new WorkspaceError('INVALID_ROOT', 'Workspace root must be a directory.');
  return fs.realpath(workspace.root);
}

async function resolveCwd(root, value) {
  if (value === undefined || value === '') return { absolute: root, relative: '.' };
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value) || /^[a-z]:/i.test(value) || /^[/\\]/.test(value)) {
    throw new WorkspaceError('INVALID_PATH', 'Use a relative cwd inside the workspace.');
  }
  const segments = value.split(/[/\\]+/).filter((part) => part && part !== '.');
  if (segments.includes('..')) throw new WorkspaceError('PATH_ESCAPE', 'Parent traversal is not allowed.');
  const target = path.resolve(root, ...segments);
  if (!inside(root, target)) throw new WorkspaceError('PATH_ESCAPE', 'cwd is outside the workspace.');
  let stat;
  try { stat = await fs.stat(target); } catch (error) {
    if (error.code === 'ENOENT') throw new WorkspaceError('INVALID_PATH', 'cwd does not exist.');
    throw error;
  }
  if (!stat.isDirectory()) throw new WorkspaceError('INVALID_PATH', 'cwd must be a directory.');
  const actual = await fs.realpath(target);
  if (!inside(root, actual)) throw new WorkspaceError('PATH_ESCAPE', 'Resolved cwd is outside the workspace.');
  return { absolute: actual, relative: path.relative(root, actual).split(path.sep).join('/') || '.' };
}

function environment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || !SAFE_ENV.test(key) || SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  env.NO_COLOR = env.NO_COLOR ?? '1';
  return env;
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const fallback = () => { try { child.kill('SIGKILL'); } catch {} };
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      // If taskkill itself stalls, still stop the shell instead of leaving the tool hung.
      const guard = setTimeout(fallback, 2000);
      guard.unref?.();
      killer.on('error', () => { clearTimeout(guard); fallback(); });
      // Let taskkill enumerate the tree before anything kills the shell itself.
      killer.on('close', (code) => { clearTimeout(guard); if (code !== 0 && child.exitCode === null) fallback(); });
    } catch { fallback(); }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { fallback(); }
  }
}

function capture(stream, state) {
  stream.on('data', (chunk) => {
    const remaining = MAX_OUTPUT_BYTES - state.bytes;
    if (remaining > 0) {
      const part = chunk.subarray(0, remaining);
      state.chunks.push(part);
      state.bytes += part.length;
      if (part.length < chunk.length) state.truncated = true;
    } else if (chunk.length > 0) {
      state.truncated = true;
    }
  });
}

export async function runBashTool(args, { workspace, signal } = {}) {
  if (signal?.aborted) throw new WorkspaceError('ABORTED', 'Operation cancelled.');
  validate(args);
  const root = await workspaceRoot(workspace);
  const cwd = await resolveCwd(root, args.cwd);
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new WorkspaceError('INVALID_ARGUMENTS', 'Invalid timeout.');
  if (signal?.aborted) throw new WorkspaceError('ABORTED', 'Operation cancelled.');

  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(args.command, {
        shell: true,
        cwd: cwd.absolute,
        env: environment(),
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new WorkspaceError('BASH_FAILED', `Cannot start shell: ${error.message}`));
      return;
    }

    const stdout = { chunks: [], bytes: 0, truncated: false };
    const stderr = { chunks: [], bytes: 0, truncated: false };
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve({
        command: args.command,
        cwd: cwd.relative,
        exitCode: child.exitCode ?? null,
        signal: child.signalCode ?? null,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    const onAbort = () => { aborted = true; terminate(child); };

    const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    capture(child.stdout, stdout);
    capture(child.stderr, stderr);
    child.on('error', (error) => finish(new WorkspaceError('BASH_FAILED', `Shell failed: ${error.message}`)));
    child.on('close', () => finish(aborted ? new WorkspaceError('ABORTED', 'Operation cancelled.') : undefined));
  });
}
