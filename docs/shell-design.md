# Builtin shell design (bash-fidelity, pure JS, zero deps)

Status: authorised by the user on 2026-11-12 ("make the builtin bash behave like a real bash; do P0–P4").

## Goal

`strong_shell` with backend `builtin` must behave like bash 5.2 for the scripts an
agent actually writes. Reference oracle: `C:\\Program Files\\Git\\bin\\bash.exe`
(5.2.37), used offline to generate golden outputs. It cannot be used at runtime
inside a confined token, so the interpreter must be ours.

Non-goals: job control beyond `&`, `$!` semantics for builtins, full `[[ ]]`
regex engines, coprocesses, process substitution beyond `<(...)`.

## Module layout

    src/builtin-shell.mjs      thin adapter: runBuiltinShell() -> src/shell/index.mjs
    src/shell/index.mjs        async runScript({command,cwd,root,sandbox,env,timeoutMs,signal})
    src/shell/fs.mjs           virtual POSIX filesystem over the project root (SYNC)
    src/shell/io.mjs           shared helpers for coreutils (SYNC)
    src/shell/lexer.mjs        script -> token stream
    src/shell/parser.mjs       tokens -> AST
    src/shell/expand.mjs       word expansion, parameter expansion, arithmetic, command substitution, word splitting, glob
    src/shell/glob.mjs         pattern -> regex + brace expansion
    src/shell/exec.mjs         AST evaluator: lists, pipelines, redirections, functions, set -o, traps
    src/shell/builtins.mjs     shell builtins (cd echo printf export set test read ...)
    src/shell/coreutils/*.mjs  external-command lookalikes, pure functions

## Layering rules

- `fs.mjs` and `coreutils/*` are SYNCHRONOUS. `exec.mjs`/`expand.mjs` are async
  because external commands spawn. No coreutil may await.
- No coreutil may import another coreutil. Shared helpers live in `io.mjs`.
- Nothing outside `src/shell/` may import `coreutils/*` directly; `exec.mjs`
  resolves a name through `coreutils/registry.mjs`.

## Coreutil contract (exact)

    // src/shell/coreutils/<name>.mjs
    export const names = ['grep'];           // command names this module provides
    export function main(prog, argv, ctx) {} // argv[0] === prog, rest are args
    // returns { code:number, out:string, err:string }

`ctx` (created once per script by exec.mjs):

    {
      cwd: '/',            // virtual POSIX cwd, always starts with '/'
      env: Map<string,string>,
      fs: ShellFs,         // from fs.mjs
      stdin: string,       // previous pipeline stage output ('' if none)
      opts: { globstar, xtrace },
      check(): void,       // throws ShellAbort when the deadline/abort fired; call every ~1000 iterations
      vars(name): string,  // shell variable lookup (not env)
    }

Rules:
- Never print usage for an unknown option: return code 2 and a bash-style message
  (`grep: invalid option -- 'z'`).
- Write nothing to stdout for diagnostics; `err` lines end with `\n`.
- `out` may omit the trailing newline only when the real command would.
- File errors use `io.formatError(prog, vpath, code)`:
  `grep: foo.txt: No such file or directory`.

## fs.mjs contract

Virtual paths: `/` is the project root. Accepting forms:
- `/src/a.mjs` -> <root>/src/a.mjs
- `src/a.mjs`, `./a`, `../b` -> resolved against `ctx.cwd`
- `C:\\...` or `C:/...` -> host path; allowed only inside <root>, else ShellError EPERM
- `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/zero` -> virtual devices

Methods (sync): virtual(hostPath), host(vpath), stat, exists, isFile, isDir,
readdir, readText, readBuffer, writeText, appendText, mkdirp, remove, rename,
copy, chmod, realpath, glob(pattern, {globstar}), walk(dir, {maxDepth}),
sizeOf(vpath). Every failure throws `ShellError` with `.code` in
`ENOENT EACCES EPERM EISDIR ENOTDIR EEXIST EROFS EFBIG EINVAL EBUSY` and `.vpath`.

## Lexer contract

`lex(script) -> Token[]`, token kinds:

    { t:'word', parts:Part[], raw:string }        // quoting already encoded in parts
    { t:'op', v:'&&'|'||'|'|'|';'|'&'|'('|')'|'{'|'}'|';;'|'newline' }
    { t:'redir', fd:number|null, op:'>'|'>>'|'<'|'<<'|'<<<'|'>&'|'<&'|'&>'|'&>>'|'<>', target:Word }
    { t:'heredoc', fd, delim:string, quoted:boolean, body:string }
    { t:'arith', src:string }                      // (( ... ))

Part kinds (shared with expand.mjs):

    { t:'lit', v:string, q:0|1|2 }                 // 0=unquoted 1=single 2=double
    { t:'param', name:string, special:boolean, braced:boolean,
      len:boolean, op:null|'-#'|'##'|'%'|'%%'|'/'|'//', arg:Part[]|null,
      slice:[off:string|null, len:string|null]|null }
    { t:'cmd', ast:Node[], q:2|0 }                 // $(...) and `...`
    { t:'arith', src:string, q:2|0 }

Lexing rules that must hold (these are the bugs being fixed):
- `\n` is a command separator; `\r\n` normalises to `\n`.
- `#` starts a comment only at the start of a word.
- Backslash-newline is a line continuation.
- `'...'` literal; `"..."` expands `$ \\ \" \``; `$'...'` and `$"..."` accepted.
- `$( )`, `$(( ))`, `${...}` nest correctly including nested quotes.
- `<<EOF` reads the heredoc body; `<<-EOF` strips leading tabs.
- Operators: `&& || | ; & ( ) { } ;; ` and redirections with optional fd prefix.

## AST contract

    Node = {k:'script', body:Node[]}
         | {k:'list', items:[{node:Node, sep:'\n'|';'|'&'}]}
         | {k:'andor', first:Node, rest:[{op:'&&'|'||', node:Node}]}
         | {k:'pipeline', negate:boolean, cmds:Node[]}
         | {k:'simple', assigns:[{name, value:Word}], words:Word[], redirs:Redir[]}
         | {k:'if', branches:[{cond, body}], elseBody:Node[]|null}
         | {k:'for', name:string, words:Word[]|null, body:Node[]}
         | {k:'while'|'until', cond, body}
         | {k:'case', word:Word, arms:[{pats:Word[], body:Node[], fall:boolean}]}
         | {k:'group', body:Node[], subshell:boolean}
         | {k:'func', name:string, body:Node}
         | {k:'arithcmd', src:string}
    Redir = {fd:number|null, op, target:Word}
    Word  = {parts:Part[]}

## Exec contract

`runScript(options)` -> `{stdout, stderr, exitCode, cwd}` (async).
Scope object fields used by builtins: `{vars:Map, exported:Set, funcs:Map, cwd,
positional:string[], opts:{errexit,nounset,xtrace,pipefail,globstar,noexec},
lastStatus, pid, depth}`. Builtins receive `(scope, args, io)` where
`io.write(text)`, `io.error(text)`, `io.exit(code)`.

Semantics that must match bash 5.2:
- assignment expansions happen before the command's own expansions.
- `$?` after a failed `$( )` does not abort the line.
- `set -e` does not exit inside conditions/pipelines except the last element.
- pipeline stages run in subshell scopes; `pipefail` returns the rightmost failure.
- `local` sees the caller's value until assigned.
- `cd` updates `PWD`/`OLDPWD`; `cd -` prints the new PWD.
- exit status 127 for unknown command with `builtin-shell: foo: command not found`.

## Implementation status (2026-11-12)

The interpreter is implemented by these modules, all synchronous except `exec.mjs`/`expand.mjs`:

    src/shell/lexer.mjs       full script tokenizer (comments, continuations, heredocs, [[ ]])
    src/shell/parser.mjs      recursive-descent AST incl. arrays, arithmetic for, case fallthrough
    src/shell/expand.mjs      parameters, arrays, brace/glob, arithmetic substitution, command substitution, IFS
    src/shell/arith.mjs       C-style arithmetic with assignment, ternary, ++/--, bases
    src/shell/exec.mjs        lists, and-or, pipelines, redirections, functions, traps, set -o, external spawn
    src/shell/builtins.mjs    cd/echo/printf/read/export/local/set/test/[[ ]]/getopts/trap/...
    src/shell/fs.mjs          virtual filesystem over the project root with symlink-escape checks
    src/shell/coreutils/      48 commands in registry.mjs (text, filter, sort, sed, awk, fs, misc)

Fidelity is checked by `node scripts/parity-shell.mjs`, which runs 172 scripts through both this
interpreter and Git Bash 5.2.37 and compares stdout and exit status. Current result: 172/172.
`node --test` covers the interpreter and every coreutil module (436 tests at the time of writing).

Known gaps, intentionally outside the current contract:

- process substitution (`<(...)`, `>(...)`), so `done < <(cmd)` is a syntax error;
- associative arrays (`declare -A`), `${var@Q}`/`${var@E}` style transformations, `${!prefix*}`;
- job control (`&` is rejected by the adapter), `select`, `coproc`, `wait -n`, `read -t/-u`;
- extglob patterns and a few GNU long-tail flags;
- `sed` lacks `s///e` and case-conversion escapes; `awk` omits gawk-only extensions;
- `.bashrc`/`.profile` are not loaded and aliases are off unless `shopt -s expand_aliases`.
