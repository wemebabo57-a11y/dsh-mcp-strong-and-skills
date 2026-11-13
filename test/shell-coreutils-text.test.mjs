import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createFs } from '../src/shell/fs.mjs';
import { main, names } from '../src/shell/coreutils/text.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-coreutils-text-'));

function context(stdin = '') {
  const shellFs = createFs({ root, mode: 'danger-full-access' });
  return {
    cwd: '/',
    env: new Map(),
    stdin,
    opts: {},
    fs: shellFs,
    check() {},
    vars() { return undefined; },
  };
}

const ctx = context();

const ok = out => ({ code: 0, out, err: '' });
const bad = (err, code = 1, out = '') => ({ code, out, err });

function check(prog, args, expected) {
  assert.deepEqual(main(prog, [prog, ...args], ctx), expected);
}

function checkWith(prog, stdin, args, expected) {
  assert.deepEqual(main(prog, [prog, ...args], context(stdin)), expected);
}

await writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
await writeFile(path.join(root, 'b.txt'), 'four\nfive\n');
await writeFile(path.join(root, 'num.txt'), '1\n2\n3\n4\n5\n');
await writeFile(path.join(root, 'blanks.txt'), 'x\n\n\n\ny\n');
await writeFile(path.join(root, 'cols.txt'), 'a:b:c\n1:2:3\n');
await writeFile(path.join(root, 'mixed.txt'), 'plain\na:b\n');
await writeFile(path.join(root, 'sparse.txt'), 'x:y::z:\n');
await writeFile(path.join(root, 'abcdef.txt'), 'abcdef\n');
await writeFile(path.join(root, 'tabs.txt'), 'a\tb\n');
await writeFile(path.join(root, 'noeol.txt'), 'tail');
await writeFile(path.join(root, 'empty.txt'), '');
await writeFile(path.join(root, 'latin.txt'), 'caf\u00e9\n');
await writeFile(path.join(root, 'ctl.txt'), 'a\u0001b\u007f\n');
await writeFile(path.join(root, 'crlf.txt'), 'a\r\nb\r\n');
await mkdir(path.join(root, 'sub'));

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('names lists every text command', () => {
  assert.deepEqual(names, ['cat', 'head', 'tail', 'wc', 'cut', 'tr', 'tee', 'nl', 'tac', 'paste']);
  assert.equal(names.length, 10);
});

test('cat concatenates and numbers', () => {
  check('cat', ['a.txt'], ok('one\ntwo\nthree\n'));
  check('cat', ['a.txt', 'b.txt'], ok('one\ntwo\nthree\nfour\nfive\n'));
  check('cat', ['-n', 'a.txt'], ok('     1\tone\n     2\ttwo\n     3\tthree\n'));
  check('cat', ['-b', 'blanks.txt'], ok('     1\tx\n\n\n\n     2\ty\n'));
  check('cat', ['-s', 'blanks.txt'], ok('x\n\ny\n'));
  check('cat', ['-n', '-s', 'blanks.txt'], ok('     1\tx\n     2\t\n     3\ty\n'));
  check('cat', ['-A', 'tabs.txt'], ok('a^Ib$\n'));
  check('cat', ['-T', 'tabs.txt'], ok('a^Ib\n'));
  check('cat', ['-v', 'ctl.txt'], ok('a^Ab^?\n'));
  check('cat', ['-v', 'latin.txt'], ok('cafM-CM-)\n'));
  check('cat', ['-E', 'noeol.txt'], ok('tail'));
  check('cat', ['empty.txt'], ok(''));
  check('cat', ['a.txt', 'nope.txt'], bad('cat: nope.txt: No such file or directory\n', 1, 'one\ntwo\nthree\n'));
  check('cat', ['sub'], bad('cat: sub: Is a directory\n'));
  checkWith('cat', 'abc', [], ok('abc'));
  checkWith('cat', 'abc', ['-n'], ok('     1\tabc'));
});

test('cat keeps carriage returns untouched', () => {
  check('cat', ['crlf.txt'], ok('a\r\nb\r\n'));
});

test('head selects lines and bytes', () => {
  check('head', ['-n', '2', 'num.txt'], ok('1\n2\n'));
  check('head', ['-n', '-2', 'num.txt'], ok('1\n2\n3\n'));
  check('head', ['-n', '-0', 'num.txt'], ok('1\n2\n3\n4\n5\n'));
  check('head', ['-c', '3', 'num.txt'], ok('1\n2'));
  check('head', ['-c', '-3', 'num.txt'], ok('1\n2\n3\n4'));
  check('head', ['-2', 'num.txt'], ok('1\n2\n'));
  check('head', ['-n', '+1', 'num.txt'], ok('1\n'));
  check('head', ['--lines=2', 'num.txt'], ok('1\n2\n'));
  check('head', ['-c', '2', '-n', '2', 'num.txt'], ok('1\n2\n'));
  check('head', ['-n', '0', 'a.txt'], ok(''));
  check('head', ['-n', '1', 'a.txt', 'b.txt'], ok('==> a.txt <==\none\n\n==> b.txt <==\nfour\n'));
  check('head', ['-n', '1', 'nope.txt', 'a.txt'], bad("head: cannot open 'nope.txt' for reading: No such file or directory\n", 1, '==> a.txt <==\none\n'));
  check('head', ['-n', 'x', 'a.txt'], bad("head: invalid number of lines: 'x'\n"));
  check('head', ['-c', 'x', 'a.txt'], bad("head: invalid number of bytes: 'x'\n"));
  check('head', ['-n', '1', 'noeol.txt'], ok('tail'));
});

test('tail selects lines and bytes', () => {
  check('tail', ['-n', '2', 'num.txt'], ok('4\n5\n'));
  check('tail', ['-n', '+3', 'num.txt'], ok('3\n4\n5\n'));
  check('tail', ['-n', '+1', 'num.txt'], ok('1\n2\n3\n4\n5\n'));
  check('tail', ['-c', '3', 'num.txt'], ok('\n5\n'));
  check('tail', ['-c', '+5', 'num.txt'], ok('3\n4\n5\n'));
  check('tail', ['-2', 'num.txt'], ok('4\n5\n'));
  check('tail', ['-n', '0', 'a.txt'], ok(''));
  check('tail', ['-n', '1', 'noeol.txt'], ok('tail'));
  check('tail', ['-n', '1', 'a.txt', 'b.txt'], ok('==> a.txt <==\nthree\n\n==> b.txt <==\nfive\n'));
  check('tail', ['-n', '1', 'nope.txt', 'a.txt'], bad("tail: cannot open 'nope.txt' for reading: No such file or directory\n", 1, '==> a.txt <==\nthree\n'));
  check('tail', ['-n', '+9', 'num.txt'], ok(''));
});

test('wc counts and aligns like bash', () => {
  check('wc', ['num.txt'], ok(' 5  5 10 num.txt\n'));
  check('wc', ['-l', 'num.txt'], ok('5 num.txt\n'));
  check('wc', ['-l', '-c', 'num.txt'], ok(' 5 10 num.txt\n'));
  check('wc', ['-L', 'a.txt'], ok('5 a.txt\n'));
  check('wc', ['-m', 'latin.txt'], ok('5 latin.txt\n'));
  check('wc', ['-c', 'latin.txt'], ok('6 latin.txt\n'));
  check('wc', ['num.txt', 'a.txt'], ok(' 5  5 10 num.txt\n 3  3 14 a.txt\n 8  8 24 total\n'));
  check('wc', ['-l', 'num.txt', 'a.txt'], ok(' 5 num.txt\n 3 a.txt\n 8 total\n'));
  check('wc', ['-l', 'nope.txt'], bad('wc: nope.txt: No such file or directory\n'));
  checkWith('wc', 'a\n', [], ok('      1       1       2\n'));
  checkWith('wc', 'a\n', ['-l'], ok('1\n'));
  checkWith('wc', 'ab\n', ['-c', '-l'], ok('      1       3\n'));
  checkWith('wc', 'a b\tc\n', ['-L'], ok('9\n'));
});

test('cut selects characters', () => {
  check('cut', ['-c', '1-3', 'a.txt'], ok('one\ntwo\nthr\n'));
  check('cut', ['-c', '3,1', 'a.txt'], ok('oe\nto\ntr\n'));
  check('cut', ['-c', '2-', 'a.txt'], ok('ne\nwo\nhree\n'));
  check('cut', ['-c', '1', 'crlf.txt'], ok('a\nb\n'));
});

test('cut inserts output delimiters between range groups', () => {
  check('cut', ['-c', '1-2,4-', '--output-delimiter=,', 'abcdef.txt'], ok('ab,def\n'));
  check('cut', ['-c', '1-2,3-4', '--output-delimiter=,', 'abcdef.txt'], ok('ab,cd\n'));
  check('cut', ['-c', '1-2,2-3', '--output-delimiter=,', 'abcdef.txt'], ok('abc\n'));
});

test('cut selects fields', () => {
  check('cut', ['-f', '2', '-d', ':', 'cols.txt'], ok('b\n2\n'));
  check('cut', ['-f', '1,3', '-d', ':', 'cols.txt'], ok('a:c\n1:3\n'));
  check('cut', ['-f', '2', '-d', ':', 'mixed.txt'], ok('plain\nb\n'));
  check('cut', ['-f', '2', '-d', ':', '-s', 'mixed.txt'], ok('b\n'));
  check('cut', ['-f', '1', 'mixed.txt'], ok('plain\na:b\n'));
  check('cut', ['-f', '1-5', '-d', ':', '--output-delimiter=<>', 'sparse.txt'], ok('x<>y<><>z<>\n'));
  check('cut', ['-f', '9', '-d', ':', 'cols.txt'], ok('\n\n'));
});

test('cut reports usage and range errors', () => {
  check('cut', ['-d', ':', '-c', '1', 'a.txt'], bad('cut: an input delimiter may be specified only when operating on fields\n'));
  check('cut', ['-f', '1', '-c', '1', 'a.txt'], bad('cut: only one type of list may be specified\n'));
  check('cut', ['a.txt'], bad('cut: you must specify a list of bytes, characters, or fields\n'));
  check('cut', ['-f', '1', '-d', '::', 'a.txt'], bad('cut: the delimiter must be a single character\n'));
  check('cut', ['-c', '0', 'a.txt'], bad('cut: byte/character positions are numbered from 1\n'));
  check('cut', ['-f', '0', 'a.txt'], bad('cut: fields are numbered from 1\n'));
  check('cut', ['-c', '', 'a.txt'], bad('cut: byte/character positions are numbered from 1\n'));
  check('cut', ['-c', 'x', 'a.txt'], bad("cut: invalid byte/character position 'x'\n"));
  check('cut', ['-f', 'x', 'a.txt'], bad("cut: invalid field value 'x'\n"));
  check('cut', ['-f', '1-2-3', 'a.txt'], bad('cut: invalid field range\n'));
  check('cut', ['-c', '1-2-3', 'a.txt'], bad('cut: invalid byte or character range\n'));
  check('cut', ['-c', '5-3', 'a.txt'], bad('cut: invalid decreasing range\n'));
  check('cut', ['-c', '-', 'a.txt'], bad('cut: invalid range with no endpoint: -\n'));
  check('cut', ['-f', '2', '-d', ':', 'nope.txt'], bad('cut: nope.txt: No such file or directory\n'));
  check('cut', ['-z', 'a.txt'], { code: 2, out: '', err: "cut: invalid option -- 'z'\n" });
});

test('tr translates, deletes and squeezes', () => {
  checkWith('tr', 'abc\n', ['a-z', 'A-Z'], ok('ABC\n'));
  checkWith('tr', 'abc', ['[:lower:]', '[:upper:]'], ok('ABC'));
  checkWith('tr', 'abcxyz', ['-d', 'a-c'], ok('xyz'));
  checkWith('tr', 'aaab', ['-s', 'a'], ok('ab'));
  checkWith('tr', '   a\n', ['-s', ' '], ok(' a\n'));
  checkWith('tr', 'abc1\n', ['-c', 'a-z', 'X'], ok('abcXX'));
  checkWith('tr', 'a1b2', ['-d', '[:digit:]'], ok('ab'));
  checkWith('tr', 'abc', ['abc', 'XY'], ok('XYY'));
  checkWith('tr', 'aabb', ['-ds', 'a', 'b'], ok('b'));
  checkWith('tr', 'a b\tc', ['[:space:]', '\n'], ok('a\nb\nc'));
  checkWith('tr', 'ABC', ['A-Z', 'a-z', 'extra'], bad("tr: extra operand 'extra'\n"));
});

test('tr reports set errors', () => {
  checkWith('tr', '', [], bad('tr: missing operand\n'));
  checkWith('tr', '', ['a'], bad("tr: missing operand after 'a'\n"));
  checkWith('tr', '', ['-d', 'a', 'b'], bad("tr: extra operand 'b'\n"));
  checkWith('tr', '', ['z-a', 'x'], bad("tr: range-endpoints of 'z-a' are in reverse collating sequence order\n"));
  checkWith('tr', '', ['[:foo:]', 'x'], bad("tr: invalid character class 'foo'\n"));
  checkWith('tr', '', ['abc', '[:upper:]'], bad('tr: misaligned [:upper:] and/or [:lower:] construct\n'));
});

test('tee copies stdin to every file and stdout', async () => {
  assert.deepEqual(main('tee', ['tee', 'out1.txt'], context('hi\n')), ok('hi\n'));
  assert.equal(await readFile(path.join(root, 'out1.txt'), 'utf8'), 'hi\n');
  assert.deepEqual(main('tee', ['tee', '-a', 'out1.txt'], context('more\n')), ok('more\n'));
  assert.equal(await readFile(path.join(root, 'out1.txt'), 'utf8'), 'hi\nmore\n');
  assert.deepEqual(main('tee', ['tee'], context('plain\n')), ok('plain\n'));
  assert.deepEqual(main('tee', ['tee', 'zero.txt'], context('')), ok(''));
  assert.equal(await readFile(path.join(root, 'zero.txt'), 'utf8'), '');
  assert.deepEqual(
    main('tee', ['tee', 'missing/out.txt'], context('q\n')),
    bad('tee: missing/out.txt: No such file or directory\n', 1, 'q\n'),
  );
  assert.deepEqual(
    main('tee', ['tee', 'missing/out.txt', 'keeper.txt'], context('z\n')),
    bad('tee: missing/out.txt: No such file or directory\n', 1, 'z\n'),
  );
  assert.equal(await readFile(path.join(root, 'keeper.txt'), 'utf8'), 'z\n');
  assert.deepEqual(main('tee', ['tee', '--append', 'out1.txt'], context('third\n')), ok('third\n'));
  assert.equal(await readFile(path.join(root, 'out1.txt'), 'utf8'), 'hi\nmore\nthird\n');
});

test('nl numbers lines the bash way', () => {
  check('nl', ['a.txt'], ok('     1\tone\n     2\ttwo\n     3\tthree\n'));
  check('nl', ['-ba', 'blanks.txt'], ok('     1\tx\n     2\t\n     3\t\n     4\t\n     5\ty\n'));
  check('nl', ['-bn', 'a.txt'], ok('       one\n       two\n       three\n'));
  check('nl', ['-w', '3', '-s', ':', '-v', '10', '-i', '5', 'a.txt'], ok(' 10:one\n 15:two\n 20:three\n'));
  check('nl', ['-n', 'rz', '-w', '2', 'a.txt'], ok('01\tone\n02\ttwo\n03\tthree\n'));
  check('nl', ['-n', 'ln', '-w', '4', 'a.txt'], ok('1   \tone\n2   \ttwo\n3   \tthree\n'));
  check('nl', ['-s', '', 'a.txt'], ok('     1one\n     2two\n     3three\n'));
  check('nl', ['a.txt', 'b.txt'], ok('     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour\n     5\tfive\n'));
  check('nl', ['noeol.txt'], ok('     1\ttail\n'));
  check('nl', ['-b', 'x', 'a.txt'], bad("nl: invalid body numbering style: 'x'\n"));
  check('nl', ['-n', 'x', 'a.txt'], bad("nl: invalid line numbering format: 'x'\n"));
  check('nl', ['-w', 'x', 'a.txt'], bad("nl: invalid line number field width: 'x'\n"));
  check('nl', ['nope.txt'], bad('nl: nope.txt: No such file or directory\n'));
});

test('tac reverses records', () => {
  check('tac', ['num.txt'], ok('5\n4\n3\n2\n1\n'));
  check('tac', ['noeol.txt'], ok('tail'));
  check('tac', ['empty.txt'], ok(''));
  check('tac', ['a.txt', 'b.txt'], ok('three\ntwo\none\nfive\nfour\n'));
  check('tac', ['nope.txt', 'a.txt'], bad("tac: failed to open 'nope.txt' for reading: No such file or directory\n", 1, 'three\ntwo\none\n'));
});

test('paste merges files in parallel and serial mode', () => {
  check('paste', ['a.txt', 'b.txt'], ok('one\tfour\ntwo\tfive\nthree\t\n'));
  check('paste', ['-d', ',', 'a.txt', 'b.txt'], ok('one,four\ntwo,five\nthree,\n'));
  check('paste', ['-d', ',-', 'a.txt', 'b.txt'], ok('one,four\ntwo,five\nthree,\n'));
  check('paste', ['-s', '-d', ',', 'a.txt'], ok('one,two,three\n'));
  check('paste', ['-s', 'a.txt', 'b.txt'], ok('one\ttwo\tthree\nfour\tfive\n'));
  check('paste', ['-s', 'empty.txt'], ok('\n'));
  check('paste', ['-d', '\\0', 'a.txt', 'b.txt'], ok('onefour\ntwofive\nthree\n'));
  check('paste', ['nope.txt', 'a.txt'], bad('paste: nope.txt: No such file or directory\n'));
  checkWith('paste', 'x\ny\n', ['-s'], ok('x\ty\n'));
});
