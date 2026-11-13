// Tests for sort, uniq, comm and diff: exact outputs, columns, hunks, errors.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ShellError } from '../src/shell/fs.mjs';
import { main, names } from '../src/shell/coreutils/sort.mjs';

function makeCtx(options = {}) {
  const files = new Map(Object.entries(options.files || {}));
  const dirs = new Set(options.dirs || []);
  const ctx = {
    cwd: '/',
    env: new Map(),
    stdin: options.stdin || '',
    opts: { globstar: false, xtrace: false },
    check() {},
    vars() { return ''; },
    fs: {
      readBuffer(path) {
        if (dirs.has(path)) throw new ShellError('EISDIR', path);
        if (!files.has(path)) throw new ShellError('ENOENT', path);
        return Buffer.from(files.get(path), 'utf8');
      },
      writeText(path, cwd, text) {
        if (path.startsWith('nodir/')) throw new ShellError('ENOENT', path);
        files.set(path, text);
      }
    }
  };
  return { ctx, files };
}

function run(prog, args, ctx) {
  return main(prog, [prog, ...args], ctx);
}

function seq(count) {
  const lines = [];
  for (let index = 1; index <= count; index += 1) lines.push(String(index));
  return lines.join('\n') + '\n';
}

function withLine(text, number, value) {
  const lines = text.split('\n');
  lines[number - 1] = value;
  return lines.join('\n');
}

test('coreutils names', () => {
  assert.deepEqual(names, ['sort', 'uniq', 'comm', 'diff']);
});

test('sort: byte order, reverse and empty input', () => {
  let { ctx } = makeCtx();
  let result = run('sort', [], ctx);
  assert.equal(result.out, '');
  assert.equal(result.code, 0);
  assert.equal(result.err, '');

  ({ ctx } = makeCtx({ stdin: 'b\nA\na\nB\n' }));
  result = run('sort', [], ctx);
  assert.equal(result.out, 'A\nB\na\nb\n');

  ({ ctx } = makeCtx({ stdin: '\u{1F600}\n\uFFFD\n' }));
  result = run('sort', [], ctx);
  assert.equal(result.out, '\uFFFD\n\u{1F600}\n');

  ({ ctx } = makeCtx({ stdin: 'b\na\nc\n' }));
  result = run('sort', ['-r'], ctx);
  assert.equal(result.out, 'c\nb\na\n');

  ({ ctx } = makeCtx({ stdin: 'b\na' }));
  result = run('sort', [], ctx);
  assert.equal(result.out, 'a\nb\n');

  ({ ctx } = makeCtx({ files: { in: 'b\na\n' } }));
  result = run('sort', ['in'], ctx);
  assert.equal(result.out, 'a\nb\n');
});

test('sort: numeric keys and leading blanks', () => {
  let { ctx } = makeCtx({ stdin: '10\n9\n2\n' });
  assert.equal(run('sort', ['-n'], ctx).out, '2\n9\n10\n');
  assert.equal(run('sort', ['-nr'], ctx).out, '10\n9\n2\n');

  ({ ctx } = makeCtx({ stdin: ' 10\n9\n' }));
  assert.equal(run('sort', ['-n'], ctx).out, '9\n 10\n');

  ({ ctx } = makeCtx({ stdin: '\t10\n9\n' }));
  assert.equal(run('sort', ['-n'], ctx).out, '9\n\t10\n');

  ({ ctx } = makeCtx({ stdin: '-2\n+1.5\n.5\n' }));
  assert.equal(run('sort', ['-n'], ctx).out, '-2\n.5\n+1.5\n');

  ({ ctx } = makeCtx({ stdin: 'abc\n0\n' }));
  assert.equal(run('sort', ['-n'], ctx).out, '0\nabc\n');

  ({ ctx } = makeCtx({ stdin: '1.0\n1.0000000000000000001\n' }));
  assert.equal(run('sort', ['-n'], ctx).out, '1.0\n1.0000000000000000001\n');

  ({ ctx } = makeCtx({ stdin: '100000000000000000000000000000\n99999999999999999999999999999\n' }));
  assert.equal(run('sort', ['-n'], ctx).out, '99999999999999999999999999999\n100000000000000000000000000000\n');
});

test('sort: human readable numbers', () => {
  let { ctx } = makeCtx({ stdin: '1.5K\n1530\n1KB\n1KiB\n1024\n' });
  assert.equal(run('sort', ['-h'], ctx).out, '1024\n1530\n1KB\n1KiB\n1.5K\n');

  ({ ctx } = makeCtx({ stdin: '1M\n2K\n' }));
  assert.equal(run('sort', ['-h'], ctx).out, '2K\n1M\n');

  ({ ctx } = makeCtx({ stdin: '-1K\n5\n' }));
  assert.equal(run('sort', ['-h'], ctx).out, '-1K\n5\n');

  ({ ctx } = makeCtx({ stdin: '-1M\n-1K\n' }));
  assert.equal(run('sort', ['-h'], ctx).out, '-1M\n-1K\n');
});

test('sort: version sort', () => {
  const input = '1.10\n1.9\n1.0a\n1.0\na10\na2\na1\n1.0.1\n1.0.0\n0.9\n1.0~rc1\n1.0-1\n1.a\n1a\n1.00\n2.0\n';
  const expected = '0.9\n1.a\n1a\n1.0~rc1\n1.0\n1.00\n1.0a\n1.0-1\n1.0.0\n1.0.1\n1.9\n1.10\n2.0\na1\na2\na10\n';
  let { ctx } = makeCtx({ stdin: input });
  assert.equal(run('sort', ['-V'], ctx).out, expected);

  ({ ctx } = makeCtx({ stdin: '1.0\n1.0~rc1\n' }));
  assert.equal(run('sort', ['-V'], ctx).out, '1.0~rc1\n1.0\n');

  ({ ctx } = makeCtx({ stdin: 'x 1.10\nx 1.9\n' }));
  assert.equal(run('sort', ['-V', '-k2,2'], ctx).out, 'x 1.9\nx 1.10\n');
});

test('sort: case folding, blank skipping and stability', () => {
  let { ctx } = makeCtx({ stdin: 'B\n a\na\nA\n' });
  assert.equal(run('sort', ['-f'], ctx).out, ' a\nA\na\nB\n');

  ({ ctx } = makeCtx({ stdin: ' b\n a\na\nb\n' }));
  assert.equal(run('sort', ['-b'], ctx).out, ' a\na\n b\nb\n');

  ({ ctx } = makeCtx({ stdin: 'x b\nx a\n' }));
  assert.equal(run('sort', ['-k1,1'], ctx).out, 'x a\nx b\n');
  assert.equal(run('sort', ['-k1,1', '-r'], ctx).out, 'x b\nx a\n');
  assert.equal(run('sort', ['-k1,1', '-s'], ctx).out, 'x b\nx a\n');

  ({ ctx } = makeCtx({ stdin: 'b 2\na 1\na 1\nb 0\n' }));
  assert.equal(run('sort', ['-s', '-k1,1'], ctx).out, 'a 1\na 1\nb 2\nb 0\n');
});

test('sort: key fields and characters', () => {
  let { ctx } = makeCtx({ stdin: 'xac\nxab\n' });
  assert.equal(run('sort', ['-k1.2,1.2'], ctx).out, 'xab\nxac\n');

  ({ ctx } = makeCtx({ stdin: 'a:10\nb:9\nc:2\n' }));
  assert.equal(run('sort', ['-t:', '-k2,2n'], ctx).out, 'c:2\nb:9\na:10\n');

  ({ ctx } = makeCtx({ stdin: 'x 10\ny 9\n' }));
  assert.equal(run('sort', ['-k2,2n'], ctx).out, 'y 9\nx 10\n');

  ({ ctx } = makeCtx({ stdin: 'a\nb:1\n' }));
  assert.equal(run('sort', ['-t:', '-k2,2n'], ctx).out, 'a\nb:1\n');

  ({ ctx } = makeCtx({ stdin: 'x  b\ny  a\n' }));
  assert.equal(run('sort', ['-b', '-k2,2'], ctx).out, 'y  a\nx  b\n');

  ({ ctx } = makeCtx({ stdin: 'b 2\na 2\na 1\nb 1\n' }));
  assert.equal(run('sort', ['-k1,1', '-k2,2n'], ctx).out, 'a 1\na 2\nb 1\nb 2\n');

  ({ ctx } = makeCtx({ stdin: 'a 2\na 1\n' }));
  assert.equal(run('sort', ['-k1,1', '-k2,2r'], ctx).out, 'a 2\na 1\n');

  ({ ctx } = makeCtx({ stdin: 'b 1\na 2\n' }));
  assert.equal(run('sort', ['-k2,1'], ctx).out, 'a 2\nb 1\n');
});

test('sort: unique and output file', () => {
  let { ctx } = makeCtx({ stdin: 'a\na\nb\n' });
  assert.equal(run('sort', ['-u'], ctx).out, 'a\nb\n');

  ({ ctx } = makeCtx({ stdin: 'a 2\na 1\nb 0\n' }));
  assert.equal(run('sort', ['-k1,1', '-u'], ctx).out, 'a 2\nb 0\n');

  ({ ctx } = makeCtx({ stdin: 'A\na\n' }));
  assert.equal(run('sort', ['-f', '-u'], ctx).out, 'A\n');

  const made = makeCtx({ files: { in: 'b\na\n' } });
  const result = run('sort', ['-o', 'out.txt', 'in'], made.ctx);
  assert.equal(result.code, 0);
  assert.equal(result.out, '');
  assert.equal(made.files.get('out.txt'), 'a\nb\n');

  const missing = makeCtx({ stdin: 'a\n' });
  const failed = run('sort', ['-o', 'nodir/x'], missing.ctx);
  assert.equal(failed.code, 2);
  assert.equal(failed.out, '');
  assert.equal(failed.err, 'sort: nodir/x: No such file or directory\n');
});

test('sort: accepted no-op options', () => {
  let { ctx } = makeCtx({ stdin: 'b\na\n' });
  assert.equal(run('sort', ['-m'], ctx).code, 0);
  assert.equal(run('sort', ['-m'], ctx).out, 'a\nb\n');

  ({ ctx } = makeCtx({ stdin: 'b\na\n' }));
  const parallel = run('sort', ['--parallel=4', '-r'], ctx);
  assert.equal(parallel.code, 0);
  assert.equal(parallel.out, 'b\na\n');
});

test('sort: error diagnostics', () => {
  const cases = [
    [['-k0'], "sort: field number is zero: invalid field specification '0'\n"],
    [['-k1.0'], "sort: character offset is zero: invalid field specification '1.0'\n"],
    [['-k1.'], "sort: invalid number after '.': invalid count at start of ''\n"],
    [['-k1,2,3'], "sort: stray character in field spec: invalid field specification '1,2,3'\n"],
    [['-k1.2x'], "sort: stray character in field spec: invalid field specification '1.2x'\n"],
    [['-k'], "sort: option requires an argument -- 'k'\n"],
    [['-k1,1d'], "sort: unsupported key modifier 'd'\n"],
    [['-t', '::'], "sort: multi-character tab '::'\n"],
    [['-t', ''], 'sort: empty tab\n'],
    [['-Z'], "sort: invalid option -- 'Z'\n"],
    [['nosuch'], 'sort: nosuch: No such file or directory\n']
  ];
  for (const [args, expected] of cases) {
    const { ctx } = makeCtx({ stdin: 'a\n' });
    const result = run('sort', args, ctx);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.equal(result.err, expected);
  }
});

test('uniq: filters and counts', () => {
  const input = 'a\na\nb\nc\nc\n';
  let { ctx } = makeCtx({ stdin: input });
  assert.equal(run('uniq', [], ctx).out, 'a\nb\nc\n');

  ({ ctx } = makeCtx({ stdin: input }));
  assert.equal(run('uniq', ['-c'], ctx).out, '      2 a\n      1 b\n      2 c\n');

  ({ ctx } = makeCtx({ stdin: input }));
  assert.equal(run('uniq', ['-d'], ctx).out, 'a\nc\n');

  ({ ctx } = makeCtx({ stdin: input }));
  assert.equal(run('uniq', ['-D'], ctx).out, 'a\na\nc\nc\n');

  ({ ctx } = makeCtx({ stdin: input }));
  assert.equal(run('uniq', ['-u'], ctx).out, 'b\n');

  ({ ctx } = makeCtx({ stdin: input }));
  assert.equal(run('uniq', ['-c', '-d'], ctx).out, '      2 a\n      2 c\n');

  ({ ctx } = makeCtx({ stdin: input }));
  assert.equal(run('uniq', ['-c', '-u'], ctx).out, '      1 b\n');

  ({ ctx } = makeCtx({ stdin: input }));
  assert.equal(run('uniq', ['-D', '-u'], ctx).out, 'a\nc\n');

  ({ ctx } = makeCtx({ stdin: input }));
  assert.equal(run('uniq', ['-c', '-d', '-u'], ctx).out, '');

  ({ ctx } = makeCtx({ stdin: 'a\na\n' }));
  assert.equal(run('uniq', ['-c', '-D'], ctx).err, 'uniq: printing all duplicated lines and repeat counts is meaningless\n');
});

test('uniq: comparisons, skips and multiple files', () => {
  let { ctx } = makeCtx({ stdin: 'A\na\nB\n' });
  assert.equal(run('uniq', ['-i'], ctx).out, 'A\nB\n');

  ({ ctx } = makeCtx({ stdin: 'x a\ny a\nz b\n' }));
  assert.equal(run('uniq', ['-f1'], ctx).out, 'x a\nz b\n');

  ({ ctx } = makeCtx({ stdin: 'x\ta\ny a\nz b\n' }));
  assert.equal(run('uniq', ['-f1'], ctx).out, 'x\ta\ny a\nz b\n');

  ({ ctx } = makeCtx({ stdin: 'ax\nyx\nbz\n' }));
  assert.equal(run('uniq', ['-s2'], ctx).out, 'ax\n');

  ({ ctx } = makeCtx({ stdin: 'ab\nac\nzz\n' }));
  assert.equal(run('uniq', ['-w1'], ctx).out, 'ab\nzz\n');

  ({ ctx } = makeCtx({ stdin: 'a\nb\n' }));
  assert.equal(run('uniq', ['-w0'], ctx).out, 'a\n');

  ({ ctx } = makeCtx({ stdin: 'abcdef\nabcxyz\n' }));
  assert.equal(run('uniq', ['-s3', '-w2'], ctx).out, 'abcdef\nabcxyz\n');

  ({ ctx } = makeCtx({ stdin: 'a xx1\nb xx2\nc yy\n' }));
  assert.equal(run('uniq', ['-f1', '-s1'], ctx).out, 'a xx1\nb xx2\nc yy\n');

  ({ ctx } = makeCtx({ stdin: 'ABx\naby\n' }));
  assert.equal(run('uniq', ['-w2', '-i', '-c'], ctx).out, '      2 ABx\n');

  ({ ctx } = makeCtx({ stdin: 'A\na\nB\n' }));
  assert.equal(run('uniq', ['-D', '-i'], ctx).out, 'A\na\n');

  ({ ctx } = makeCtx({ stdin: 'a\na\nb\nc\nc\n' }));
  assert.equal(run('uniq', ['-D', '-u'], ctx).out, 'a\nc\n');

  ({ ctx } = makeCtx({ stdin: 'a\na\nb\n' }));
  assert.equal(run('uniq', ['-d', '-u'], ctx).out, '');

  ({ ctx } = makeCtx({ stdin: '   \n   \n' }));
  assert.equal(run('uniq', ['-f1', '-c'], ctx).out, '      2    \n');

  ({ ctx } = makeCtx({ stdin: 'x\nx\n' }));
  assert.equal(run('uniq', ['-f5', '-c'], ctx).out, '      2 x\n');

  ({ ctx } = makeCtx({ stdin: 'ab\nab\n' }));
  assert.equal(run('uniq', ['-s99', '-c'], ctx).out, '      2 ab\n');

  ({ ctx } = makeCtx({ files: { f1: 'a\na\n', f2: 'b\n' } }));
  assert.equal(run('uniq', ['f1', 'f2'], ctx).out, 'a\nb\n');

  ({ ctx } = makeCtx({ stdin: 'a\na\n', files: { f2: 'b\n' } }));
  assert.equal(run('uniq', ['-', 'f2'], ctx).out, 'a\nb\n');

  const wide = 'x\n'.repeat(12);
  ({ ctx } = makeCtx({ stdin: wide }));
  assert.equal(run('uniq', ['-c'], ctx).out, '     12 x\n');
});

test('uniq: error diagnostics', () => {
  let { ctx } = makeCtx({ stdin: 'a\n' });
  let result = run('uniq', ['nosuch'], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.equal(result.err, 'uniq: nosuch: No such file or directory\n');

  ({ ctx } = makeCtx({ stdin: 'a\n' }));
  result = run('uniq', ['-Z'], ctx);
  assert.equal(result.code, 2);
  assert.equal(result.err, "uniq: invalid option -- 'Z'\n");

  ({ ctx } = makeCtx({ stdin: 'a\n' }));
  result = run('uniq', ['-w', 'x'], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.err, "uniq: invalid number of bytes to compare: 'x'\n");

  ({ ctx } = makeCtx({ stdin: 'a\n' }));
  result = run('uniq', ['-f', '-1'], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.err, "uniq: invalid number of fields to skip: '-1'\n");
});

test('comm: columns and suppressed columns', () => {
  const files = { c1: 'a\nc\ne\n', c2: 'b\nc\nd\n' };
  let { ctx } = makeCtx({ files });
  assert.equal(run('comm', ['c1', 'c2'], ctx).out, 'a\n\tb\n\t\tc\n\td\ne\n');

  ({ ctx } = makeCtx({ files }));
  assert.equal(run('comm', ['-1', 'c1', 'c2'], ctx).out, 'b\n\tc\nd\n');

  ({ ctx } = makeCtx({ files }));
  assert.equal(run('comm', ['-2', 'c1', 'c2'], ctx).out, 'a\n\tc\ne\n');

  ({ ctx } = makeCtx({ files }));
  assert.equal(run('comm', ['-3', 'c1', 'c2'], ctx).out, 'a\n\tb\n\td\ne\n');

  ({ ctx } = makeCtx({ files }));
  assert.equal(run('comm', ['-12', 'c1', 'c2'], ctx).out, 'c\n');

  ({ ctx } = makeCtx({ files }));
  assert.equal(run('comm', ['-13', 'c1', 'c2'], ctx).out, 'b\nd\n');

  ({ ctx } = makeCtx({ files }));
  assert.equal(run('comm', ['-23', 'c1', 'c2'], ctx).out, 'a\ne\n');

  ({ ctx } = makeCtx({ files }));
  assert.equal(run('comm', ['-123', 'c1', 'c2'], ctx).out, '');
});

test('comm: duplicates, empty inputs and stdin', () => {
  let { ctx } = makeCtx({ files: { c1: 'a\na\nb\n', c2: 'a\na\nc\n' } });
  assert.equal(run('comm', ['c1', 'c2'], ctx).out, '\t\ta\n\t\ta\nb\n\tc\n');

  ({ ctx } = makeCtx({ files: { e1: '', e2: '' } }));
  assert.equal(run('comm', ['e1', 'e2'], ctx).out, '');

  ({ ctx } = makeCtx({ files: { n1: 'a\nb', n2: 'a\nb' } }));
  assert.equal(run('comm', ['n1', 'n2'], ctx).out, '\t\ta\n\t\tb\n');

  ({ ctx } = makeCtx({ stdin: 'b\nc\n', files: { c2: 'b\nc\n' } }));
  assert.equal(run('comm', ['-', 'c2'], ctx).out, '\t\tb\n\t\tc\n');
});

test('comm: error diagnostics', () => {
  let { ctx } = makeCtx({ files: { c1: 'a\n' } });
  let result = run('comm', [], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.err, 'comm: missing operand\n');

  ({ ctx } = makeCtx({ files: { c1: 'a\n' } }));
  result = run('comm', ['c1'], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.err, "comm: missing operand after 'c1'\n");

  ({ ctx } = makeCtx({ files: { c1: 'a\n', c2: 'a\n' } }));
  result = run('comm', ['c1', 'c2', 'extra'], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.err, "comm: extra operand 'extra'\n");

  ({ ctx } = makeCtx({ files: { c1: 'a\n' } }));
  result = run('comm', ['c1', 'nosuch'], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.err, 'comm: nosuch: No such file or directory\n');

  ({ ctx } = makeCtx({ files: { c1: 'a\n' } }));
  result = run('comm', ['-Z', 'c1', 'c1'], ctx);
  assert.equal(result.code, 2);
  assert.equal(result.err, "comm: invalid option -- 'Z'\n");
});

test('diff: unified output and headers', () => {
  let { ctx } = makeCtx({ files: { f1: 'a\nb\nc\n', f2: 'a\nB\nc\n' } });
  assert.equal(run('diff', ['-u', 'f1', 'f2'], ctx).out, '--- f1\n+++ f2\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');

  ({ ctx } = makeCtx({ files: { f1: 'a\nb\nc\n', f2: 'a\nb\nc\n' } }));
  let result = run('diff', ['-u', 'f1', 'f2'], ctx);
  assert.equal(result.code, 0);
  assert.equal(result.out, '');

  ({ ctx } = makeCtx({ files: { e: '', t: 'x\ny\n' } }));
  assert.equal(run('diff', ['-u', 'e', 't'], ctx).out, '--- e\n+++ t\n@@ -0,0 +1,2 @@\n+x\n+y\n');

  ({ ctx } = makeCtx({ files: { e: '', t: 'x\ny\n' } }));
  assert.equal(run('diff', ['-u', 't', 'e'], ctx).out, '--- t\n+++ e\n@@ -1,2 +0,0 @@\n-x\n-y\n');

  ({ ctx } = makeCtx({ files: { o1: 'a\n', o2: 'b\n' } }));
  assert.equal(run('diff', ['-u', 'o1', 'o2'], ctx).out, '--- o1\n+++ o2\n@@ -1 +1 @@\n-a\n+b\n');

  ({ ctx } = makeCtx({ files: { o0: '', o1: 'a\n' } }));
  assert.equal(run('diff', ['-u', 'o0', 'o1'], ctx).out, '--- o0\n+++ o1\n@@ -0,0 +1 @@\n+a\n');

  ({ ctx } = makeCtx({ files: { o0: '', o1: 'a\n' } }));
  assert.equal(run('diff', ['-u', 'o1', 'o0'], ctx).out, '--- o1\n+++ o0\n@@ -1 +0,0 @@\n-a\n');

  const seven = seq(7);
  ({ ctx } = makeCtx({ files: { s7: seven, s7m: withLine(seven, 7, 'X') } }));
  assert.equal(run('diff', ['-u', 's7', 's7m'], ctx).out, '--- s7\n+++ s7m\n@@ -4,4 +4,4 @@\n 4\n 5\n 6\n-7\n+X\n');
});

test('diff: hunk merging and splitting', () => {
  const twenty = seq(20);
  const merged = withLine(withLine(twenty, 5, 'FIVE'), 12, 'TWELVE');
  let { ctx } = makeCtx({ files: { s20: twenty, s20m: merged } });
  const mergeOutput = [
    '--- s20', '+++ s20m', '@@ -2,14 +2,14 @@',
    ' 2', ' 3', ' 4', '-5', '+FIVE', ' 6', ' 7', ' 8', ' 9', ' 10', ' 11', '-12', '+TWELVE', ' 13', ' 14', ' 15'
  ].join('\n') + '\n';
  assert.equal(run('diff', ['-u', 's20', 's20m'], ctx).out, mergeOutput);

  const split = withLine(withLine(twenty, 5, 'FIVE'), 13, 'THIRTEEN');
  ({ ctx } = makeCtx({ files: { s21: twenty, s21m: split } }));
  const splitOutput = run('diff', ['-u', 's21', 's21m'], ctx).out;
  const headers = splitOutput.split('\n').filter((line) => line.startsWith('@@'));
  assert.deepEqual(headers, ['@@ -2,7 +2,7 @@', '@@ -10,7 +10,7 @@']);
  assert.equal(splitOutput.split('\n')[0], '--- s21');
  assert.equal(splitOutput.split('\n')[1], '+++ s21m');
});

test('diff: normal format commands', () => {
  let { ctx } = makeCtx({ files: { f1: 'a\nb\nc\n', f2: 'a\nB\nc\n' } });
  assert.equal(run('diff', ['f1', 'f2'], ctx).out, '2c2\n< b\n---\n> B\n');

  ({ ctx } = makeCtx({ files: { f1: 'a\n', f2: 'a\nb\nc\n' } }));
  assert.equal(run('diff', ['f1', 'f2'], ctx).out, '1a2,3\n> b\n> c\n');

  ({ ctx } = makeCtx({ files: { f1: 'a\nb\nc\n', f2: 'a\n' } }));
  assert.equal(run('diff', ['f1', 'f2'], ctx).out, '2,3d1\n< b\n< c\n');

  ({ ctx } = makeCtx({ files: { e: '', t: 'x\ny\n' } }));
  assert.equal(run('diff', ['e', 't'], ctx).out, '0a1,2\n> x\n> y\n');

  ({ ctx } = makeCtx({ files: { e: '', t: 'x\ny\n' } }));
  assert.equal(run('diff', ['t', 'e'], ctx).out, '1,2d0\n< x\n< y\n');

  const ten = seq(10);
  const changed = withLine(withLine(ten, 2, 'X'), 8, 'Y');
  ({ ctx } = makeCtx({ files: { s10: ten, s10m: changed } }));
  assert.equal(run('diff', ['s10', 's10m'], ctx).out, '2c2\n< 2\n---\n> X\n8c8\n< 8\n---\n> Y\n');

  ({ ctx } = makeCtx({ files: { f1: 'a\nb\n', f2: 'a\nb\n' } }));
  const same = run('diff', ['f1', 'f2'], ctx);
  assert.equal(same.code, 0);
  assert.equal(same.out, '');
});

test('diff: brief, case and whitespace options', () => {
  let { ctx } = makeCtx({ files: { f1: 'a\nb\n', f2: 'a\nB\n' } });
  let result = run('diff', ['-q', 'f1', 'f2'], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.out, 'Files f1 and f2 differ\n');

  ({ ctx } = makeCtx({ files: { f1: 'a\n', f2: 'a\n' } }));
  result = run('diff', ['-q', 'f1', 'f2'], ctx);
  assert.equal(result.code, 0);
  assert.equal(result.out, '');

  ({ ctx } = makeCtx({ files: { f1: 'a\nb\n', f2: 'a\nB\n' } }));
  assert.equal(run('diff', ['-q', '-u', 'f1', 'f2'], ctx).out, 'Files f1 and f2 differ\n');

  ({ ctx } = makeCtx({ files: { f1: 'Hello\n', f2: 'hello\n' } }));
  result = run('diff', ['-i', 'f1', 'f2'], ctx);
  assert.equal(result.code, 0);
  assert.equal(result.out, '');

  ({ ctx } = makeCtx({ files: { f1: 'a  b\n', f2: 'a b\n' } }));
  result = run('diff', ['-w', 'f1', 'f2'], ctx);
  assert.equal(result.code, 0);
  assert.equal(result.out, '');

  ({ ctx } = makeCtx({ files: { f1: 'a  b\n', f2: 'a b\n' } }));
  result = run('diff', ['-b', 'f1', 'f2'], ctx);
  assert.equal(result.code, 0);

  ({ ctx } = makeCtx({ files: { f1: 'a \n', f2: 'a\n' } }));
  assert.equal(run('diff', ['-b', 'f1', 'f2'], ctx).code, 0);

  ({ ctx } = makeCtx({ files: { f1: '  a\n', f2: ' a\n' } }));
  assert.equal(run('diff', ['-b', 'f1', 'f2'], ctx).code, 0);

  ({ ctx } = makeCtx({ files: { f1: '  a\tb\n', f2: 'a b\n' } }));
  result = run('diff', ['-b', 'f1', 'f2'], ctx);
  assert.equal(result.code, 1);
  assert.equal(result.out, '1c1\n<   a\tb\n---\n> a b\n');

  ({ ctx } = makeCtx({ files: { f1: 'a\tb\n', f2: 'a b\n' } }));
  assert.equal(run('diff', ['-b', 'f1', 'f2'], ctx).code, 0);
});

test('diff: missing final newlines', () => {
  let { ctx } = makeCtx({ files: { n1: 'a\nb', n2: 'a\nb\n' } });
  assert.equal(run('diff', ['-u', 'n1', 'n2'], ctx).out, '--- n1\n+++ n2\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');

  ({ ctx } = makeCtx({ files: { n1: 'a\nb', n2: 'a\nb\n' } }));
  assert.equal(run('diff', ['n1', 'n2'], ctx).out, '2c2\n< b\n\\ No newline at end of file\n---\n> b\n');

  ({ ctx } = makeCtx({ files: { n1: 'q\na\nb', n2: 'r\na\nb\n' } }));
  assert.equal(run('diff', ['-u', 'n1', 'n2'], ctx).out, '--- n1\n+++ n2\n@@ -1,3 +1,3 @@\n-q\n+r\n a\n-b\n\\ No newline at end of file\n+b\n');

  ({ ctx } = makeCtx({ files: { n1: 'a\nb', n2: 'a\nb' } }));
  const same = run('diff', ['n1', 'n2'], ctx);
  assert.equal(same.code, 0);
  assert.equal(same.out, '');
});

test('diff: stdin label and error diagnostics', () => {
  let made = makeCtx({ stdin: 'a\nb\n', files: { f1: 'a\nb\nc\n' } });
  assert.equal(run('diff', ['-u', '-', 'f1'], made.ctx).out, '--- -\n+++ f1\n@@ -1,2 +1,3 @@\n a\n b\n+c\n');

  made = makeCtx({ files: { f1: 'a\n' } });
  let result = run('diff', ['f1', 'nosuch'], made.ctx);
  assert.equal(result.code, 2);
  assert.equal(result.out, '');
  assert.equal(result.err, 'diff: nosuch: No such file or directory\n');

  made = makeCtx({ files: { f1: 'a\n' }, dirs: ['adir'] });
  result = run('diff', ['adir', 'f1'], made.ctx);
  assert.equal(result.code, 2);
  assert.equal(result.err, 'diff: adir: Is a directory\n');

  made = makeCtx({ files: { f1: 'a\n' } });
  result = run('diff', ['f1'], made.ctx);
  assert.equal(result.code, 2);
  assert.equal(result.err, "diff: missing operand after 'f1'\n");

  made = makeCtx();
  result = run('diff', [], made.ctx);
  assert.equal(result.code, 2);
  assert.equal(result.err, "diff: missing operand after 'diff'\n");

  made = makeCtx({ files: { f1: 'a\n' } });
  result = run('diff', ['f1', 'f1', 'f1'], made.ctx);
  assert.equal(result.code, 2);
  assert.equal(result.err, "diff: extra operand 'f1'\n");

  made = makeCtx({ files: { f1: 'a\n' } });
  result = run('diff', ['-Z', 'f1', 'f1'], made.ctx);
  assert.equal(result.code, 2);
  assert.equal(result.err, "diff: invalid option -- 'Z'\n");

  made = makeCtx({ files: { f1: 'a\n' } });
  result = run('diff', ['-r', 'f1', 'f1'], made.ctx);
  assert.equal(result.code, 2);
  assert.equal(result.err, "diff: invalid option -- 'r'\n");

  made = makeCtx({ files: { f1: 'a\n', f2: 'b\n' } });
  const differ = run('diff', ['-u', 'f1', 'f2'], made.ctx);
  assert.equal(differ.code, 1);
  assert.equal(differ.err, '');
});
