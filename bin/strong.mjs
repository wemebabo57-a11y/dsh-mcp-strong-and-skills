#!/usr/bin/env node
import { realpath, stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrongEngine, budgetReport } from '../src/engine.mjs';
import { startMcp } from '../src/mcp.mjs';

const HELP = `dsh-strong — DeepSeek Harness 编码增强

  serve   --root <项目目录> [--profile lean|balanced|thorough]   stdio MCP
  skill   [--id debug | --query "修复登录错误"] [--limit 1|2]   按需技能
  inspect --root <项目目录> --action map|search|read|diff|checks|style|knowledge|project
          [--path src] [--query keyword] [--start 1] [--limit 80]
  code    --root <项目目录> --action symbols|imports|diagnostics [--path src] [--text 报错]
  review  --root <项目目录> [--path src] [--limit 40]           差异与风险建议
  config  --mode native|mcp --root <项目目录> [--profile balanced]  输出 DSH patch
  budget  [--profile lean|balanced|thorough]                     上下文开销估算
  version                                                        显示版本

知识配置：--knowledge-file <JSON文件>（原生/MCP/inspect 均可使用）
通用增强选项：--thinking on|off --thinking-level balanced|deep
              --clarification auto|more|few --model auto|deepseek-v4-pro|deepseek-v4.1-flash-1017|generic
              --tools compact|expanded --claude-mode on|off --we-need-to on|off --unlimited on|off
              --web on|off --web-private on|off --browse auto|on|off --ptc auto|on|off --browser-path <绝对路径>
              --shell on|off --shell-backend auto|git-bash|wsl|bash|pwsh|cmd|builtin
              --shell-path <绝对路径> --wsl-distro <发行版>

不写用户配置。config 将可用的绝对路径 patch 打印到 stdout。`;

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (!argument?.startsWith('--')) throw new Error(`Expected --option value: ${argument}`);
    const equals = argument.indexOf('=');
    const flag = equals > 2 ? argument.slice(0, equals) : argument;
    let value;
    if (equals > 2) value = argument.slice(equals + 1);
    else {
      value = rest[index + 1];
      index++;
      if (value === undefined || value.startsWith('--')) throw new Error(`Expected --option value: ${flag}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${flag}`);
    Object.defineProperty(options, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return { command, options };
}

function checkOptions(command, options) {
  const common = ['profile', 'thinking', 'thinking-level', 'clarification', 'model', 'tools', 'claude-mode', 'we-need-to', 'unlimited', 'web', 'web-private', 'browse', 'ptc', 'browser-path', 'shell', 'shell-backend', 'shell-path', 'wsl-distro', 'knowledge-file'];
  const allowed = {
    serve: ['root', ...common], skill: ['id', 'query', 'limit', ...common],
    inspect: ['root', 'action', 'path', 'query', 'start', 'limit', ...common],
    code: ['root', 'action', 'path', 'text', 'limit', ...common], review: ['root', 'path', 'limit', ...common],
    config: ['mode', 'root', ...common], budget: common, version: [], '--version': [], '-v': [], help: [], '--help': [], '-h': [],
  }[command];
  if (!allowed) throw new Error(`Unknown command: ${command}`);
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Unknown option for ${command}: --${key}`);
}

export function optionsToConfig(options) {
  const config = {};
  for (const [flag, field] of [['profile', 'profile'], ['thinking-level', 'thinkingLevel'], ['clarification', 'clarification'], ['model', 'modelPreset'], ['tools', 'toolSet'], ['shell-backend', 'shellBackend'], ['shell-path', 'shellPath'], ['wsl-distro', 'wslDistro'], ['browser-path', 'browserPath']]) {
    if (options[flag] !== undefined) config[field] = options[flag];
  }
  for (const [flag, field, values] of [['browse', 'browseTool', ['auto', 'on', 'off']], ['ptc', 'ptcMode', ['auto', 'on', 'off']]]) {
    if (options[flag] === undefined) continue;
    if (!values.includes(options[flag])) throw new Error(`--${flag} must be ${values.join('|')}`);
    config[field] = options[flag];
  }
  for (const [flag, field] of [['thinking', 'enhancedThinking'], ['claude-mode', 'claudeMode'], ['we-need-to', 'weNeedToThinking'], ['unlimited', 'unlimitedTokens'], ['web', 'webTool'], ['web-private', 'webAllowPrivate'], ['shell', 'shellTool']]) {
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
  if (['version', '--version', '-v'].includes(command)) { const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')); process.stdout.write(`dsh-strong ${pkg.version}\n`); return; }
  const config = optionsToConfig(options);
  if (options['knowledge-file']) {
    if ((await stat(options['knowledge-file'])).size > 262144) throw new Error('Knowledge configuration file is too large');
    config.knowledgeConfig = await readFile(options['knowledge-file'], 'utf8');
  }
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
      for (const key of ['thinking', 'thinking-level', 'clarification', 'model', 'tools', 'claude-mode', 'we-need-to', 'unlimited', 'web', 'web-private', 'browse', 'ptc', 'browser-path', 'shell', 'shell-backend', 'shell-path', 'wsl-distro']) if (options[key] !== undefined) args.push(`--${key}`, options[key]);
      if (options['knowledge-file']) args.push('--knowledge-file', resolve(options['knowledge-file']));
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
