import { describe, expect, it } from 'vitest'
import { EnvError, loadSettings, requireDeployer, requireDeployKey } from './env.js'

const KEY = `0x${'11'.repeat(32)}`
const ADDRESS = '0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0'

const base = {
  NNS_ANCHOR_RPC_URL: 'https://sepolia.example',
  NNS_ANCHOR_CHAIN_ID: '11155111',
  NNS_ANCHOR_DEPLOY_KEY: KEY,
}

describe('loadSettings', () => {
  it('reads a complete environment', () => {
    expect(loadSettings(base)).toEqual({
      rpcUrl: 'https://sepolia.example',
      chainId: 11155111,
      deployKey: KEY,
      deployAddress: undefined,
    })
  })

  it('treats blank as absent', () => {
    expect(() => loadSettings({ ...base, NNS_ANCHOR_RPC_URL: '   ' })).toThrow(/NNS_ANCHOR_RPC_URL is required/)
  })

  it('requires the chain id, with no default', () => {
    // Deliberately not defaulted to 137. The value exists to disagree with a
    // stale RPC URL, and a default would agree with it instead.
    const { NNS_ANCHOR_CHAIN_ID: _omitted, ...without } = base
    expect(() => loadSettings(without)).toThrow(/NNS_ANCHOR_CHAIN_ID is required/)
  })

  it('rejects a chain id that is not a positive integer', () => {
    for (const bad of ['0', '-1', '13.7', 'polygon', '']) {
      expect(() => loadSettings({ ...base, NNS_ANCHOR_CHAIN_ID: bad })).toThrow(EnvError)
    }
  })

  it('rejects every non-decimal spelling JavaScript would coerce', () => {
    // `Number('0x89')` is 137 and `Number('1e3')` is 1000, so a `Number` +
    // `isInteger` check alone accepts chain ids nobody wrote. Caught by this
    // test on the way in: 0x89 *is* 137, so the bug would have looked correct
    // on Polygon and silently misread anything else.
    for (const bad of ['0x89', '1e3', '0b10001001', '0o211', '+137', '137.0']) {
      expect(() => loadSettings({ ...base, NNS_ANCHOR_CHAIN_ID: bad })).toThrow(/decimal integer/)
    }
  })

  it('still trims surrounding whitespace', () => {
    // Trimming is deliberate and shared with every other env reader in the
    // repo — a trailing space in a .env file is a typo, not a different value.
    expect(loadSettings({ ...base, NNS_ANCHOR_CHAIN_ID: ' 137 ' }).chainId).toBe(137)
  })

  it('accepts an address instead of a key, for planning without one', () => {
    const { NNS_ANCHOR_DEPLOY_KEY: _omitted, ...without } = base
    const settings = loadSettings({ ...without, NNS_ANCHOR_DEPLOY_ADDRESS: ADDRESS })
    expect(settings.deployKey).toBeUndefined()
    expect(settings.deployAddress).toBe(ADDRESS)
  })

  it('does not require a deployer at all', () => {
    // `verify` reads code at an address and needs no deployer. Demanding one
    // here would make the audit command — the one a third party runs to check
    // the operator — require a key it has no business holding. Found by
    // running the CLI, not by a test.
    const { NNS_ANCHOR_DEPLOY_KEY: _omitted, ...without } = base
    const settings = loadSettings(without)
    expect(settings.deployKey).toBeUndefined()
    expect(settings.deployAddress).toBeUndefined()
  })

  it('rejects a malformed key without echoing it', () => {
    const bad = '0xdeadbeef'
    try {
      loadSettings({ ...base, NNS_ANCHOR_DEPLOY_KEY: bad })
      expect.unreachable('should have thrown')
    } catch (error) {
      // A key in an error message ends up in a terminal, a log file and a
      // pasted bug report. Shape only.
      expect((error as Error).message).not.toContain(bad)
      expect((error as Error).message).toMatch(/32-byte hex private key/)
    }
  })

  it('rejects a malformed address', () => {
    expect(() => loadSettings({ ...base, NNS_ANCHOR_DEPLOY_ADDRESS: '0x1234' })).toThrow(
      /20-byte hex address/,
    )
  })
})

describe('requireDeployer', () => {
  it('reports a signing deployer when the key is set', () => {
    expect(requireDeployer(loadSettings(base))).toEqual({
      kind: 'signing',
      key: KEY,
      declaredAddress: undefined,
    })
  })

  it('reports a planning deployer when only the address is set', () => {
    const { NNS_ANCHOR_DEPLOY_KEY: _omitted, ...without } = base
    expect(requireDeployer(loadSettings({ ...without, NNS_ANCHOR_DEPLOY_ADDRESS: ADDRESS }))).toEqual({
      kind: 'planning',
      address: ADDRESS,
    })
  })

  it('throws when neither is set', () => {
    const { NNS_ANCHOR_DEPLOY_KEY: _omitted, ...without } = base
    expect(() => requireDeployer(loadSettings(without))).toThrow(/NNS_ANCHOR_DEPLOY_KEY to deploy/)
  })
})

describe('requireDeployKey', () => {
  it('returns the key when set', () => {
    expect(requireDeployKey(loadSettings(base))).toBe(KEY)
  })

  it('throws when only an address is configured', () => {
    const { NNS_ANCHOR_DEPLOY_KEY: _omitted, ...without } = base
    const settings = loadSettings({ ...without, NNS_ANCHOR_DEPLOY_ADDRESS: ADDRESS })
    expect(() => requireDeployKey(settings)).toThrow(/required to send/)
  })
})
