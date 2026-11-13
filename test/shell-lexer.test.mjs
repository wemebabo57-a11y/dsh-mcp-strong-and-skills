import test from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/shell/lexer.mjs';
import { parseScript } from '../src/shell/parser.mjs';

const DOLLAR = '$';
const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const lit = (v, q = 0) => ({ t: 'lit', v, q });
const partsOf = (token) => token.parts;
const opsOf = (tokens) => tokens.filter((token) => token.t === 'op').map((token) => token.v);
const firstNode = (source) => parseScript(lex(source))[0].items[0].node;
const throwsWith = (fn, text) => assert.throws(fn, (error) => error.message.includes(text));

test('lex: words, newline ops and comments only at word start', () => {
  const tokens = lex(`echo hi
# note
echo a#b
`);
  assert.equal(tokens.length, 7);
  assert.deepEqual(tokens[0], { t: 'word', parts: [lit('echo')], raw: 'echo' });
  assert.deepEqual(tokens[1], { t: 'word', parts: [lit('hi')], raw: 'hi' });
  assert.deepEqual(tokens[2], { t: 'op', v: 'newline' });
  assert.deepEqual(tokens[3], { t: 'op', v: 'newline' });
  assert.deepEqual(tokens[4], { t: 'word', parts: [lit('echo')], raw: 'echo' });
  assert.deepEqual(tokens[5], { t: 'word', parts: [lit('a#b')], raw: 'a#b' });
  assert.deepEqual(tokens[6], { t: 'op', v: 'newline' });
});

test('lex: hash at a redirection target starts a comment', () => {
  throwsWith(() => lex('echo >#file'), 'unexpected token');
  throwsWith(() => lex('echo >' + '#file' + NL), 'unexpected token');
});

test('lex: CRLF is normalised to newline ops', () => {
  const tokens = lex('a' + CR + NL + 'b' + CR + NL);
  assert.equal(tokens.length, 4);
  assert.deepEqual(partsOf(tokens[0]), [lit('a')]);
  assert.deepEqual(opsOf(tokens), ['newline', 'newline']);
});

test('lex: backslash-newline continuation joins a word', () => {
  const tokens = lex('echo a' + BS + NL + 'b' + NL);
  assert.equal(tokens.length, 3);
  assert.deepEqual(partsOf(tokens[1]), [lit('ab')]);
});

test('lex: single quotes are literal', () => {
  const tokens = lex(`echo 'a $b "c"'
`);
  assert.deepEqual(partsOf(tokens[1]), [lit('a $b "c"', 1)]);
});

test('lex: double quotes expand params and keep quote parts', () => {
  const tokens = lex(`echo "a $c b"
`);
  const parts = partsOf(tokens[1]);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], lit('a ', 2));
  assert.equal(parts[1].t, 'param');
  assert.equal(parts[1].name, 'c');
  assert.equal(parts[1].q, 2);
  assert.deepEqual(parts[2], lit(' b', 2));
});

test('lex: double quote backslash escapes', () => {
  const source = 'echo "a' + BS + '"b' + BS + '$c' + BS + BS + 'd"';
  const parts = partsOf(lex(source)[1]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].q, 2);
  assert.equal(parts[0].v, 'a"b$c' + BS + 'd');
});

test('lex: single quotes inside double quotes stay literal', () => {
  const source = 'echo "' + DOLLAR + "'a'" + '"';
  const parts = partsOf(lex(source)[1]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].v, DOLLAR + "'a'");
  assert.equal(parts[0].q, 2);
});

test('lex: ANSI-C quoting decodes escapes', () => {
  const tabTokens = lex('x=$' + "'A" + BS + "tB'");
  assert.equal(partsOf(tabTokens[0])[1].v, 'A' + TAB + 'B');
  assert.equal(partsOf(tabTokens[0])[1].q, 1);
  const newlineTokens = lex('x=$' + "'a" + BS + "nb'");
  assert.equal(partsOf(newlineTokens[0])[1].v, 'a' + NL + 'b');
  const quoteTokens = lex('x=$' + "'a" + BS + "'b'");
  assert.equal(partsOf(quoteTokens[0])[1].v, "a'b");
  const octalTokens = lex('x=$' + "'" + BS + "101'");
  assert.equal(partsOf(octalTokens[0])[1].v, 'A');
  const longOctalTokens = lex('x=$' + "'" + BS + "0101'");
  assert.equal(partsOf(longOctalTokens[0])[1].v, String.fromCharCode(8) + '1');
  const unknownTokens = lex('x=$' + "'a" + BS + "qb'");
  assert.equal(partsOf(unknownTokens[0])[1].v, 'a' + BS + 'qb');
});

test('lex: unquoted backslash escapes the next character', () => {
  const tokens = lex('echo a' + BS + ' b');
  assert.deepEqual(partsOf(tokens[1]), [lit('a'), lit(' ', 1), lit('b')]);
});

test('lex: dollar forms pick ANSI-C only outside double quotes', () => {
  const source = 'echo ' + DOLLAR + "'c d' " + DOLLAR + '"a b"';
  const tokens = lex(source);
  assert.deepEqual(partsOf(tokens[1]), [lit('c d', 1)]);
  assert.deepEqual(partsOf(tokens[2]), [lit('a b', 2)]);
});

test('lex: operators', () => {
  const tokens = lex(`a && b || c | d ; e & (f) { g; } ;;
`);
  assert.deepEqual(opsOf(tokens), ['&&', '||', '|', ';', '&', '(', ')', '{', ';', '}', ';;', 'newline']);
  assert.equal(tokens.length, 19);
});

test('lex: redirections with file descriptor prefixes', () => {
  const tokens = lex(`cmd 2>err <in >>out 2>&1 &>all 3<>f
`);
  assert.equal(tokens.length, 8);
  assert.equal(tokens[1].t, 'redir');
  assert.equal(tokens[1].fd, 2);
  assert.equal(tokens[1].op, '>');
  assert.deepEqual(tokens[1].target.parts, [lit('err')]);
  assert.equal(tokens[2].fd, null);
  assert.equal(tokens[2].op, '<');
  assert.equal(tokens[3].op, '>>');
  assert.equal(tokens[4].fd, 2);
  assert.equal(tokens[4].op, '>&');
  assert.deepEqual(tokens[4].target.parts, [lit('1')]);
  assert.equal(tokens[5].op, '&>');
  assert.equal(tokens[5].fd, null);
  assert.equal(tokens[6].op, '<>');
  assert.equal(tokens[6].fd, 3);
});

test('lex: heredoc collects body lines until the delimiter', () => {
  const tokens = lex(`cat <<EOF
hello $(x)
EOF
echo done
`);
  assert.equal(tokens.length, 6);
  const heredoc = tokens[1];
  assert.equal(heredoc.t, 'heredoc');
  assert.equal(heredoc.delim, 'EOF');
  assert.equal(heredoc.quoted, false);
  assert.equal(heredoc.stripTabs, false);
  assert.equal(heredoc.body, 'hello $(x)' + NL);
});

test('lex: heredoc with tab stripping', () => {
  const tokens = lex(`cat <<-EOF
	line
	EOF
echo
`);
  const heredoc = tokens[1];
  assert.equal(heredoc.stripTabs, true);
  assert.equal(heredoc.delim, 'EOF');
  assert.equal(heredoc.body, 'line' + NL);
});

test('lex: quoted heredoc delimiter', () => {
  const tokens = lex(`cat <<'EOF'
$x
EOF
`);
  const heredoc = tokens[1];
  assert.equal(heredoc.quoted, true);
  assert.equal(heredoc.delim, 'EOF');
  assert.equal(heredoc.body, '$x' + NL);
});

test('lex: arithmetic command token', () => {
  const tokens = lex(`((1 + 2 * 3))
`);
  assert.equal(tokens[0].t, 'arith');
  assert.equal(tokens[0].src, '1 + 2 * 3');
  assert.deepEqual(opsOf(tokens), ['newline']);
});

test('lex: command substitution nests', () => {
  const tokens = lex(`x=$(echo $(echo hi))
`);
  const parts = partsOf(tokens[0]);
  assert.equal(parts[0].t, 'lit');
  assert.equal(parts[0].v, 'x=');
  assert.equal(parts[1].t, 'cmd');
  assert.equal(parts[1].q, 0);
  assert.equal(parts[1].ast[0].k, 'list');
  assert.equal(parts[1].ast[0].items[0].node.words[0].parts[0].v, 'echo');
  assert.equal(parts[1].ast[0].items[0].node.words[1].parts[0].t, 'cmd');
});

test('lex: parameter expansion containing command substitution and braces', () => {
  const source = 'echo ' + DOLLAR + '{v:-$(echo })}';
  const param = partsOf(lex(source)[1])[0];
  assert.equal(param.t, 'param');
  assert.equal(param.name, 'v');
  assert.equal(param.op, ':-');
  assert.equal(param.arg[0].t, 'cmd');
  assert.equal(param.arg[0].ast[0].items[0].node.words[1].parts[0].v, '}');
});

test('lex: special and positional parameters', () => {
  const source = DOLLAR + '? ' + DOLLAR + '# ' + DOLLAR + '@ ' + DOLLAR + '* ' + DOLLAR + DOLLAR
    + ' ' + DOLLAR + '! ' + DOLLAR + '0 ' + DOLLAR + '9 ' + DOLLAR + '{10}';
  const tokens = lex(source);
  assert.equal(tokens.length, 9);
  const params = tokens.map((token) => partsOf(token)[0]);
  assert.deepEqual(params.map((param) => param.name), ['?', '#', '@', '*', DOLLAR, '!', '0', '9', '10']);
  assert.equal(params.every((param) => param.t === 'param' && param.special === true), true);
  assert.equal(params[0].braced, false);
  assert.equal(params[8].braced, true);
});

test('lex: braced parameter operators', () => {
  const pieces = ['{a}', '{#a}', '{a:-d}', '{a-d}', '{a:=d}', '{a:?m}', '{a:+p}', '{a#x}',
    '{a##x}', '{a%x}', '{a%%x}', '{a/x/y}', '{a//x/y}', '{a:1:2}'];
  const source = pieces.map((piece) => DOLLAR + piece).join(' ');
  const params = lex(source).map((token) => partsOf(token)[0]);
  assert.equal(params.length, 14);
  assert.equal(params[0].op, null);
  assert.equal(params[0].braced, true);
  assert.equal(params[1].len, true);
  assert.equal(params[2].op, ':-');
  assert.deepEqual(params[2].arg, [lit('d')]);
  assert.equal(params[3].op, '-');
  assert.equal(params[4].op, ':=');
  assert.equal(params[5].op, ':?');
  assert.equal(params[6].op, ':+');
  assert.equal(params[7].op, '#');
  assert.equal(params[8].op, '##');
  assert.equal(params[9].op, '%');
  assert.equal(params[10].op, '%%');
  assert.equal(params[11].op, '/');
  assert.deepEqual(params[11].arg.map((part) => part.v), ['x']);
  assert.deepEqual(params[11].replacement.parts.map((part) => part.v), ['y']);
  assert.equal(params[12].op, '//');
  assert.deepEqual(params[13].slice, ['1', '2']);
});

test('lex: slice keeps raw offset and length source strings', () => {
  const source = DOLLAR + '{a:2:} ' + DOLLAR + '{a: -2: 1}';
  const params = lex(source).map((token) => partsOf(token)[0]);
  assert.deepEqual(params[0].slice, ['2', '']);
  assert.equal(params[0].arg, null);
  assert.deepEqual(params[1].slice, ['-2', '1']);
});

test('lex: parameter parts carry quote context', () => {
  const tokens = lex('echo "$a" ' + DOLLAR + '@');
  assert.equal(partsOf(tokens[1])[0].q, 2);
  assert.equal(partsOf(tokens[2])[0].q, 0);
});

test('lex: backtick command substitution', () => {
  const tokens = lex('echo ' + BT + 'echo hi' + BT);
  const part = partsOf(tokens[1])[0];
  assert.equal(part.t, 'cmd');
  assert.equal(part.q, 0);
  assert.equal(part.ast[0].items[0].node.words[1].parts[0].v, 'hi');
});

test('lex: unterminated constructs throw bash-like errors', () => {
  throwsWith(() => lex(`echo 'abc`), 'unexpected EOF while looking for matching');
  throwsWith(() => lex('echo ' + DOLLAR + '{abc'), 'unexpected EOF while looking for matching');
  throwsWith(() => lex(`echo $(echo`), "matching ')'");
  throwsWith(() => lex(`cat <<EOF
x
`), "matching 'EOF'");
});

test('parser: simple command with assignments and redirections', () => {
  const node = firstNode(`a=1 b="x y" cmd arg >out 2>&1
`);
  assert.equal(node.k, 'simple');
  assert.equal(node.assigns.length, 2);
  assert.equal(node.assigns[0].name, 'a');
  assert.deepEqual(node.assigns[0].value.parts, [lit('1')]);
  assert.deepEqual(node.assigns[1].value.parts, [lit('x y', 2)]);
  assert.equal(node.words.length, 2);
  assert.equal(node.words[0].parts[0].v, 'cmd');
  assert.equal(node.redirs.length, 2);
  assert.equal(node.redirs[0].op, '>');
  assert.equal(node.redirs[1].fd, 2);
  assert.equal(node.redirs[1].op, '>&');
  assert.deepEqual(node.redirs[1].target.parts, [lit('1')]);
});

test('parser: and/or lists and separators', () => {
  const list = parseScript(lex(`a && b || c
`))[0];
  assert.equal(list.k, 'list');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].sep, NL);
  const node = list.items[0].node;
  assert.equal(node.k, 'andor');
  assert.equal(node.first.k, 'simple');
  assert.equal(node.rest.length, 2);
  assert.equal(node.rest[0].op, '&&');
  assert.equal(node.rest[1].op, '||');
});

test('parser: background separator', () => {
  const list = parseScript(lex(`a & b
`))[0];
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].sep, '&');
  assert.equal(list.items[1].sep, NL);
});

test('parser: pipeline with negation', () => {
  const node = firstNode(`! echo hi | cat
`);
  assert.equal(node.k, 'pipeline');
  assert.equal(node.negate, true);
  assert.equal(node.cmds.length, 2);
  assert.equal(node.cmds[0].k, 'simple');
  const double = firstNode(`! ! echo hi
`);
  assert.equal(double.k, 'simple');
  assert.deepEqual(double.words.map((word) => word.parts[0].v), ['echo', 'hi']);
});

test('parser: if elif else', () => {
  const node = firstNode(`if a; then b; elif c; then d; else e; fi
`);
  assert.equal(node.k, 'if');
  assert.equal(node.branches.length, 2);
  assert.equal(node.branches[0].cond.length, 1);
  assert.equal(node.branches[1].cond.length, 1);
  assert.equal(node.branches[0].body.length, 1);
  assert.equal(node.elseBody.length, 1);
  assert.equal(node.elseBody[0].k, 'list');
});

test('parser: for in words', () => {
  const node = firstNode(`for i in 1 2; do echo $i; done
`);
  assert.equal(node.k, 'for');
  assert.equal(node.name, 'i');
  assert.equal(node.words.length, 2);
  assert.equal(node.body.length, 1);
  const simple = node.body[0].items[0].node;
  assert.equal(simple.k, 'simple');
  assert.equal(simple.words[1].parts[0].t, 'param');
  assert.equal(simple.words[1].parts[0].name, 'i');
});

test('parser: arithmetic for', () => {
  const node = firstNode(`for ((i=0;i<3;i++)); do echo $i; done
`);
  assert.equal(node.k, 'for');
  assert.equal(node.name, null);
  assert.equal(node.words, null);
  assert.equal(node.arith, 'i=0;i<3;i++');
  assert.equal(node.body.length, 1);
});

test('parser: while and until', () => {
  const whileNode = firstNode(`while a; do b; done
`);
  assert.equal(whileNode.k, 'while');
  assert.equal(whileNode.cond.length, 1);
  assert.equal(whileNode.body.length, 1);
  const untilNode = firstNode(`until a; do b; done
`);
  assert.equal(untilNode.k, 'until');
});

test('parser: case arms and terminators', () => {
  const node = firstNode(`case $x in
a|b) echo ab ;;
c) echo c ;&
*) : ;;&
esac
`);
  assert.equal(node.k, 'case');
  assert.equal(node.word.parts[0].name, 'x');
  assert.equal(node.arms.length, 3);
  assert.equal(node.arms[0].pats.length, 2);
  assert.equal(node.arms[0].fall, false);
  assert.equal(node.arms[1].fall, true);
  assert.equal(node.arms[2].fall, true);
});

test('parser: brace group and subshell', () => {
  const group = firstNode(`{ echo a; } >out
`);
  assert.equal(group.k, 'group');
  assert.equal(group.subshell, false);
  assert.equal(group.body.length, 1);
  assert.equal(group.redirs[0].op, '>');
  const subshell = firstNode(`(cd /tmp)
`);
  assert.equal(subshell.k, 'group');
  assert.equal(subshell.subshell, true);
});

test('parser: function definitions in both forms', () => {
  const funcDef = firstNode(`f() { echo x; }
`);
  assert.equal(funcDef.k, 'func');
  assert.equal(funcDef.name, 'f');
  assert.equal(funcDef.body.k, 'group');
  const funcKeyword = firstNode(`function g { echo y; }
`);
  assert.equal(funcKeyword.k, 'func');
  assert.equal(funcKeyword.name, 'g');
  assert.equal(funcKeyword.body.k, 'group');
});

test('parser: heredoc becomes redirection with here payload', () => {
  const node = firstNode(`cat <<EOF
hi
EOF
`);
  const redir = node.redirs[0];
  assert.equal(redir.op, '<<');
  assert.equal(redir.here.delim, 'EOF');
  assert.equal(redir.here.body, 'hi' + NL);
  assert.equal(redir.here.quoted, false);
  assert.equal(redir.here.stripTabs, false);
});

test('parser: heredoc with tab stripping stores stripped body', () => {
  const node = firstNode(`cat <<-EOF
	line
	EOF
`);
  assert.equal(node.redirs[0].here.stripTabs, true);
  assert.equal(node.redirs[0].here.body, 'line' + NL);
});

test('parser: redirections attach to compound commands', () => {
  const node = firstNode(`if a; then b; fi >log
`);
  assert.equal(node.k, 'if');
  assert.equal(node.redirs.length, 1);
  assert.equal(node.redirs[0].op, '>');
  assert.deepEqual(node.redirs[0].target.parts, [lit('log')]);
});

test('parser: nested compound commands', () => {
  const outer = firstNode(`if a; then for i in 1; do echo; done; fi
`);
  const bodyList = outer.branches[0].body[0];
  assert.equal(bodyList.k, 'list');
  assert.equal(bodyList.items[0].node.k, 'for');
  assert.equal(bodyList.items[0].node.name, 'i');
});

test('parser: empty input and assignment-only commands', () => {
  assert.deepEqual(parseScript(lex('')), []);
  assert.deepEqual(parseScript([]), []);
  const node = firstNode(`x=1
`);
  assert.equal(node.k, 'simple');
  assert.equal(node.assigns.length, 1);
  assert.equal(node.words.length, 0);
  assert.equal(node.redirs.length, 0);
});

test('parser: bash-like syntax errors', () => {
  throwsWith(() => parseScript(lex(`echo hi ))
`)), 'syntax error near unexpected token');
  throwsWith(() => parseScript(lex(`if true; then
`)), 'unexpected end of file');
});

test('lex: empty quoted words are kept as empty literals', () => {
  const tokens = lex('echo ' + "''" + ' ' + DOLLAR + "''" + ' ' + DOLLAR + '""' + NL);
  assert.equal(tokens.length, 5);
  assert.deepEqual(partsOf(tokens[1]), [lit('', 1)]);
  assert.deepEqual(partsOf(tokens[2]), [lit('', 1)]);
  assert.deepEqual(partsOf(tokens[3]), [lit('', 2)]);
  const node = firstNode('x=' + "''" + NL);
  assert.deepEqual(node.assigns[0].value.parts, [lit('', 1)]);
});

test('lex: escaped slash in a double-quoted replacement stays literal', () => {
  const tokens = lex('echo "' + DOLLAR + '{v/a' + BS + '/b/c}"' + NL);
  const param = partsOf(tokens[1])[0];
  assert.equal(param.op, '/');
  assert.deepEqual(param.arg, [lit('a/b', 2)]);
  assert.deepEqual(param.replacement.parts, [lit('c', 2)]);
});

test('lex: heredoc inside command substitution keeps paren body text', () => {
  const script = 'x=' + DOLLAR + '(cat <<EOF' + NL + ')' + NL + 'EOF' + NL + ')' + NL;
  const tokens = lex(script);
  assert.equal(tokens.length, 2);
  const parts = partsOf(tokens[0]);
  assert.equal(parts.length, 2);
  assert.equal(parts[1].t, 'cmd');
  const inner = parts[1].ast[0].items[0].node;
  assert.equal(inner.redirs.length, 1);
  assert.equal(inner.redirs[0].here.body, ')' + NL);
  const node = parseScript(tokens)[0].items[0].node;
  assert.equal(node.k, 'simple');
  assert.equal(node.assigns[0].name, 'x');
});

test('lex: command substitution skips arithmetic shift operators', () => {
  const source = 'x=' + DOLLAR + '( (( y << 2 ))' + NL + 'echo hi' + NL + ')';
  const tokens = lex(source);
  const parts = partsOf(tokens[0]);
  assert.equal(parts[1].t, 'cmd');
  const items = parts[1].ast[0].items;
  assert.equal(items.length, 2);
  assert.equal(items[0].node.k, 'arithcmd');
  assert.equal(items[0].node.src, 'y << 2');
  assert.equal(items[1].node.k, 'simple');
  const inner = parts[1].ast[0].items[1].node;
  assert.deepEqual(inner.words.map((word) => word.parts[0].v), ['echo', 'hi']);
});

test('lex: multiple heredocs queue bodies in order', () => {
  const tokens = lex('cat <<A <<B' + NL + 'one' + NL + 'A' + NL + 'two' + NL + 'B' + NL);
  assert.equal(tokens.length, 4);
  const redirs = parseScript(tokens)[0].items[0].node.redirs;
  assert.equal(redirs.length, 2);
  assert.equal(redirs[0].here.body, 'one' + NL);
  assert.equal(redirs[1].here.body, 'two' + NL);
});

test('parser: function body group keeps trailing redirections', () => {
  const node = firstNode('f() {' + NL + '  echo x' + NL + '} >out' + NL);
  assert.equal(node.k, 'func');
  assert.equal(node.name, 'f');
  assert.equal(node.body.k, 'group');
  assert.equal(node.body.redirs.length, 1);
  assert.equal(node.body.redirs[0].op, '>');
});

