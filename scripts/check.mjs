import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SKILL_CATALOG, loadSkill } from '../src/skills.mjs';
import { budgetReport } from '../src/engine.mjs';

const root = new URL('../', import.meta.url);
const nodeEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' };
for (const directory of ['src', 'bin', 'client', 'scripts', 'test']) {
  for (const file of await readdir(new URL(`${directory}/`, root))) {
    if (!/\.[cm]?js$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`${directory}/${file}`, root))], { encoding: 'utf8', env: nodeEnv });
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
if (budget.approximateResidentTokens > 1600 || budget.residentTools !== 4) throw new Error('Resident context budget exceeded');
const compact = budgetReport({ toolSet: 'compact', enhancedThinking: false });
if (compact.residentTools !== 2 || compact.approximateResidentTokens > 650) throw new Error('Compact mode budget exceeded');
const unlimited = budgetReport({ profile: 'lean', toolSet: 'compact', enhancedThinking: false, unlimitedTokens: true });
if (!unlimited.unlimitedTokens || unlimited.residentTools !== 4 || unlimited.maxResultChars !== 'unlimited' || unlimited.maxFiles !== 5000 || unlimited.maxSkillLoads !== 8) throw new Error('Unlimited mode overrides are incomplete');
const ui = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/build-ui.mjs', root)), '--check'], { encoding: 'utf8', env: nodeEnv });
if (ui.status !== 0) throw new Error(ui.stderr || ui.stdout || 'Client bundle check failed');
process.stdout.write(JSON.stringify({ syntax: 'ok', skills: SKILL_CATALOG.length, budget }, null, 2) + '\n');
