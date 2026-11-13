import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createFs } from '../src/shell/fs.mjs';
import { names, main } from '../src/shell/coreutils/awk.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-coreutils-awk-'));
const vfs = createFs({ root, mode: 'danger-full-access' });

function makeCtx(stdin) {
  const calls = [];
  return {
    fs: vfs,
    cwd: '/',
    env: new Map(),
    stdin: stdin === undefined ? '' : stdin,
    calls,
    check() {},
    getVar() { return undefined; },
    out() {},
    err() {},
    runCommand(argv) {
      calls.push(argv.join(' '));
      return { code: 0, stdout: 'ran:' + argv.join(' ') + '\n', stderr: '' };
    },
  };
}

function run(args, stdin) {
  const ctx = makeCtx(stdin);
  const result = main('awk', ['awk', ...args], ctx);
  return { code: result.code, out: result.out, err: result.err, calls: ctx.calls };
}

function seed(name, text) {
  vfs.writeText(name, '/', text);
}

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('exports names and main', () => {
  assert.deepEqual(names, ['awk']);
  assert.equal(typeof main, 'function');
});

test('default field splitting and $0/NF', () => {
  const result = run(['{print NF, $1, $2, $NF}'], '  a  b  c  \nd e\n');
  assert.equal(result.code, 0);
  assert.equal(result.out, '3 a b c\n2 d e e\n');
});

test('-F: splits on a single character', () => {
  assert.equal(run(['-F:', '{print $2}'], 'a:b:c\n').out, 'b\n');
  assert.equal(run(['-F', ':', '{print NF}'], 'a:b:c\n').out, '3\n');
});

test('-F with a tab escape sequence', () => {
  const tab = String.fromCharCode(9);
  assert.equal(run(['-F', '\\t', '{print NF, $2 "|"}'], 'a' + tab + tab + 'b\n').out, '3 |\n');
  assert.equal(run(['-F', tab, '{print $2}'], 'a' + tab + 'b\n').out, 'b\n');
});

test('-F accepts a regular expression', () => {
  assert.equal(run(['-F', '[,;]+', '{print NF, $2, $3}'], 'a,b;c\n').out, '3 b c\n');
  assert.equal(run(['-F', '.', '{print NF}'], 'a.b.c\n').out, '3\n');
});

test('sums with BEGIN and END', () => {
  const result = run(['BEGIN{total=0} {total+=$1} END{print total, NR}'], '1\n2\n3\n');
  assert.equal(result.out, '6 3\n');
});

test('associative arrays, in, delete and for (k in a)', () => {
  const result = run(
    ['{count[$1]++} END{for (k in count) print k, count[k]; print ("x" in count), ("z" in count)}'],
    'x\ny\nx\n',
  );
  assert.equal(result.out, 'x 2\ny 1\n1 0\n');
  assert.equal(run(['BEGIN{a["k"]=1; delete a["k"]; print length(a); delete a; print length(a)}']).out, '0\n0\n');
});

test('arrays are passed to functions by reference', () => {
  const program = 'function fill(arr, key) { arr[key] = 1 } BEGIN { fill(a, "k"); print length(a), a["k"] }';
  assert.equal(run([program]).out, '1 1\n');
});

test('BEGIN runs before input and END after it', () => {
  const result = run(['BEGIN{print "b"} {print "m" $0} END{print "e", NR}'], 'x\n');
  assert.equal(result.out, 'b\nmx\ne 1\n');
});

test('printf conversions', () => {
  const program = 'BEGIN{printf "%d|%.2f|%s|%5.2f|%e|%g\\n", 3.9, 3.14159, "hi", 2.5, 1234.5, 0.0001}';
  assert.equal(run([program]).out, '3|3.14|hi| 2.50|1.234500e+03|0.0001\n');
  const flags = 'BEGIN{printf "[%5d][%-5d][%05d][%+d][%x][%o]\\n", 42, 42, 42, 42, 255, 8}';
  assert.equal(run([flags]).out, '[   42][42   ][00042][+42][ff][10]\n');
  assert.equal(run(['BEGIN{printf "%.2s|%10s|%*d|%.*f|100%%\\n", "abcdef", "hi", 5, 42, 2, 3.14159}']).out,
    'ab|        hi|   42|3.14|100%\n');
});

test('printf rounds ties to even like C', () => {
  assert.equal(run(['BEGIN{printf "%5.1f|%5.1f\\n", 1.25, 1.35}']).out, '  1.2|  1.4\n');
});

test('gsub and sub with & and escapes', () => {
  assert.equal(run(['{gsub(/a/, "[&]"); print}'], 'aaa\n').out, '[a][a][a]\n');
  assert.equal(run(['BEGIN{s="abcabc"; n=gsub(/b/, "X", s); print n, s}']).out, '2 aXcaXc\n');
  assert.equal(run(['BEGIN{s="abc"; n=sub(/b/, "B", s); print n, s}']).out, '1 aBc\n');
  assert.equal(run(['BEGIN{s="aaa"; gsub(/a/, "\\\\&", s); print s}']).out, '&&&\n');
  assert.equal(run(['BEGIN{s="aaa"; gsub(/a/, "\\\\\\\\&", s); print s}']).out, '\\a\\a\\a\n');
});

test('gsub handles empty matches like POSIX awk', () => {
  assert.equal(run(['BEGIN{s="abc"; n=gsub(/x*/, "-", s); print n, s}']).out, '4 -a-b-c-\n');
  assert.equal(run(['BEGIN{s="baaac"; n=gsub(/a*/, "-", s); print n, s}']).out, '3 -b-c-\n');
  assert.equal(run(['BEGIN{s="aaa"; n=gsub(/a*/, "-", s); print n, s}']).out, '1 -\n');
  assert.equal(run(['BEGIN{s="a b"; n=gsub(/ */, "_", s); print n, s}']).out, '3 _a_b_\n');
  assert.equal(run(['BEGIN{s=""; n=gsub(/a*/, "-", s); print n, "[" s "]"}']).out, '1 [-]\n');
  assert.equal(run(['BEGIN{s="abc"; n=sub(/x*/, "-", s); print n, s}']).out, '1 -abc\n');
});

test('multi-subscript in and %c/%i conversions', () => {
  assert.equal(run(['BEGIN{a[1,2]=3; print (1,2) in a}']).out, '1\n');
  assert.equal(run(['BEGIN{a[1,2]=3; print ((1,2) in a), ((1,3) in a)}']).out, '1 0\n');
  assert.equal(run(['BEGIN{printf "%c%c%c|%i|%5.2s|\\n", 65, "BC", 97.9, 42, "abcdef"}']).out, 'ABa|42|   ab|\n');
});

test('gsub on $0 rebuilds the fields', () => {
  assert.equal(run(['{gsub(/b/, "X Y"); print NF, $2}'], 'a b c\n').out, '4 X\n');
});

test('user functions with locals, recursion and return', () => {
  const fact = 'function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) } BEGIN { print fact(5) }';
  assert.equal(run([fact]).out, '120\n');
  const shadow = 'function f(x) { x = 99; return x } BEGIN { x = 1; print f(x), x }';
  assert.equal(run([shadow]).out, '99 1\n');
  const nothing = 'function g() { return } BEGIN { print g() == 0, g() == "" }';
  assert.equal(run([nothing]).out, '1 1\n');
});

test('-v assigns variables before BEGIN', () => {
  assert.equal(run(['-v', 'x=5', 'BEGIN{print x + 1}']).out, '6\n');
  assert.equal(run(['-v', 's=a b', 'BEGIN{print s, length(s)}']).out, 'a b 3\n');
  assert.equal(run(['-vx=7', 'BEGIN{print x}']).out, '7\n');
});

test('program from a -f file', () => {
  seed('prog.awk', 'BEGIN { print "from file" }\n{ print $2 }\n');
  const result = run(['-f', 'prog.awk'], 'a b\n');
  assert.equal(result.code, 0);
  assert.equal(result.out, 'from file\nb\n');
});

test('print redirection to files, close and getline < file', () => {
  const program = [
    'BEGIN { print "one" > "out.txt"; print "two" > "out.txt"; close("out.txt") }',
    'END { while ((getline line < "out.txt") > 0) print "got:" line }',
  ].join(' ');
  const result = run([program], 'x\n');
  assert.equal(result.code, 0);
  assert.equal(result.out, 'got:one\ngot:two\n');
  assert.equal(vfs.readText('out.txt', '/'), 'one\ntwo\n');
});

test('print >> appends to an existing file', () => {
  seed('log.txt', 'first\n');
  const result = run(['BEGIN { print "second" >> "log.txt"; close("log.txt") }']);
  assert.equal(result.code, 0);
  assert.equal(vfs.readText('log.txt', '/'), 'first\nsecond\n');
});

test('print | command buffers and forwards the command output', () => {
  const result = run(['BEGIN { print "x" | "cat"; close("cat") }']);
  assert.equal(result.code, 0);
  assert.equal(result.out, 'ran:cat\n');
  assert.deepEqual(result.calls, ['cat']);
});

test('system runs a command and returns its status', () => {
  const result = run(['BEGIN { print system("echo hi") }']);
  assert.equal(result.out, 'ran:echo hi\n0\n');
  assert.deepEqual(result.calls, ['echo hi']);
});

test('OFMT and CONVFMT control number output', () => {
  assert.equal(run(['BEGIN{OFMT="%.2f"; print 3, 3.14159, 1/3}']).out, '3 3.14 0.33\n');
  assert.equal(run(['BEGIN{CONVFMT="%.2g"; x=1/3; print x ""}']).out, '0.33\n');
  assert.equal(run(['BEGIN{print 1/3, 100000, 1e6, 0.1+0.2, 123456789, 2^31}']).out,
    '0.333333 100000 1000000 0.3 123456789 2147483648\n');
});

test('OFS and ORS separate printed values', () => {
  assert.equal(run(['BEGIN{OFS="-"; ORS="|"; print 1, 2; print 3}']).out, '1-2|3|');
  assert.equal(run(['BEGIN{OFS="-"; $0="a b c"; $1=$1; print}']).out, 'a-b-c\n');
});

test('assigning fields and NF rebuilds $0', () => {
  assert.equal(run(['{$2="X"; print}'], 'a b c\n').out, 'a X c\n');
  assert.equal(run(['{NF=2; print}'], 'a b c\n').out, 'a b\n');
  assert.equal(run(['{print $5 "|"}'], 'a b\n').out, '|\n');
  assert.equal(run(['BEGIN{OFS=","; $0="a"; NF=3; print}']).out, 'a,,\n');
  assert.equal(run(['BEGIN{$0="  a  b  c  "; print NF}']).out, '3\n');
});

test('record separators: paragraph mode and custom RS', () => {
  assert.equal(run(['BEGIN{RS=""} {print NR ":" $0}'], 'a b\nc\n\nd\n').out, '1:a b\nc\n2:d\n');
  assert.equal(run(['BEGIN{RS=";"} {print NR, $0}'], 'a;b;c').out, '1 a\n2 b\n3 c\n');
});

test('comparison rules for strnum, string and uninitialized values', () => {
  assert.equal(run(['{print ($1<9), ($1=="10"), ($1+0), ($1==0)}'], '10\n').out, '0 1 10 0\n');
  assert.equal(run(['{print ($1==0), ($1=="00")}'], '0\n').out, '1 0\n');
  assert.equal(run(['{print ($1<5)}'], '10abc\n').out, '1\n');
  assert.equal(run(['BEGIN{print (x==0), (x==""), (x=="0"), length(x)}']).out, '1 1 0 0\n');
  assert.equal(run(['BEGIN{print ("10"==10), ("10"<9), ("1.0"==1)}']).out, '1 1 0\n');
});

test('arithmetic operators and precedence', () => {
  assert.equal(run(['BEGIN{print 2^3^2, -2^2, 2^-1, 2**3}']).out, '512 -4 0.5 8\n');
  assert.equal(run(['BEGIN{print -7%3, 7%-3, 7.5%2}']).out, '-1 1 1.5\n');
  assert.equal(run(['BEGIN{print 010, 09, 0.5}']).out, '8 9 0.5\n');
  assert.equal(run(['BEGIN{print !0, !1, !"", !"x", +"3x", -"3x"}']).out, '1 0 1 0 3 -3\n');
  assert.equal(run(['BEGIN{x=5; print x++, x, ++x, x--, x}']).out, '5 6 7 7 6\n');
  assert.equal(run(['BEGIN{print "a" "b" == "ab", 1 "2" == 12}']).out, '1 1\n');
});

test('ternary, in and match operators', () => {
  assert.equal(run(['BEGIN{print (1>2)?"y":"n"}']).out, 'n\n');
  assert.equal(run(['BEGIN{a[1]=1; print (1 in a) ? "yes" : "no"}']).out, 'yes\n');
  assert.equal(run(['$1 ~ /^a/ {print "m:" $1} $1 !~ /^a/ {print "n:" $1}'], 'abc\nbcd\n').out, 'm:abc\nn:bcd\n');
});

test('range patterns print inclusively', () => {
  assert.equal(run(['/a/,/c/'], 'a\nb\nc\nd\n').out, 'a\nb\nc\n');
});

test('control flow: if/else, loops, break, continue, next', () => {
  const program = 'BEGIN{for(i=0;i<5;i++){if(i==2)continue; if(i==4)break; printf "%d", i} print ""}';
  assert.equal(run([program]).out, '013\n');
  assert.equal(run(['BEGIN{i=0; do {printf "%d", i; i++} while(i<3); print ""}']).out, '012\n');
  assert.equal(run(['{if($1>1) print "big"; else print "small"}'], '2\n0\n').out, 'big\nsmall\n');
  assert.equal(run(['/skip/{next} {print}'], 'a\nskip\nb\n').out, 'a\nb\n');
  assert.equal(run(['{while ((getline line) > 0) n++; print n; n=0}'], '1\n2\n3\n').out, '2\n');
});

test('getline from the main input in BEGIN', () => {
  assert.equal(run(['BEGIN{while ((getline line) > 0) n++; print n}'], 'a\nb\nc\n').out, '3\n');
});

test('builtins', () => {
  assert.equal(run(['BEGIN{print length("hello"), substr("hello",2,2), substr("hello",0,2), substr("hello",10) "|"}']).out,
    '5 el he |\n');
  assert.equal(run(['BEGIN{print index("abcabc","bc"), index("abc","z"), index("abc","")}']).out, '2 0 1\n');
  assert.equal(run(['BEGIN{n=split("a:b::c", arr, ":"); print n, arr[1], arr[3] "|"}']).out, '4 a |\n');
  assert.equal(run(['BEGIN{n=split("a1b22c", arr, /[0-9]+/); print n, arr[3]}']).out, '3 c\n');
  assert.equal(run(['BEGIN{print toupper("ab"), tolower("AB"), int(-3.9), sqrt(16), exp(0), log(1), atan2(0,1)}']).out,
    'AB ab -3 4 1 0 0\n');
  assert.equal(run(['BEGIN{print sprintf("%05d|%-5d|%x", 42, 42, 255)}']).out, '00042|42   |ff\n');
  assert.equal(run(['BEGIN{print match("abc123", /[0-9]+/), RSTART, RLENGTH}']).out, '4 4 3\n');
  assert.equal(run(['BEGIN{print match("abc", /[0-9]+/), RSTART, RLENGTH}']).out, '0 0 -1\n');
  assert.equal(run(['BEGIN{print close("never-opened")}']).out, '-1\n');
});

test('rand and srand are reproducible', () => {
  assert.equal(run(['BEGIN{srand(1); a=rand(); srand(1); b=rand(); print (a==b), (a>=0 && a<1)}']).out, '1 1\n');
  assert.equal(run(['BEGIN{srand(1); print srand(2)}']).out, '1\n');
});

test('FILENAME, FNR, NR and file operands', () => {
  seed('one.txt', 'a\nb\n');
  seed('two.txt', 'c\n');
  const stdinOnly = run(['{print FILENAME}'], 'x\n');
  assert.equal(stdinOnly.out, '-\n');
  const files = run(['{print FILENAME, FNR, NR}', 'one.txt', 'two.txt']);
  assert.equal(files.out, 'one.txt 1 1\none.txt 2 2\ntwo.txt 1 3\n');
});

test('operand assignments apply between files', () => {
  seed('one.txt', 'x\n');
  seed('two.txt', 'y\n');
  const result = run(['{print v, $0}', 'v=1', 'one.txt', 'v=2', 'two.txt']);
  assert.equal(result.out, '1 x\n2 y\n');
});

test('nextfile skips the rest of a file', () => {
  seed('a.txt', '1\n2\n');
  seed('b.txt', '3\n');
  assert.equal(run(['{print FILENAME ":" $0; nextfile}', 'a.txt', 'b.txt']).out, 'a.txt:1\nb.txt:3\n');
});

test('exit status and END handling', () => {
  assert.equal(run(['BEGIN{exit 3} END{print "end"}']).code, 3);
  assert.equal(run(['BEGIN{exit 3} END{print "end"}']).out, 'end\n');
  assert.equal(run(['{exit 2} END{print NR}'], 'a\nb\n').code, 2);
  assert.equal(run(['END{exit}']).code, 0);
  assert.equal(run(['BEGIN{print "x"}']).code, 0);
});

test('delete, SUBSEP keys and multi-subscript arrays', () => {
  const program = 'BEGIN{a[1,2]=3; for (k in a) { split(k, parts, SUBSEP); print parts[1], parts[2], a[k] }}';
  assert.equal(run([program]).out, '1 2 3\n');
});

test('syntax errors exit 2 with an awk message', () => {
  const result = run(['BEGIN {']);
  assert.equal(result.code, 2);
  assert.match(result.err, /^awk: syntax error/);
  assert.equal(run(['{print $1}}']).code, 2);
  assert.equal(run(['BEGIN{print 1 +}']).code, 2);
});

test('option and operand errors exit 2', () => {
  assert.equal(run(['-Q', 'BEGIN{print 1}']).code, 2);
  assert.match(run(['-Q']).err, /^awk: unknown option/);
  assert.equal(run([]).code, 2);
  assert.equal(run(['-v', 'bad', 'BEGIN{print 1}']).code, 2);
});

test('missing input file reports ENOENT and exits 2', () => {
  const result = run(['{print}', 'nope.txt']);
  assert.equal(result.code, 2);
  assert.match(result.err, /No such file or directory/);
});

test('--help and --version', () => {
  const help = run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /usage/i);
  assert.equal(run(['--version']).code, 0);
});

test('regex literals vs division disambiguation', () => {
  assert.equal(run(['{print $1 / 2}'], '8\n').out, '4\n');
  assert.equal(run(['$0 ~ /x/ {print "has x"}'], 'axb\n').out, 'has x\n');
  assert.equal(run(['BEGIN{n=3; print n/2, 6/2/3}']).out, '1.5 1\n');
});

test('division by zero is a fatal error', () => {
  const result = run(['BEGIN{print 1/0}']);
  assert.equal(result.code, 2);
  assert.match(result.err, /division by zero/);
});

test('main tolerates argv that still includes the program name', () => {
  const withName = main('awk', ['awk', 'BEGIN{print 1}'], makeCtx(''));
  const withoutName = main('awk', ['BEGIN{print 2}'], makeCtx(''));
  assert.equal(withName.out, '1\n');
  assert.equal(withoutName.out, '2\n');
});

test('stdin operand - reads standard input', () => {
  assert.equal(run(['{print $2}', '-'], 'a b\n').out, 'b\n');
});
