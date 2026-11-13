import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createFs } from '../src/shell/fs.mjs';
import { main, names } from '../src/shell/coreutils/sed.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-coreutils-sed-'));

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

const ok = out => ({ code: 0, out, err: '' });
const fail = (err, code = 1) => ({ code, out: '', err });
const mixed = (out, err, code = 1) => ({ code, out, err });

function check(args, expected, stdin = '') {
  assert.deepEqual(main('sed', ['sed', ...args], context(stdin)), expected);
}

async function virtualText(name) {
  return readFile(path.join(root, name), 'utf8');
}

await writeFile(path.join(root, 'one.txt'), 'one\n');
await writeFile(path.join(root, 'two.txt'), 'alpha\nbeta\n');
await writeFile(path.join(root, 'lines.txt'), 'one\ntwo\nthree\n');
await writeFile(path.join(root, 'f1.txt'), '1\n2\n');
await writeFile(path.join(root, 'f2.txt'), '3\n4\n');
await writeFile(path.join(root, 'data.txt'), 'D1\nD2\n');
await writeFile(path.join(root, 'one-two.txt'), 'one two\n');
await writeFile(path.join(root, 'script.sed'), 's/o/0/g\n');
await writeFile(path.join(root, 'latin.txt'), 'caf\u00e9\n');
await writeFile(path.join(root, 'ctl.txt'), 'a\u0001b\u007f\n');

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("names lists sed", () => {
  assert.deepEqual(names, ['sed']);
});

test("copies input when the script is empty", () => {
  check([""], ok("a\nb\n"), "a\nb\n");
  check([""], ok(""));
  check(["-n", "p"], ok("a\nb\n"), "a\nb\n");
  check(["p", "-"], ok("a\na\nb\nb\n"), "a\nb\n");
  check(["", "one.txt"], ok("one\n"));
  check(["", "two.txt", "one.txt"], ok("alpha\nbeta\none\n"));
});

test("s substitutes with flags g, p, I and a match number", () => {
  check(["s/o/0/"], ok("0ne two\n"), "one two\n");
  check(["s/o/0/g"], ok("0ne tw0\n"), "one two\n");
  check(["s/o/0/2"], ok("one tw0\n"), "one two\n");
  check(["s/o/0/2g"], ok("one tw0\n"), "one two\n");
  check(["s/a/b/2"], ok("aba\n"), "aaa\n");
  check(["s/a/b/2g"], ok("abb\n"), "aaa\n");
  check(["s/a//g"], ok("\n"), "aaa\n");
  check(["s/O/x/I"], ok("xne\n"), "one\n");
  check(["s|o|0|g"], ok("0ne tw0\n"), "one two\n");
  check(["s/o/X/p"], ok("Xne\nXne\n"), "one\n");
  check(["-n", "s/o/X/p"], ok("Xne\n"), "one\n");
});

test("s replacement understands &, back references and escapes", () => {
  check(["s/o/[&]/g"], ok("[o]ne tw[o]\n"), "one two\n");
  check(["s/o/\\&/"], ok("&\n"), "o\n");
  check(["s/\\(o\\)/\\1\\1/"], ok("oone\n"), "one\n");
  check(["s/o/\\n/"], ok("\n\n"), "o\n");
  check(["s/o/\\t/"], ok("\t\n"), "o\n");
  check(["s/a/\\\\/"], ok("\\\n"), "a\n");
  check(["s/\\(.\\)\\(.\\)/\\2\\1/"], ok("ba\n"), "ab\n");
});

test("s reuses the previous regular expression when its RE is empty", () => {
  check(["-n", "/a/{s//X/;p}"], ok("X\n"), "a\n");
  check(["-n", "s/a/b/;s//c/p"], ok(""), "a\n");
  check(["-n", "s/a/b/;s//c/p"], ok("bc\n"), "aa\n");
  check(["s//X/"], fail("sed: -e expression #1, char 5: no previous regular expression\n", 2));
});

test("zero-length matches follow the GNU skip rule", () => {
  check(["s/a*/X/g"], ok("XbX\n"), "aab\n");
  check(["s/a*/X/g"], ok("X\n"), "aa\n");
  check(["s/a*/X/g"], ok("XbX\n"), "ba\n");
  check(["s/x*/-/g"], ok("-a-b-c-\n"), "abc\n");
  check(["s/x*/-/g"], ok("-\n"), "\n");
  check(["s/b*/X/g"], ok("XaX\n"), "ab\n");
});

test("line numbers, $, regex and step addresses select lines", () => {
  check(["-n", "2p"], ok("2\n"), "1\n2\n3\n");
  check(["-n", "$p"], ok("3\n"), "1\n2\n3\n");
  check(["-n", "/t/p"], ok("two\nthree\n"), "one\ntwo\nthree\n");
  check(["-n", "/T/Ip"], ok("TWO\n"), "one\nTWO\n");
  check(["-n", "1~2p"], ok("1\n3\n5\n"), "1\n2\n3\n4\n5\n");
  check(["-n", "2~3p"], ok("2\n5\n"), "1\n2\n3\n4\n5\n");
  check(["-n", "0~2p"], ok("2\n4\n6\n"), "1\n2\n3\n4\n5\n6\n");
  check(["-n", "1~p"], ok("1\n"), "1\n2\n3\n");
  check(["-n", "2!p"], ok("1\n3\n"), "1\n2\n3\n");
  check(["0~0p"], fail("sed: -e expression #1, char 4: invalid usage of line address 0\n", 2));
  check(["0p"], fail("sed: -e expression #1, char 2: invalid usage of line address 0\n", 2));
});

test("address ranges and negation", () => {
  check(["-n", "2,3p"], ok("2\n3\n"), "1\n2\n3\n4\n");
  check(["-n", "2,$p"], ok("2\n3\n"), "1\n2\n3\n");
  check(["-n", "1,$p"], ok("1\n2\n3\n"), "1\n2\n3\n");
  check(["-n", "$,2p"], ok("3\n"), "1\n2\n3\n");
  check(["-n", "1,1p"], ok("one\n"), "one\ntwo\n");
  check(["-n", "/a/,/b/p"], ok("ab\nc\n"), "ab\nc\n");
  check(["-n", "1,2!p"], ok("3\n"), "1\n2\n3\n");
});

test("braces group commands and carry their own address", () => {
  check(["1{p}"], ok("1\n1\n2\n"), "1\n2\n");
  check(["1!{p}"], ok("1\n2\n2\n"), "1\n2\n");
  check(["1,2{p;d}"], ok("1\n2\n3\n"), "1\n2\n3\n");
  check(["-n", "1{p;l}"], ok("a\na$\n"), "a\nb\nc\n");
  check(["-n", "1,2{p;l}"], ok("a\na$\nb\nb$\n"), "a\nb\nc\n");
});

test("d, D, n, N and P", () => {
  check(["2d"], ok("1\n3\n"), "1\n2\n3\n");
  check(["/two/d"], ok("one\nthree\n"), "one\ntwo\nthree\n");
  check(["-n", "n;p"], ok("2\n"), "1\n2\n3\n");
  check(["-n", "N;s/\\n/+/p"], ok("a+b\n"), "a\nb\nc\n");
  check(["N;s/\\n/+/"], ok("a+b\nc\n"), "a\nb\nc\n");
  check(["-n", "N;P"], ok("a\n"), "a\nb\n");
  check(["-n", "P"], ok("a\nb\n"), "a\nb\n");
  check(["N;P;D"], ok("a\nb\nc\n"), "a\nb\nc\n");
});

test("prints line numbers and escapes with l", () => {
  check(["="], ok("1\na\n2\nb\n"), "a\nb\n");
  check(["-n", "=;p"], ok("1\na"), "a");
  check(["-n", "p;="], ok("a\n1\n"), "a");
  check(["l 5"], ok("abcd\\\nefgh\\\nij$\nabcdefghij\n"), "abcdefghij\n");
  check(["l 3"], ok("ab\\\ncd\\\nef$\nabcdef\n"), "abcdef\n");
  check(["l 0"], ok("abcdef$\nabcdef\n"), "abcdef\n");
  check(["l"], ok("a\\001b\\177$\na\u0001b\n"), "a\u0001b\n");
  check(["l"], ok("caf\\303\\251$\ncafé\n"), "café\n");
});

test("hold space commands", () => {
  check(["G"], ok("x\n\n"), "x\n");
  check(["H;g"], ok("\nx\n"), "x\n");
  check(["h;g"], ok("x\n"), "x\n");
  check(["x"], ok("\n"), "x\n");
  check(["s/a/b/;G"], ok("b\n\n"), "a\n");
  check(["-n", "1h;2,$H;${x;p}"], ok("a\nb\nc\n"), "a\nb\nc\n");
  check(["-n", "1h;2,$H;${g;p}"], ok("a\nb\nc\n"), "a\nb\nc\n");
  check(["1!G;h;$!d"], ok("c\nb\na\n"), "a\nb\nc\n");
  check(["$!d"], ok("c\n"), "a\nb\nc\n");
  check(["-n", "H;$!d;x;s/\\n//;p"], ok("a\nb\nc\n"), "a\nb\nc\n");
  check(["-n", "1{h;d};2{G;p}"], ok("b\na\n"), "a\nb\n");
  check(["$!N;s/\\n/ /"], ok("1 2\n3\n"), "1\n2\n3\n");
});

test("y transliterates characters", () => {
  check(["y/abc/xyz/"], ok("xyz zxy\n"), "abc cab\n");
  check(["y/abc/\\n\\tX/"], ok("\n\tX\n"), "abc\n");
  check(["y/ab/AB/;y/AB/xy/"], ok("xy\n"), "ab\n");
  check(["y/a/\\n/"], ok("\n\n"), "a\n");
});

test("append, insert and change text", () => {
  check(["a hi"], ok("x\nhi\n"), "x\n");
  check(["a hi; there"], ok("x\nhi; there\n"), "x\n");
  check(["2i hi"], ok("1\nhi\n2\n"), "1\n2\n");
  check(["2c hi"], ok("1\nhi\n3\n"), "1\n2\n3\n");
  check(["1,2c CH"], ok("CH\n3\n"), "1\n2\n3\n");
  check(["c X"], ok("X\nX\n"), "x\ny\n");
  check(["-n", "c X"], ok("X\nX\n"), "x\ny\n");
  check(["1a\\\nline1\\\nline2"], ok("x\nline1\nline2\n"), "x\n");
  check(["1a  hi"], ok("x\nhi\n"), "x\n");
  check(["1a\thi"], ok("x\nhi\n"), "x\n");
  check(["1aX"], ok("x\nX\n"), "x\n");
  check(["1a\\"], ok("x\n"), "x\n");
  check(["1i\\"], ok("x\ny\n"), "x\ny\n");
  check(["1c\\"], ok("y\n"), "x\ny\n");
  check(["1a"], fail("sed: -e expression #1, char 2: expected \\ after `a', `c' or `i'\n", 2));
  check(["1a  "], fail("sed: -e expression #1, char 4: expected \\ after `a', `c' or `i'\n", 2));
});

test("branch, test and labels", () => {
  check(["-n", "s/1/one/;t yes;b;:yes;p"], ok("one\n"), "1\n2\n");
  check(["-n", "s/9/x/;t yes;p;:yes"], ok("1\n2\n"), "1\n2\n");
  check(["-n", ": x ; s/a/b/; t x"], ok(""), "a\n");
  check(["-n", "s/a/A/;T skip;p;:skip"], ok("Ab\nbA\n"), "ab\nba\n");
  check(["-n", "p;b"], ok("a\nb\n"), "a\nb\n");
});

test("POSIX BRE constructs are translated for JavaScript", () => {
  check(["s/(a)/X/"], ok("X\n"), "(a)\n");
  check(["s/a+/X/"], ok("X\n"), "a+\n");
  check(["s/a{2}/X/"], ok("X\n"), "a{2}\n");
  check(["s/a|b/X/"], ok("X\n"), "a|b\n");
  check(["s/a\\{2,3\\}/X/"], ok("Xa\n"), "aaaa\n");
  check(["s/ab\\+/X/"], ok("X\n"), "abbb\n");
  check(["s/\\(a\\)\\(b\\)/\\2\\1/"], ok("ba\n"), "ab\n");
  check(["s/a\\|b/X/g"], ok("X X\n"), "a b\n");
  check(["s/[[:alpha:]]\\{2\\}/X/"], ok("Xcd\n"), "abcd\n");
  check(["s/[[:upper:]]/X/g"], ok("aXcX\n"), "aBcD\n");
  check(["s/[[:digit:]]/N/g"], ok("aNbN\n"), "a1b2\n");
  check(["s/[[:space:]]/_/g"], ok("a_b_c\n"), "a b\tc\n");
  check(["s/[^[:digit:]]/./g"], ok(".1.2\n"), "a1b2\n");
  check(["s/\\<b\\>/X/"], ok("a X c\n"), "a b c\n");
  check(["s/^/>/"], ok(">ab\n"), "ab\n");
  check(["s/$/</"], ok("ab<\n"), "ab\n");
  check(["s/^/x/;s/$/y/"], ok("xaby\n"), "ab\n");
  check(["N;s/^/X/;s/$/Y/"], ok("Xa\nbY\n"), "a\nb\n");
  check(["s/a.c/X/"], ok("X abc\n"), "a.c abc\n");
  check(["s/..$/>/"], ok("ab>\n"), "abcd\n");
});

test("ERE mode and accepted no-op options", () => {
  check(["-E", "s/(a)(b)/\\2\\1/"], ok("ba\n"), "ab\n");
  check(["-r", "s/a+/X/"], ok("X\n"), "aaa\n");
  check(["--posix", "s/a/b/"], ok("b\n"), "a\n");
});

test("multiple files, -s and $", () => {
  check(["-n", "$p", "f1.txt", "f2.txt"], ok("4\n"));
  check(["-ns", "$p", "f1.txt", "f2.txt"], ok("2\n4\n"));
  check(["=", "f1.txt", "f2.txt"], ok("1\n1\n2\n2\n3\n3\n4\n4\n"));
  check(["-s", "=", "f1.txt", "f2.txt"], ok("1\n1\n2\n2\n1\n3\n2\n4\n"));
  check(["N;s/\\n/+/", "f1.txt", "f2.txt"], ok("1+2\n3+4\n"));
});

test("the #n first-line directive suppresses the default print", () => {
  check(["#n"], ok(""), "1\n2\n");
  check(["#n\np"], ok("1\n2\n"), "1\n2\n");
  check(["p\n#n"], ok("1\n1\n2\n2\n"), "1\n2\n");
});

test("-e and -f scripts are concatenated", () => {
  check(["-e", "s/o/0/", "-e", "s/0/O/"], ok("One\n"), "one\n");
  check(["-f", "script.sed", "one-two.txt"], ok("0ne tw0\n"));
});

test("a final line without a newline keeps missing it", () => {
  check(["s/t/T/"], ok("Tail"), "tail");
  check(["p"], ok("tail\ntail"), "tail");
  check(["-n", "p;p"], ok("tail\ntail"), "tail");
});

test("patterns work on UTF-8 code points", () => {
  check(["s/./X/g"], ok("XXXX\n"), "café\n");
});

test("y accepts multi-byte characters", () => {
  check(["y/é/e/"], ok("e\n"), "é\n");
});

test("script errors exit 2 with a sed: prefix", () => {
  check(["Z"], fail("sed: -e expression #1, char 1: unknown command: `Z'\n", 2));
  check(["s/a"], fail("sed: -e expression #1, char 3: unterminated `s' command\n", 2));
  check(["s/a/b/Z"], fail("sed: -e expression #1, char 7: unknown option to `s'\n", 2));
  check(["y/abc/de/"], fail("sed: -e expression #1, char 9: strings for `y' command are different lengths\n", 2));
  check(["b nope"], fail("sed: can't find label for jump to `nope'\n", 2));
  check(["}"], fail("sed: -e expression #1, char 1: unexpected `}'\n", 2));
  check(["{p"], fail("sed: -e expression #1, char 1: unmatched `{'\n", 2));
  check(["1"], fail("sed: -e expression #1, char 1: missing command\n", 2));
  check(["r"], fail("sed: -e expression #1, char 1: missing filename in r/R/w/W commands\n", 2));
  check(["s/a/b/0"], fail("sed: -e expression #1, char 7: number option to `s' command may not be zero\n", 2));
  check(["s/a/\\U/"], fail("sed: -e expression #1, char 7: unsupported escape \\U in replacement\n", 2));
  check(["s/a/b/e"], fail("sed: -e expression #1, char 7: unsupported flag `e' for `s' command\n", 2));
  check([], fail("sed: no script specified\n", 2));
  check(["--null-data"], fail("sed: unsupported option '--null-data'\n", 2));
});

test("an unreadable input file exits 1 and later files still run", () => {
  check(["p", "nope.txt", "f2.txt"], mixed("3\n3\n4\n4\n", "sed: can't read nope.txt: No such file or directory\n", 1));
});

test('q and Q quit with an optional exit code', () => {
  check(['q5'], { code: 5, out: 'a\n', err: '' }, 'a\nb\n');
  check(['Q7'], { code: 7, out: '', err: '' }, 'a\nb\n');
  check(['-n', 'q'], ok(''), 'a\n');
});

test('--help and --version print usage information', () => {
  const help = main('sed', ['sed', '--help'], context(''));
  assert.equal(help.code, 0);
  assert.equal(help.err, '');
  assert.ok(help.out.startsWith('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...'));
  assert.equal(help.out.includes('-i[SUFFIX], --in-place[=SUFFIX]'), true);
  assert.deepEqual(main('sed', ['sed', '--version'], context('')), ok('sed (dsh coreutils) 1.0\n'));
});

test('-i edits files in place and writes nothing to stdout', async () => {
  await writeFile(path.join(root, 'edit1.txt'), '1\n2\n');
  check(['-i', 's/1/one/', 'edit1.txt'], ok(''));
  assert.equal(await virtualText('edit1.txt'), 'one\n2\n');
});

test('-iSUFFIX keeps a backup of the original file', async () => {
  await writeFile(path.join(root, 'edit2.txt'), '1\n2\n');
  check(['-i.bak', 's/1/one/', 'edit2.txt'], ok(''));
  assert.equal(await virtualText('edit2.txt'), 'one\n2\n');
  assert.equal(await virtualText('edit2.txt.bak'), '1\n2\n');
});

test('-i rewrites the file with exactly the produced text', async () => {
  await writeFile(path.join(root, 'edit3.txt'), '1\n2\n');
  check(['-i', '1q', 'edit3.txt'], ok(''));
  assert.equal(await virtualText('edit3.txt'), '1\n');
});

test('-i needs input files and treats - as a file name', () => {
  check(['-i', 'p'], fail('sed: no input files\n', 2));
  check(['-i', 'p', '-'], fail("sed: can't read -: No such file or directory\n", 1));
  check(['-i', 'p', 'missing.txt'], fail("sed: can't read missing.txt: No such file or directory\n", 1));
});

test('w writes the pattern space to a file', async () => {
  check(['s/o/0/gw sw.txt', 'one-two.txt'], ok('0ne tw0\n'));
  assert.equal(await virtualText('sw.txt'), '0ne tw0\n');
  check(['-n', 'w wout.txt', 'f1.txt'], ok(''));
  assert.equal(await virtualText('wout.txt'), '1\n2\n');
});

test('r queues a file after the pattern space and ignores missing files', () => {
  check(['1r data.txt', 'one-two.txt'], ok('one two\nD1\nD2\n'));
  check(['r nope.txt', 'one-two.txt'], ok('one two\n'));
});

test('line address 0 opens a 0,/regex/ range', () => {
  check(['-n', '0,/2/p'], ok('1\n2\n'), '1\n2\n3\n4\n');
  check(['-n', '0,/1/p'], ok('1\n'), '1\n2\n3\n');
  check(['-n', '0,/b/p'], ok('b\n'), 'b\nc\n');
  check(['0,/b/d'], ok(''), '1\n2\n3\n4\n');
  check(['-n', '0,/b/!p'], ok(''), '1\n2\n3\n4\n');
  check(['0p'], fail('sed: -e expression #1, char 2: invalid usage of line address 0\n', 2));
  check(['0,$p'], fail('sed: -e expression #1, char 4: invalid usage of line address 0\n', 2));
});

test('a numeric second address ends the range once it is reached', () => {
  check(['-n', '3,2p'], ok('3\n'), '1\n2\n3\n4\n');
  check(['-n', '1,0p'], ok('1\n'), '1\n2\n3\n4\n');
  check(['2,3!cX'], ok('X\n2\n3\nX\n'), '1\n2\n3\n4\n');
});
