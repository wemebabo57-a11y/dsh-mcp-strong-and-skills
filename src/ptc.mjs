// Only useful where the host executes call bodies (run_code); auto-detected there.
export const PTC_GUIDE = 'PTC 模式（run_code 内）：用 await tools.名字({...}) 调用，独立查询 Promise.all 并行。只取需用字段，不打印整个 JSON/文件；失败先读错误再改一处；浏览器用完 close。';

/** auto: only when the host exposes run_code; on/off override detection. */
export function buildPtcPolicy(config = {}, { available = false } = {}) {
  const mode = config.ptcMode ?? 'auto';
  if (mode !== 'auto' && mode !== 'on' && mode !== 'off') throw new Error('Invalid ptcMode');
  if (mode === 'off') return '';
  return mode === 'on' || available === true ? PTC_GUIDE : '';
}
