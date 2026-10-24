import { readFile } from 'node:fs/promises';

const ROUTES = [
  ['code-delivery', '实现功能、API 与完整代码交付', ['实现', '开发', '新增', '功能', '接口', '交付', 'implement', 'feature', 'api', 'build']],
  ['debug', '定位错误、根因与回归修复', ['调试', '报错', '错误', '崩溃', '修复', '异常', '排查', 'debug', 'bug', 'fix', 'crash', 'error']],
  ['refactor', '保持行为的重构与迁移', ['重构', '迁移', '拆分', '解耦', 'refactor', 'migrate', 'migration']],
  ['testing', '测试策略、回归与边界验证', ['测试', '回归', '覆盖', 'test', 'coverage', 'regression']],
  ['frontend-design', '界面风格、布局、交互与可访问性', ['前端', '界面', '页面', '视觉', '配色', '美化', '设计', '蓝色', '无障碍', 'ui', 'ux', 'frontend', 'css', 'design', 'accessibility', 'layout']],
  ['security-review', '按需审查输入、权限与敏感数据边界', ['安全', '漏洞', '鉴权', '权限', '注入', 'security', 'auth', 'vulnerability', 'injection']],
  ['performance', '测量瓶颈、性能与资源消耗', ['性能', '优化', '瓶颈', '内存', '延迟', '慢', 'performance', 'optimize', 'latency', 'memory', 'benchmark']],
  ['research', '官方资料、版本兼容与技术选型', ['资料', '文档', '研究', '选型', '兼容', '版本', '调研', 'research', 'docs', 'documentation', 'compatibility', 'version']],
];

export const SKILL_CATALOG = Object.freeze(ROUTES.map(([id, description]) => Object.freeze({ id, description })));

function keywordMatch(query, keyword) {
  if (/^[a-z]+$/.test(keyword)) return new RegExp(`(?:^|[^a-z])${keyword}(?:s|ing|ed)?(?:$|[^a-z])`, 'i').test(query);
  return query.includes(keyword);
}

export async function loadSkill(id, signal) {
  signal?.throwIfAborted();
  if (!SKILL_CATALOG.some(skill => skill.id === id)) throw new Error(`Unknown skill: ${id}`);
  const file = new URL(`../skills/${id}/SKILL.md`, import.meta.url);
  const source = await readFile(file, { encoding: 'utf8', signal });
  const match = /^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match || match[1] !== id) throw new Error(`Invalid skill file: ${id}`);
  return { id, description: SKILL_CATALOG.find(skill => skill.id === id).description, content: match[3].trim() };
}

export async function selectSkills(args, config, signal) {
  signal?.throwIfAborted();
  if (args.id) return { skills: [await loadSkill(args.id, signal)] };
  if (!args.query?.trim()) return { skills: SKILL_CATALOG, hint: 'Supply id or a task query to load only relevant bodies.' };
  const query = args.query.toLowerCase();
  const ranked = ROUTES.map(([id, description, keywords], order) => ({ id, description, order,
    score: (query.includes(id) ? 5 : 0) + keywords.filter(word => keywordMatch(query, word)).length,
  })).filter(skill => skill.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
  if (!ranked.length) return { skills: SKILL_CATALOG, matched: false, hint: 'No confident keyword match; select an id from the catalog.' };
  const selected = ranked.slice(0, Math.min(args.limit ?? 1, config.maxSkillLoads));
  const skills = await Promise.all(selected.map(skill => loadSkill(skill.id, signal)));
  return { skills, alternatives: ranked.slice(selected.length, selected.length + 3).map(({ id, description }) => ({ id, description })) };
}
