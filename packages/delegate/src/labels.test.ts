import { describe, expect, it } from 'vitest'

import { addressFromBytes, formatAddress } from '@nimiqnames/core'

import { countLabels, LabelFileError, parseLabelFile, readLabelFile, MAX_TTL_SEC } from './labels.js'

const addr = (fill: number): string => formatAddress(addressFromBytes(new Uint8Array(20).fill(fill)))

/** One name's file, which is the common shape an owner writes. */
const file = (labels: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  names: { binance: labels },
  ...extra,
})

/** Every rejection must name the key. An owner with a hundred labels gets one line. */
const rejects = (raw: unknown, key: string | null): LabelFileError => {
  let caught: unknown
  try {
    parseLabelFile(raw)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(LabelFileError)
  const error = caught as LabelFileError
  expect(error.key).toBe(key)
  if (key !== null) expect(error.message.startsWith(`${key}: `)).toBe(true)
  return error
}

describe('parseLabelFile', () => {
  it('accepts the shorthand and the object form, and applies defaultTtl', () => {
    const parsed = parseLabelFile(
      file({ shop: addr(1), pay: { address: addr(2), ttl: 60 } }, { defaultTtl: 120 }),
      300,
    )
    expect(parsed.defaultTtl).toBe(120)
    const binance = parsed.names.get('binance')
    expect(binance?.get('shop')).toEqual({ address: addressFromBytes(new Uint8Array(20).fill(1)), ttl: 120 })
    expect(binance?.get('pay')?.ttl).toBe(60)
  })

  it('falls back to the deployment ttl when the file states none', () => {
    expect(parseLabelFile(file({ shop: addr(1) }), 77).defaultTtl).toBe(77)
    expect(parseLabelFile(file({ shop: addr(1) }), 77).names.get('binance')?.get('shop')?.ttl).toBe(77)
  })

  it('names the offending label when its address is not an address', () => {
    const error = rejects(file({ shop: addr(1), pay: 'NQ99 nope' }), 'names.binance.pay')
    expect(error.message).toContain('not a Nimiq address')
  })

  it('names the offending label when the key is not a §4.4 label', () => {
    expect(rejects(file({ '-shop': addr(1) }), 'names.binance.-shop').message).toContain('LEADING_HYPHEN')
    expect(rejects(file({ SHOP: addr(1) }), 'names.binance.SHOP').message).toContain('BAD_CHARACTER')
    expect(rejects(file({ 'a.b': addr(1) }), 'names.binance.a.b').message).toContain('BAD_CHARACTER')
  })

  it('names the offending label when its ttl is out of range or not an integer', () => {
    rejects(file({ shop: { address: addr(1), ttl: 0 } }), 'names.binance.shop.ttl')
    rejects(file({ shop: { address: addr(1), ttl: MAX_TTL_SEC + 1 } }), 'names.binance.shop.ttl')
    rejects(file({ shop: { address: addr(1), ttl: 1.5 } }), 'names.binance.shop.ttl')
  })

  it('names an unknown field inside a label entry', () => {
    // The likeliest typo in a file whose whole content is addresses.
    rejects(file({ shop: { address: addr(1), sig: 'x' } }), 'names.binance.shop.sig')
  })

  it('names an unknown top-level key rather than ignoring it', () => {
    // This is the whole reason `names` stays a wrapper. Hoisted, `namez` would
    // parse as a *name* nobody ever queries, with no error anywhere the owner
    // looks — and a subdomain silently out of service is the failure mode this
    // parser exists to prevent.
    rejects({ names: { binance: {} }, namez: {} }, 'namez')
    rejects({ names: { binance: {} }, version: 1 }, 'version')
  })

  it('rejects a name that is not a §4.1 name, and names it', () => {
    expect(rejects({ names: { Binance: {} } }, 'names.Binance').message).toContain('BAD_CHARACTER')
    expect(rejects({ names: { 'alice.bob': {} } }, 'names.alice.bob').message).toContain('BAD_CHARACTER')
    // Length claims a malformed *short* name before the character rule does —
    // `name.ts` orders it that way deliberately, and the key still points at it.
    expect(rejects({ names: { 'a.b': {} } }, 'names.a.b').message).toContain('TOO_SHORT')
  })

  it('accepts a short name a fired U released — validateNameSyntax, not validateName', () => {
    // `nns` is 3 characters, reserved by rule until a `U` fires. The delegate
    // applies no §7 rule and must serve whatever the chain says is registered.
    expect(parseLabelFile({ names: { nns: { pay: addr(1) } } }).names.has('nns')).toBe(true)
  })

  it('rejects a name whose labels are not an object', () => {
    // The array form: `"binance": [{...}]` implies an ordering that does not
    // exist and makes a duplicate label expressible.
    rejects({ names: { binance: [{ shop: addr(1) }] } }, 'names.binance')
    rejects({ names: { binance: 'NQ…' } }, 'names.binance')
  })

  it('requires names, and names the key when it is missing or wrong', () => {
    rejects({}, 'names')
    rejects({ names: [] }, 'names')
  })

  it('accepts an empty label set — an owner who has removed every subdomain', () => {
    expect(parseLabelFile(file({})).names.get('binance')?.size).toBe(0)
  })

  it('rejects anything that is not an object, with no key to name', () => {
    rejects([], null)
    rejects('binance', null)
  })
})

describe('many names in one file — what r23 made possible', () => {
  const two = {
    defaultTtl: 300,
    names: {
      nimiq: { burn: addr(1), staking: addr(2) },
      nns: { pay: { address: addr(3), ttl: 60 } },
    },
  }

  it('keeps each name in its own namespace', () => {
    const parsed = parseLabelFile(two)
    expect(parsed.names.size).toBe(2)
    expect(parsed.names.get('nimiq')?.has('burn')).toBe(true)
    // `pay` exists — under `nns`, not under `nimiq`.
    expect(parsed.names.get('nimiq')?.has('pay')).toBe(false)
    expect(parsed.names.get('nns')?.has('pay')).toBe(true)
  })

  it('lets the same label mean different addresses under different names', () => {
    const parsed = parseLabelFile({ names: { alice: { pay: addr(1) }, bob: { pay: addr(2) } } })
    expect(parsed.names.get('alice')?.get('pay')?.address).not.toBe(parsed.names.get('bob')?.get('pay')?.address)
  })

  it('counts labels across every name, which is what healthz reports', () => {
    expect(countLabels(parseLabelFile(two))).toBe(3)
  })

  it('applies one file-level defaultTtl to every name', () => {
    const parsed = parseLabelFile({ defaultTtl: 42, names: { alice: { pay: addr(1) }, bob: { pay: addr(2) } } })
    expect(parsed.names.get('alice')?.get('pay')?.ttl).toBe(42)
    expect(parsed.names.get('bob')?.get('pay')?.ttl).toBe(42)
  })
})

describe('readLabelFile', () => {
  it('reports a JSON syntax error as a file-level fault', () => {
    let caught: unknown
    try {
      readLabelFile('{ not json')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LabelFileError)
    expect((caught as LabelFileError).key).toBeNull()
    expect((caught as LabelFileError).message).toContain('not valid JSON')
  })

  it('round-trips a file an owner would actually write', () => {
    const text = JSON.stringify({ defaultTtl: 300, names: { binance: { shop: addr(3) } } })
    expect(readLabelFile(text).names.get('binance')?.get('shop')).toBeDefined()
  })
})
