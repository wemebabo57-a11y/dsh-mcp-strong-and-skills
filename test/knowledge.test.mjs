import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseKnowledgeConfig, normalizeProjectRoot, githubSource, projectForRoot } from '../src/knowledge-config.mjs';
import { Knowledge, projectKnowledgePolicy } from '../src/knowledge.mjs';
import { StrongEngine, buildPolicy, budgetReport } from '../src/engine.mjs';
import { resolveConfig } from '../src/config.mjs';
import { installNativePolicy, POLICY_SECTION } from '../src/native-policy.mjs';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'strong-knowledge-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('strong-knowledge-')); await fs.rm(root, { recursive: true, force: true }); });
  const paths = Object.fromEntries(['a', 'ab', 'shared', 'private-a', 'private-b'].map(name => [name, path.join(root, name)]));
  for (const directory of Object.values(paths)) await fs.mkdir(directory);
  await fs.writeFile(path.join(paths.shared, 'guide.md'), 'shared keyword architecture\n');
  await fs.writeFile(path.join(paths['private-a'], 'a.md'), 'project A keyword ONLY_A\n' + 'large'.repeat(3000));
  await fs.writeFile(path.join(paths['private-b'], 'b.md'), 'project B keyword ONLY_B\n');
  await fs.writeFile(path.join(paths['private-a'], '.env'), 'API_SECRET=never-return');
  const settings = { projects: [{ root: paths.a, name: 'A', notes: 'A uses TypeScript; run npm test.' }, { root: paths.ab, name: 'B', notes: 'B uses Python.' }], libraries: [
    { id: 'common', name: 'Common', kind: 'local', location: paths.shared, scope: 'global' },
    { id: 'a-only', name: 'A private', kind: 'local', location: paths['private-a'], scope: paths.a },
    { id: 'b-only', name: 'B private', kind: 'local', location: paths['private-b'], scope: paths.ab },
  ] };
  return { paths, settings, config: { knowledgeConfig: JSON.stringify(settings) } };
}

test('source config validates scope, absolute roots, URLs, identities and card budgets', () => {
  assert.deepEqual(parseKnowledgeConfig(''), { projects: [], libraries: [] });
  assert.equal(normalizeProjectRoot('C:\\work\\demo\\'), 'C:/work/demo');
  assert.equal(normalizeProjectRoot('C:/'), 'C:/');
  assert.equal(normalizeProjectRoot('/work//demo/'), '/work/demo');
  assert.throws(() => normalizeProjectRoot('C:'));
  assert.throws(() => normalizeProjectRoot('//server/share'));
  assert.deepEqual(githubSource('https://github.com/org/repo.git'), { owner: 'org', repo: 'repo' });
  assert.deepEqual(githubSource('github:org/repo'), { owner: 'org', repo: 'repo' });
  const source = { id: 'docs', name: 'Docs', kind: 'github', location: 'https://github.com/org/repo', scope: 'global' };
  for (const url of ['http://github.com/org/repo', 'https://github.com.evil.test/org/repo', 'https://user:pass@github.com/org/repo', 'https://github.com/org/repo/tree/main', 'http://127.0.0.1/secret', 'https://github.com/org/repo?token=x']) assert.throws(() => githubSource(url));
  for (const settings of [{ libraries: [source, source] }, { libraries: [{ ...source, scope: '/missing' }] }, { projects: [{ root: '/a/../b', name: 'B' }] }, { projects: [{ root: '/a', name: 'A', notes: 'x'.repeat(1201) }] }, { projects: [{ root: 'C:/Demo', name: 'A' }, { root: 'c:/demo', name: 'B' }] }, { token: 'unknown' }]) assert.throws(() => resolveConfig({ knowledgeConfig: JSON.stringify(settings) }));
  const canonical = parseKnowledgeConfig(JSON.stringify({ projects: [{ root: 'C:/Demo', name: 'A' }], libraries: [{ ...source, scope: 'c:/demo' }] }));
  assert.equal(canonical.libraries[0].scope, 'C:/Demo');
  assert.equal(projectForRoot(canonical, 'c:/demo/src').name, 'A');
  assert.equal(projectForRoot(canonical, 'C:/Demo-other'), undefined);
});

test('public and private local sources survive new engine instances without leaking across projects', async t => {
  const { paths, config } = await fixture(t);
  for (const [root, expected] of [[paths.a, ['a-only', 'common']], [paths.ab, ['b-only', 'common']], [path.dirname(paths.a), ['common']]]) {
    const engine = new StrongEngine(root, config);
    const catalog = await engine.call('strong_context', { action: 'knowledge' });
    assert.deepEqual(catalog.libraries.map(item => item.id), expected);
    assert.ok(!JSON.stringify(catalog).includes('ONLY_A'));
    const found = await engine.call('strong_context', { action: 'knowledge', query: 'keyword' });
    assert.ok(found.matches.some(match => match.library === 'common'));
    assert.ok(found.matches.every(match => expected.includes(match.library)));
  }
  const engine = new StrongEngine(paths.a, config);
  await assert.rejects(engine.call('strong_context', { action: 'knowledge', path: 'b-only/b.md' }), /not available/);
  for (const input of ['a-only/../b.md', 'a-only/.env', 'a-only/C:/secret']) await assert.rejects(engine.call('strong_context', { action: 'knowledge', path: input }), /Disallowed/);
  const read = await new StrongEngine(paths.a, config).call('strong_context', { action: 'knowledge', path: 'a-only/a.md', start: 1, limit: 1 });
  assert.equal(read.lines[0].text, 'project A keyword ONLY_A');
  assert.equal(read.truncated, true);
});

test('single-file imports cannot read siblings and symlinked sources are rejected', async t => {
  const { paths } = await fixture(t);
  const source = { id: 'file', name: 'File', kind: 'local', location: path.join(paths.shared, 'guide.md'), scope: 'global' };
  const engine = new StrongEngine(paths.a, { knowledgeConfig: JSON.stringify({ libraries: [source] }) });
  const read = await engine.call('strong_context', { action: 'knowledge', path: 'file/guide.md' });
  assert.equal(read.lines[0].text, 'shared keyword architecture');
  const other = await engine.call('strong_context', { action: 'knowledge', path: 'file/sibling.md' });
  assert.match(other.errors[0].message, /only the registered file/);
  const link = path.join(path.dirname(paths.a), 'link');
  await fs.symlink(paths.shared, link, process.platform === 'win32' ? 'junction' : 'dir');
  const knowledge = new Knowledge(paths.a, { knowledgeConfig: JSON.stringify({ libraries: [{ ...source, location: link }] }) });
  const result = await knowledge.run({ action: 'knowledge', path: 'file/guide.md' });
  assert.match(result.errors[0].message, /symlinks or junctions/);
});

test('project cards are directory-specific, available in every fresh prompt, and never load library bodies', async t => {
  const { paths, config, settings } = await fixture(t);
  const policy = buildPolicy(config, { root: path.join(paths.a, 'src') });
  assert.match(policy, /A uses TypeScript/);
  assert.doesNotMatch(policy, /B uses Python|ONLY_A|ONLY_B/);
  assert.match(policy, /项目1个、公共1个/);
  assert.match(buildPolicy(config, { root: paths.ab }), /B uses Python/);
  assert.equal(projectKnowledgePolicy(resolveConfig(), paths.a), '');
  assert.equal(await fs.readFile(path.join(paths.shared, 'guide.md'), 'utf8'), 'shared keyword architecture\n');
  settings.libraries[0].location = '/does-not-exist';
  assert.doesNotThrow(() => buildPolicy({ knowledgeConfig: JSON.stringify(settings) }, { root: paths.a }));
  assert.equal((await new StrongEngine(paths.a, config).call('strong_context', { action: 'project' })).project.name, 'A');
  assert.equal(budgetReport(config, { root: paths.a }).residentTools, 6);
});

test('knowledge results retain their own small budget even when unlimited mode is enabled', async t => {
  const { paths, config } = await fixture(t);
  const engine = new StrongEngine(paths.a, { ...config, unlimitedTokens: true });
  const result = await engine.call('strong_context', { action: 'knowledge', path: 'a-only/a.md', limit: 5000 });
  assert.ok(JSON.stringify(result).length <= 6000);
  assert.equal(result.truncated, true);
});

test('GitHub import is lazy, bounded, revision-labelled and excludes symlinks and secrets before fetching text', async () => {
  const text = 'architecture notes\nkeyword remote evidence\n';
  const sha = 'a'.repeat(40), rootSha = 'b'.repeat(40);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    assert.ok(url.startsWith('https://api.github.com/repos/strong-test/lazy-source/'));
    if (url.includes('/git/trees/')) return Response.json({ sha: rootSha, tree: [
      { type: 'blob', mode: '100644', path: 'README.md', size: Buffer.byteLength(text), sha },
      { type: 'blob', mode: '120000', path: 'escape.md', size: 4, sha: 'c'.repeat(40) },
      { type: 'blob', mode: '100644', path: '.env', size: 4, sha: 'd'.repeat(40) },
      { type: 'blob', mode: '100644', path: 'huge.md', size: 999999, sha: 'e'.repeat(40) },
    ] });
    return Response.json({ encoding: 'base64', content: Buffer.from(text).toString('base64') });
  };
  const config = { knowledgeConfig: JSON.stringify({ libraries: [{ id: 'remote', name: 'Remote', kind: 'github', location: 'https://github.com/strong-test/lazy-source', scope: 'global', ref: 'topic/docs' }] }) };
  const knowledge = new Knowledge('/project', config, { fetchImpl });
  await knowledge.run({ action: 'knowledge' }); assert.equal(calls.length, 0);
  const listing = await knowledge.run({ action: 'knowledge', path: 'remote' });
  assert.deepEqual(listing.files.map(file => file.path), ['README.md']);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('topic%2Fdocs'));
  const result = await knowledge.run({ action: 'knowledge', query: 'keyword', path: 'remote' });
  assert.equal(result.matches[0].line, 2);
  assert.equal(result.matches[0].revision, rootSha);
  assert.equal(calls.length, 2);
  const read = await knowledge.run({ action: 'knowledge', path: 'remote/README.md', start: 2, limit: 1 });
  assert.equal(read.lines[0].text, 'keyword remote evidence');
  assert.equal(calls.length, 2, 'Immutable blob and tree caches avoid repeated downloads');
  await assert.rejects(knowledge.run({ action: 'knowledge', path: 'remote/.env' }), /Disallowed/);
  const aborted = new AbortController(); aborted.abort(new Error('stop knowledge'));
  await assert.rejects(knowledge.run({ action: 'knowledge', path: 'remote' }, { signal: aborted.signal }), /stop knowledge/);
});

test('GitHub errors, oversized responses and partial search coverage remain explicit', async () => {
  const config = name => ({ knowledgeConfig: JSON.stringify({ libraries: [{ id: 'remote', name: 'Remote', kind: 'github', location: `https://github.com/strong-test/${name}`, scope: 'global', ref: 'main' }] }) });
  const error = await new Knowledge('/project', config('no-access'), { fetchImpl: async () => new Response('', { status: 403 }) }).run({ action: 'knowledge', path: 'remote' });
  assert.match(error.errors[0].message, /GitHub HTTP 403/);
  const large = await new Knowledge('/project', config('too-large'), { fetchImpl: async () => new Response('{}', { headers: { 'content-length': '99999999' } }) }).run({ action: 'knowledge', path: 'remote' });
  assert.match(large.errors[0].message, /exceeds/);
  const sha = 'f'.repeat(40);
  const partial = new Knowledge('/project', config('partial'), { fetchImpl: async url => url.includes('/git/trees/') ? Response.json({ sha, truncated: true, tree: [] }) : Response.json({}) });
  assert.equal((await partial.run({ action: 'knowledge', query: 'keyword' })).truncated, true);
});

test('native final assembly follows the current caller directory and live project settings', async t => {
  const { paths, config } = await fixture(t);
  let transform, current = paths.a, lookup = 0;
  const agent = {};
  const ctx = { systemPrompt: { section() {} }, on(_name, callback) { transform = callback; }, workingDirectory: { async ensure(received) { assert.equal(received, agent); lookup++; return current; } } };
  installNativePolicy(ctx, () => resolveConfig(config));
  const assembly = { sections: [{ name: POLICY_SECTION, text: '' }], variables: {} };
  assert.match((await transform(null, { agent }, async () => assembly)).sections[0].text, /A uses TypeScript/);
  current = paths.ab;
  const updated = await transform(null, { agent }, async () => assembly);
  assert.match(updated.sections[0].text, /B uses Python/);
  assert.doesNotMatch(updated.sections[0].text, /A uses TypeScript/);
  assert.equal(lookup, 2);
});

test('local knowledge search matches all terms like GitHub sources', async (t) => {
  const { paths, config } = await fixture(t);
  const result = await new Knowledge(paths.a, config).run({ action: 'knowledge', query: 'shared architecture' });
  assert.ok(result.matches.some(match => match.library === 'common' && /shared keyword architecture/.test(match.text)));
  const single = await new Knowledge(paths.a, config).run({ action: 'knowledge', query: 'architecture' });
  assert.ok(single.matches.some(match => match.library === 'common'));
});
