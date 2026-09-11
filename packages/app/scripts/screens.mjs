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

// A browser opens on the landing page; every scenario but `home` starts from
// Buy, which is a route (`#/buy`, lib/route.ts) since 2026-09-09 — before
// that, `load` had to go through the hero's search.
const landing = async () => {
  await send('Page.navigate', { url: URL })
  await sleep(1500)
  await evaluate(helpers)
}
const load = async () => {
  // Scenarios share one profile, so an owner-* run's seeded identity would
  // make the next anonymous one the owner of `nns`.
  await send('Page.navigate', { url: URL })
  await sleep(300)
  await evaluate(`localStorage.removeItem('nns.hub.addresses'); true`)
  await send('Page.navigate', { url: `${URL}#/buy` })
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
  await send('Page.navigate', { url: `${URL}#/buy` })
  await sleep(2000)
  await evaluate(helpers)
}
const scenarios = {
  'home': async () => { await landing(); await sleep(1500); await shot('home', true) },
  'owner-names': async () => { await loadAsOwner(); await tab('My Names'); await sleep(2500); await shot('owner-names') },
  'owner-detail': async () => {
    await loadAsOwner(); await tab('My Names'); await sleep(2500)
    await evaluate(`__click('.name-row')`); await sleep(4000); await shot('owner-detail', true)
  },
  'owner-sheet': async () => {
    await loadAsOwner(); await tab('My Names'); await sleep(2500)
    await evaluate(`__click('.name-row')`); await sleep(4000)
    await evaluate(`[...document.querySelectorAll('.owner-action-tile')].find(t => t.textContent.includes('Target Address')).click()`)
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
  // The agreeing resolvers are a state now: closed on arrival, open on a tap.
  'verify-open': async () => {
    await load(); await search('nns')
    await evaluate(`__click('.verify-toggle')`); await sleep(400); await shot('verify-open', true)
  },
  'hint-delegated': async () => {
    await load(); await search('rico.nns')
    await evaluate(`__click('.verify-delegated .hint-btn')`); await sleep(400); await shot('hint-delegated')
  },
  'owner-buy-own': async () => { await loadAsOwner(); await search('nns'); await shot('owner-buy-own', true) },
  'owner-pay': async () => { await loadAsOwner(); await tab('Pay'); await search('nns'); await evaluate(`__type('.pay-input', '12,5')`); await sleep(300); await shot('owner-pay', true) },
  'buy-idle': async () => { await load(); await shot('buy-idle') },
  'buy-nns': async () => { await load(); await search('nns'); await shot('buy-nns', true) },
  'buy-register': async () => {
    await load(); await search('zebra-quick-fox')
    try { await evaluate(`__clickText('.action-go', 'Register')`) } catch {}
    await sleep(800); await shot('buy-register', true)
  },
  // The term choice (tasks/19 D3): the Lifetime segment, and the review under it as a date.
  'buy-register-lifetime': async () => {
    await load(); await search('zebra-quick-fox')
    try { await evaluate(`__clickText('.action-go', 'Register')`) } catch {}
    await sleep(800)
    await evaluate(`__clickText('.term-option', 'Lifetime')`)
    await sleep(800); await shot('buy-register-lifetime', true)
  },
  'owner-renew-lifetime': async () => {
    await loadAsOwner(); await tab('My Names'); await sleep(2500)
    await evaluate(`__click('.name-row')`); await sleep(4000)
    await evaluate(`[...document.querySelectorAll('.owner-action-tile')].find(t => t.textContent.includes('Renew Registration')).click()`)
    await sleep(800)
    await evaluate(`__clickText('.term-option', 'Lifetime')`)
    await sleep(800); await shot('owner-renew-lifetime', true)
  },
  'buy-available': async () => { await load(); await search('zebra-quick-fox'); await shot('buy-available', true) },
  'buy-reserved': async () => { await load(); await search('ab'); await shot('buy-reserved', true) },
  'buy-delegated': async () => { await load(); await search('rico.nns'); await shot('buy-delegated', true) },
  'buy-message': async () => {
    await load(); await search('nns')
    await evaluate(`__click('.message-owner-btn')`)
    await sleep(300)
    await evaluate(`__type('.composer-input', 'Hi — is this name for sale?')`)
    await sleep(500); await shot('buy-message', true)
  },
  'buy-invalid': async () => { await load(); await search('not a name!'); await shot('buy-invalid') },
  'pay': async () => { await load(); await tab('Pay'); await shot('pay-idle'); await search('nns'); await shot('pay-nns', true) },
  'pay-available': async () => { await load(); await tab('Pay'); await search('zebra-quick-fox'); await shot('pay-available', true) },
  'owner-pay-available': async () => { await loadAsOwner(); await tab('Pay'); await search('zebra-quick-fox'); await shot('owner-pay-available', true) },
  // The payment link (`lib/payRequest.ts`): the amount prefilled, the
  // reference locked with its Edit. Navigated to directly, because the point
  // is what a link does on arrival.
  'pay-link': async () => {
    await send('Page.navigate', { url: URL })
    await sleep(300)
    await evaluate(`localStorage.removeItem('nns.hub.addresses'); true`)
    await send('Page.navigate', { url: `${URL}#/pay/paylink-demo?amount=12.5&message=INV-42` })
    await sleep(4000); await evaluate(helpers); await shot('pay-link', true)
  },
  'owner-request': async () => {
    await loadAsOwner(); await tab('My Names'); await sleep(2500)
    await evaluate(`__click('.name-row')`); await sleep(4000)
    await evaluate(`[...document.querySelectorAll('.owner-action-tile')].find(t => t.textContent.includes('Request Payment')).click()`)
    await sleep(500)
    await evaluate(`__type('.modal-input', '12.5')`)
    await evaluate(`const i = document.querySelectorAll('.modal-input')[1]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'INV-42'); i.dispatchEvent(new Event('input',{bubbles:true})); true`)
    await sleep(500); await shot('owner-request', true)
  },
  // The same link asking for USDT: the asset row (an `E` record is what shows
  // it), no message field, and Pay opening in USDT mode on the other address.
  'pay-link-usdt': async () => {
    await send('Page.navigate', { url: URL })
    await sleep(300)
    await evaluate(`localStorage.removeItem('nns.hub.addresses'); true`)
    await send('Page.navigate', { url: `${URL}#/pay/paylink-demo?amount=25&asset=usdt` })
    await sleep(4000); await evaluate(helpers); await shot('pay-link-usdt', true)
  },
  'names': async () => { await load(); await tab('My Names'); await shot('names') },
  'inbox': async () => { await load(); await tab('Inbox'); await shot('inbox') },
  'market': async () => { await load(); await tab('Market'); await shot('market', true) },
  'market-sheet': async () => {
    await loadAsOwner(); await tab('Market')
    // Whichever listing exists today: an offer's Buy Now, else an auction's Place Bid.
    await evaluate(`[...document.querySelectorAll('button')].find(b => /^(Buy Now|Place Bid)$/.test(b.textContent.trim()))?.click(); true`)
    await sleep(4000); await shot('market-sheet', true)
  },
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
