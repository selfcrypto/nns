import { describe, expect, it } from 'vitest'
import { join } from './transport.js'

// `join` is what turns a configured endpoint into a request URL, on the path
// that produces addresses (`quorum.ts`, `anchors.ts`). It is deliberately
// string concatenation rather than `new URL(path, base)`: concatenation
// carries a **root-relative** base through unchanged, which is what lets a
// host app configure `/api` and serve the bundle from any hostname without a
// rebuild. `new URL` would need an origin this package does not have.
describe('join', () => {
  it('carries a same-origin base through as a relative path', () => {
    expect(join('/api', 'resolve/alice')).toBe('/api/resolve/alice')
    expect(join('/api/', '/resolve/alice')).toBe('/api/resolve/alice')
  })

  it('treats a bare "/" as the origin root', () => {
    expect(join('/', 'resolve/alice')).toBe('/resolve/alice')
  })

  it('joins an absolute base the same way, trailing slash or not', () => {
    expect(join('https://api.example.com', 'resolve/alice')).toBe('https://api.example.com/resolve/alice')
    expect(join('https://api.example.com/', 'resolve/alice')).toBe('https://api.example.com/resolve/alice')
  })
})
