import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('bundle freshness tolerates Git LF/CRLF checkouts but rejects stale source', async t => {
  const parent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'strong-ui-eol-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('strong-ui-eol-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'client'));
  const script = await readFile(new URL('../scripts/build-ui.mjs', import.meta.url), 'utf8');
  const bundle = (await readFile(new URL('../client/client.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const sources = await Promise.all(['controller.mjs', 'view.mjs', 'index.mjs'].map(async name => [name, (await readFile(new URL(`../client/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')]));
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/build-ui.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
  for (const [sourceEol, bundleEol] of [['\n', '\r\n'], ['\r\n', '\n'], ['\r\n', '\r\n']]) {
    await writeFile(path.join(root, 'scripts/build-ui.mjs'), script.replace(/\r\n/g, '\n').replace(/\n/g, sourceEol));
    for (const [name, content] of sources) await writeFile(path.join(root, 'client', name), content.replace(/\n/g, sourceEol));
    await writeFile(path.join(root, 'client/client.js'), bundle.replace(/\n/g, bundleEol));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(path.join(root, 'client/view.mjs'), sources.find(([name]) => name === 'view.mjs')[1] + '\n// New source is not in the committed bundle.\n');
  const stale = run();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /bundle is stale/);
});
