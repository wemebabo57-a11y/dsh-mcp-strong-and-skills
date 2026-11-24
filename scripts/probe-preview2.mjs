// One-off real-browser probe for 0.4.4-preview.2 fixes (not part of CI).
const { runBrowseTool, findBrowser } = await import('../src/browse.mjs')
const http = await import('node:http')
const browser = findBrowser()
console.log('browser:', browser || 'NONE')
if (!browser) process.exit(2)
const page = '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>'
  + '<input class="dup" id="hidden-input" style="display:none" aria-label="hidden dup">'
  + '<input class="dup" id="visible-input" aria-label="visible dup" value="">'
  + '<button class="btn" id="btn-a" aria-label="Alpha">Alpha</button>'
  + '<button class="btn" id="btn-b" aria-label="Beta">Beta</button>'
  + '<div class="menu-item" role="menuitem" aria-label="MenuAction">MenuAction</div>'
  + '</body></html>'
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = 'http://127.0.0.1:' + server.address().port + '/'
const ctx = { root: process.cwd(), config: { webAllowPrivate: true } }
const results = {}
try {
  const opened = await runBrowseTool({ action: 'open', url, maxChars: 800 }, ctx)
  results.open = { title: opened.title }
  const clicked = await runBrowseTool({ action: 'click', selector: '.dup' }, ctx)
  results.clickVisibleDup = { label: clicked.clicked?.label, returnsBody: typeof clicked.text === 'string' }
  await runBrowseTool({ action: 'type', text: 'hello' }, ctx)
  const snap1 = await runBrowseTool({ action: 'snapshot', maxChars: 800 }, ctx)
  results.typeFocus = { focusedValue: snap1.elements.find((e) => e.id === 'visible-input')?.text }
  await runBrowseTool({ action: 'press', key: 'Ctrl+A' }, ctx)
  await runBrowseTool({ action: 'type', text: 'world' }, ctx)
  const snap2 = await runBrowseTool({ action: 'snapshot', maxChars: 800 }, ctx)
  results.pressCtrlAReplace = { valueAfter: snap2.elements.find((e) => e.id === 'visible-input')?.text }
  const clickB = await runBrowseTool({ action: 'click', selector: '.btn', index: 2 }, ctx)
  results.indexSecondButton = { label: clickB.clicked?.label }
  const menu = await runBrowseTool({ action: 'click', text: 'MenuAction' }, ctx)
  results.textDivMenu = { tag: menu.clicked?.tag, label: menu.clicked?.label }
  const mouse = await runBrowseTool({ action: 'mouse', x: 10, y: 10 }, ctx)
  results.mouse = { hasBodyText: typeof mouse.text === 'string', hasNote: typeof mouse.note === 'string', clickedTag: mouse.clicked?.tag }
  await runBrowseTool({ action: 'close' }, ctx)
  try { await runBrowseTool({ action: 'snapshot' }, ctx); results.afterClose = 'NO-ERROR-BAD' }
  catch (error) { results.afterClose = { code: error.code } }
} finally {
  await runBrowseTool({ action: 'close' }, ctx).catch(() => {})
  server.close()
}
console.log(JSON.stringify(results, null, 1))
process.exit(0)
