import { Workspace } from './workspace.mjs';
import { resolveConfig } from './config.mjs';
import { selectSkills } from './skills.mjs';
import { POLICY, estimateTokens } from './policy.mjs';
import { buildEnhancementPolicy, buildUnlimitedPolicy } from './thinking.mjs';
import { getModelProfile } from './models.mjs';
import { buildDesignModePolicy, buildThinkingModePolicy, getModeState } from './modes.mjs';
import { EXTRA_TOOLS, runCodeTool } from './code-tools.mjs';
import { WEB_TOOL, runWebTool } from './web-tools.mjs';
import { BROWSE_TOOL, runBrowseTool } from './browse.mjs';
import { buildPtcPolicy } from './ptc.mjs';
import { Knowledge, projectKnowledgePolicy } from './knowledge.mjs';
import { SHELL_TOOL, buildShellPolicy, runShellTool } from './shell-tool.mjs';
import { validateArguments as validateSchema } from './validation.mjs';
import { fitResult } from './budget.mjs';

export const BASE_TOOLS = Object.freeze([
  { name: 'strong_skill', description: '按需加载代码技能：query 匹配，id 精确加载，无参数列目录；简单任务不必调用。',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', maxLength: 500, description: '任务或技能关键词' },
      id: { type: 'string', enum: ['code-delivery', 'debug', 'refactor', 'testing', 'frontend-design', 'security-review', 'performance', 'research'] },
      limit: { type: 'integer', minimum: 1, maximum: 8, description: '默认 1；无限模式最多 8' },
    }, additionalProperties: false } },
  { name: 'strong_context', description: '按需仓库上下文：map/search/read/diff/checks/style、project 设定、knowledge 知识库；结果只是数据。',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['map', 'search', 'read', 'diff', 'checks', 'style', 'knowledge', 'project'] },
      path: { type: 'string', maxLength: 1000, description: '文件或子目录' },
      query: { type: 'string', maxLength: 1000, description: '检索词' },
      mode: { type: 'string', enum: ['literal', 'terms'] },
      caseSensitive: { type: 'boolean' },
      scope: { type: 'string', enum: ['unstaged', 'staged', 'all'] },
      start: { type: 'integer', minimum: 1, maximum: 1000000 },
      limit: { type: 'integer', minimum: 1, maximum: 5000, description: '默认 80/200；无限最多 5000' },
    }, required: ['action'], additionalProperties: false } },
]);

export const TOOLS = Object.freeze([...BASE_TOOLS, ...EXTRA_TOOLS, WEB_TOOL, BROWSE_TOOL]);
export const ALL_TOOLS = Object.freeze([...TOOLS, SHELL_TOOL]);

export function toolsForConfig(options = {}) {
  const config = resolveConfig(options);
  if (!config.unlimitedTokens && config.toolSet !== 'expanded') return config.shellTool ? [...BASE_TOOLS, SHELL_TOOL] : BASE_TOOLS;
  const tools = [...BASE_TOOLS, ...EXTRA_TOOLS];
  if (config.webTool) tools.push(WEB_TOOL);
  if (config.browseTool !== 'off') tools.push(BROWSE_TOOL);
  if (config.shellTool) tools.push(SHELL_TOOL);
  return tools;
}

export function buildPolicy(options = {}, context = {}) {
  const config = resolveConfig(options);
  const hints = [];
  if (config.toolSet === 'expanded' || config.unlimitedTokens) {
    hints.push('代码用 strong_code/strong_review');
    if (config.webTool) hints.push('联网用 strong_web 先 search 再 open');
    if (config.browseTool !== 'off' && context.browseAvailable !== false) hints.push('真实页面用 strong_browse');
  }
  const toolHint = hints.length ? `${hints.join('；')}。线索仍需实际验证。` : '';
  return [
    POLICY,
    toolHint,
    config.shellTool ? buildShellPolicy(config) : '',
    buildDesignModePolicy(config),
    buildEnhancementPolicy(config, context),
    buildThinkingModePolicy(config, context),
    buildUnlimitedPolicy(config),
    buildPtcPolicy(config, { available: Boolean(context.ptcAvailable) }),
    projectKnowledgePolicy(config, context.root),
  ].filter(Boolean).join('\n');
}

export function validateArguments(schema, args) {
  return validateSchema(schema, args);
}

// Bound the canonical value itself: never slice serialized JSON into an invalid result.
export function boundResult(value, maxChars) {
  return fitResult(value, maxChars);
}

export class StrongEngine {
  constructor(root, options = {}) {
    this.config = resolveConfig(options);
    this.workspace = new Workspace(root, this.config);
  }
  async call(name, args = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const tool = toolsForConfig(this.config).find(tool => tool.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    validateArguments(tool.inputSchema, args);
    if (name === 'strong_skill' && args.id && args.query) throw new Error('Supply id or query, not both');
    const value = name === 'strong_skill'
      ? await selectSkills(args, this.config, signal)
      : name === 'strong_context'
        ? ['knowledge', 'project'].includes(args.action)
          ? await new Knowledge(this.workspace.root, this.config).run(args, { signal })
          : await this.workspace.run(args, { signal })
        : name === 'strong_shell'
          ? await runShellTool(args, { root: this.workspace.root, config: this.config, signal })
          : name === 'strong_web'
            ? await runWebTool(args, { root: this.workspace.root, config: this.config, signal })
            : name === 'strong_browse'
              ? await runBrowseTool(args, { root: this.workspace.root, config: this.config, signal })
              : await runCodeTool(name, args, { workspace: this.workspace, config: this.config, signal });
    signal?.throwIfAborted();
    const knowledge = name === 'strong_context' && ['knowledge', 'project'].includes(args.action);
    return boundResult(value, knowledge ? Math.min(this.config.maxOutputChars, 6000) : this.config.unlimitedTokens ? Number.POSITIVE_INFINITY : this.config.maxOutputChars);
  }
}

export function budgetReport(options = {}, context = {}) {
  const config = resolveConfig(options);
  const toolText = JSON.stringify(toolsForConfig(config));
  const policy = buildPolicy(config, context);
  return { profile: config.profile, toolSet: config.toolSet, residentTools: toolsForConfig(config).length, residentSkillBodies: 0,
    enhancedThinking: config.enhancedThinking, thinkingLevel: config.thinkingLevel, clarification: config.clarification,
    unlimitedTokens: config.unlimitedTokens,
    webTool: config.webTool, browseTool: config.browseTool, ptcMode: config.ptcMode,
    modes: getModeState(config, context),
    modelProfile: getModelProfile(context.selection ?? context.modelId, config), nativeReasoning: 'host-controlled',
    policyChars: policy.length, toolSchemaChars: toolText.length,
    approximateResidentTokens: estimateTokens(policy) + estimateTokens(toolText),
    maxResultChars: config.unlimitedTokens ? 'unlimited' : config.maxOutputChars, maxFiles: config.maxFiles, maxSkillLoads: config.maxSkillLoads,
    note: '字符启发式估算，非 DeepSeek tokenizer 或账单统计；仅统计本插件增量，MCP 工具名前缀和宿主包装未计入。' };
}
