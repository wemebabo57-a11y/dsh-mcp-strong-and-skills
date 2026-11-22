// Rejects the common catastrophic-backtracking shape before V8 sees it.
// `(a+)+b` takes minutes on a short line; bash/grep run it in linear time.
const NESTED_QUANTIFIER = /\((?!\?:)(?:[^()\\]|\\.)*[*+](?:[^()\\]|\\.)*\)\s*(?:[*+?]|\{\d+(?:,\d*)?\})/;

export function isRiskyRegex(source) {
  return NESTED_QUANTIFIER.test(String(source || ''));
}

export function assertSafeRegex(source) {
  if (isRiskyRegex(source)) {
    throw new Error('potentially catastrophic nested quantifier');
  }
}
