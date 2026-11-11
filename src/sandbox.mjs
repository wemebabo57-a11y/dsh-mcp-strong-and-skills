import path from 'node:path';
import { WorkspaceError } from './workspace.mjs';

const CONFINING_MODES = new Set(['read-only', 'workspace-write']);

function sameExecutable(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * Environment for a process that may be the DSH sandbox runner itself.
 *
 * Under DSH Desktop the runner is the Electron executable running a Node
 * entry with ELECTRON_RUN_AS_NODE=1. The host sets that flag for its own
 * children, but our shell tool builds a deliberately small environment; if the
 * flag is dropped, Electron starts another GUI instance, writes Chromium noise
 * to stderr and exits 0 with no command output. Preserve the flag, and add it
 * when we can see that the prepared program is the Electron executable.
 */
export function runnerEnvironment(base, prepared, host = {}) {
  const env = { ...base };
  const electron = host.electron ?? Boolean(process.versions?.electron);
  const execPath = host.execPath ?? process.execPath;
  const program = prepared?.argv?.[0];
  if (electron && typeof program === 'string' && program && sameExecutable(program, execPath)) {
    env.ELECTRON_RUN_AS_NODE = env.ELECTRON_RUN_AS_NODE || '1';
  }
  // The host may inject a runner preload through NODE_OPTIONS (for example
  // dsh-acl-sandbox-patch, which repairs workspace ACL grants). That variable
  // is intentionally absent from the shell's allowlist, but the runner must
  // still see the host's own value or it runs unpatched.
  const parentNodeOptions = host.parentEnvironment ?? process.env;
  if (prepared?.argv?.length && typeof parentNodeOptions?.NODE_OPTIONS === 'string' && parentNodeOptions.NODE_OPTIONS) {
    env.NODE_OPTIONS = env.NODE_OPTIONS || parentNodeOptions.NODE_OPTIONS;
  }
  return env;
}

function unavailable(mode, detail) {
  return new WorkspaceError('SANDBOX_UNAVAILABLE', '沙箱不可用（' + mode + '）：' + detail + '。为安全起见，已拒绝在无沙箱保护下执行。');
}

function facade({ mode, policy, provider, root, enforce }) {
  const state = { mode, workspaceRoot: String(policy?.workspaceRoot || root), enforcement: enforce ? 'pending' : 'none', enforce };
  return {
    ...state,
    get workspaceRoot() { return state.workspaceRoot; },
    get enforcement() { return state.enforcement; },
    async wrap(argv, signal) {
      if (!enforce) return { argv: [...argv], enforcement: 'none', denialSignatures: [], runnerFailureRules: [] };
      let prepared;
      try {
        prepared = await provider.confine(argv, policy, signal);
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        throw unavailable(mode, 'DSH 无法准备受限执行：' + (error instanceof Error ? error.message : String(error)));
      }
      if (!prepared || !Array.isArray(prepared.argv) || !prepared.argv.length) throw unavailable(mode, 'DSH 沙箱返回了无效的启动参数');
      state.enforcement = prepared.enforcement || 'unknown';
      return prepared;
    },
    matches(stderr, exitCode, prepared) {
      const signatures = prepared?.denialSignatures;
      if (!Array.isArray(signatures) || !signatures.length) return false;
      if (exitCode === null || exitCode === 0) return false;
      const lowered = String(stderr || '').toLowerCase();
      return signatures.some(signature => typeof signature === 'string' && signature.trim() && lowered.includes(signature.toLowerCase()));
    },
    runnerFailure(stderr, exitCode, prepared) {
      const rules = prepared?.runnerFailureRules;
      if (!Array.isArray(rules) || !rules.length || exitCode === null || exitCode === 0) return '';
      const lines = String(stderr || '').split(/\r?\n/);
      for (const rule of rules) {
        if (!rule || !Array.isArray(rule.fatalSignatures)) continue;
        if (Array.isArray(rule.allowedExitCodes) && !rule.allowedExitCodes.includes(exitCode)) continue;
        const informational = new Set((rule.informationalLines || []).map(line => String(line).toLowerCase()));
        const fatal = rule.fatalSignatures.filter(signature => typeof signature === 'string' && signature.trim()).map(signature => signature.toLowerCase());
        for (const line of lines) {
          const lowered = line.toLowerCase();
          if (informational.has(lowered)) continue;
          if (fatal.some(signature => lowered.includes(signature))) return line.trim();
        }
      }
      return '';
    },
    get sandboxInfo() { return { mode, enforcement: state.enforcement, enforced: enforce }; },
  };
}

/**
 * Resolve the execution sandbox the host applies to its native shell.
 * Shell backends that cannot be confined fail closed instead of silently
 * running with the current user's full permissions.
 */
export async function resolveShellSandbox(ctx, execution, root) {
  const get = name => {
    try { return typeof ctx?.get === 'function' ? ctx.get(name) : undefined; }
    catch { return undefined; }
  };
  const provider = get('sandbox');
  const policies = get('sandboxPolicy');
  const hostShell = get('shell');
  const hostMode = hostShell?.sandboxMode;
  let policy;
  if (policies && typeof policies.resolve === 'function') {
    try {
      policy = policies.resolve(execution?.agent ? { session: execution.agent.session } : {});
    } catch (error) {
      throw unavailable(hostMode || 'unknown', '无法解析当前会话的沙箱策略：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  const mode = policy?.mode || hostMode;
  if (mode === undefined) {
    // Hosts predating the sandbox seam: keep the legacy behaviour but label it,
    // so the model and the user can see that no confinement was applied.
    return facade({ mode: 'unconfined', policy, provider, root, enforce: false });
  }
  if (mode === 'danger-full-access') return facade({ mode, policy, provider, root, enforce: false });
  if (!CONFINING_MODES.has(mode)) throw unavailable(String(mode), '未知的沙箱模式');
  if (!provider || typeof provider.confine !== 'function') {
    throw unavailable(mode, 'DSH 未提供 ctx.sandbox（SandboxProvider）服务');
  }
  if (!policy || !policy.workspaceRoot) throw unavailable(mode, 'DSH 未返回包含 workspaceRoot 的沙箱策略');
  return facade({ mode, policy, provider, root, enforce: true });
}
