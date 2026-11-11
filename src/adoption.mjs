import { SHELL_TOOL } from './shell-tool.mjs';

// Host shells the model picks out of habit. They stay registered for cases where
// the plugin shell is unavailable, but while strong_shell is enabled and visible
// every native one-shot shell call is redirected to it.
const NATIVE_SHELLS = new Set(['bash', 'pwsh']);

export function installShellAdoption(ctx, currentConfig) {
  // Older hosts and test doubles may not expose the event service. Registration
  // alone must never make the plugin fail to load; the prompt route still applies.
  if (typeof ctx.on !== 'function' || !ctx.tools) return;
  ctx.on('tools/pre-execute', (execution, next) => {
    const config = currentConfig();
    if (!config.shellTool || !execution.agent || !NATIVE_SHELLS.has(execution.name)) return next();
    let visible = false;
    try {
      visible = ctx.tools.schemas(execution.agent).some(tool => tool.name === SHELL_TOOL.name);
    } catch {
      visible = false;
    }
    if (!visible) return next();
    return {
      kind: 'deny',
      reason: '已启用 strong_shell：所有 shell 命令（包括宿主 run_code 里的 shell）请直接用 strong_shell 执行（更快、返回结构化结果、继承 DSH 沙箱）。它会使用设置中的后端；命令语法不匹配时按该后端改写，不要改回宿主 bash/pwsh。只有 strong_shell 本身报错时才按错误提示调整或让用户处理。',
    };
  });
}
