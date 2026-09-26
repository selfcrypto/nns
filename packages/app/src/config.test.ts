import { CONSTANTS } from '@nimiqnames/core'
import { describe, expect, it } from 'vitest'

import { ConfigParseError, parseAnchorConfig, parseExplorerTemplate, parseQuorum, parseResolverList } from './config'

describe('parseResolverList', () => {
  it('parses named endpoints', () => {
    expect(parseResolverList('[{"name":"Ours","url":"https://nns.example"}]')).toEqual([
      { name: 'Ours', url: 'https://nns.example' },
    ])
  })

  it('empty and unset mean an empty list, not an error — the setup screen owns that case', () => {
    expect(parseResolverList(undefined)).toEqual([])
    expect(parseResolverList('  ')).toEqual([])
  })

  it('refuses an entry without a name — disagreement reports need a party, not a URL', () => {
    expect(() => parseResolverList('[{"url":"https://nns.example"}]')).toThrow(ConfigParseError)
    expect(() => parseResolverList('[{"name":"","url":"https://nns.example"}]')).toThrow(ConfigParseError)
  })

  it('refuses non-JSON and non-http URLs', () => {
    expect(() => parseResolverList('nope')).toThrow(ConfigParseError)
    expect(() => parseResolverList('[{"name":"A","url":"ftp://x"}]')).toThrow(ConfigParseError)
  })

  // The whole point of the relative form: the nginx in front of the app serves the
  // API on the bundle's own origin, so one image runs on any hostname.
  it('accepts a same-origin path, so no hostname is baked into the bundle', () => {
    expect(parseResolverList('[{"name":"This deployment","url":"/api"}]')).toEqual([
      { name: 'This deployment', url: '/api' },
    ])
    expect(parseResolverList('[{"name":"Root","url":"/"}]')).toEqual([{ name: 'Root', url: '/' }])
  })

  it('refuses a protocol-relative URL — it reads as same-origin and is not', () => {
    expect(() => parseResolverList('[{"name":"A","url":"//evil.example/api"}]')).toThrow(ConfigParseError)
  })

  it('still refuses a bare path with no leading slash — relative to the current page, not the origin', () => {
    expect(() => parseResolverList('[{"name":"A","url":"api"}]')).toThrow(ConfigParseError)
  })
})

describe('parseQuorum', () => {
  it("defaults to the spec's RESOLVER_QUORUM, not to what one endpoint could meet", () => {
    expect(parseQuorum(undefined)).toBe(CONSTANTS.RESOLVER_QUORUM)
    expect(parseQuorum(undefined)).toBe(2)
  })

  it('accepts integers ≥ 1 and refuses the rest', () => {
    expect(parseQuorum('2')).toBe(2)
    expect(() => parseQuorum('0')).toThrow(ConfigParseError)
    expect(() => parseQuorum('1.5')).toThrow(ConfigParseError)
  })
})

/**
 * The explorer link exists so a reader does not have to take the app's word
 * that a message is a real transaction (Rico, 2026-09-15). A template rather
 * than a base, because the two Nimiq explorers route differently and neither
 * is wrong.
 */
describe('parseExplorerTemplate', () => {
  it('defaults to nimiq.watch, whose transaction view shows the payload', () => {
    expect(parseExplorerTemplate(undefined)).toBe('https://nimiq.watch/#{hash}')
    expect(parseExplorerTemplate('   ')).toBe('https://nimiq.watch/#{hash}')
  })

  it('takes an override verbatim, whatever shape it routes on', () => {
    // The other explorer checked against a real transaction: a path, not a
    // fragment. A base URL could not have expressed both.
    expect(parseExplorerTemplate('https://www.nimiqhub.com/tx/{hash}')).toBe('https://www.nimiqhub.com/tx/{hash}')
  })

  it('refuses a template with nowhere to put the hash', () => {
    expect(() => parseExplorerTemplate('https://example.test/tx/')).toThrow(ConfigParseError)
  })

  it('refuses a non-http value, including a same-origin path', () => {
    // Unlike the endpoints, this one is always a third-party site: a relative
    // path here would be a link back into the app, which proves nothing.
    expect(() => parseExplorerTemplate('ftp://x/{hash}')).toThrow(ConfigParseError)
    expect(() => parseExplorerTemplate('/tx/{hash}')).toThrow(ConfigParseError)
  })
})

/**
 * The anchor chain the Stats page reads. Every refusal here is a value that
 * would otherwise degrade silently: one endpoint reads as a cross-check that
 * never ran, an empty publisher list makes a chain full of anchors read as
 * "none", and a missing chain name leaves the page printing a guess.
 */
describe('parseAnchorConfig', () => {
  const contract = '0xEF503A681C490CCB65090B7E9F6DF734D9F7EAEB'
  const publisher = '0x2EFD3F0E5608BB9E2E7027A1F73485B82E8093C6'
  const rpcs = ['https://a.example.test', 'https://b.example.test']
  const full = { chain: ' Sepolia ', contract, rpcs, publishers: [publisher], lookbackBlocks: 45000, explorer: 'https://sepolia.etherscan.io/address/x' }

  it('is unset by default — a supported deployment', () => {
    expect(parseAnchorConfig(undefined)).toBeNull()
    expect(parseAnchorConfig('  ')).toBeNull()
  })

  it('parses a full object, lower-casing the addresses the reader compares', () => {
    expect(parseAnchorConfig(JSON.stringify(full))).toEqual({
      chain: 'Sepolia',
      contract: contract.toLowerCase(),
      rpcs,
      publishers: [publisher.toLowerCase()],
      lookbackBlocks: 45000n,
      explorer: 'https://sepolia.etherscan.io/address/x',
    })
  })

  it('leaves the window and the explorer to their defaults when absent', () => {
    const { lookbackBlocks: _l, explorer: _e, ...minimal } = full
    expect(parseAnchorConfig(JSON.stringify(minimal))).toMatchObject({ lookbackBlocks: null, explorer: null })
  })

  it('refuses one endpoint — one is not a cross-check', () => {
    expect(() => parseAnchorConfig(JSON.stringify({ ...full, rpcs: [rpcs[0]] }))).toThrow(ConfigParseError)
  })

  it('refuses an empty publisher list rather than reading a chain as empty', () => {
    expect(() => parseAnchorConfig(JSON.stringify({ ...full, publishers: [] }))).toThrow(ConfigParseError)
  })

  it('refuses a malformed address, a missing chain name, a bad window and a relative explorer', () => {
    expect(() => parseAnchorConfig(JSON.stringify({ ...full, contract: '0x1234' }))).toThrow(ConfigParseError)
    expect(() => parseAnchorConfig(JSON.stringify({ ...full, publishers: ['not-an-address'] }))).toThrow(ConfigParseError)
    expect(() => parseAnchorConfig(JSON.stringify({ ...full, chain: '' }))).toThrow(ConfigParseError)
    expect(() => parseAnchorConfig(JSON.stringify({ ...full, lookbackBlocks: 0 }))).toThrow(ConfigParseError)
    expect(() => parseAnchorConfig(JSON.stringify({ ...full, explorer: '/address/x' }))).toThrow(ConfigParseError)
  })

  it('refuses anything that is not one object', () => {
    expect(() => parseAnchorConfig('nope')).toThrow(ConfigParseError)
    expect(() => parseAnchorConfig('[]')).toThrow(ConfigParseError)
  })
})
