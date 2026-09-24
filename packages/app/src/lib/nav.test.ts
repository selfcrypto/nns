/**
 * The masthead's five destinations (`NAV`, wording.ts) are the one part of the
 * nav with a silent failure mode. `parseRoute` answers an unknown tab with the
 * fallback rather than an error, so a typo in `#/docs/intro` does not throw and
 * does not 404 — it quietly lands the reader on whatever screen the caller
 * named as the fallback, which looks like a working link.
 *
 * So: every hash entry has to survive a round trip, and every absolute one has
 * to be https (the app opens those in a new tab, and a `http://` there is a
 * downgrade nobody would notice in review).
 */

import { describe, expect, it } from 'vitest'
import { NAV } from './wording'
import { formatRoute, parseRoute } from './route'

describe('masthead nav', () => {
  it('has five destinations, each labelled once (another moves the app.css nav breakpoint)', () => {
    expect(NAV).toHaveLength(5)
    expect(new Set(NAV.map(([label]) => label)).size).toBe(NAV.length)
  })

  it('routes to a real tab, not to the fallback', () => {
    for (const [label, href] of NAV) {
      if (!href.startsWith('#')) continue
      // Round-tripping is the assertion: a misspelt tab parses to the fallback
      // and formats back to something else.
      expect(formatRoute(parseRoute(href, 'home')), label).toBe(href)
    }
  })

  it('leaves the app only over https', () => {
    for (const [label, href] of NAV) {
      if (href.startsWith('#')) continue
      expect(href.startsWith('https://'), label).toBe(true)
    }
  })
})
