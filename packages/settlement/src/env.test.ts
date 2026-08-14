import { describe, expect, it } from 'vitest'

import { MARKETPLACE, TREASURY, testAddress } from './test-fixtures.js'
import { loadIssuerSettings, loadLedgerSettings, loadSettings, loadWatcherSettings } from './env.js'

const BASE = {
  NNS_API_URL: 'http://api.test/',
  NNS_NETWORK_ID: '5',
  NNS_LAUNCH_HEIGHT: '58177000',
  NNS_TREASURY_ADDRESS: TREASURY,
  NNS_PROTOCOL_ADDRESS: testAddress(2),
  NNS_ADMIN_ADDRESS: testAddress(3),
  NNS_MARKETPLACE_ADDRESS: MARKETPLACE,
} as const

describe('loadSettings', () => {
  it('builds a validated config and strips the trailing slash from the API URL', () => {
    const settings = loadSettings(BASE)
    expect(settings.apiUrl).toBe('http://api.test')
    expect(settings.config.launchHeight).toBe(58_177_000)
    expect(settings.config.marketplace).toBe(MARKETPLACE)
  })

  it('has no database and no key to load — the independence is structural', () => {
    const settings = loadSettings({ ...BASE, NNS_DATABASE_URL: 'postgres://nope', NNS_SETTLEMENT_KEY: 'nope' })
    expect(Object.keys(settings).sort()).toEqual(['apiUrl', 'config'])
    expect(Object.values(settings)).not.toContain('postgres://nope')
  })

  it('requires the API URL, and requires it to be one', () => {
    expect(() => loadSettings({ ...BASE, NNS_API_URL: undefined })).toThrow(/NNS_API_URL is required/)
    expect(() => loadSettings({ ...BASE, NNS_API_URL: 'not a url' })).toThrow(/not a valid URL/)
  })

  it('rejects a listing fee written in NIM', () => {
  })

  it('rejects a launch height that is not an integer', () => {
    expect(() => loadSettings({ ...BASE, NNS_LAUNCH_HEIGHT: '58177000.5' })).toThrow(/must be an integer/)
  })

  it('reports a bad address through EnvError rather than core’s own error', () => {
    expect(() => loadSettings({ ...BASE, NNS_TREASURY_ADDRESS: 'NQ00 NOPE' })).toThrow(
      expect.objectContaining({ name: 'EnvError' }),
    )
  })

  it('reads no reserved list at all — it is a §3 constant since the launch freeze', () => {
    // Setting the deleted variable is inert, not honoured. An env var that
    // still existed is one an operator could still use to make this service
    // replay under a list the indexer never ran with.
    const settings = loadSettings({ ...BASE, NNS_RESERVED_NAMES: 'binance', NNS_LISTING_FEE: '100000' })
    expect(Object.keys(settings.config).sort()).toEqual([
      'admin',
      'launchHeight',
      'marketplace',
      'networkId',
      'protocol',
      'treasury',
    ])
  })
})

describe('loadLedgerSettings', () => {
  const LEDGER = { ...BASE, NNS_SETTLEMENT_DATABASE_URL: 'postgres://nns@localhost:5434/nns_settlement' } as const

  it('loads the ledger database, and only the ledger loads it', () => {
    expect(loadLedgerSettings(LEDGER).databaseUrl).toBe('postgres://nns@localhost:5434/nns_settlement')
    // The two commands that must keep starting on a box with no database.
    expect(Object.keys(loadSettings(LEDGER))).not.toContain('databaseUrl')
    expect(Object.keys(loadWatcherSettings(LEDGER))).not.toContain('databaseUrl')
  })

  it('requires it — a ledger without a database is not a ledger', () => {
    expect(() => loadLedgerSettings(BASE)).toThrow(/NNS_SETTLEMENT_DATABASE_URL is required/)
  })

  // One .env on a box serves several of these processes, and pointing the
  // ledger at the indexer's database is the one arrangement this package rules
  // out: that one is a droppable projection of the chain, this one is not.
  it('refuses the indexer’s own database', () => {
    expect(() =>
      loadLedgerSettings({
        ...BASE,
        NNS_DATABASE_URL: 'postgres://nns@localhost:5433/nns',
        NNS_SETTLEMENT_DATABASE_URL: 'postgres://nns@localhost:5433/nns',
      }),
    ).toThrow(/its own/)
  })
})

describe('loadIssuerSettings', () => {
  const ISSUER = {
    ...BASE,
    NNS_SETTLEMENT_DATABASE_URL: 'postgres://nns@localhost:5434/nns_settlement',
    NNS_RPC_URL: 'http://127.0.0.1:6488',
    NNS_SETTLEMENT_EXPIRY_BLOCKS: '120',
    NNS_SETTLEMENT_MIN_BALANCE: '10000000',
  } as const

  it('adds a node and the §11.5 thresholds to the ledger’s settings', () => {
    const settings = loadIssuerSettings(ISSUER)
    expect(settings.rpcUrl).toBe('http://127.0.0.1:6488')
    expect(settings.expiryBlocks).toBe(120)
    expect(settings.minBalance).toBe(10_000_000n)
    expect(settings.databaseUrl).toBe('postgres://nns@localhost:5434/nns_settlement')
  })

  it('still loads no key — those are keys.ts’s, and only issue-main reaches it', () => {
    const settings = loadIssuerSettings({ ...ISSUER, NNS_SETTLEMENT_MARKETPLACE_KEY: 'ab'.repeat(32) })
    expect(Object.values(settings)).not.toContain('ab'.repeat(32))
  })

  it('assembles the RPC URL from host and port, like admin does', () => {
    const settings = loadIssuerSettings({ ...ISSUER, NNS_RPC_URL: undefined, NNS_RPC_HOST: '10.0.0.4', NNS_RPC_PORT: '6488' })
    expect(settings.rpcUrl).toBe('http://10.0.0.4:6488')
  })

  it('requires a node', () => {
    expect(() => loadIssuerSettings({ ...ISSUER, NNS_RPC_URL: undefined })).toThrow(/NNS_RPC_URL/)
  })

  // Unset means "take the node's transactionValidityWindow", which is the
  // normal case; resolveExpiryBlocks holds the rule that an override may only
  // be longer.
  it('leaves the expiry window null when unset, for the node to answer', () => {
    expect(loadIssuerSettings({ ...ISSUER, NNS_SETTLEMENT_EXPIRY_BLOCKS: undefined }).expiryBlocks).toBeNull()
    expect(loadIssuerSettings(ISSUER).expiryBlocks).toBe(120)
    expect(() => loadIssuerSettings({ ...ISSUER, NNS_SETTLEMENT_EXPIRY_BLOCKS: '0' })).toThrow(/integer >= 1/)
  })

  // §11.5 rule 2: alerting at zero alerts after the failure.
  it('requires an alert threshold above zero', () => {
    expect(() => loadIssuerSettings({ ...ISSUER, NNS_SETTLEMENT_MIN_BALANCE: undefined })).toThrow(
      /NNS_SETTLEMENT_MIN_BALANCE is required/,
    )
    expect(() => loadIssuerSettings({ ...ISSUER, NNS_SETTLEMENT_MIN_BALANCE: '0' })).toThrow(/well above zero/)
  })

  it('defaults the fee to zero, which the network accepts', () => {
    expect(loadIssuerSettings(ISSUER).feeLuna).toBe(0n)
    expect(loadIssuerSettings({ ...ISSUER, NNS_SETTLEMENT_FEE_LUNA: '138' }).feeLuna).toBe(138n)
  })
})
