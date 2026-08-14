import { describe, expect, it } from 'vitest'

import {
  NNS_NAME_CLASS,
  RENDERING_CSS,
  injectRenderingCss,
  type StyleSheetElement,
} from './rendering.js'

/**
 * The properties tested here are the ones whose absence fails silently — a
 * stylesheet that still applies, still looks fine, and no longer separates
 * the pairs §4.3 names. Nothing here asserts formatting.
 */
describe('§4.3 rendering CSS', () => {
  it('is scoped to the name field and touches nothing global', () => {
    expect(RENDERING_CSS).toContain(`.${NNS_NAME_CLASS} {`)
    expect(RENDERING_CSS).not.toContain(':root')
    expect(RENDERING_CSS).not.toContain('@layer')
    // No bare element or universal selector at the start of a rule: every
    // selector in the file is qualified by the class.
    for (const selector of selectors(RENDERING_CSS)) {
      expect(selector).toContain(`.${NNS_NAME_CLASS}`)
    }
  })

  it('falls back to monospace, never to a proportional face', () => {
    const family = declaration(RENDERING_CSS, 'font-family')
    const last = family.replace(/\)+\s*$/, '').trimEnd()
    expect(last.endsWith('monospace')).toBe(true)
    expect(family).not.toContain('serif')
  })

  it('asks for the features §4.3 names', () => {
    const features = declaration(RENDERING_CSS, 'font-feature-settings')
    expect(features).toContain('"ss02"')
    expect(features).toContain('"zero"')
    // Ligatures fuse characters into glyphs — the rn/m failure by another route.
    expect(features).toContain('"calt" 0')
    expect(RENDERING_CSS).toContain('font-variant-ligatures: none')
  })

  it('references fonts and embeds none', () => {
    expect(RENDERING_CSS).not.toContain('@font-face')
    expect(RENDERING_CSS).not.toContain('@import')
    expect(RENDERING_CSS).not.toContain('url(')
    expect(RENDERING_CSS).not.toContain('data:')
  })

  it('leaves the whole stack overridable without forking the file', () => {
    expect(RENDERING_CSS).toContain('var(--nns-name-font-family,')
    expect(RENDERING_CSS).toContain('var(--nns-name-font-features,')
  })
})

describe('injectRenderingCss', () => {
  it('appends one style element carrying the stylesheet', () => {
    const host = fakeHost()
    injectRenderingCss(host)

    expect(host.appended).toHaveLength(1)
    expect(host.appended[0]?.textContent).toBe(RENDERING_CSS)
    expect(host.appended[0]?.attributes['data-nns-rendering']).toBe('')
  })

  it('is a no-op the second time', () => {
    const host = fakeHost()
    injectRenderingCss(host)
    injectRenderingCss(host)
    injectRenderingCss(host)

    expect(host.appended).toHaveLength(1)
  })
})

/**
 * Compile-time, never run: a real `Document` satisfies `StyleHost`. The
 * structural type exists so the injector is testable without a DOM, which is
 * worth nothing if it has drifted out of accepting the thing every caller
 * actually passes. The DOM lib is in scope here; the runtime is not.
 */
export function _documentSatisfiesStyleHost(doc: Document): void {
  injectRenderingCss(doc)
}

interface FakeStyle extends StyleSheetElement {
  attributes: Record<string, string>
}

/** Enough of a `Document` for the injector, and no more. */
function fakeHost() {
  const appended: FakeStyle[] = []
  return {
    appended,
    createElement(_tagName: 'style'): FakeStyle {
      const attributes: Record<string, string> = {}
      return {
        attributes,
        textContent: null,
        setAttribute(name: string, value: string) {
          attributes[name] = value
        },
      }
    },
    querySelector(selectors: string): unknown {
      const name = selectors.slice(selectors.indexOf('[') + 1, -1)
      return appended.find((el) => name in el.attributes) ?? null
    },
    head: {
      appendChild(node: FakeStyle): unknown {
        appended.push(node)
        return node
      },
    },
  }
}

/** Selector text of every rule, comments stripped. */
function selectors(css: string): string[] {
  return withoutComments(css)
    .split('}')
    .map((block) => block.split('{')[0]?.trim() ?? '')
    .filter((selector) => selector.length > 0)
}

/** The value of a declaration, wherever it wraps across lines. */
function declaration(css: string, property: string): string {
  const body = withoutComments(css)
  const at = body.indexOf(`${property}:`)
  expect(at).toBeGreaterThan(-1)
  return body.slice(at + property.length + 1, body.indexOf(';', at))
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}
