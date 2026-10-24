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
  config  --mode native|mcp --root <项目目录> [--profile balanced]  输出 DSH patch
  budget  [--profile lean|balanced|thorough]                     上下文开销估算

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
  const allowed = {
    serve: ['root', 'profile'], skill: ['id', 'query', 'limit', 'profile'],
    inspect: ['root', 'action', 'path', 'query', 'start', 'limit', 'profile'],
    config: ['mode', 'root', 'profile'], budget: ['profile'], help: [], '--help': [], '-h': [],
  }[command];
  if (!allowed) throw new Error(`Unknown command: ${command}`);
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Unknown option for ${command}: --${key}`);
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
  const config = options.profile ? { profile: options.profile } : {};
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
      process.stdout.write(`- insert:\n    - id: strong-skills\n      name: ${quote(fileURLToPath(new URL('../src/index.mjs', import.meta.url)))}\n      config:\n        profile: ${budget.profile}\n`);
    } else if (options.mode === 'mcp') {
      process.stdout.write(`- insert:\n    - id: strong-skills-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: strong\n        transport: stdio\n        command: ${quote(process.execPath)}\n        args: [${quote(resolve(directory, 'bin/strong.mjs'))}, serve, --root, ${quote(root)}, --profile, ${budget.profile}]\n        cwd: ${quote(root)}\n`);
    } else throw new Error('--mode must be native or mcp');
    return;
  }
  const args = Object.fromEntries(['action', 'path', 'query', 'start', 'limit'].filter(key => options[key] !== undefined).map(key => [key, ['start', 'limit'].includes(key) ? Number(options[key]) : options[key]]));
  process.stdout.write(JSON.stringify(await new StrongEngine(root, config).call('strong_context', args), null, 2) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`dsh-strong: ${error.message}\n`); process.exitCode = 1; });
}
