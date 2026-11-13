// Shared helpers for coreutils. Synchronous, no I/O policy of its own.
import { ShellError, ERRNO_TEXT } from './fs.mjs';

export function formatError(prog, vpath, code, note) {
  const text = note ?? ERRNO_TEXT[code] ?? code;
  return prog + ': ' + vpath + ': ' + text + '\n';
}

export function usageError(prog, message) {
  return { code: 2, out: '', err: prog + ': ' + message + '\n' };
}

/** Parse short/long options. defs maps both short chars and long names to 'bool'|'value'. */
export function parseOptions(argv, defs) {
  const opts = new Map();
  const args = [];
  let stop = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (stop || token === '-' || !token.startsWith('-')) { args.push(token); continue; }
    if (token === '--') { stop = true; continue; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      const kind = defs[name];
      if (!kind) return { error: "unrecognized option '--" + name + "'" };
      if (kind === 'bool') { opts.set(name, true); continue; }
      if (eq >= 0) { opts.set(name, token.slice(eq + 1)); continue; }
      const value = argv[i + 1];
      if (value === undefined) return { error: "option '--" + name + "' requires an argument" };
      opts.set(name, value); i++; continue;
    }
    for (let j = 1; j < token.length; j++) {
      const ch = token[j];
      const kind = defs[ch];
      if (!kind) return { error: "invalid option -- '" + ch + "'" };
      if (kind === 'bool') { opts.set(ch, true); continue; }
      const rest = token.slice(j + 1);
      if (rest) { opts.set(ch, rest); break; }
      const value = argv[i + 1];
      if (value === undefined || value === '') return { error: "option requires an argument -- '" + ch + "'" };
      opts.set(ch, value); i++; break;
    }
  }
  return { opts, args, error: null };
}

/** Split text into lines without the trailing empty line. CRLF tolerated. */
export function splitLines(text) {
  if (!text) return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export function joinLines(lines) {
  if (!lines.length) return '';
  return lines.join('\n') + '\n';
}

/**
 * Resolve file arguments into text inputs.
 * options.missing: 'error' (default) | 'skip' | 'empty'
 * returns { files:[{path,text,binary}], error:string|null, code:number }
 */
export function readInputs(ctx, prog, paths, options = {}) {
  const files = [];
  if (!paths.length) return { files: [{ path: '-', text: ctx.stdin ?? '', binary: false }], error: null, code: 0 };
  for (const candidate of paths) {
    if (candidate === '-') {
      const text = ctx.stdin ?? '';
      files.push({ path: '-', text, binary: text.includes('\u0000') });
      continue;
    }
    try {
      const buffer = ctx.fs.readBuffer(candidate, ctx.cwd, { maxBytes: options.maxBytes });
      files.push({ path: candidate, text: buffer.toString('utf8'), binary: buffer.includes(0) });
    } catch (error) {
      if (!(error instanceof ShellError)) throw error;
      if (options.missing === 'skip') continue;
      if (options.missing === 'empty') { files.push({ path: candidate, text: '', binary: false }); continue; }
      return { files: [], error: formatError(prog, candidate, error.code), code: 2 };
    }
  }
  return { files, error: null, code: 0 };
}

/** Parse an integer option value, returning null when invalid. */
export function toInt(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return null;
  const number = Number.parseInt(text, 10);
  return Number.isFinite(number) ? number : null;
}

/** Read all inputs and concatenate (cat-like). */
export function concatInputs(ctx, prog, paths, options = {}) {
  const input = readInputs(ctx, prog, paths, options);
  if (input.error) return { text: null, error: input.error, code: input.code };
  return { text: input.files.map(file => file.text).join(''), error: null, code: 0 };
}

export function writeOut(text) {
  return { code: 0, out: text, err: '' };
}

export function fail(prog, message, code = 1) {
  return { code, out: '', err: prog + ': ' + message + '\n' };
}

/** Iterate with a deadline check every N items. */
export function loop(ctx, items, every, body) {
  let index = 0;
  for (const item of items) {
    if (index++ % every === 0) ctx.check?.();
    body(item, index - 1);
  }
}

/** Split a range spec like '1,3-5' into [start,end] pairs (1-based, end=Infinity allowed). */
export function parseRanges(spec) {
  const ranges = [];
  for (const piece of String(spec).split(',')) {
    const text = piece.trim();
    if (!text) continue;
    const match = /^(\d*)(?:-(\d*))?$/.exec(text);
    if (!match) return null;
    const rawStart = match[1];
    const rawEnd = match[2];
    const start = rawStart ? Number(rawStart) : 1;
    if (rawEnd === undefined) ranges.push([start, start]);
    else ranges.push([start, rawEnd === '' ? Infinity : Number(rawEnd)]);
  }
  return ranges.length ? ranges : null;
}

export function inRanges(ranges, number) {
  for (const range of ranges) if (number >= range[0] && number <= range[1]) return true;
  return false;
}
