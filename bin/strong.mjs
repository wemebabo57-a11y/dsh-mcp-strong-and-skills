#!/usr/bin/env node
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrongEngine, budgetReport } from '../src/engine.mjs';
import { startMcp } from '../src/mcp.mjs';

const HELP = `dsh-strong — DeepSeek Harness 编码增强

  serve   --root <项目目录> [--profile lean|balanced|thorough]   stdio MCP
  skill   [--id debug | --query "修复登录错误"] [--limit 1|2]   按需技能
  inspect --root <项目目录> --action map|search|read|diff|checks|style
          [--path src] [--query keyword] [--start 1] [--limit 80]
  code    --root <项目目录> --action symbols|imports|diagnostics [--path src] [--text 报错]
  review  --root <项目目录> [--path src] [--limit 40]           差异与风险建议
  config  --mode native|mcp --root <项目目录> [--profile balanced]  输出 DSH patch
  budget  [--profile lean|balanced|thorough]                     上下文开销估算

通用增强选项：--thinking on|off --thinking-level balanced|deep
              --clarification auto|more|few --model auto|deepseek-v4-pro|deepseek-v4.1-flash-1017|generic
              --tools compact|expanded --claude-mode on|off --we-need-to on|off

不写用户配置。config 将可用的绝对路径 patch 打印到 stdout。`;

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`Expected --option value: ${flag}`);
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${flag}`);
    Object.defineProperty(options, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return { command, options };
}

function checkOptions(command, options) {
  const common = ['profile', 'thinking', 'thinking-level', 'clarification', 'model', 'tools', 'claude-mode', 'we-need-to'];
  const allowed = {
    serve: ['root', ...common], skill: ['id', 'query', 'limit', ...common],
    inspect: ['root', 'action', 'path', 'query', 'start', 'limit', ...common],
    code: ['root', 'action', 'path', 'text', 'limit', ...common], review: ['root', 'path', 'limit', ...common],
    config: ['mode', 'root', ...common], budget: common, help: [], '--help': [], '-h': [],
  }[command];
  if (!allowed) throw new Error(`Unknown command: ${command}`);
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Unknown option for ${command}: --${key}`);
}

export function optionsToConfig(options) {
  const config = {};
  for (const [flag, field] of [['profile', 'profile'], ['thinking-level', 'thinkingLevel'], ['clarification', 'clarification'], ['model', 'modelPreset'], ['tools', 'toolSet']]) {
    if (options[flag] !== undefined) config[field] = options[flag];
  }
  for (const [flag, field] of [['thinking', 'enhancedThinking'], ['claude-mode', 'claudeMode'], ['we-need-to', 'weNeedToThinking']]) {
    if (options[flag] === undefined) continue;
    if (!['on', 'off'].includes(options[flag])) throw new Error(`--${flag} must be on or off`);
    config[field] = options[flag] === 'on';
  }
  return config;
}

async function projectRoot(value) {
  if (!value) throw new Error('--root <project directory> is required');
  const root = await realpath(resolve(value));
  if (!(await stat(root)).isDirectory()) throw new Error('--root must be a directory');
  return root;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  checkOptions(command, options);
  if (['help', '--help', '-h'].includes(command)) { process.stdout.write(HELP + '\n'); return; }
  const config = optionsToConfig(options);
  // Resolve/validate profile even for config generation.
  const budget = budgetReport(config);
  if (command === 'budget') { process.stdout.write(JSON.stringify(budget, null, 2) + '\n'); return; }
  if (command === 'skill') {
    const args = Object.fromEntries(['id', 'query', 'limit'].filter(key => options[key] !== undefined).map(key => [key, key === 'limit' ? Number(options[key]) : options[key]]));
    process.stdout.write(JSON.stringify(await new StrongEngine(process.cwd(), config).call('strong_skill', args), null, 2) + '\n'); return;
  }
  const root = await projectRoot(options.root);
  if (command === 'serve') { startMcp({ root, config }); return; }
  if (command === 'config') {
    const directory = fileURLToPath(new URL('../', import.meta.url));
    const quote = value => JSON.stringify(value); // JSON strings are valid YAML scalars; no shell interpolation.
    if (options.mode === 'native') {
      const fields = { profile: budget.profile, ...config };
      process.stdout.write(`- insert:\n    - id: strong-skills\n      name: ${quote(fileURLToPath(new URL('../src/index.mjs', import.meta.url)))}\n      config:\n${Object.entries(fields).map(([key, value]) => `        ${key}: ${quote(value)}`).join('\n')}\n`);
    } else if (options.mode === 'mcp') {
      const args = [resolve(directory, 'bin/strong.mjs'), 'serve', '--root', root, '--profile', budget.profile];
      for (const key of ['thinking', 'thinking-level', 'clarification', 'model', 'tools', 'claude-mode', 'we-need-to']) if (options[key] !== undefined) args.push(`--${key}`, options[key]);
      process.stdout.write(`- insert:\n    - id: strong-skills-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: strong\n        transport: stdio\n        command: ${quote(process.execPath)}\n        args: ${quote(args)}\n        cwd: ${quote(root)}\n`);
    } else throw new Error('--mode must be native or mcp');
    return;
  }
  const fields = command === 'review' ? ['path', 'limit'] : command === 'code' ? ['action', 'path', 'text', 'limit'] : ['action', 'path', 'query', 'start', 'limit'];
  const args = Object.fromEntries(fields.filter(key => options[key] !== undefined).map(key => [key, ['start', 'limit'].includes(key) ? Number(options[key]) : options[key]]));
  const tool = command === 'review' ? 'strong_review' : command === 'code' ? 'strong_code' : 'strong_context';
  process.stdout.write(JSON.stringify(await new StrongEngine(root, config).call(tool, args), null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`dsh-strong: ${error.message}\n`); process.exitCode = 1; });
}
