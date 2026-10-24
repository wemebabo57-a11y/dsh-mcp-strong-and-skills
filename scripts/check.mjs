import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILL_CATALOG, loadSkill } from '../src/skills.mjs';
import { budgetReport } from '../src/engine.mjs';

const root = new URL('../', import.meta.url);
for (const directory of ['src', 'bin', 'scripts', 'test']) {
  for (const file of await readdir(new URL(`${directory}/`, root))) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`${directory}/${file}`, root))], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
  }
}
for (const skill of SKILL_CATALOG) {
  const loaded = await loadSkill(skill.id);
  if (loaded.content.length < 100 || loaded.content.length > 1800) throw new Error(`Skill body exceeds concise-content bounds: ${skill.id}`);
}
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) throw new Error('Runtime must remain dependency-free');
const budget = budgetReport();
if (budget.approximateResidentTokens > 1600 || budget.residentTools !== 2) throw new Error('Resident context budget exceeded');
process.stdout.write(JSON.stringify({ syntax: 'ok', skills: SKILL_CATALOG.length, budget }, null, 2) + '\n');
