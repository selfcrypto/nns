// Phase 13 of the battery: drive @nns/resolver against the run's own APIs and
// the Sepolia anchor this run deployed. Tooling only — it touches no constant,
// so it is cherry-pickable to main.
//
//   node scripts/resolve-check.mjs [name]
const { createResolver } = await import('../packages/resolver/dist/index.js')

const API1 = process.env.NNS_RESOLVE_API_1 ?? 'http://127.0.0.1:8635'
const API2 = process.env.NNS_RESOLVE_API_2 ?? 'http://127.0.0.1:8636'
const NAME = process.argv[2] ?? 'tempolongliveda'
const ANCHORS = {
  contract: '0x8bfd0d7f8fe94570858a8ae2e075a56e2a3bbd67',
  rpcs: ['https://gateway.tenderly.co/public/sepolia', 'https://ethereum-sepolia-rpc.publicnode.com'],
  publishers: ['0x2efD3F0E5608BB9E2E7027a1f73485B82E8093c6', '0xFf75c3F13A3031F4bB297DAa3CA4eBe8d71d44ff'],
  // Public Sepolia endpoints cap eth_getLogs ranges — PublicNode at 50,000 —
  // and the reader's default lookback is 250,000, so an unset value here makes
  // every check `unavailable` on an endpoint that is working perfectly.
  lookbackBlocks: 40_000n,
}

const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`)
const summarise = (r) => {
  line('address', r.address ?? '(none)')
  line('verification', r.verification)
  line('quorum', JSON.stringify(r.quorum))
  line('warnings', r.warnings.length ? r.warnings.map((w) => w.code ?? w).join(', ') : '(none)')
  if (r.anchor) line('anchor', `${r.anchor.status}${r.anchor.reason ? ' / ' + r.anchor.reason : ''}`)
}

console.log('13.1–13.4  quorum 1, one operator, anchors configured')
const single = createResolver({ resolvers: [{ name: 'Battery Operator', url: API1 }], quorum: 1, anchors: ANCHORS })
summarise(await single.resolve(NAME))

console.log('\n13.5  available() on three kinds of name')
for (const n of ['temponeverregistered', 'nnstempospare', 'nnstempoawarded']) {
  const a = await single.available(n)
  line(n, JSON.stringify(a))
}

console.log('\n13.6  a dotted query (§8.6 delegate flow)')
try { summarise(await single.resolve(`sub.${NAME}`)) } catch (e) { line('threw', e.message.slice(0, 90)) }

const GRACE = process.argv[3] ?? 'nnstemporeleased'
console.log(`\n13.7  a name in grace (${GRACE}) — missing is not a failed proof`)
try { summarise(await single.resolve(GRACE)) } catch (e) { line('refused with', e.message.slice(0, 90)) }

console.log('\n13.8  quorum 2 over both APIs (mechanics, not independence)')
const pair = createResolver({
  resolvers: [{ name: 'Indexer 1', url: API1 }, { name: 'Indexer 2', url: API2 }],
  quorum: 2,
  anchors: ANCHORS,
})
summarise(await pair.resolve(NAME))

console.log('\n13.10  anchors omitted — zero extra requests')
const bare = createResolver({ resolvers: [{ name: 'Battery Operator', url: API1 }], quorum: 1 })
summarise(await bare.resolve(NAME))
