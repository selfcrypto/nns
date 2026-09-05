// Headless Chromium screenshots of the app at phone size, driven over the
// DevTools protocol — no Playwright, no extension, nothing installed beyond
// the system browser. Every screen and state the visual pass reviewed, one
// PNG each, so a styling change can be looked at rather than reasoned about.
//
//   VITE_NNS_RESOLVERS='[{"name":"NNS public","url":"https://nns.sonartech.pro"}]' pnpm dev
//   node scripts/screens.mjs out/            # every scenario
//   node scripts/screens.mjs out/ buy-nns    # one
//
// `NNS_APP_URL` (default http://localhost:5173/), `NNS_SHOT_OWNER` (the Hub
// address the owner-* scenarios seed into localStorage; defaults to the
// mainnet owner of `nns`), `CHROMIUM` (default /usr/bin/chromium).
//
// A desktop Chromium is evidence the build shipped and nothing more
// (CLAUDE.md, "Never reason about Pay's WebView from a desktop") — these are
// for the look of a screen, never for where the tab bar sits.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const URL = process.env['NNS_APP_URL'] ?? 'http://localhost:5173/'
const [outDir, ...only] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })

const PORT = 9333
const chrome = spawn(process.env['CHROMIUM'] ?? '/usr/bin/chromium', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => chrome.kill())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let targets = null
for (let i = 0; i < 50 && targets === null; i++) {
  try {
    targets = await (await fetch(`http://localhost:${PORT}/json`)).json()
  } catch {
    await sleep(200)
  }
}
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
const events = []
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id !== undefined) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  } else events.push(msg)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception))
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Emulation.setTouchEmulationEnabled', { enabled: true })

const helpers = `
  window.__type = (selector, text) => {
    const el = document.querySelector(selector)
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  window.__clickText = (selector, text) => {
    const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.trim() === text)
    if (!el) throw new Error('no element ' + selector + ' with text ' + text)
    el.click(); return true
  }
  window.__click = (selector) => { document.querySelector(selector).click(); return true }
  true
`

const load = async () => {
  await send('Page.navigate', { url: URL })
  await sleep(1500)
  await evaluate(helpers)
}
const shot = async (name, full = false) => {
  const params = { format: 'png' }
  if (full) {
    const h = await evaluate('document.documentElement.scrollHeight')
    params.clip = { x: 0, y: 0, width: 390, height: h, scale: 1 }
    params.captureBeyondViewport = true
  }
  const { data } = await send('Page.captureScreenshot', params)
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'))
  console.log('wrote', name)
}
const search = async (text) => {
  await evaluate(`__type('.search-input', ${JSON.stringify(text)})`)
  try { await evaluate(`__click('.search-go')`) } catch {}
  await sleep(4000)
}
const tab = async (label) => {
  await evaluate(`__clickText('.tab', ${JSON.stringify(label)})`)
  await sleep(2500)
}

const OWNER = process.env['NNS_SHOT_OWNER'] ?? 'NQ42 5QRF L5AV J6K3 BQHQ FAE8 XXHR TS8Y 9YRA'
const loadAsOwner = async () => {
  await send('Page.navigate', { url: URL })
  await sleep(300)
  await evaluate(`localStorage.setItem('nns.hub.addresses', ${JSON.stringify(JSON.stringify([OWNER]))}); true`)
  await send('Page.navigate', { url: URL })
  await sleep(2000)
  await evaluate(helpers)
}
const scenarios = {
  'owner-names': async () => { await loadAsOwner(); await tab('My Names'); await sleep(2500); await shot('owner-names') },
  'owner-detail': async () => {
    await loadAsOwner(); await tab('My Names'); await sleep(2500)
    await evaluate(`__click('.name-row')`); await sleep(4000); await shot('owner-detail', true)
  },
  'owner-sheet': async () => {
    await loadAsOwner(); await tab('My Names'); await sleep(2500)
    await evaluate(`__click('.name-row')`); await sleep(4000)
    await evaluate(`[...document.querySelectorAll('.action-row')].find(r => r.textContent.includes('Change where it points')).querySelector('.action-go').click()`)
    await sleep(800)
    await evaluate(`__type('.sheet-input', 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000')`)
    await sleep(800); await shot('owner-sheet', true)
  },
  'owner-panel': async () => {
    await loadAsOwner(); await sleep(1500)
    await evaluate(`__click('.identity-who')`); await sleep(500); await shot('owner-panel')
  },
  'hint-open': async () => {
    await load(); await search('nns')
    await evaluate(`__click('.verify-head .hint-btn')`); await sleep(400); await shot('hint-open')
  },
  'hint-delegated': async () => {
    await load(); await search('rico.nns')
    await evaluate(`__click('.verify-delegated .hint-btn')`); await sleep(400); await shot('hint-delegated')
  },
  'owner-buy-own': async () => { await loadAsOwner(); await search('nns'); await shot('owner-buy-own', true) },
  'owner-pay': async () => { await loadAsOwner(); await tab('Pay'); await search('nns'); await evaluate(`__type('.pay-input', '12,5')`); await sleep(300); await shot('owner-pay', true) },
  'buy-idle': async () => { await load(); await shot('buy-idle') },
  'buy-nns': async () => { await load(); await search('nns'); await shot('buy-nns', true) },
  'buy-open-bid': async () => {
    await load(); await search('nns')
    try { await evaluate(`__clickText('.action-go', 'Open')`) } catch {}
    await sleep(800); await shot('buy-open-bid', true)
  },
  'buy-available': async () => { await load(); await search('zebra-quick-fox'); await shot('buy-available', true) },
  'buy-reserved': async () => { await load(); await search('ab'); await shot('buy-reserved', true) },
  'buy-delegated': async () => { await load(); await search('rico.nns'); await shot('buy-delegated', true) },
  'buy-message': async () => {
    await load(); await search('nns')
    await evaluate(`__click('.message-owner summary')`)
    await evaluate(`__type('.composer-input', 'Hi — is this name for sale?')`)
    await sleep(500); await shot('buy-message', true)
  },
  'buy-invalid': async () => { await load(); await search('not a name!'); await shot('buy-invalid') },
  'pay': async () => { await load(); await tab('Pay'); await shot('pay-idle'); await search('nns'); await shot('pay-nns', true) },
  'names': async () => { await load(); await tab('My Names'); await shot('names') },
  'inbox': async () => { await load(); await tab('Inbox'); await shot('inbox') },
  'market': async () => { await load(); await tab('Market'); await shot('market', true) },
}
for (const [name, run] of Object.entries(scenarios)) {
  if (only.length > 0 && !only.includes(name)) continue
  try {
    await run()
  } catch (error) {
    console.log('scenario', name, 'failed:', error.message)
  }
}
ws.close()
chrome.kill()
process.exit(0)
