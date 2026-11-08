// Only useful where the host executes call bodies (run_code); auto-detected there.
export const PTC_GUIDE = 'PTC 模式（run_code 里调用工具）：这里的工具就是代码函数，用 await tools.名字({...}) 调用；互不依赖的查询用 Promise.all 并行。只返回筛选后的字段或短摘要，不要打印整个 JSON 或整份文件；失败先读错误再改一处；浏览器用完调用 close，截图只在确实需要看页面时用。';

/** auto: only when the host exposes run_code; on/off override detection. */
export function buildPtcPolicy(config = {}, { available = false } = {}) {
  const mode = config.ptcMode ?? 'auto';
  if (mode !== 'auto' && mode !== 'on' && mode !== 'off') throw new Error('Invalid ptcMode');
  if (mode === 'off') return '';
  return mode === 'on' || available === true ? PTC_GUIDE : '';
}
