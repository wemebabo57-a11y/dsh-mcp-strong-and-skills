#!/usr/bin/env node
// Benchmark and behaviour fingerprint for src/workspace.mjs.
//
// Builds a deterministic fixture tree (built-in walk + optional Git repository),
// then times the inventory/resolve-heavy actions and, with --fingerprint, writes
// a canonical dump of every result so a before/after run can be compared
// byte-for-byte. Timings are excluded from the fingerprint on purpose.
//
// Usage:
//   node scripts/bench-workspace.mjs [--reps 5] [--json out.json] [--fingerprint out.json]
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Workspace } from '../src/workspace.mjs';

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1];
}
const REPS = Math.max(1, Number(option('--reps', 5)));
const JSON_OUT = option('--json', '');
const FINGERPRINT = option('--fingerprint', '');

function codeFile(index) {
  const lines = [];
  for (let line = 0; line < 30; line++) {
    lines.push('export const value' + index + '_' + line + ' = compute(' + index + ', ' + line + '); // filler line for the scanner');
  }
  if (index % 37 === 0) lines.push('const marker = "NEEDLE_MARKER";');
  return lines.join('\n') + '\n';
}

function styleFile(index) {
  const lines = [];
  for (let line = 0; line < 40; line++) {
    lines.push('.rule-' + index + '-' + line + ' { color: #333333; padding: ' + line + 'px; }');
  }
  lines.push('.hero-' + index + ' { background: linear-gradient(90deg, #0f172a, #1e3a8a); }');
  lines.push('.panel-' + index + ' { background: #1d4ed8; }');
  return lines.join('\n') + '\n';
}

async function writeFile(root, name, content) {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

function binaryBuffer(length) {
  const buffer = Buffer.alloc(length);
  for (let index = 0; index < length; index++) buffer[index] = index % 251 === 0 ? 0 : 7 + (index % 90);
  return buffer;
}

async function buildTree() {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'bench-workspace-'));
  for (let directory = 0; directory < 24; directory++) {
    const name = 'src/mod-' + String(directory).padStart(2, '0');
    for (let file = 0; file < 20; file++) {
      const index = directory * 20 + file;
      await writeFile(root, name + '/file-' + String(file).padStart(2, '0') + '.mjs', codeFile(index));
    }
  }
  // A deep chain exercises the per-file path resolution walk.
  const deepDir = 'deep/a/b/c/d/e/f/g/h';
  for (let file = 0; file < 10; file++) await writeFile(root, deepDir + '/deep-' + file + '.mjs', codeFile(900 + file));
  for (let file = 0; file < 12; file++) await writeFile(root, 'styles/theme-' + file + '.css', styleFile(file));
  await writeFile(root, 'docs/notes.md', 'Notes about NEEDLE_MARKER in prose.\n'.repeat(40));
  await writeFile(root, 'assets/logo.png', binaryBuffer(2048));
  await writeFile(root, 'assets/data.bin', binaryBuffer(1024));
  await writeFile(root, 'large.txt', 'z'.repeat(300 * 1024));
  await writeFile(root, 'package.json', JSON.stringify({ name: 'bench-fixture', scripts: { build: 'vite build', test: 'node --test', lint: 'eslint .' } }, null, 2));
  await writeFile(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n');
  await writeFile(root, '.github/workflows/ci.yml', 'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n');
  await writeFile(root, 'README.md', '# Bench fixture\n\nDeterministic tree for workspace benchmarks.\n');
  return root;
}

function git(root, args) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, shell: false });
}

function hasGit() {
  return spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
}

async function buildGitTree() {
  if (!hasGit()) return null;
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'bench-workspace-git-'));
  for (let directory = 0; directory < 8; directory++) {
    for (let file = 0; file < 15; file++) {
      const index = directory * 15 + file;
      await writeFile(root, 'lib/pkg-' + directory + '/mod-' + String(file).padStart(2, '0') + '.mjs', codeFile(index));
    }
  }
  await writeFile(root, 'package.json', JSON.stringify({ name: 'bench-git-fixture', scripts: { test: 'node --test' } }, null, 2));
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Bench', '-c', 'user.email=bench@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

const CASES = [
  { name: 'list', action: (workspace) => workspace.list('.') },
  { name: 'map', action: (workspace) => workspace.run({ action: 'map', limit: 80 }) },
  { name: 'search-full', action: (workspace) => workspace.run({ action: 'search', query: 'needle_marker', limit: 80 }) },
  { name: 'search-early', action: (workspace) => workspace.run({ action: 'search', query: 'export', limit: 5 }) },
  { name: 'search-terms', action: (workspace) => workspace.run({ action: 'search', query: 'needle_marker value0', mode: 'terms', limit: 40 }) },
  { name: 'search-subdir', action: (workspace) => workspace.run({ action: 'search', path: 'src/mod-07', query: 'compute', limit: 20 }) },
  { name: 'style', action: (workspace) => workspace.run({ action: 'style', limit: 40 }) },
  { name: 'checks', action: (workspace) => workspace.run({ action: 'checks' }) },
  { name: 'read', action: (workspace) => workspace.run({ action: 'read', path: 'src/mod-03/file-04.mjs', limit: 60 }) },
];

const GIT_CASES = [
  { name: 'git-list', action: (workspace) => workspace.list('.') },
  { name: 'git-map', action: (workspace) => workspace.run({ action: 'map', limit: 80 }) },
  { name: 'git-search', action: (workspace) => workspace.run({ action: 'search', query: 'needle_marker', limit: 40 }) },
  { name: 'git-search-early', action: (workspace) => workspace.run({ action: 'search', query: 'export', limit: 5 }) },
];

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[sorted.length >> 1];
}

async function timeCase(entry, root) {
  await entry.action(new Workspace(root));
  const times = [];
  for (let round = 0; round < REPS; round++) {
    const started = performance.now();
    await entry.action(new Workspace(root));
    times.push(performance.now() - started);
  }
  return { name: entry.name, best: Math.min(...times), median: median(times), times };
}

function digest(value) {
  const text = JSON.stringify(value);
  return { sha256: createHash('sha256').update(text).digest('hex'), chars: text.length, text };
}

async function main() {
  const root = await buildTree();
  const gitRoot = await buildGitTree();
  try {
    const rows = [];
    for (const entry of CASES) rows.push(await timeCase(entry, root));
    if (gitRoot) for (const entry of GIT_CASES) rows.push(await timeCase(entry, gitRoot));

    const width = Math.max(...rows.map((row) => row.name.length)) + 2;
    console.log('workspace benchmark, node ' + process.version + ', ' + process.platform + ', reps=' + REPS + ' (fresh Workspace per rep)');
    console.log('fixture: 24x20 module files, depth-9 chain, 12 style files, 1 large file, 2 binary files' + (gitRoot ? ', plus a 120-file Git work tree' : ', no Git available'));
    console.log('');
    console.log('case'.padEnd(width) + 'median ms'.padStart(11) + 'best ms'.padStart(10));
    for (const row of rows) {
      console.log(row.name.padEnd(width) + row.median.toFixed(2).padStart(11) + row.best.toFixed(2).padStart(10));
    }

    if (JSON_OUT) {
      await fs.writeFile(JSON_OUT, JSON.stringify({ node: process.version, platform: process.platform, reps: REPS, rows }, null, 2) + '\n');
      console.log('\nwrote ' + JSON_OUT);
    }

    if (FINGERPRINT) {
      const fingerprints = {};
      for (const entry of CASES) fingerprints[entry.name] = digest(await entry.action(new Workspace(root)));
      if (gitRoot) for (const entry of GIT_CASES) fingerprints[entry.name] = digest(await entry.action(new Workspace(gitRoot)));
      await fs.writeFile(FINGERPRINT, JSON.stringify(fingerprints, null, 2) + '\n');
      const mismatches = Object.values(fingerprints).filter((entry) => entry.chars === 0).length;
      console.log('wrote ' + FINGERPRINT + ' (' + Object.keys(fingerprints).length + ' results, ' + mismatches + ' empty)');
      for (const [name, entry] of Object.entries(fingerprints)) console.log('  ' + name.padEnd(width) + entry.sha256.slice(0, 16) + '  ' + entry.chars + ' chars');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (gitRoot) await fs.rm(gitRoot, { recursive: true, force: true });
  }
}

await main();
