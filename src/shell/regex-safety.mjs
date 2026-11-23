// Rejects catastrophic-backtracking shapes before V8 sees them. The previous
// pattern skipped non-capturing groups, so (?:a*)* and grep's a** translation
// bypassed the guard entirely.
export const MAX_REGEX_LENGTH = 100000;

function quantifierAt(source, i) {
  const ch = source[i];
  if (ch === '*' || ch === '+' || ch === '?') return { end: i + 1, lazy: false };
  if (ch !== '{') return null;
  let j = i + 1;
  while (j < source.length && /[0-9]/.test(source[j])) j++;
  if (j === i + 1) return null;
  if (source[j] === ',') {
    j++;
    while (j < source.length && /[0-9]/.test(source[j])) j++;
  }
  if (source[j] !== '}') return null;
  return { end: j + 1, lazy: false };
}

export function isRiskyRegex(source) {
  const text = String(source || '');
  if (text.length > MAX_REGEX_LENGTH) return true;
  const stack = [];
  let inClass = false;
  let classStart = 0;
  let lastQuantifier = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; lastQuantifier = false; continue; }
    if (inClass) {
      if (ch === ']' && i > classStart + 1) inClass = false;
      continue;
    }
    if (ch === '[') { inClass = true; classStart = i; lastQuantifier = false; continue; }
    if (ch === '(') {
      let j = i + 1;
      // Skip group modifiers: ?: ?= ?! ?<name> ?<= ?<!
      if (text[j] === '?') {
        if (text[j + 1] === '<' && (text[j + 2] === '=' || text[j + 2] === '!')) j += 3;
        else if (text[j + 1] === '<') { const close = text.indexOf('>', j + 2); j = close === -1 ? text.length : close + 1; }
        else j += 2;
      }
      stack.push({ quantified: false });
      i = j - 1;
      lastQuantifier = false;
      continue;
    }
    if (ch === '|') { lastQuantifier = false; continue; }
    if (ch === ')') {
      const group = stack.pop();
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = quantifierAt(text, j);
      // A quantified group whose body already contains a quantifier is the
      // (a+)+ / (?:a*)* shape. A plain (ab)+ is linear and stays allowed.
      if (group && group.quantified && next) return true;
      lastQuantifier = false;
      continue;
    }
    const quant = quantifierAt(text, i);
    if (quant) {
      if (lastQuantifier && ch !== '?') return true;
      // Lazy modifiers (+?, *?, ??) are not another repetition.
      if (lastQuantifier && ch === '?') { lastQuantifier = false; i = quant.end - 1; continue; }
      for (const group of stack) group.quantified = true;
      lastQuantifier = true;
      i = quant.end - 1;
      continue;
    }
    lastQuantifier = false;
  }
  return false;
}

export function assertSafeRegex(source) {
  if (isRiskyRegex(source)) {
    throw new Error('potentially catastrophic regex rejected');
  }
}
