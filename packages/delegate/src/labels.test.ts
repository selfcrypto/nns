import { describe, expect, it } from 'vitest'

import { addressFromBytes, formatAddress } from '@nns/core'

import { LabelFileError, parseLabelFile, readLabelFile, MAX_TTL_SEC } from './labels.js'

const addr = (fill: number): string => formatAddress(addressFromBytes(new Uint8Array(20).fill(fill)))

const file = (labels: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  name: 'binance',
  labels,
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
    expect(parsed.name).toBe('binance')
    expect(parsed.defaultTtl).toBe(120)
    expect(parsed.labels.get('shop')).toEqual({ address: addressFromBytes(new Uint8Array(20).fill(1)), ttl: 120 })
    expect(parsed.labels.get('pay')?.ttl).toBe(60)
  })

  it('falls back to the deployment ttl when the file states none', () => {
    expect(parseLabelFile(file({ shop: addr(1) }), 77).defaultTtl).toBe(77)
    expect(parseLabelFile(file({ shop: addr(1) }), 77).labels.get('shop')?.ttl).toBe(77)
  })

  it('names the offending label when its address is not an address', () => {
    const error = rejects(file({ shop: addr(1), pay: 'NQ99 nope' }), 'labels.pay')
    expect(error.message).toContain('not a Nimiq address')
  })

  it('names the offending label when the key is not a §4.4 label', () => {
    expect(rejects(file({ '-shop': addr(1) }), 'labels.-shop').message).toContain('LEADING_HYPHEN')
    expect(rejects(file({ SHOP: addr(1) }), 'labels.SHOP').message).toContain('BAD_CHARACTER')
    expect(rejects(file({ 'a.b': addr(1) }), 'labels.a.b').message).toContain('BAD_CHARACTER')
  })

  it('names the offending label when its ttl is out of range or not an integer', () => {
    rejects(file({ shop: { address: addr(1), ttl: 0 } }), 'labels.shop.ttl')
    rejects(file({ shop: { address: addr(1), ttl: MAX_TTL_SEC + 1 } }), 'labels.shop.ttl')
    rejects(file({ shop: { address: addr(1), ttl: 1.5 } }), 'labels.shop.ttl')
  })

  it('names an unknown field inside a label entry', () => {
    // The likeliest typo in a file whose whole content is addresses.
    rejects(file({ shop: { address: addr(1), sig: 'x' } }), 'labels.shop.sig')
  })

  it('names an unknown top-level key rather than ignoring it', () => {
    // `label` for `labels` would otherwise serve an empty, valid file.
    rejects(file({ shop: addr(1) }, { label: {} }), 'label')
  })

  it('rejects a version it does not implement', () => {
    rejects({ version: 2, name: 'binance', labels: {} }, 'version')
  })

  it('rejects a name that is not a §4.1 name', () => {
    rejects({ version: 1, name: 'Binance', labels: {} }, 'name')
  })

  it('accepts an empty label set — an owner who has removed every subdomain', () => {
    expect(parseLabelFile(file({})).labels.size).toBe(0)
  })

  it('rejects anything that is not an object, with no key to name', () => {
    rejects([], null)
    rejects('binance', null)
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
    const text = JSON.stringify({ version: 1, name: 'binance', defaultTtl: 300, labels: { shop: addr(3) } })
    expect(readLabelFile(text).labels.get('shop')).toBeDefined()
  })
})
