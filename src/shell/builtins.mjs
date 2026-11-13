// Shell builtins: the commands bash implements internally.
import fsNode from 'node:fs';
import pathNode from 'node:path';
import { ShellError } from './fs.mjs';
import { ShellExit, ShellBreak, ShellContinue, ShellReturn } from './errors.mjs';
import { evalArith } from './arith.mjs';
import * as expand from './expand.mjs';

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function escapeBytes(text) {
  let out = '';
  let stop = false;
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch !== '\\') { out += ch; index++; continue; }
    index++;
    const next = text[index];
    if (next === undefined) { out += '\\'; break; }
    if (next === 'c') { stop = true; break; }
    if (next === 'a') { out += '\x07'; index++; continue; }
    if (next === 'b') { out += '\b'; index++; continue; }
    if (next === 'e' || next === 'E') { out += '\x1b'; index++; continue; }
    if (next === 'f') { out += '\f'; index++; continue; }
    if (next === 'n') { out += '\n'; index++; continue; }
    if (next === 'r') { out += '\r'; index++; continue; }
    if (next === 't') { out += '\t'; index++; continue; }
    if (next === 'v') { out += '\v'; index++; continue; }
    if (next === '\\') { out += '\\'; index++; continue; }
    if (next === '0') {
      const digits = /^[0-7]{0,3}/.exec(text.slice(index + 1))[0];
      out += String.fromCharCode(Number.parseInt(digits === '' ? '0' : digits, 8));
      index += 1 + digits.length;
      continue;
    }
    if (next === 'x') {
      const match = /^[0-9a-fA-F]{1,2}/.exec(text.slice(index + 1));
      if (!match) { out += '\\x'; index++; continue; }
      out += String.fromCharCode(Number.parseInt(match[0], 16));
      index += 1 + match[0].length;
      continue;
    }
    if (next === 'u' || next === 'U') {
      const limit = next === 'u' ? 4 : 8;
      const match = new RegExp('^[0-9a-fA-F]{1,' + limit + '}').exec(text.slice(index + 1));
      if (!match) { out += '\\' + next; index++; continue; }
      out += String.fromCodePoint(Number.parseInt(match[0], 16));
      index += 1 + match[0].length;
      continue;
    }
    out += '\\' + next;
    index++;
  }
  return { text: out, stop };
}

function padNumber(digits, negative, flags, width, precision, prefix) {
  let body = digits;
  if (precision !== null && precision !== undefined) {
    while (body.length < precision) body = '0' + body;
  }
  let sign = negative ? '-' : (flags.includes('+') ? '+' : (flags.includes(' ') ? ' ' : ''));
  if (prefix) sign = prefix + sign;
  let result = sign + body;
  if (width && result.length < width) {
    if (flags.includes('-')) result = result + ' '.repeat(width - result.length);
    else if (flags.includes('0') && (precision === null || precision === undefined)) {
      result = sign + '0'.repeat(width - result.length - sign.length) + body;
    } else result = ' '.repeat(width - result.length) + result;
  }
  return result;
}

function padString(value, flags, width, precision) {
  let body = value;
  if (precision !== null && precision !== undefined) body = body.slice(0, precision);
  if (width && body.length < width) {
    if (flags.includes('-')) body = body + ' '.repeat(width - body.length);
    else body = ' '.repeat(width - body.length) + body;
  }
  return body;
}

function shellQuote(value) {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_\/.,:@%+=^-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function printfQuote(value) {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_\/.,:@%+=^-]+$/.test(value)) return value;
  if (/[\x00-\x1f\x7f]/.test(value)) {
    let out = "$'";
    for (const ch of value) {
      const code = ch.codePointAt(0);
      if (ch === '\\') out += '\\\\';
      else if (ch === "'") out += "\\'";
      else if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else if (code < 32 || code === 127) out += '\\x' + code.toString(16).padStart(2, '0');
      else out += ch;
    }
    return out + "'";
  }
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9_\/.,:@%+=^-]/.test(ch)) out += ch;
    else out += '\\' + ch;
  }
  return out;
}

function printfFormat(format, args) {
  let out = '';
  let argIndex = 0;
  let stop = false;
  let conversions = 0;
  const state = { index: 0 };
  const values = args.slice();

  const runPass = () => {
    let index = 0;
    while (index < format.length) {
      const ch = format[index];
      if (ch === '\\') {
        const rest = escapeBytes(format.slice(index));
        out += rest.text;
        if (rest.stop) stop = true;
        index = format.length;
        break;
      }
      if (ch !== '%') { out += ch; index++; continue; }
      if (format[index + 1] === '%') { out += '%'; index += 2; continue; }
      let cursor = index + 1;
      let flags = '';
      while (cursor < format.length && '-+ 0#'.includes(format[cursor])) { flags += format[cursor]; cursor++; }
      let widthText = '';
      while (cursor < format.length && /[0-9]/.test(format[cursor])) { widthText += format[cursor]; cursor++; }
      if (format[cursor] === '*') { widthText = String(values[state.index++] ?? 0); cursor++; }
      const width = widthText === '' ? 0 : Number(widthText);
      let precision = null;
      if (format[cursor] === '.') {
        cursor++;
        let precisionText = '';
        while (cursor < format.length && /[0-9]/.test(format[cursor])) { precisionText += format[cursor]; cursor++; }
        if (format[cursor] === '*') { precision = Number(values[state.index++] ?? 0); cursor++; }
        else precision = precisionText === '' ? 0 : Number(precisionText);
      }
      while (cursor < format.length && 'hlLjzt'.includes(format[cursor])) cursor++;
      const conversion = format[cursor];
      if (!conversion) { out += '%'; index = format.length; break; }
      cursor++;
      index = cursor;
      conversions++;
      let raw;
      if (conversion === 's' || conversion === 'b' || conversion === 'q' || conversion === 'c') {
        raw = values[state.index];
        state.index++;
      } else if (conversion === 'd' || conversion === 'i' || conversion === 'u' || conversion === 'o' || conversion === 'x' || conversion === 'X' || conversion === 'f' || conversion === 'F' || conversion === 'e' || conversion === 'E' || conversion === 'g' || conversion === 'G') {
        raw = values[state.index];
        state.index++;
      } else {
        out += '%' + conversion;
        continue;
      }
      if (conversion === 's') { out += padString(text(raw), flags, width, precision); continue; }
      if (conversion === 'b') {
        const escaped = escapeBytes(text(raw));
        out += padString(escaped.text, flags, width, precision);
        if (escaped.stop) { stop = true; return; }
        continue;
      }
      if (conversion === 'q') { out += padString(printfQuote(text(raw)), flags, width, precision); continue; }
      if (conversion === 'c') {
        const value = text(raw);
        out += padString(value.length ? value[0] : '', flags, width, precision);
        continue;
      }
      const number = Number(String(raw === undefined ? '' : raw).trim());
      const value = Number.isFinite(number) ? number : 0;
      if (conversion === 'd' || conversion === 'i') {
        out += padNumber(String(Math.trunc(Math.abs(value))), value < 0, flags, width, precision);
        continue;
      }
      if (conversion === 'u') { out += padNumber(String(Math.trunc(value) >>> 0), false, flags, width, precision); continue; }
      if (conversion === 'o') { out += padNumber((Math.trunc(value) >>> 0).toString(8), false, flags, width, precision, flags.includes('#') ? '0' : ''); continue; }
      if (conversion === 'x') { out += padNumber((Math.trunc(value) >>> 0).toString(16), false, flags, width, precision, flags.includes('#') ? '0x' : ''); continue; }
      if (conversion === 'X') { out += padNumber((Math.trunc(value) >>> 0).toString(16).toUpperCase(), false, flags, width, precision, flags.includes('#') ? '0X' : ''); continue; }
      const digits = precision === null || precision === undefined ? 6 : precision;
      let formatted;
      if (conversion === 'f' || conversion === 'F') formatted = Math.abs(value).toFixed(digits);
      else if (conversion === 'e' || conversion === 'E') formatted = Math.abs(value).toExponential(digits);
      else formatted = String(Math.abs(value));
      if (conversion === 'E' || conversion === 'G') formatted = formatted.toUpperCase();
      out += padNumber(formatted, value < 0, flags, width, null);
    }
  };

  for (;;) {
    const before = state.index;
    runPass();
    if (stop) break;
    if (conversions === 0) break;
    if (state.index >= values.length) break;
    if (state.index === before) break;
  }
  return out;
}

const UNARY = {
  e: (ctx, value) => testExists(ctx, value),
  a: (ctx, value) => testExists(ctx, value),
  f: (ctx, value) => { const info = testStat(ctx, value); return Boolean(info && info.isFile); },
  d: (ctx, value) => { const info = testStat(ctx, value); return Boolean(info && info.isDir); },
  s: (ctx, value) => { const info = testStat(ctx, value); return Boolean(info && info.size > 0); },
  r: (ctx, value) => testExists(ctx, value),
  w: (ctx, value) => testExists(ctx, value),
  x: (ctx, value) => testExists(ctx, value),
  L: (ctx, value) => { const info = testLstat(ctx, value); return Boolean(info && info.isSymlink); },
  h: (ctx, value) => { const info = testLstat(ctx, value); return Boolean(info && info.isSymlink); },
  p: () => false,
  S: () => false,
  b: () => false,
  c: () => false,
  t: () => false,
  z: (ctx, value) => text(value) === '',
  n: (ctx, value) => text(value) !== '',
  v: (ctx, value) => ctx.scope.getVar(value) !== undefined,
  o: () => false,
  G: () => false,
  O: () => false,
  N: (ctx, value) => { const info = testStat(ctx, value); return Boolean(info && info.mtime && info.mtime.getTime() !== 0); },
};

function testStat(ctx, value) {
  try { return ctx.fs.stat(value, ctx.scope.cwd); }
  catch { return null; }
}

function testLstat(ctx, value) {
  try { return ctx.fs.lstat(value, ctx.scope.cwd); }
  catch { return null; }
}

function testExists(ctx, value) {
  try { return ctx.fs.exists(value, ctx.scope.cwd); }
  catch { return false; }
}

function testBinary(ctx, left, op, right, mode) {
  const a = text(left);
  const b = text(right);
  if (op === '=~') {
    try { return new RegExp(b).test(a); } catch { return false; }
  }
  if (op === '=' || op === '==') return mode && mode.pattern ? expand.matchPattern(b, a) : a === b;
  if (op === '!=') return mode && mode.pattern ? !expand.matchPattern(b, a) : a !== b;
  if (op === '<') return a < b;
  if (op === '>') return a > b;
  const na = Number(a);
  const nb = Number(b);
  if (op === '-eq') return na === nb;
  if (op === '-ne') return na !== nb;
  if (op === '-lt') return na < nb;
  if (op === '-le') return na <= nb;
  if (op === '-gt') return na > nb;
  if (op === '-ge') return na >= nb;
  if (op === '-nt') {
    const sa = testStat(ctx, a);
    const sb = testStat(ctx, b);
    return Boolean(sa && sb && sa.mtime > sb.mtime);
  }
  if (op === '-ot') {
    const sa = testStat(ctx, a);
    const sb = testStat(ctx, b);
    return Boolean(sa && sb && sa.mtime < sb.mtime);
  }
  if (op === '-ef') {
    const sa = testStat(ctx, a);
    const sb = testStat(ctx, b);
    return Boolean(sa && sb && sa.ino !== undefined && sa.ino === sb.ino && sa.dev === sb.dev);
  }
  return false;
}

function evalTestExpression(tokens, ctx, mode) {
  let position = 0;
  const options = mode || {};
  const BINARY = new Set(['=', '==', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

  const peek = () => tokens[position];

  function primary() {
    const token = peek();
    if (token === undefined) throw new Error('argument expected');
    if (token === '!') { position++; return !primary(); }
    if (token === '(') { position++; const value = orExpr(); if (peek() !== ')') throw new Error('\')\' expected'); position++; return value; }
    if (token.length === 2 && token[0] === '-' && Object.prototype.hasOwnProperty.call(UNARY, token[1]) && position + 1 < tokens.length) {
      position++;
      const operand = tokens[position];
      position++;
      return Boolean(UNARY[token[1]](ctx, operand));
    }
    const next = tokens[position + 1];
    if (next !== undefined && BINARY.has(next) && position + 2 < tokens.length) {
      position++;
      const right = tokens[position + 1];
      position += 2;
      return testBinary(ctx, token, next, right, options);
    }
    position++;
    return text(token) !== '';
  }

  function andExpr() {
    let value = primary();
    while (peek() === '-a' || peek() === '&&') { position++; const right = primary(); value = value && right; }
    return value;
  }

  function orExpr() {
    let value = andExpr();
    while (peek() === '-o' || peek() === '||') { position++; const right = andExpr(); value = value || right; }
    return value;
  }

  const result = orExpr();
  if (position < tokens.length) throw new Error('too many arguments');
  return result;
}

function splitReadLine(text, ifs) {
  if (ifs === '') return [text];
  const out = [];
  let index = 0;
  const isSep = (ch) => ifs.indexOf(ch) !== -1;
  while (index < text.length && isSep(text[index])) index++;
  while (index < text.length) {
    let word = '';
    while (index < text.length && !isSep(text[index])) { word += text[index]; index++; }
    out.push(word);
    let skipped = 0;
    while (index < text.length && isSep(text[index])) { index++; skipped++; }
    if (!skipped) break;
  }
  return out;
}

export function createBuiltins(shell) {
  const builtins = new Map();

  const define = (names, fn) => { for (const name of names) builtins.set(name, fn); };

  define([':', 'true'], () => 0);
  define(['false'], () => 1);

  define(['echo'], (scope, args, io) => {
    let newline = true;
    let interpret = false;
    let index = 0;
    for (; index < args.length; index++) {
      const arg = args[index];
      if (arg === '-n') { newline = false; continue; }
      if (arg === '-e') { interpret = true; continue; }
      if (arg === '-E') { interpret = false; continue; }
      if (/^-[neE]+$/.test(arg)) {
        for (const flag of arg.slice(1)) {
          if (flag === 'n') newline = false;
          else if (flag === 'e') interpret = true;
          else interpret = false;
        }
        continue;
      }
      break;
    }
    let body = args.slice(index).join(' ');
    if (interpret) {
      const escaped = escapeBytes(body);
      io.write(escaped.text);
      if (escaped.stop) return 0;
    } else {
      io.write(body);
    }
    if (newline) io.write('\n');
    return 0;
  });

  define(['printf'], (scope, args, io) => {
    let target = null;
    if (args[0] === '-v' && args.length > 2) { target = args[1]; args = args.slice(2); }
    if (!args.length) { io.error('printf: usage: printf format [arguments]\n'); return 2; }
    let format = args[0];
    let rest = 1;
    if (format === '--') { format = args[1] === undefined ? '' : args[1]; rest = 2; }
    const values = args.slice(rest);
    const output = printfFormat(format, values);
    if (target) scope.setVar(target, output);
    else io.write(output);
    return 0;
  });

  define(['pwd'], (scope, args, io) => {
    io.write(scope.cwd + '\n');
    return 0;
  });

  define(['cd'], (scope, args, io) => {
    let target = args.filter((arg) => !arg.startsWith('-') || arg === '-').pop();
    if (args.includes('-P') || args.includes('-L')) { /* physical mode is the same here */ }
    if (target === undefined) target = scope.getVar('HOME') || '/';
    if (target === '-') {
      const previous = scope.getVar('OLDPWD');
      if (!previous) { io.error('cd: OLDPWD not set\n'); return 1; }
      target = previous;
    }
    let next;
    try { next = scope.fs.vpath(target, scope.cwd); }
    catch (error) {
      io.error('cd: ' + target + ': ' + (error && error.message ? error.message : 'No such file or directory') + '\n');
      return 1;
    }
    const info = (() => { try { return scope.fs.stat(next, '/'); } catch { return null; } })();
    if (!info || !info.isDir) { io.error('cd: ' + target + ': Not a directory\n'); return 1; }
    scope.vars.set('OLDPWD', scope.cwd);
    scope.cwd = next;
    scope.vars.set('PWD', next);
    if (args.includes('-')) io.write(next + '\n');
    return 0;
  });

  define(['export'], (scope, args, io) => {
    let print = false;
    const names = [];
    for (const arg of args) {
      if (arg === '-p') { print = true; continue; }
      if (arg === '-n') { continue; }
      names.push(arg);
    }
    if (!names.length || print) {
      const keys = print ? [...scope.exported].sort() : names;
      for (const key of keys) {
        if (print) io.write('declare -x ' + key + '="' + text(scope.getVar(key)) + '"\n');
        else scope.exported.add(key);
      }
      return 0;
    }
    for (const entry of names) {
      const at = entry.indexOf('=');
      if (at === -1) { scope.exported.add(entry); continue; }
      const name = entry.slice(0, at);
      scope.setVar(name, entry.slice(at + 1));
      scope.exported.add(name);
    }
    return 0;
  });

  define(['readonly'], (scope, args, io) => {
    if (!args.length) { for (const key of scope.readonly) io.write('declare -r ' + key + '\n'); return 0; }
    for (const entry of args) {
      const at = entry.indexOf('=');
      if (at === -1) { scope.readonly.add(entry); continue; }
      const name = entry.slice(0, at);
      scope.setVar(name, entry.slice(at + 1));
      scope.readonly.add(name);
    }
    return 0;
  });

  define(['declare', 'typeset'], (scope, args, io) => {
    const mode = { print: false, export: false, readonly: false, integer: false, array: false, global: false };
    const names = [];
    for (const arg of args) {
      if (arg.startsWith('-') && arg.length > 1) {
        for (const flag of arg.slice(1)) {
          if (flag === 'p') mode.print = true;
          else if (flag === 'x') mode.export = true;
          else if (flag === 'r') mode.readonly = true;
          else if (flag === 'i') mode.integer = true;
          else if (flag === 'a' || flag === 'A') mode.array = true;
          else if (flag === 'g') mode.global = true;
          else if (flag === 'f') mode.print = true;
        }
        continue;
      }
      names.push(arg);
    }
    if (!names.length) {
      const keys = [...scope.vars.keys()].sort();
      for (const key of keys) {
        const prefix = 'declare -- ';
        io.write(prefix + key + '="' + text(scope.getVar(key)) + '"\n');
      }
      return 0;
    }
    for (const entry of names) {
      const at = entry.indexOf('=');
      const name = at === -1 ? entry : entry.slice(0, at);
      const value = at === -1 ? undefined : entry.slice(at + 1);
      if (mode.print) {
        io.write('declare -- ' + name + '="' + text(scope.getVar(name)) + '"\n');
        continue;
      }
      if (value !== undefined) {
        if (mode.integer) scope.setVar(name, String(Number(value) || 0));
        else scope.setVar(name, value);
      } else if (scope.getVar(name) === undefined) {
        scope.setVar(name, '');
      }
      if (mode.export) scope.exported.add(name);
      if (mode.readonly) scope.readonly.add(name);
    }
    return 0;
  });

  define(['unset'], (scope, args, io) => {
    let functions = false;
    for (const arg of args) {
      if (arg === '-f') { functions = true; continue; }
      if (arg === '-v' || arg === '--') continue;
      if (functions) scope.funcs.delete(arg);
      else scope.unsetVar(arg);
    }
    return 0;
  });

  define(['local'], (scope, args, io) => {
    if (!scope.frames.length) { io.error('local: can only be used in a function\n'); return 1; }
    for (const entry of args) {
      const at = entry.indexOf('=');
      if (at === -1) scope.defineLocal(entry, undefined);
      else scope.defineLocal(entry.slice(0, at), entry.slice(at + 1));
    }
    return 0;
  });

  define(['set'], (scope, args, io) => {
    if (!args.length) {
      const keys = [...scope.vars.keys()].sort();
      for (const key of keys) io.write(key + '=' + text(scope.getVar(key)) + '\n');
      return 0;
    }
    let index = 0;
    while (index < args.length) {
      const arg = args[index];
      if (arg === '--') { scope.setPositional(args.slice(index + 1)); return 0; }
      if (arg === '-o' || arg === '+o') {
        const name = args[index + 1];
        index += 2;
        if (!name) { io.write('errexit off\nnounset off\nxtrace off\npipefail off\n'); continue; }
        const on = arg === '-o';
        if (name === 'pipefail') scope.opts.pipefail = on;
        else if (name === 'errexit') scope.opts.errexit = on;
        else if (name === 'nounset') scope.opts.nounset = on;
        else if (name === 'xtrace') scope.opts.xtrace = on;
        else if (name === 'noglob') scope.opts.noglob = on;
        else if (name === 'allexport') scope.opts.allexport = on;
        else if (name === 'noexec') scope.opts.noexec = on;
        else { io.error('set: ' + name + ': invalid option name\n'); return 2; }
        continue;
      }
      if ((arg.startsWith('-') || arg.startsWith('+')) && arg.length > 1) {
        const on = arg[0] === '-';
        for (const flag of arg.slice(1)) {
          if (flag === 'e') scope.opts.errexit = on;
          else if (flag === 'u') scope.opts.nounset = on;
          else if (flag === 'x') scope.opts.xtrace = on;
          else if (flag === 'f') scope.opts.noglob = on;
          else if (flag === 'a') scope.opts.allexport = on;
          else if (flag === 'n') scope.opts.noexec = on;
          else if (flag === 'C') scope.opts.noclobber = on;
          else { io.error('set: -' + flag + ': invalid option\n'); return 2; }
        }
        index++;
        continue;
      }
      scope.setPositional(args.slice(index));
      return 0;
    }
    return 0;
  });

  define(['shift'], (scope, args, io) => {
    const count = args.length ? Number(args[0]) || 0 : 1;
    if (count > scope.positional.length) { io.error('shift: shift count out of range\n'); return 1; }
    scope.positional = scope.positional.slice(count);
    return 0;
  });

  define(['exit'], (scope, args) => {
    const code = args.length ? Number(args[0]) : scope.lastStatus;
    throw new ShellExit(Number.isFinite(code) ? code : 0);
  });

  define(['return'], (scope, args) => {
    const code = args.length ? Number(args[0]) : scope.lastStatus;
    throw new ShellReturn(Number.isFinite(code) ? code : 0);
  });

  define(['break'], (scope, args) => {
    const count = args.length ? Number(args[0]) : 1;
    throw new ShellBreak(Number.isFinite(count) ? count : 1);
  });

  define(['continue'], (scope, args) => {
    const count = args.length ? Number(args[0]) : 1;
    throw new ShellContinue(Number.isFinite(count) ? count : 1);
  });

  define(['eval'], async (scope, args, io) => {
    if (!args.length) return 0;
    const script = args.join(' ');
    return await shell.runScriptText(script, scope, io);
  });

  define(['.', 'source'], (scope, args, io) => {
    if (!args.length) { io.error('.: filename argument required\n'); return 2; }
    const file = args[0];
    let code;
    try { code = scope.fs.readText(file, scope.cwd); }
    catch { io.error('.: ' + file + ': No such file or directory\n'); return 1; }
    const previous = scope.positional;
    if (args.length > 1) scope.positional = args.slice(1);
    try {
      return shell.runScriptText(code, scope, io);
    } catch (error) {
      if (error instanceof ShellReturn) return error.code;
      throw error;
    } finally {
      scope.positional = previous;
    }
  });

  define(['test', '['], (scope, args, io) => {
    let tokens = args;
    if (builtins.has('[') && args.length && args[args.length - 1] === ']') {
      const prog = 'test';
      tokens = args.slice(0, -1);
    }
    try {
      if (!tokens.length) return 1;
      const result = evalTestExpression(tokens, { fs: scope.fs, scope });
      return result ? 0 : 1;
    } catch (error) {
      io.error('test: ' + (error && error.message ? error.message : 'error') + '\n');
      return 2;
    }
  });

  define(['[['], (scope, args, io) => {
    let tokens = args;
    if (tokens.length && tokens[tokens.length - 1] === ']]') tokens = tokens.slice(0, -1);
    try {
      if (!tokens.length) return 1;
      const result = evalTestExpression(tokens, { fs: scope.fs, scope }, { pattern: true });
      return result ? 0 : 1;
    } catch (error) {
      io.error('[[: ' + (error && error.message ? error.message : 'error') + '\n');
      return 2;
    }
  });

  define(['read'], (scope, args, io) => {
    const options = { raw: false, delim: '\n', count: 0, array: null, prompt: null };
    const names = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '-r') { options.raw = true; continue; }
      if (arg === '-p') { options.prompt = args[index + 1]; index++; continue; }
      if (arg === '-n' || arg === '-N') { options.count = Number(args[index + 1]) || 0; index++; continue; }
      if (arg === '-d') { options.delim = args[index + 1] === undefined ? '\n' : args[index + 1]; index++; continue; }
      if (arg === '-a') { options.array = args[index + 1]; index++; continue; }
      if (arg === '-t' || arg === '-u') { index++; continue; }
      if (arg === '-s') continue;
      if (arg === '--') continue;
      names.push(arg);
    }
    if (options.prompt) io.error(options.prompt);
    const source = io.input || { text: io.stdinText || '', pos: 0 };
    const text_ = source.text;
    if (source.pos >= text_.length) {
      if (options.array) scope.setVar(options.array, '');
      return 1;
    }
    let line = '';
    let consumed = 0;
    let sawDelimiter = false;
    while (source.pos < text_.length) {
      const ch = text_[source.pos];
      source.pos++;
      consumed++;
      if (options.count && line.length >= options.count) { break; }
      if (ch === options.delim) { sawDelimiter = true; break; }
      if (!options.raw && ch === '\\') {
        const next = text_[source.pos];
        if (next === undefined) { line += '\\'; break; }
        source.pos++;
        consumed++;
        if (next === '\n') continue;
        line += next;
        continue;
      }
      line += ch;
    }
    const ifs = scope.getVar('IFS') === undefined ? ' \t\n' : text(scope.getVar('IFS'));
    if (options.array) {
      const parts = splitReadLine(line, ifs);
      scope.setVar(options.array, '(' + parts.join(' ') + ')');
      scope.vars.set(options.array, parts.join(' '));
      if (names.length) scope.setVar(names[0], line);
      return sawDelimiter || line.length ? 0 : 1;
    }
    if (!names.length) {
      scope.setVar('REPLY', options.raw ? line : line);
    } else if (names.length === 1) {
      scope.setVar(names[0], line);
    } else {
      const parts = splitReadLine(line, ifs);
      for (let index = 0; index < names.length; index++) {
        if (index === names.length - 1) {
          const used = parts.slice(0, index).join(' ');
          const rest = index < parts.length ? line.slice(line.indexOf(parts[index])) : '';
          scope.setVar(names[index], rest);
        } else {
          scope.setVar(names[index], parts[index] === undefined ? '' : parts[index]);
        }
      }
    }
    return sawDelimiter || line.length ? 0 : 1;
  });

  define(['let'], (scope, args, io) => {
    let value = 0;
    for (const expression of args) {
      value = evalArith(expression, scope);
      if (!value) return 1;
    }
    return value ? 0 : 1;
  });

  define(['command'], async (scope, args, io, ctx) => {
    const words = args.slice();
    let verbose = false;
    let which = false;
    while (words.length && words[0].startsWith('-') && words[0] !== '-') {
      const flag = words.shift();
      if (flag === '-v') which = true;
      else if (flag === '-V') { which = true; verbose = true; }
      else if (flag === '-p') continue;
    }
    if (which) {
      for (const name of words) io.write(name + '\n');
      return words.length ? 0 : 1;
    }
    if (!words.length) return 0;
    const program = words[0];
    if (builtins.has(program)) {
      const result = await builtins.get(program)(scope, words.slice(1), io, ctx);
      return typeof result === 'number' ? result : 0;
    }
    const registry = shell.coreutils;
    if (registry && registry.has(program)) {
      const result = registry.get(program)(program, words.slice(1), shell.coreutilsContext(scope, io));
      if (result && result.out) io.write(result.out);
      if (result && result.err) io.error(result.err);
      return result && typeof result.code === 'number' ? result.code : 0;
    }
    const resolved = shell.resolve ? shell.resolve(program) : null;
    if (!resolved) { io.error(program + ': command not found\n'); return 127; }
    const result = shell.execSync(words, io.stdinText);
    io.write(result.stdout);
    io.error(result.stderr);
    return result.code;
  });

  define(['builtin'], async (scope, args, io, ctx) => {
    if (!args.length) return 0;
    const name = args[0];
    if (!builtins.has(name)) { io.error('builtin: ' + name + ': not a shell builtin\n'); return 1; }
    const result = await builtins.get(name)(scope, args.slice(1), io, ctx);
    return typeof result === 'number' ? result : 0;
  });

  define(['type'], (scope, args, io) => {
    let status = 0;
    const short = args.includes('-t');
    const names = args.filter((arg) => !arg.startsWith('-'));
    for (const name of names) {
      if (scope.funcs.has(name)) { io.write(short ? 'function\n' : name + ' is a function\n'); continue; }
      if (builtins.has(name)) { io.write(short ? 'builtin\n' : name + ' is a shell builtin\n'); continue; }
      const external = shell.resolve ? shell.resolve(name) : null;
      if (external) { io.write(short ? 'file\n' : name + ' is ' + (shell.fs.vpath ? name : name) + '\n'); continue; }
      io.error('type: ' + name + ': not found\n');
      status = 1;
    }
    return status;
  });

  define(['trap'], (scope, args, io) => {
    if (!scope.traps) scope.traps = new Map();
    if (!args.length) {
      for (const [signal, action] of scope.traps) io.write('trap -- ' + shellQuote(action) + ' ' + signal + '\n');
      return 0;
    }
    if (args[0] === '-p' || args[0] === '-l') return 0;
    const action = args[0];
    const signals = args.slice(1);
    if (!signals.length) return 0;
    for (const signal of signals) {
      if (action === '-') scope.traps.delete(signal);
      else scope.traps.set(signal.replace(/^SIG/, '').toUpperCase(), action);
    }
    return 0;
  });

  define(['umask'], (scope, args, io) => {
    if (!args.length) { io.write('0022\n'); return 0; }
    return 0;
  });

  define(['wait'], () => 0);
  define(['jobs'], (scope, args, io) => 0);
  define(['fg', 'bg', 'disown'], (scope, args, io) => { io.error('fg: no job control\n'); return 1; });
  define(['hash', 'history', 'times', 'help', 'logout', 'suspend'], () => 0);
  define(['alias', 'unalias'], () => 0);
  define(['getopts'], (scope, args, io) => {
    if (args.length < 2) { io.error('getopts: usage: getopts optstring name [arg ...]\n'); return 2; }
    const optstring = args[0];
    const name = args[1];
    const supplied = args.slice(2);
    const argv = supplied.length ? supplied : (scope.positional || []);
    const silent = optstring.startsWith(':');
    const spec = silent ? optstring.slice(1) : optstring;
    let state = scope.getoptsState;
    if (!state || state.argv !== argv) { state = { argv, index: 0, char: 0 }; scope.getoptsState = state; }
    const finish = (value) => { scope.setVar(name, value); scope.setVar('OPTIND', String(state.index + 1)); return 0; };
    for (;;) {
      if (state.index >= argv.length) { scope.setVar(name, '?'); scope.setVar('OPTIND', String(argv.length + 1)); return 1; }
      const current = argv[state.index];
      if (state.char === 0) {
        if (current === '--') { state.index = argv.length; scope.setVar(name, '?'); scope.setVar('OPTIND', String(argv.length + 1)); return 1; }
        if (current.length < 2 || current[0] !== '-') { state.index = argv.length; scope.setVar(name, '?'); scope.setVar('OPTIND', String(argv.length + 1)); return 1; }
      }
      const letter = current[1 + state.char];
      if (letter === undefined) { state.index += 1; state.char = 0; continue; }
      const position = spec.indexOf(letter);
      if (position === -1 || letter === ':') {
        const bad = silent ? letter : '?';
        if (silent) scope.setVar('OPTARG', letter);
        else io.error('getopts: illegal option -- ' + letter + '\n');
        state.char += 1;
        if (current[1 + state.char] === undefined) { state.index += 1; state.char = 0; }
        return finish(bad);
      }
      const needsArgument = spec[position + 1] === ':';
      if (needsArgument) {
        let value = current.slice(2 + state.char);
        state.index += 1;
        state.char = 0;
        if (value === '') {
          if (state.index >= argv.length) {
            if (silent) { scope.setVar('OPTARG', letter); return finish(':'); }
            io.error('getopts: option requires an argument -- ' + letter + '\n');
            return finish('?');
          }
          value = argv[state.index];
          state.index += 1;
        }
        scope.setVar('OPTARG', value);
        return finish(letter);
      }
      state.char += 1;
      if (current[1 + state.char] === undefined) { state.index += 1; state.char = 0; }
      return finish(letter);
    }
  });
  define(['compgen'], () => 1);
  define(['complete'], () => 0);

  define(['shopt'], (scope, args, io) => {
    const options = ['dotglob', 'expand_aliases', 'extglob', 'failglob', 'globstar', 'nullglob', 'nocaseglob'];
    let set = null;
    const names = [];
    for (const arg of args) {
      if (arg === '-s') set = true;
      else if (arg === '-u') set = false;
      else if (arg === '-q') set = null;
      else if (arg.startsWith('-')) continue;
      else names.push(arg);
    }
    if (!names.length) {
      for (const name of options) io.write(name + '\t' + (scope.opts[name.replace(/_([a-z])/g, (m, c) => c.toUpperCase())] ? 'on' : 'off') + '\n');
      return 0;
    }
    for (const name of names) {
      const key = name.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
      if (set !== null) { scope.opts[key] = set; continue; }
      if (!scope.opts[key]) return 1;
    }
    return 0;
  });

  define(['mapfile', 'readarray'], (scope, args, io) => {
    let name = 'MAPFILE';
    let count = null;
    let skip = 0;
    let origin = 0;
    let delim = '\n';
    let trim = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '-t') { trim = true; continue; }
      if (arg === '-n' || arg === '-s' || arg === '-O' || arg === '-d' || arg === '-u') {
        const value = args[++index];
        if (value === undefined) { io.error('mapfile: option requires an argument -- ' + arg.slice(1) + '\n'); return 2; }
        if (arg === '-n') count = Number(value);
        else if (arg === '-s') skip = Number(value);
        else if (arg === '-O') origin = Number(value);
        else if (arg === '-d') delim = value === '' ? '\0' : value[0];
        continue;
      }
      if (arg.startsWith('-n') && arg.length > 2) { count = Number(arg.slice(2)); continue; }
      if (arg.startsWith('-s') && arg.length > 2) { skip = Number(arg.slice(2)); continue; }
      if (arg.startsWith('-O') && arg.length > 2) { origin = Number(arg.slice(2)); continue; }
      if (arg.startsWith('-d') && arg.length > 2) { delim = arg.slice(2)[0]; continue; }
      if (arg.startsWith('-')) continue;
      name = arg;
    }
    const source = io.input || { text: io.stdinText || '', pos: 0 };
    const rest = source.text.slice(source.pos);
    source.pos = source.text.length;
    let lines = rest === '' ? [] : rest.split(delim);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!trim) lines = lines.map((line) => line + delim);
    const selected = lines.slice(skip, count === null ? undefined : skip + count);
    const existing = scope.getVar(name);
    const target = Array.isArray(existing) ? existing.slice() : [];
    selected.forEach((line, offset) => { target[origin + offset] = line; });
    scope.setVar(name, target);
    return 0;
  });

  define(['dirs'], (scope, args, io) => {
    const stack = scope.dirstack || [];
    io.write([scope.cwd].concat(stack.slice().reverse()).join(' ') + '\n');
    return 0;
  });
  define(['pushd'], (scope, args, io) => {
    if (!args.length) return 0;
    scope.dirstack = scope.dirstack || [];
    scope.dirstack.push(scope.cwd);
    try { scope.cwd = scope.fs.vpath(args[0], scope.cwd); } catch { io.error('pushd: ' + args[0] + ': No such file or directory\n'); return 1; }
    return 0;
  });
  define(['popd'], (scope, args, io) => {
    const stack = scope.dirstack || [];
    if (!stack.length) { io.error('popd: directory stack empty\n'); return 1; }
    scope.cwd = stack.pop();
    return 0;
  });

  define(['getconf'], () => 0);
  define(['exec'], async (scope, args, io) => {
    if (!args.length) return 0;
    const result = shell.execSync(args, io.stdinText);
    io.write(result.stdout);
    io.error(result.stderr);
    throw new ShellExit(result.code);
  });

  return builtins;
}
