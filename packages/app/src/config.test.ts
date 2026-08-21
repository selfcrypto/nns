import { describe, expect, it } from 'vitest'
import { ConfigParseError, parseQuorum, parseResolverList } from './config'

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

  // The whole point of the relative form: `deploy/service`'s nginx serves the
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
  it('defaults to 1 — the launch decision, explicit in this deployment', () => {
    expect(parseQuorum(undefined)).toBe(1)
  })

  it('accepts integers ≥ 1 and refuses the rest', () => {
    expect(parseQuorum('2')).toBe(2)
    expect(() => parseQuorum('0')).toThrow(ConfigParseError)
    expect(() => parseQuorum('1.5')).toThrow(ConfigParseError)
  })
})
