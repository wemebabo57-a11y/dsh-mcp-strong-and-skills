import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFs } from '../src/shell/fs.mjs';
import { names, main } from '../src/shell/coreutils/filter.mjs';

// GNU find prints its diagnostics with a backtick before the token.
const TICK = String.fromCharCode(96);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-filter-'));

const fixture = {
  '.git/c.txt': 'alpha hidden\n',
  'a.txt': 'alpha one\nbeta two\ngamma alpha\n',
  'b.txt': 'nothing here\nALPHA upper\n',
  'bin.dat': 'alpha\u0000tail\n',
  'blank.txt': '\n\nalpha\n\n',
  'ctx.txt': 'x alpha y\nzz\nzz\nzz alpha q\n',
  'empty.txt': '',
  'exact.txt': 'alpha\nalpha beta\n',
  'gap.txt': 'alpha\nx\ny\nz\nalpha\n',
  'noalpha.txt': 'zzz\n',
  'old.txt': 'alpha old\n',
  'sub/a.txt': 'sub alpha\nnope\n',
  'sub/deep/d.txt': 'alpha deep\n',
  'tab.txt': 'tab\talpha\n',
  'twice.txt': 'alpha alpha\n',
};

for (const [name, text] of Object.entries(fixture)) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
fs.mkdirSync(path.join(root, 'emptydir'), { recursive: true });
const oldTime = new Date('2020-01-01T00:00:00Z');
fs.utimesSync(path.join(root, 'old.txt'), oldTime, oldTime);

const shellFs = createFs({ root, mode: 'unconfined' });

function run(argv, extra) {
  const ctx = {
    cwd: '/',
    env: new Map(),
    fs: shellFs,
    stdin: '',
    opts: { globstar: false, xtrace: false },
    check() {},
    vars() { return ''; },
    ...extra,
  };
  return main(argv[0], argv, ctx);
}

function check(argv, want, extra) {
  const result = run(argv, extra);
  assert.deepEqual(
    { code: result.code, out: result.out, err: result.err },
    { code: 0, out: '', err: '', ...want },
  );
}

// Symlinks live in a separate tree so the main listing stays deterministic.
const linksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-filter-links-'));
let hasSymlinks = false;
try {
  fs.mkdirSync(path.join(linksRoot, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(linksRoot, 'file.txt'), 'alpha link\n');
  fs.writeFileSync(path.join(linksRoot, 'dir', 'inner.txt'), 'alpha inner\n');
  fs.symlinkSync(path.join(linksRoot, 'file.txt'), path.join(linksRoot, 'flink'));
  fs.symlinkSync(path.join(linksRoot, 'dir'), path.join(linksRoot, 'dlink'));
  hasSymlinks = true;
} catch {
  hasSymlinks = false;
}
const linksFs = createFs({ root: linksRoot, mode: 'unconfined' });

function runLinks(argv) {
  const ctx = {
    cwd: '/',
    env: new Map(),
    fs: linksFs,
    stdin: '',
    opts: { globstar: false, xtrace: false },
    check() {},
    vars() { return ''; },
  };
  return main(argv[0], argv, ctx);
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(linksRoot, { recursive: true, force: true });
});

const FIND_PATHS = [
  '.',
  './.git',
  './.git/c.txt',
  './a.txt',
  './b.txt',
  './bin.dat',
  './blank.txt',
  './ctx.txt',
  './empty.txt',
  './emptydir',
  './exact.txt',
  './gap.txt',
  './noalpha.txt',
  './old.txt',
  './sub',
  './sub/a.txt',
  './sub/deep',
  './sub/deep/d.txt',
  './tab.txt',
  './twice.txt',
];
const FIND_ALL = FIND_PATHS.join('\n') + '\n';

const FIND_FILES = './.git/c.txt\n./a.txt\n./b.txt\n./bin.dat\n./blank.txt\n./ctx.txt\n./empty.txt\n./exact.txt\n./gap.txt\n./noalpha.txt\n./old.txt\n./sub/a.txt\n./sub/deep/d.txt\n./tab.txt\n./twice.txt\n';
const FIND_FILES_NEWER = './.git/c.txt\n./a.txt\n./b.txt\n./bin.dat\n./blank.txt\n./ctx.txt\n./empty.txt\n./exact.txt\n./gap.txt\n./noalpha.txt\n./sub/a.txt\n./sub/deep/d.txt\n./tab.txt\n./twice.txt\n';
const FIND_NONEMPTY = './.git/c.txt\n./a.txt\n./b.txt\n./bin.dat\n./blank.txt\n./ctx.txt\n./exact.txt\n./gap.txt\n./noalpha.txt\n./old.txt\n./sub/a.txt\n./sub/deep/d.txt\n./tab.txt\n./twice.txt\n';
const FIND_TXT = './.git/c.txt\n./a.txt\n./b.txt\n./blank.txt\n./ctx.txt\n./empty.txt\n./exact.txt\n./gap.txt\n./noalpha.txt\n./old.txt\n./sub/a.txt\n./sub/deep/d.txt\n./tab.txt\n./twice.txt\n';
const FIND_DIRS = '.\n./.git\n./emptydir\n./sub\n./sub/deep\n';
const FIND_DEPTH1 = '.\n./.git\n./a.txt\n./b.txt\n./bin.dat\n./blank.txt\n./ctx.txt\n./empty.txt\n./emptydir\n./exact.txt\n./gap.txt\n./noalpha.txt\n./old.txt\n./sub\n./tab.txt\n./twice.txt\n';
const FIND_DEPTH1_NO_ROOT = './.git\n./a.txt\n./b.txt\n./bin.dat\n./blank.txt\n./ctx.txt\n./empty.txt\n./emptydir\n./exact.txt\n./gap.txt\n./noalpha.txt\n./old.txt\n./sub\n./tab.txt\n./twice.txt\n';
const FIND_NOT_TXT = '.\n./.git\n./bin.dat\n./emptydir\n./sub\n./sub/deep\n';
const FIND_ZERO_SIZE = '.\n./.git\n./empty.txt\n./emptydir\n./sub\n./sub/deep\n';
const FIND_NEWER = '.\n./.git\n./.git/c.txt\n./a.txt\n./b.txt\n./bin.dat\n./blank.txt\n./ctx.txt\n./empty.txt\n./emptydir\n./exact.txt\n./gap.txt\n./noalpha.txt\n./sub\n./sub/a.txt\n./sub/deep\n./sub/deep/d.txt\n./tab.txt\n./twice.txt\n';

const GREP_RECURSIVE = './a.txt:alpha one\n./a.txt:gamma alpha\nBinary file ./bin.dat matches\n./blank.txt:alpha\n./ctx.txt:x alpha y\n./ctx.txt:zz alpha q\n./exact.txt:alpha\n./exact.txt:alpha beta\n./gap.txt:alpha\n./gap.txt:alpha\n./old.txt:alpha old\n./sub/a.txt:sub alpha\n./sub/deep/d.txt:alpha deep\n./tab.txt:tab\talpha\n./twice.txt:alpha alpha\n';
const GREP_RECURSIVE_COUNT = './a.txt:2\n./b.txt:0\n./bin.dat:1\n./blank.txt:1\n./ctx.txt:2\n./empty.txt:0\n./exact.txt:2\n./gap.txt:2\n./noalpha.txt:0\n./old.txt:1\n./sub/a.txt:1\n./sub/deep/d.txt:1\n./tab.txt:1\n./twice.txt:1\n';
const GREP_RECURSIVE_LIST = './a.txt\n./bin.dat\n./blank.txt\n./ctx.txt\n./exact.txt\n./gap.txt\n./old.txt\n./sub/a.txt\n./sub/deep/d.txt\n./tab.txt\n./twice.txt\n';
const GREP_RECURSIVE_WITHOUT = './b.txt\n./empty.txt\n./noalpha.txt\n';
const GREP_RECURSIVE_H = 'alpha one\ngamma alpha\nBinary file ./bin.dat matches\nalpha\nx alpha y\nzz alpha q\nalpha\nalpha beta\nalpha\nalpha\nalpha old\nsub alpha\nalpha deep\ntab\talpha\nalpha alpha\n';
const GREP_RECURSIVE_INCLUDE = './a.txt:alpha one\n./a.txt:gamma alpha\n./blank.txt:alpha\n./ctx.txt:x alpha y\n./ctx.txt:zz alpha q\n./exact.txt:alpha\n./exact.txt:alpha beta\n./gap.txt:alpha\n./gap.txt:alpha\n./old.txt:alpha old\n./sub/a.txt:sub alpha\n./sub/deep/d.txt:alpha deep\n./tab.txt:tab\talpha\n./twice.txt:alpha alpha\n';
const GREP_RECURSIVE_EXCLUDE = 'Binary file ./bin.dat matches\n./blank.txt:alpha\n./ctx.txt:x alpha y\n./ctx.txt:zz alpha q\n./exact.txt:alpha\n./exact.txt:alpha beta\n./gap.txt:alpha\n./gap.txt:alpha\n./old.txt:alpha old\n./sub/deep/d.txt:alpha deep\n./tab.txt:tab\talpha\n./twice.txt:alpha alpha\n';
const GREP_RECURSIVE_EXCLUDE_DIR = './a.txt:alpha one\n./a.txt:gamma alpha\nBinary file ./bin.dat matches\n./blank.txt:alpha\n./ctx.txt:x alpha y\n./ctx.txt:zz alpha q\n./exact.txt:alpha\n./exact.txt:alpha beta\n./gap.txt:alpha\n./gap.txt:alpha\n./old.txt:alpha old\n./tab.txt:tab\talpha\n./twice.txt:alpha alpha\n';

test('module contract', () => {
  assert.deepEqual(names, ['grep', 'find', 'xargs']);
  assert.equal(typeof main, 'function');
});

test('grep basic output modes', () => {
  check(['grep', '-n', 'alpha', 'a.txt'], { out: '1:alpha one\n3:gamma alpha\n' });
  check(['grep', 'alpha', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-c', 'alpha', 'a.txt'], { out: '2\n' });
  check(['grep', 'alpha', 'a.txt', 'b.txt'], { out: 'a.txt:alpha one\na.txt:gamma alpha\n' });
  check(['grep', '-h', 'alpha', 'a.txt', 'b.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-H', 'alpha', 'a.txt'], { out: 'a.txt:alpha one\na.txt:gamma alpha\n' });
  check(['grep', '-i', 'alpha', 'b.txt'], { out: 'ALPHA upper\n' });
  check(['grep', '-v', 'alpha', 'a.txt'], { out: 'beta two\n' });
  check(['grep', '-l', 'alpha', 'a.txt', 'b.txt'], { out: 'a.txt\n' });
  check(['grep', '-L', 'alpha', 'a.txt', 'b.txt'], { out: 'b.txt\n' });
  check(['grep', '-o', 'alpha', 'twice.txt'], { out: 'alpha\nalpha\n' });
  check(['grep', '-c', 'alpha', 'twice.txt'], { out: '1\n' });
  check(['grep', '-w', 'alpha', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-w', 'alph', 'a.txt'], { code: 1 });
  check(['grep', '-x', 'alpha', 'exact.txt'], { out: 'alpha\n' });
  check(['grep', '-x', 'alpha', 'a.txt'], { code: 1 });
  check(['grep', '-q', 'alpha', 'a.txt'], {});
  check(['grep', '-q', 'nomatch', 'a.txt'], { code: 1 });
  check(['grep', '-m1', 'alpha', 'a.txt'], { out: 'alpha one\n' });
  check(['grep', '-m1', '-c', 'alpha', 'a.txt'], { out: '1\n' });
  check(['grep', '-m0', 'alpha', 'a.txt'], { code: 1 });
  check(['grep', '-m', '-1', 'alpha', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-e', 'alpha', '-e', 'beta', 'a.txt'], { out: 'alpha one\nbeta two\ngamma alpha\n' });
  check(['grep', '--color=never', 'alpha', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '--', 'alpha', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-l', '-c', 'alpha', 'a.txt'], { out: 'a.txt\n' });
  check(['grep', '-c', '-l', 'alpha', 'a.txt'], { out: 'a.txt\n' });
  check(['grep', '-h', '-c', 'alpha', 'a.txt', 'b.txt'], { out: '2\n0\n' });
  check(['grep', '-H', '-c', 'alpha', 'a.txt'], { out: 'a.txt:2\n' });
  check(['grep', '-h', '-H', 'alpha', 'a.txt'], { out: 'a.txt:alpha one\na.txt:gamma alpha\n' });
  check(['grep', '-H', '-h', 'alpha', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-n', '-h', 'alpha', 'a.txt', 'b.txt'], { out: '1:alpha one\n3:gamma alpha\n' });
});

test('grep pattern dialects', () => {
  check(['grep', '-E', 'alpha|beta', 'a.txt'], { out: 'alpha one\nbeta two\ngamma alpha\n' });
  check(['grep', '-F', 'a.*a', 'a.txt'], { code: 1 });
  check(['grep', '-G', 'a.*a', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-P', 'alpha|beta', 'a.txt'], { out: 'alpha one\nbeta two\ngamma alpha\n' });
  check(['grep', 'alph+', 'a.txt'], { code: 1 });
  check(['grep', 'alph\\+', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-G', '\\(alpha\\)', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-E', '\\(alpha\\)', 'a.txt'], { code: 1 });
  check(['grep', '-E', '*', 'a.txt'], { out: 'alpha one\nbeta two\ngamma alpha\n' });
  check(['grep', '-E', '[[:alpha:]]+', 'twice.txt'], { out: 'alpha alpha\n' });
  check(['grep', '-E', '[', 'a.txt'], { code: 2, err: 'grep: Invalid regular expression\n' });
  check(['grep', '[', 'a.txt'], { code: 2, err: 'grep: Invalid regular expression\n' });
  check(['grep', '-F', '[', 'a.txt'], { code: 1 });
  check(['grep', '-E', 'a**', 'a.txt'], { out: 'alpha one\nbeta two\ngamma alpha\n' });
  check(['grep', '-E', 'a+*', 'a.txt'], { out: 'alpha one\nbeta two\ngamma alpha\n' });
  check(['grep', '-E', '({2})', 'a.txt'], { out: 'alpha one\nbeta two\ngamma alpha\n' });
  check(['grep', '-E', ')', 'a.txt'], { code: 1 });
  check(['grep', '-E', '(', 'a.txt'], { code: 2, err: 'grep: Unmatched ( or \\(\n' });
  check(['grep', '\\)', 'a.txt'], { code: 2, err: 'grep: Unmatched ) or \\)\n' });
  check(['grep', '\\', 'a.txt'], { code: 2, err: 'grep: Trailing backslash\n' });
  check(['grep', 'z\\{3\\}', 'noalpha.txt'], { out: 'zzz\n' });
  check(['grep', 'z\\{4\\}', 'noalpha.txt'], { code: 1 });
});

test('grep diagnostics and exit codes', () => {
  check(['grep', '-z', 'alpha', 'a.txt'], { code: 2, err: "grep: invalid option -- 'z'\n" });
  check(['grep', 'alpha', 'missing.txt'], { code: 2, err: 'grep: missing.txt: No such file or directory\n' });
  check(['grep', 'alpha', 'missing.txt', 'a.txt'], { code: 2, out: 'a.txt:alpha one\na.txt:gamma alpha\n', err: 'grep: missing.txt: No such file or directory\n' });
  check(['grep', '-s', 'alpha', 'missing.txt'], { code: 2 });
  check(['grep', 'alpha', 'sub'], { code: 2, err: 'grep: sub: Is a directory\n' });
  check(['grep'], { code: 2, err: 'Usage: grep [OPTION]... PATTERN [FILE]...\nTry ' + "'grep --help'" + ' for more information.\n' });
  check(['grep', '-A', 'alpha', 'a.txt'], { code: 2, err: 'grep: alpha: invalid context length argument\n' });
  check(['grep', '-m', 'x', 'alpha', 'a.txt'], { code: 2, err: 'grep: invalid max count\n' });
  check(['grep', '-e'], { code: 2, err: 'grep: option requires an argument -- e\n' });
  check(['grep', '-q', 'alpha', 'missing.txt', 'a.txt'], { err: 'grep: missing.txt: No such file or directory\n' });
  check(['grep', '-q', 'alpha', 'missing.txt', 'noalpha.txt'], { code: 2, err: 'grep: missing.txt: No such file or directory\n' });
});

test('grep binary and empty files', () => {
  check(['grep', 'alpha', 'bin.dat'], { out: 'Binary file bin.dat matches\n' });
  check(['grep', '-a', 'alpha', 'bin.dat'], { out: 'alpha\u0000tail\n' });
  check(['grep', '-l', 'alpha', 'bin.dat'], { out: 'bin.dat\n' });
  check(['grep', '-c', 'alpha', 'bin.dat'], { out: '1\n' });
  check(['grep', '-o', 'alpha', 'bin.dat'], { out: 'Binary file bin.dat matches\n' });
  check(['grep', 'alpha', 'empty.txt'], { code: 1 });
  check(['grep', '-c', 'alpha', 'empty.txt'], { code: 1, out: '0\n' });
  check(['grep', '-L', 'alpha', 'bin.dat'], {});
  check(['grep', '-L', 'zzz', 'a.txt'], { code: 1, out: 'a.txt\n' });
});

test('grep context output', () => {
  check(['grep', '-A1', 'alpha', 'gap.txt'], { out: 'alpha\nx\n--\nalpha\n' });
  check(['grep', '-B1', 'alpha', 'gap.txt'], { out: 'alpha\n--\nz\nalpha\n' });
  check(['grep', '-C1', 'alpha', 'gap.txt'], { out: 'alpha\nx\n--\nz\nalpha\n' });
  check(['grep', '-A2', 'alpha', 'gap.txt'], { out: 'alpha\nx\ny\n--\nalpha\n' });
  check(['grep', '-B2', 'alpha', 'gap.txt'], { out: 'alpha\n--\ny\nz\nalpha\n' });
  check(['grep', '-C0', 'alpha', 'gap.txt'], { out: 'alpha\n--\nalpha\n' });
  check(['grep', '-n', '-C1', 'alpha', 'ctx.txt'], { out: '1:x alpha y\n2-zz\n3-zz\n4:zz alpha q\n' });
  check(['grep', '-C1', 'alpha', 'ctx.txt'], { out: 'x alpha y\nzz\nzz\nzz alpha q\n' });
  check(['grep', '-A1', '-c', 'alpha', 'gap.txt'], { out: '2\n' });
  check(['grep', '-m1', '-A1', 'alpha', 'gap.txt'], { out: 'alpha\nx\n' });
  check(['grep', '-o', '-A1', 'alpha', 'gap.txt'], { out: 'alpha\nalpha\n' });
  check(['grep', '-h', '-C1', 'alpha', 'gap.txt', 'ctx.txt'], { out: 'alpha\nx\n--\nz\nalpha\n--\nx alpha y\nzz\nzz\nzz alpha q\n' });
  check(['grep', '-A1', 'alpha', 'missing.txt', 'a.txt'], { code: 2, out: 'a.txt:alpha one\na.txt-beta two\na.txt:gamma alpha\n', err: 'grep: missing.txt: No such file or directory\n' });
});

test('grep recursive search', () => {
  check(['grep', '-r', 'alpha', '.'], { out: GREP_RECURSIVE });
  check(['grep', '-R', 'alpha', '.'], { out: GREP_RECURSIVE });
  check(['grep', '-r', '-c', 'alpha', '.'], { out: GREP_RECURSIVE_COUNT });
  check(['grep', '-r', '-l', 'alpha', '.'], { out: GREP_RECURSIVE_LIST });
  check(['grep', '-r', '-L', 'alpha', '.'], { out: GREP_RECURSIVE_WITHOUT });
  check(['grep', '-r', '-h', 'alpha', '.'], { out: GREP_RECURSIVE_H });
  check(['grep', '-r', '--include=*.txt', 'alpha', '.'], { out: GREP_RECURSIVE_INCLUDE });
  check(['grep', '-r', '--exclude=a.txt', 'alpha', '.'], { out: GREP_RECURSIVE_EXCLUDE });
  check(['grep', '-r', '--exclude-dir=sub', 'alpha', '.'], { out: GREP_RECURSIVE_EXCLUDE_DIR });
  check(['grep', '-r', 'alpha', 'sub'], { out: 'sub/a.txt:sub alpha\nsub/deep/d.txt:alpha deep\n' });
  check(['grep', '-r', 'alpha', './sub'], { out: './sub/a.txt:sub alpha\n./sub/deep/d.txt:alpha deep\n' });
  check(['grep', '-r', 'alpha', 'sub/'], { out: 'sub/a.txt:sub alpha\nsub/deep/d.txt:alpha deep\n' });
  check(['grep', '-r', 'alpha', 'a.txt'], { out: 'alpha one\ngamma alpha\n' });
  check(['grep', '-r', '-n', 'alpha', 'sub'], { out: 'sub/a.txt:1:sub alpha\nsub/deep/d.txt:1:alpha deep\n' });
  check(['grep', '-r', '-H', '-c', 'alpha', 'sub'], { out: 'sub/a.txt:1\nsub/deep/d.txt:1\n' });
  check(['grep', '-r', '-h', '-c', 'alpha', 'sub'], { out: '1\n1\n' });
  check(['grep', '-r', 'nomatch', '.'], { code: 1 });
  check(['grep', '-r', 'alpha', 'missing.txt'], { code: 2, err: 'grep: missing.txt: No such file or directory\n' });
});

test('grep standard input', () => {
  check(['grep', 'alpha'], { out: 'alpha here\n' }, { stdin: 'alpha here\nzzz\n' });
  check(['grep', '-n', 'alpha'], { out: '1:alpha here\n' }, { stdin: 'alpha here\nzzz\n' });
  check(['grep', '-c', 'alpha'], { out: '1\n' }, { stdin: 'alpha here\nzzz\n' });
  check(['grep', '-H', 'alpha'], { out: '(standard input):alpha here\n' }, { stdin: 'alpha here\n' });
  check(['grep', '-q', 'alpha'], {}, { stdin: 'alpha here\n' });
  check(['grep', 'alpha', '-'], { out: 'alpha here\n' }, { stdin: 'alpha here\n' });
  check(['grep', 'alpha'], { out: 'Binary file (standard input) matches\n' }, { stdin: 'alpha\u0000tail\n' });
  check(['grep', '-v', 'alpha'], { out: 'zzz\n' }, { stdin: 'alpha here\nzzz\n' });

  const listed = run(['grep', '-l', 'alpha', 'a.txt', 'b.txt']);
  assert.equal(listed.out, 'a.txt\n');
  const piped = run(['xargs', 'echo'], { stdin: listed.out });
  assert.equal(piped.out, 'echo a.txt\n');
});

test('find traversal', () => {
  check(['find', '.'], { out: FIND_ALL });
  check(['find'], { out: FIND_ALL });
  check(['find', 'sub'], { out: 'sub\nsub/a.txt\nsub/deep\nsub/deep/d.txt\n' });
  check(['find', 'sub/'], { out: 'sub/\nsub/a.txt\nsub/deep\nsub/deep/d.txt\n' });
  check(['find', './sub'], { out: './sub\n./sub/a.txt\n./sub/deep\n./sub/deep/d.txt\n' });
  check(['find', 'a.txt'], { out: 'a.txt\n' });
  check(['find', '.', '-maxdepth', '1'], { out: FIND_DEPTH1 });
  check(['find', '.', '-maxdepth', '0'], { out: '.\n' });
  check(['find', '.', '-mindepth', '1', '-maxdepth', '1'], { out: FIND_DEPTH1_NO_ROOT });
  check(['find', '.', '-mindepth', '2', '-maxdepth', '2'], { out: './.git/c.txt\n./sub/a.txt\n./sub/deep\n' });
  check(['find', '.', '-print0'], { out: FIND_PATHS.join('\u0000') + '\u0000' });
});

test('find predicates', () => {
  check(['find', '.', '-name', '*.txt'], { out: FIND_TXT });
  check(['find', '.', '-name', '*.TXT'], {});
  check(['find', '.', '-iname', 'A.TXT'], { out: './a.txt\n./sub/a.txt\n' });
  check(['find', '.', '-type', 'd'], { out: FIND_DIRS });
  check(['find', '.', '-type', 'f'], { out: FIND_FILES });
  check(['find', '.', '-name', '*.txt', '-o', '-name', '*.dat'], { out: FIND_FILES });
  check(['find', '.', '-name', '*.txt', '-o', '-name', '*.dat', '-print'], { out: './bin.dat\n' });
  check(['find', '.', '-not', '-name', '*.txt'], { out: FIND_NOT_TXT });
  check(['find', '.', '!', '-name', '*.txt'], { out: FIND_NOT_TXT });
  check(['find', '.', '-name', '*.txt', '-a', '-name', 'a*'], { out: './a.txt\n./sub/a.txt\n' });
  check(['find', '.', '(', '-name', '*.txt', '-o', '-name', '*.dat', ')', '-type', 'f'], { out: FIND_FILES });
  check(['find', '.', '-empty'], { out: './empty.txt\n./emptydir\n' });
  check(['find', '.', '-size', '0c'], { out: FIND_ZERO_SIZE });
  check(['find', '.', '-size', '+0c'], { out: FIND_NONEMPTY });
  check(['find', '.', '-size', '-1k'], { out: FIND_ZERO_SIZE });
  check(['find', '.', '-newer', 'old.txt'], { out: FIND_NEWER });
  check(['find', '.', '-type', 'f', '-newer', 'old.txt'], { out: FIND_FILES_NEWER });
  check(['find', '.', '-path', './sub/*'], { out: './sub/a.txt\n./sub/deep\n./sub/deep/d.txt\n' });
  check(['find', '.', '-path', '*/deep/*'], { out: './sub/deep/d.txt\n' });
});

test('find diagnostics', () => {
  check(['find', 'missing'], { code: 1, err: "find: 'missing': No such file or directory\n" });
  check(['find', '.', 'missing', '-name', '*.txt'], { code: 1, out: FIND_TXT, err: "find: 'missing': No such file or directory\n" });
  check(['find', '.', '-bogus'], { code: 1, err: 'find: unknown predicate ' + TICK + "-bogus'\n" });
  check(['find', '.', '-exec', 'echo', ';'], { code: 1, err: 'find: unknown predicate ' + TICK + "-exec'\n" });
  check(['find', '.', '-name'], { code: 1, err: 'find: missing argument to ' + TICK + "-name'\n" });
  check(['find', '.', '-maxdepth'], { code: 1, err: 'find: missing argument to ' + TICK + "-maxdepth'\n" });
  check(['find', '.', '-name', '*.txt', 'foo'], { code: 1, err: 'find: paths must precede expression: ' + TICK + "foo'\n" });
  check(['find', '.', '-type', 'x'], { code: 1, err: 'find: Unknown argument to -type: x\n' });
  check(['find', '.', '-newer', 'missing.txt'], { code: 1, err: "find: 'missing.txt': No such file or directory\n" });
});

test('xargs batching', () => {
  check(['xargs', 'echo'], { out: 'echo a b c\n' }, { stdin: 'a b c\n' });
  check(['xargs'], { out: 'echo a b c\n' }, { stdin: 'a b c\n' });
  check(['xargs', '-n1', 'echo'], { out: 'echo a\necho b\necho c\n' }, { stdin: 'a b c' });
  check(['xargs', '-n2', 'echo'], { out: 'echo a b\necho c\n' }, { stdin: 'a b c' });
  check(['xargs', '-I{}', 'echo', 'x{}y'], { out: 'echo xay\necho xby\n' }, { stdin: 'a\nb\n' });
  check(['xargs', '-0', 'echo'], { out: 'echo a b c\n' }, { stdin: 'a\u0000b c\u0000' });
  check(['xargs', '-d', ':', 'echo'], { out: 'echo a b c\n' }, { stdin: 'a:b:c' });
  check(['xargs', '-d', ':', 'echo'], { out: 'echo a b\n' }, { stdin: 'a:b:' });
  check(['xargs', '-L', '2', 'echo'], { out: 'echo a b\necho c\n' }, { stdin: 'a\nb\nc\n' });
  check(['xargs', '--max-args=2', 'echo'], { out: 'echo a b\necho c\n' }, { stdin: 'a b c' });
  check(['xargs', '--null', 'echo'], { out: 'echo a b\n' }, { stdin: 'a\u0000b\u0000' });
  check(['xargs', '--', 'echo', 'a'], { out: 'echo a\n' });
  check(['xargs', '-r', 'echo'], {}, { stdin: '' });
  check(['xargs', 'echo'], { out: 'echo\n' }, { stdin: '' });
  check(['xargs', 'echo'], { out: 'echo a b c\n' }, { stdin: "'a b' c\n" });
  check(['xargs', 'echo'], { out: 'echo ab\n' }, { stdin: 'a\\b\n' });
  check(['xargs', '-t', 'echo'], { out: 'echo a\n', err: 'echo a\n' }, { stdin: 'a' });
  check(['xargs', '-n', '0'], { code: 1, err: 'xargs: value 0 for -n option should be >= 1\n' }, { stdin: 'a' });
  check(['xargs', '-z'], { code: 1, err: "xargs: invalid option -- 'z'\n" }, { stdin: 'a' });
});

test('xargs command execution', () => {
  const calls = [];
  const hook = (cmd, argv, stdin) => {
    calls.push([cmd, argv, stdin]);
    return { code: 0, out: cmd + ':' + argv.join(',') + '\n', err: '' };
  };
  const result = run(['xargs', '-n2', 'echo'], { stdin: 'a b c', runCommand: hook });
  assert.deepEqual(calls, [['echo', ['a', 'b'], ''], ['echo', ['c'], '']]);
  assert.deepEqual(result, { code: 0, out: 'echo:a,b\necho:c\n', err: '' });

  const failing = () => ({ code: 1, out: '', err: 'boom\n' });
  const failed = run(['xargs', 'echo'], { stdin: 'a', runCommand: failing });
  assert.equal(failed.code, 123);
  assert.equal(failed.err, 'boom\n');

  const aborting = () => ({ code: 255, out: '', err: '' });
  const aborted = run(['xargs', 'boom'], { stdin: 'a', runCommand: aborting });
  assert.equal(aborted.code, 124);
  assert.equal(aborted.err, 'xargs: boom: exited with status 255; aborting\n');

  const quiet = run(['xargs', '-r', 'echo'], { stdin: '', runCommand: hook });
  assert.equal(quiet.code, 0);
  assert.equal(calls.length, 2);
});

test('symlink handling', { skip: hasSymlinks ? false : 'symlinks are not available here' }, () => {
  assert.deepEqual(runLinks(['find', '.']), { code: 0, out: '.\n./dir\n./dir/inner.txt\n./dlink\n./file.txt\n./flink\n', err: '' });
  assert.deepEqual(runLinks(['find', '.', '-type', 'l']), { code: 0, out: './dlink\n./flink\n', err: '' });
  assert.deepEqual(runLinks(['find', '.', '-type', 'f']), { code: 0, out: './dir/inner.txt\n./file.txt\n', err: '' });
  assert.deepEqual(runLinks(['grep', '-r', 'alpha', '.']), { code: 0, out: './dir/inner.txt:alpha inner\n./file.txt:alpha link\n', err: '' });
  assert.deepEqual(runLinks(['grep', 'alpha', 'flink']), { code: 0, out: 'alpha link\n', err: '' });
});
