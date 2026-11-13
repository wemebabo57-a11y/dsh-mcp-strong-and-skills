// Parity harness: compare the builtin interpreter against real Git Bash (offline oracle).
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runBuiltinShell } from '../src/builtin-shell.mjs';

const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

const cases = [
  ['echo hi', ''],
  ['echo "a  b"', ''],
  ['x=5; echo $x', ''],
  ['x=abcde; echo ${x:1:2}', ''],
  ['x=hello.txt; echo ${x%.txt}; echo ${x#*.}', ''],
  ['echo ${undefined:-fallback}; echo ${undefined-default}', ''],
  ['x=; echo ${x:-empty} ${x:+set}', ''],
  ['echo $((2+3*4)); echo $(( (1+2)*3 ))', ''],
  ['for i in 1 2 3; do echo $i; done', ''],
  ['for i in {1..3}; do echo $i; done', ''],
  ['echo {a,b}{1,2}', ''],
  ['f() { echo "f:$1"; return 3; }; f hi; echo $?', ''],
  ['if true; then echo yes; else echo no; fi', ''],
  ['false || echo recovered; true && echo ok', ''],
  ['echo a | tr a b', ''],
  ['printf %s:%03d\\n x 7', ''],
  ['cat note.txt', ''],
  ['cat note.txt | grep -n alpha', ''],
  ['x=$(echo a; echo b); echo "$x"', ''],
  ['x=$(false); echo status=$?', ''],
  ['while read line; do echo L:$line; done <<EOF\none\ntwo\nEOF', ''],
  ['cat <<EOF\nkeep text\nEOF', ''],
  ['cat <<\'EOF\'\nkeep $HOME\nEOF', ''],
  ['case x in x) echo match;; esac', ''],
  ['echo hi > out.txt; cat out.txt', ''],
  ['echo a >> out2.txt; echo b >> out2.txt; cat out2.txt', ''],
  ['(x=1; echo sub:$x); echo outer:${x:-none}', ''],
  ['set -e; false; echo unreachable', ''],
  ['true; echo $?; false; echo $?', ''],
  ['x=abcd; echo ${#x}', ''],
  ['a=(1 2 3); echo ${a[1]}', ''],
  ['[[ -n x ]] && echo yes', ''],
  ['test -f note.txt && echo file; test -d dir && echo dir', ''],
  ['seq 3', ''],
  ['sort -u words.txt', ''],
  ['uniq -c words.txt', ''],
  ['head -n 2 words.txt; tail -n 1 words.txt', ''],
  ['wc -l words.txt', ''],
  ['cut -d , -f 2 fields.csv', ''],
  ['find . -maxdepth 1 -name note.txt', ''],
  ['echo dir/*', ''],
  ['echo "a b" | xargs -n 1', ''],
  ['exit 7; echo no', ''],
  ['x=1 y=2; echo $x$y', ''],
  ['echo one; echo two', ''],
  ['echo a\\ b', ''],
  ['echo "quoted $((1+1)) done"', ''],
  ['x=abcabc; echo ${x//a/X}; echo ${x##*b}', ''],
  ['for ((i=0;i<3;i++)); do echo $i; done', ''],
  ['case x in x) echo A ;& y) echo B ;; esac', ''],
  ['case x in x) echo A ;;& y) echo B ;; esac', ''],
  ['while read l; do echo L:$l; done < note.txt', ''],
  ['read x <<< hi; echo got:$x', ''],
  ['printf "%s\\n" a b c', ''],
  ['echo err 1>&2', ''],
  ['echo dir/[ot]*.txt', ''],
  ['sort -k1,1 fields.csv; sort -t, -k2 fields.csv', ''],
  ['cut -c 1-4 note.txt; tr -s a < words.txt', ''],
  ['wc -c note.txt', ''],
  ['echo "a b c" | xargs -n 2', ''],
  ['echo {1..9..2}', ''],
  ['local_test() { local v=in; echo $v; }; v=out; local_test; echo $v', ''],
  ['set -o pipefail; false | true; echo $?', ''],
  ['echo $((2**10)); echo $((7/2))', ''],
  ['x=1; ((x+=2)); echo $x', ''],
  ['command -v echo; type echo', ''],
  ['mkdir -p d2/d3; ls d2', ''],
  ['cp note.txt copy.txt; mv copy.txt moved.txt; cat moved.txt', ''],
  ['for f in *.txt; do echo "f=$f"; done', ''],
  ['n=0; while IFS= read -r line; do n=$((n+1)); done < words.txt; echo $n', ''],
  ['grep -q beta words.txt && echo found', ''],
  ['if command -v echo >/dev/null; then echo has; fi', ''],
  ['sed -n "s/a/A/p" words.txt', ''],
  ['awk -F, "{print \$2}" fields.csv', ''],
  ['sort words.txt | head -3', ''],
  ['find . -maxdepth 1 -name "*.txt" | sort | head -2', ''],
  ['trap "rm -f tmpfile" EXIT; touch tmpfile; ls tmpfile', ''],
  ['case beta in alpha|beta) echo hit;; esac', ''],
  ['fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }; fact 5', ''],
  ['printf "%05.2f\\n" 3.14159', ''],
  ['date +%Y | wc -c', ''],
  ['sha256sum note.txt | cut -d" " -f1 | wc -c', ''],
  ['xargs -n 2 echo <<< "a b c"', ''],
  ['x=Hello; echo ${x^^}; echo ${x,,}', ''],
  ['a=(one two three); echo ${#a[@]}; echo ${a[@]}', ''],
  ['a=(x y); a[1]=z; echo ${a[1]}', ''],
  ['a=(x); a+=(y z); echo ${a[2]}', ''],
  ['[[ -f note.txt ]] && echo file', ''],
  ['[[ missing == m* ]] && echo pat', ''],
  ['[[ ! -d missing ]] && echo notdir', ''],
  ['set -o pipefail; false | true; echo $?', ''],
  ['echo -e "a\\nb"', ''],
  ['printf "%q\\n" "a b"', ''],
  ['echo hi | { read v; echo got-$v; }', ''],
  ['( echo sub ); x=1; ( x=2 ); echo $x', ''],
  ['{ echo a; echo b; } | wc -l', ''],
  ['command -v echo; type -t echo', ''],
  ['f() { echo fn; }; type -t f', ''],
  ['. ./note.txt; echo done', ''],
  ['getopts ab: opt -a -b val; echo $opt', ''],
  ['x=abc; [[ $x == *b* ]] && echo star', ''],
  ['[[ "$x" == "a b" ]] || echo differ', ''],
  ['printf "%s\\n" a b c | tail -n +2', ''],
  ['sort -k2 -t, fields.csv', ''],
  ['uniq -c words.txt', ''],
  ['grep -rl hello .', ''],
  ['find . -name "*.txt" -maxdepth 1', ''],
  ['echo hi > /dev/null; echo ok', ''],
  ['cat /dev/null | wc -c', ''],
  ['printf "a b" | wc -w', ''],
  ['ls -l note.txt | wc -l', ''],
  ['[[ -n x && -n y ]] && echo yes', ''],
  ['[[ abc == a* ]] && echo glob', ''],
  ['[[ 5 -gt 3 ]] && echo gt', ''],
  ['echo $\'a\\tb\'', ''],
  ['printf \'%s\\n\' one two', ''],
  ['x=1; ((x++)); echo $x', ''],
  ['(( 1 + 1 == 2 )) && echo math', ''],
  ['v=name; name=val; echo ${!v}', ''],
  ['IFS=, read a b <<< "1,2"; echo $b', ''],
  ['read -r line < note.txt; echo $line', ''],
  ['printf -v out \'%s-%s\' a b; echo $out', ''],
  ['set -- x y; for i in "$@"; do echo $i; done', ''],
  ['f() { return 3; }; f; echo $?', ''],
  ['echo a | { read x; echo $x; }', ''],
  ['x="a b"; for w in $x; do echo $w; done', ''],
  ['echo ${x:-$(echo sub)}', ''],
  ['echo *.txt', ''],
  ['wc -l note.txt words.txt', ''],
  ['grep -c a words.txt', ''],
  ['! true; echo $?', ''],
  ['exec 3>f3; echo z >&3; cat f3', ''],
  ['f() { echo "$#:$1:$2"; }; f a b', ''],
  ['set -- a b c; echo "$#:$1:$3"; shift; echo "$1"', ''],
  ['echo "$@"', ''],
  ['f() { local x=1; x=2; echo $x; }; x=0; f; echo $x', ''],
  ['until false; do echo once; break; done', ''],
  ['x=abc; echo ${x: -2}; echo ${x:1:1}', ''],
  ['x=hello.txt; echo ${x%%.*}; echo ${x%.*}', ''],
  ['case foo.txt in *.txt) echo text;; *) echo other;; esac', ''],
  ['for f in dir/*.txt; do echo $f; done', ''],
  ['echo $(echo $(echo deep))', ''],
  ['echo `echo backtick`', ''],
  ['x=5; if [ "$x" -gt 3 ]; then echo big; fi', ''],
  ['i=0; while [ $i -lt 3 ]; do i=$((i+1)); echo $i; done', ''],
  ['echo a b c | while read x y z; do echo $z-$x; done', ''],
  ['printf "%s\n" "$HOME" | wc -l', ''],
  ['set -e; false || echo caught; echo after', ''],
  ['trap "echo bye" EXIT; echo hi', ''],
  ['false && echo no; echo status=$?', ''],
  ['echo x > f1; echo y >> f1; wc -l < f1', ''],
  ['cat note.txt | grep -v beta | wc -l', ''],
  ['grep -n a words.txt | cut -d: -f1', ''],
  ['sort words.txt | uniq', ''],
  ['sort -r words.txt', ''],
  ['echo "b\na" | sort', ''],
  ['find dir -type f | sort', ''],
  ['ls dir', ''],
  ['basename /a/b/c.txt; dirname /a/b/c.txt', ''],
  ['seq 2 4; seq 1 2 5', ''],
  ['echo ABC | tr A-Z a-z', ''],
  ['printf "%d\n" 3 4', ''],
  ['x=; echo ${x:-d}; x=v; echo ${x:+s}', ''],
  ['echo ${undefined+set}', ''],
  ['unset x; x=${x:-1}; echo $x', ''],
  ['echo a{b,c}d; echo {x,y}', ''],
  ['touch t1 t2; ls t1 t2', ''],
  ['mkdir -p a/b; rmdir a/b; ls a', ''],
  ['echo hello | sed s/hello/world/', ''],
  ['echo "1 2 3" | awk "{print \$2}"', ''],
  ["FOO=bar env | grep '^FOO=bar$'", ''],
  ["x=1; FOO=bar env | grep '^FOO=bar$'; echo $FOO", ''],
];

async function fixture(root) {
  await writeFile(path.join(root, 'note.txt'), 'alpha\nbeta\n');
  await writeFile(path.join(root, 'words.txt'), 'b\na\na\n');
  await writeFile(path.join(root, 'fields.csv'), 'left,right\n');
  await mkdir(path.join(root, 'dir'), { recursive: true });
  await writeFile(path.join(root, 'dir', 'one.txt'), '1\n');
  await writeFile(path.join(root, 'dir', 'two.txt'), '2\n');
}

const rootA = await mkdtemp(path.join(os.tmpdir(), 'parity-a-'));
const rootB = await mkdtemp(path.join(os.tmpdir(), 'parity-b-'));
await fixture(rootA);
await fixture(rootB);
const env = { ...process.env, HOME: rootA, PWD: rootA, LANG: 'C.UTF-8' };
delete env.Path;
let fails = 0;
for (const [script] of cases) {
  const bashProc = spawnSync(BASH, ['-s'], { cwd: rootB, input: script, encoding: 'utf8', env: { ...env, HOME: rootB, PWD: rootB } });
  const expectedOut = bashProc.stdout;
  const expectedCode = bashProc.status;
  const got = await runBuiltinShell({ command: script, cwd: rootA, root: rootA, env });
  const outOk = got.stdout === expectedOut;
  const codeOk = got.exitCode === expectedCode;
  if (!outOk || !codeOk) {
    fails += 1;
    console.log('FAIL ' + JSON.stringify(script));
    console.log('  bash(' + expectedCode + '): ' + JSON.stringify(expectedOut));
    console.log('  ours(' + got.exitCode + '): ' + JSON.stringify(got.stdout) + ' err=' + JSON.stringify(got.stderr.slice(0, 200)));
  }
}
console.log('fails=' + fails + '/' + cases.length);
await rm(rootA, { recursive: true, force: true });
await rm(rootB, { recursive: true, force: true });
