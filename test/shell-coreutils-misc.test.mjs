import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createFs } from '../src/shell/fs.mjs';
import { names, main } from '../src/shell/coreutils/misc.mjs';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const ABC_MD5 = '900150983cd24fb0d6963f7d28e17f72';

/** Build a ctx shaped like exec.mjs hands to coreutils. */
function makeCtx(fs, extra = {}) {
  return {
    cwd: '/',
    env: new Map([
      ['PATH', '/bin:/usr/bin'],
      ['HOME', '/home/u'],
      ['FOO', 'bar'],
    ]),
    fs,
    stdin: '',
    opts: { globstar: false, xtrace: false },
    check() {},
    vars() {
      return '';
    },
    ...extra,
  };
}

function call(ctx, prog, ...args) {
  return main(prog, [prog, ...args], ctx);
}

async function makeSandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-misc-'));
  return { root, fs: createFs({ root }), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('misc module declares every documented command name', () => {
  const expected = [
    'basename', 'date', 'dirname', 'false', 'hostname', 'md5sum', 'printenv',
    'realpath', 'seq', 'sha256sum', 'sleep', 'true', 'which',
  ];
  assert.deepEqual([...names].sort(), expected);
  const ctx = makeCtx(null);
  assert.deepEqual(call(ctx, 'true'), { code: 0, out: '', err: '' });
  assert.deepEqual(call(ctx, 'false'), { code: 1, out: '', err: '' });
  assert.equal(call(ctx, 'true', 'ignored', '--nonsense').code, 0);
  assert.equal(call(ctx, 'false', 'ignored').code, 1);
});

test('date formats an epoch the way bash does', () => {
  const ctx = makeCtx(null);
  const at = (...args) => call(ctx, 'date', '-u', '-d', '@0', ...args);

  assert.deepEqual(at(), { code: 0, out: 'Thu Jan  1 00:00:00 UTC 1970\n', err: '' });
  assert.equal(at('+%Y').out, '1970\n');
  assert.equal(at('+%y').out, '70\n');
  assert.equal(at('+%m/%d').out, '01/01\n');
  assert.equal(at('+%e').out, ' 1\n');
  assert.equal(at('+%H:%M:%S').out, '00:00:00\n');
  assert.equal(at('+%j').out, '001\n');
  assert.equal(at('+%u').out, '4\n');
  assert.equal(at('+%w').out, '4\n');
  assert.equal(at('+%a').out, 'Thu\n');
  assert.equal(at('+%A').out, 'Thursday\n');
  assert.equal(at('+%b').out, 'Jan\n');
  assert.equal(at('+%B').out, 'January\n');
  assert.equal(at('+%p').out, 'AM\n');
  assert.equal(at('+%I').out, '12\n');
  assert.equal(at('+%Z').out, 'UTC\n');
  assert.equal(at('+%z').out, '+0000\n');
  assert.equal(at('+%:z').out, '+00:00\n');
  assert.equal(at('+%F').out, '1970-01-01\n');
  assert.equal(at('+%T').out, '00:00:00\n');
  assert.equal(at('+%D').out, '01/01/70\n');
  assert.equal(at('+%R').out, '00:00\n');
  assert.equal(at('+%N').out, '000000000\n');
  assert.equal(at('+%s').out, '0\n');
  assert.equal(at('+%V').out, '01\n');
  assert.equal(at('+%G').out, '1970\n');
  assert.equal(at('+%C').out, '19\n');
  assert.equal(at('+%q').out, '1\n');
  assert.equal(call(ctx, 'date', '-u', '-d', '@0', '-R').out, 'Thu, 01 Jan 1970 00:00:00 +0000\n');
  assert.equal(call(ctx, 'date', '-u', '-d', '@0', '--rfc-email').out, 'Thu, 01 Jan 1970 00:00:00 +0000\n');
  assert.equal(at('+%%').out, '%\n');
  assert.equal(at('+%Q').out, '%Q\n');
  assert.equal(at('+plain text').out, 'plain text\n');
});

test('date parses the supported -d forms and rejects the rest', () => {
  const ctx = makeCtx(null);
  assert.equal(call(ctx, 'date', '-u', '-d', '2020-01-01', '+%s').out, '1577836800\n');
  assert.equal(call(ctx, 'date', '-u', '-d', '2020-01-01 00:00:00', '+%F %T').out, '2020-01-01 00:00:00\n');
  assert.equal(call(ctx, 'date', '-u', '-d', '1970-01-01T00:00:00Z', '+%s').out, '0\n');
  assert.equal(call(ctx, 'date', '-u', '-d', '1970-01-01T00:00:00+02:00', '+%s').out, '-7200\n');
  assert.equal(call(ctx, 'date', '-u', '-d', '@1.5', '+%S.%N').out, '01.500000000\n');
  assert.equal(call(ctx, 'date', '-u', '-d', '@-86400', '+%F').out, '1969-12-31\n');
  assert.equal(call(ctx, 'date', '-u', '-d', '2020-02-29 12:34:56', '+%s').out, '1582979696\n');

  const invalid = call(ctx, 'date', '-u', '-d', '2021-02-29', '+%F');
  assert.equal(invalid.code, 1);
  assert.equal(invalid.err, "date: invalid date '2021-02-29'\n");
  assert.deepEqual(call(ctx, 'date', '-u', '--date=', '+%F'), {
    code: 1,
    out: '',
    err: "date: invalid date ''\n",
  });
  assert.deepEqual(call(ctx, 'date', '-u', '-d', '', '+%F'), {
    code: 1,
    out: '',
    err: "date: invalid date ''\n",
  });

  const clash = call(ctx, 'date', '-u', '-d', '@0', '-r', 'somefile');
  assert.equal(clash.code, 1);
  assert.equal(clash.err, 'date: the options to specify dates for printing are mutually exclusive\n');

  const extra = call(ctx, 'date', '-u', '+%Y', '+%T');
  assert.equal(extra.code, 1);
  assert.equal(extra.err, "date: extra operand '+%T'\n");
});

test('date -r reads a file mtime and the local default is bash shaped', async () => {
  const sandbox = await makeSandbox();
  const ctx = makeCtx(sandbox.fs);
  try {
    await writeFile(path.join(sandbox.root, 'stamp.txt'), 'x');
    const info = sandbox.fs.stat('/stamp.txt', '/');
    const expected = String(Math.floor(info.mtimeMs / 1000));
    assert.equal(call(ctx, 'date', '-u', '-r', 'stamp.txt', '+%s').out, expected + '\n');

    const missing = call(ctx, 'date', '-u', '-r', 'nope.txt', '+%s');
    assert.equal(missing.code, 1);
    assert.equal(missing.err, 'date: nope.txt: No such file or directory\n');

    const local = call(ctx, 'date', '-d', '@0');
    assert.match(local.out, /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \S+ \d{4}\n$/);
    assert.equal(call(ctx, 'date', '-u', '-d', '@0', '+%Z').out, 'UTC\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('seq matches GNU spacing, separators and formatting', () => {
  const ctx = makeCtx(null);
  assert.equal(call(ctx, 'seq', '3').out, '1\n2\n3\n');
  assert.equal(call(ctx, 'seq', '2', '4').out, '2\n3\n4\n');
  assert.equal(call(ctx, 'seq', '0.1', '0.1', '0.3').out, '0.1\n0.2\n0.3\n');
  assert.equal(call(ctx, 'seq', '0.1', '0.2', '0.3').out, '0.1\n0.3\n');
  assert.equal(call(ctx, 'seq', '0.5', '0.5', '2').out, '0.5\n1.0\n1.5\n2.0\n');
  assert.equal(call(ctx, 'seq', '--', '5', '-1', '1').out, '5\n4\n3\n2\n1\n');
  assert.equal(call(ctx, 'seq', '5', '1').out, '');
  assert.equal(call(ctx, 'seq', '5', '1').code, 0);
  assert.equal(call(ctx, 'seq', '-s', ',', '1', '3').out, '1,2,3\n');
  assert.equal(call(ctx, 'seq', '-s', '', '1', '3').out, '123\n');
  assert.equal(call(ctx, 'seq', '-w', '8', '11').out, '08\n09\n10\n11\n');
  assert.equal(call(ctx, 'seq', '-w', '-s', ':', '8', '10').out, '08:09:10\n');
  assert.equal(call(ctx, 'seq', '-f', '%03.1f', '1', '2').out, '1.0\n2.0\n');
  assert.equal(call(ctx, 'seq', '-f', 'x=%g', '1', '3').out, 'x=1\nx=2\nx=3\n');
  assert.equal(call(ctx, 'seq', '-f', '%.3e', '1000', '1000').out, '1.000e+03\n');
});

test('seq reports GNU style diagnostics', () => {
  const ctx = makeCtx(null);
  const invalid = call(ctx, 'seq', 'abc');
  assert.equal(invalid.code, 1);
  assert.equal(invalid.err, "seq: invalid floating point argument: 'abc'\n");

  const zero = call(ctx, 'seq', '1', '0', '5');
  assert.equal(zero.code, 1);
  assert.equal(zero.err, "seq: invalid Zero increment value: '0'\n");

  const extra = call(ctx, 'seq', '1', '2', '3', '4');
  assert.equal(extra.code, 1);
  assert.equal(extra.err, "seq: extra operand '4'\n");

  const missing = call(ctx, 'seq');
  assert.equal(missing.code, 1);
  assert.equal(missing.err, 'seq: missing operand\n');

  const badFormat = call(ctx, 'seq', '-f', '%d', '1', '2');
  assert.equal(badFormat.code, 1);
  assert.equal(badFormat.err, "seq: format '%d' has unknown % directive\n");

  const noDirective = call(ctx, 'seq', '-f', 'nope', '1', '2');
  assert.equal(noDirective.err, "seq: format 'nope' has no % directive\n");

  const clash = call(ctx, 'seq', '-w', '-f', '%g', '1', '2');
  assert.equal(clash.code, 1);
  assert.equal(clash.err, 'seq: format string may not be specified when printing equal width strings\n');
});

test('sha256sum and md5sum hash files, stdin and report missing files', async () => {
  const sandbox = await makeSandbox();
  const ctx = makeCtx(sandbox.fs);
  try {
    await writeFile(path.join(sandbox.root, 'abc.txt'), 'abc');
    assert.deepEqual(call(ctx, 'sha256sum', 'abc.txt'), { code: 0, out: ABC_SHA256 + '  abc.txt\n', err: '' });
    assert.deepEqual(call(ctx, 'md5sum', 'abc.txt'), { code: 0, out: ABC_MD5 + '  abc.txt\n', err: '' });
    assert.deepEqual(call(ctx, 'sha256sum', '-b', 'abc.txt'), { code: 0, out: ABC_SHA256 + '  abc.txt\n', err: '' });

    const piped = { ...ctx, stdin: 'abc' };
    assert.deepEqual(main('sha256sum', ['sha256sum'], piped), { code: 0, out: ABC_SHA256 + '  -\n', err: '' });
    assert.deepEqual(main('md5sum', ['md5sum', '-'], piped), { code: 0, out: ABC_MD5 + '  -\n', err: '' });

    const missing = call(ctx, 'sha256sum', 'x');
    assert.equal(missing.code, 1);
    assert.equal(missing.err, 'sha256sum: x: No such file or directory\n');

    const twoFiles = call(ctx, 'sha256sum', 'abc.txt', 'x');
    assert.equal(twoFiles.code, 1);
    assert.equal(twoFiles.out, ABC_SHA256 + '  abc.txt\n');
    assert.equal(twoFiles.err, 'sha256sum: x: No such file or directory\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('sha256sum -c reports OK, FAILED and the GNU warning lines', async () => {
  const sandbox = await makeSandbox();
  const ctx = makeCtx(sandbox.fs);
  try {
    await writeFile(path.join(sandbox.root, 'abc.txt'), 'abc');
    await writeFile(path.join(sandbox.root, 'other.txt'), 'other');
    await writeFile(path.join(sandbox.root, 'good.sum'), ABC_SHA256 + '  abc.txt\n');
    await writeFile(path.join(sandbox.root, 'bad.sum'), ABC_SHA256 + '  other.txt\n');
    await writeFile(path.join(sandbox.root, 'mixed.sum'), ABC_SHA256 + '  abc.txt\n' + ABC_SHA256 + '  other.txt\n');
    await writeFile(path.join(sandbox.root, 'junk.sum'), 'not a checksum line\n');
    await writeFile(path.join(sandbox.root, 'gone.sum'), ABC_SHA256 + '  gone.txt\n');

    assert.deepEqual(call(ctx, 'sha256sum', '-c', 'good.sum'), { code: 0, out: 'abc.txt: OK\n', err: '' });

    const mismatched = call(ctx, 'sha256sum', '-c', 'bad.sum');
    assert.equal(mismatched.code, 1);
    assert.equal(mismatched.out, 'other.txt: FAILED\n');
    assert.equal(mismatched.err, 'sha256sum: WARNING: 1 computed checksum did NOT match\n');

    const mixed = call(ctx, 'sha256sum', '-c', 'mixed.sum');
    assert.equal(mixed.code, 1);
    assert.equal(mixed.out, 'abc.txt: OK\nother.txt: FAILED\n');

    const junk = call(ctx, 'sha256sum', '-c', 'junk.sum');
    assert.equal(junk.code, 0);
    assert.equal(junk.err, 'sha256sum: WARNING: 1 line is improperly formatted\n');

    const gone = call(ctx, 'sha256sum', '-c', 'gone.sum');
    assert.equal(gone.code, 1);
    assert.equal(gone.out, 'gone.txt: FAILED open or read\n');
    assert.equal(
      gone.err,
      'sha256sum: gone.txt: No such file or directory\nsha256sum: WARNING: 1 listed file could not be read\n',
    );

    const quiet = call(ctx, 'sha256sum', '-c', 'mixed.sum', '--quiet');
    assert.equal(quiet.out, 'other.txt: FAILED\n');
    const status = call(ctx, 'sha256sum', '-c', 'mixed.sum', '--status');
    assert.deepEqual(status, { code: 1, out: '', err: '' });

    const generated = call(ctx, 'md5sum', 'other.txt');
    const fromStdin = main('md5sum', ['md5sum', '-c', '-'], { ...ctx, stdin: generated.out });
    assert.equal(fromStdin.code, 0);
    assert.equal(fromStdin.out, 'other.txt: OK\n');

    const silentUnreadable = call(ctx, 'sha256sum', '-c', 'gone.sum', '--status');
    assert.deepEqual(silentUnreadable, { code: 1, out: '', err: '' });

    const missingFile = call(ctx, 'sha256sum', '-c', 'nope.sum');
    assert.equal(missingFile.code, 1);
    assert.equal(missingFile.err, 'sha256sum: nope.sum: No such file or directory\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('basename strips trailing slashes and suffixes like GNU', () => {
  const ctx = makeCtx(null);
  assert.equal(call(ctx, 'basename', '/usr/bin/').out, 'bin\n');
  assert.equal(call(ctx, 'basename', '/usr/bin/sort').out, 'sort\n');
  assert.equal(call(ctx, 'basename', 'a/b/c.txt', '.txt').out, 'c\n');
  assert.equal(call(ctx, 'basename', 'foo', 'foo').out, 'foo\n');
  assert.equal(call(ctx, 'basename', '/').out, '/\n');
  assert.equal(call(ctx, 'basename', '//').out, '/\n');
  assert.equal(call(ctx, 'basename', '').out, '\n');
  assert.equal(call(ctx, 'basename', '-s', '.txt', 'a/b/c.txt', 'd/e.txt').out, 'c\ne\n');
  assert.equal(call(ctx, 'basename', '-a', 'x/one', 'y/two').out, 'one\ntwo\n');
  assert.equal(call(ctx, 'basename', '-z', 'dir/file').out, 'file\0');
  assert.equal(call(ctx, 'basename').code, 1);
  assert.equal(call(ctx, 'basename').err, 'basename: missing operand\n');
  assert.equal(call(ctx, 'basename', 'a', 'b', 'c').err, "basename: extra operand 'c'\n");
  assert.equal(call(ctx, 'basename', '-a').err, 'basename: missing operand\n');
});

test('dirname handles multiple names and roots', () => {
  const ctx = makeCtx(null);
  assert.equal(call(ctx, 'dirname', '/usr/bin/').out, '/usr\n');
  assert.equal(call(ctx, 'dirname', '/usr/bin/sort').out, '/usr/bin\n');
  assert.equal(call(ctx, 'dirname', 'foo').out, '.\n');
  assert.equal(call(ctx, 'dirname', '/').out, '/\n');
  assert.equal(call(ctx, 'dirname', '//').out, '/\n');
  assert.equal(call(ctx, 'dirname', 'a//b').out, 'a\n');
  assert.equal(call(ctx, 'dirname', 'foo', '/a/b', '/').out, '.\n/a\n/\n');
  assert.equal(call(ctx, 'dirname', '-z', 'x/y').out, 'x\0');
  assert.equal(call(ctx, 'dirname').err, 'dirname: missing operand\n');
});

test('realpath resolves existing, missing and stripped paths', async () => {
  const sandbox = await makeSandbox();
  const ctx = makeCtx(sandbox.fs);
  try {
    await mkdir(path.join(sandbox.root, 'sub'));
    await writeFile(path.join(sandbox.root, 'sub', 'file.txt'), 'x');

    assert.equal(call(ctx, 'realpath', '.').out, '/\n');
    assert.equal(call(ctx, 'realpath', 'sub/../sub/file.txt').out, '/sub/file.txt\n');

    const missing = call(ctx, 'realpath', '-e', 'sub/nope.txt');
    assert.equal(missing.code, 1);
    assert.equal(missing.err, 'realpath: sub/nope.txt: No such file or directory\n');

    assert.equal(call(ctx, 'realpath', '-m', 'missing/dir/x').out, '/missing/dir/x\n');
    assert.equal(call(ctx, 'realpath', '-m', 'sub/../other').out, '/other\n');
    assert.equal(call(ctx, 'realpath', '-s', 'sub/../sub').out, '/sub\n');

    const defaultLeaf = call(ctx, 'realpath', 'sub/new.txt');
    assert.equal(defaultLeaf.code, 0);
    assert.equal(defaultLeaf.out, '/sub/new.txt\n');

    assert.equal(call(ctx, 'realpath', '-z', 'sub/file.txt').out, '/sub/file.txt\0');
    assert.equal(call(ctx, 'realpath').err, 'realpath: missing operand\n');
    assert.equal(call(ctx, 'realpath', '-Q', 'x').code, 2);
  } finally {
    await sandbox.cleanup();
  }
});

test('which searches PATH, honours -a and knows builtins', async () => {
  const sandbox = await makeSandbox();
  try {
    await mkdir(path.join(sandbox.root, 'bin'));
    await mkdir(path.join(sandbox.root, 'extra'));
    await writeFile(path.join(sandbox.root, 'bin', 'tool'), '#!/bin/sh\n');
    await writeFile(path.join(sandbox.root, 'extra', 'tool'), '#!/bin/sh\n');
    const ctx = makeCtx(sandbox.fs, {
      env: new Map([['PATH', '/bin:/extra:/usr/bin']]),
      builtins: new Set(['cd', 'echo']),
    });

    assert.deepEqual(call(ctx, 'which', 'tool'), { code: 0, out: '/bin/tool\n', err: '' });
    assert.equal(call(ctx, 'which', '-a', 'tool').out, '/bin/tool\n/extra/tool\n');

    const missing = call(ctx, 'which', 'nope');
    assert.deepEqual(missing, { code: 1, out: '', err: '' });

    assert.deepEqual(call(ctx, 'which', 'echo'), { code: 0, out: 'echo\n', err: '' });
    assert.equal(call(ctx, 'which', 'tool', 'nope').code, 1);
    assert.equal(call(ctx, 'which', 'tool', 'nope').out, '/bin/tool\n');
    assert.equal(call(ctx, 'which', '/bin/tool').out, '/bin/tool\n');
    assert.equal(call(ctx, 'which', '-a', 'echo').out, 'echo\n');
  } finally {
    await sandbox.cleanup();
  }
});

test('sleep validates intervals and really waits', () => {
  const ctx = makeCtx(null);
  const invalid = call(ctx, 'sleep', 'xx');
  assert.equal(invalid.code, 1);
  assert.equal(invalid.err, "sleep: invalid time interval 'xx'\n");
  assert.equal(call(ctx, 'sleep', '1S').err, "sleep: invalid time interval '1S'\n");
  assert.equal(call(ctx, 'sleep').err, 'sleep: missing operand\n');
  assert.equal(call(ctx, 'sleep', '0.01', '0.01').code, 0);

  const started = performance.now();
  const waited = call(ctx, 'sleep', '0.05');
  const elapsed = performance.now() - started;
  assert.equal(waited.code, 0);
  assert.equal(waited.out, '');
  assert.ok(elapsed >= 30, 'sleep 0.05 waited only ' + elapsed.toFixed(1) + 'ms');
  assert.ok(elapsed < 5000, 'sleep 0.05 waited ' + elapsed.toFixed(1) + 'ms');
  assert.equal(call(ctx, 'sleep', '0.001m').code, 0);
});

test('printenv and hostname report the environment and the host', () => {
  const ctx = makeCtx(null);
  assert.equal(call(ctx, 'printenv').out, 'PATH=/bin:/usr/bin\nHOME=/home/u\nFOO=bar\n');
  assert.equal(call(ctx, 'printenv', 'HOME').out, '/home/u\n');
  assert.equal(call(ctx, 'printenv', 'HOME', 'FOO').out, '/home/u\nbar\n');
  assert.deepEqual(call(ctx, 'printenv', 'NOPE'), { code: 1, out: '', err: '' });
  assert.equal(call(ctx, 'printenv', 'HOME', 'NOPE').code, 1);
  assert.equal(call(ctx, 'printenv', 'HOME', 'NOPE').out, '/home/u\n');
  assert.equal(call(ctx, 'printenv', '-0', 'HOME').out, '/home/u\0');

  const hostname = call(ctx, 'hostname');
  assert.equal(hostname.code, 0);
  assert.equal(hostname.out, os.hostname() + '\n');
  assert.equal(call(ctx, 'hostname', 'new-name').code, 1);
  assert.match(call(ctx, 'hostname', 'new-name').err, /you must be root/);
  assert.equal(call(ctx, 'hostname', '-s').out, os.hostname().split('.')[0] + '\n');
});
