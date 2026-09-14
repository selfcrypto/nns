import { describe, expect, it } from 'vitest'
import { applyTheme, loadTheme, saveTheme, systemPrefersDark, type Theme } from './theme'
import type { StorageLike } from './identity'

const memoryStorage = (seed?: Record<string, string>): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

const brokenStorage = (): StorageLike => ({
  getItem: () => {
    throw new Error('no storage here')
  },
  setItem: () => {
    throw new Error('no storage here')
  },
})

/** Enough of a document for `applyTheme`: a root that records attributes. */
const fakeDocument = (paper = '#eef1f6') => {
  const attributes = new Map<string, string>()
  const meta = { content: '', setAttribute: (_: string, value: string) => void (meta.content = value) }
  return {
    attributes,
    meta,
    doc: {
      documentElement: {
        setAttribute: (name: string, value: string) => void attributes.set(name, value),
        removeAttribute: (name: string) => void attributes.delete(name),
      },
      querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? meta : null),
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => paper }) },
    } as unknown as Document,
  }
}

describe('the stored theme', () => {
  it('round-trips a choice', () => {
    const storage = memoryStorage()
    saveTheme(storage, 'dark')
    expect(loadTheme(storage, false)).toBe('dark')
    saveTheme(storage, 'light')
    expect(loadTheme(storage, true)).toBe('light')
  })

  it('falls back to the device preference, not to light', () => {
    expect(loadTheme(memoryStorage(), true)).toBe('dark')
    expect(loadTheme(memoryStorage(), false)).toBe('light')
  })

  it('treats an unreadable or nonsense store as no choice at all', () => {
    expect(loadTheme(brokenStorage(), true)).toBe('dark')
    expect(loadTheme(memoryStorage({ 'nns.theme': 'midnight' }), true)).toBe('dark')
    // Writing through a broken store is a preference not remembered, never a
    // crash on a button press.
    expect(() => saveTheme(brokenStorage(), 'dark')).not.toThrow()
  })
})

describe('systemPrefersDark', () => {
  it('is false where nothing can answer', () => {
    expect(systemPrefersDark({} as unknown as Window)).toBe(false)
    expect(
      systemPrefersDark({
        matchMedia: () => {
          throw new Error('unsupported')
        },
      } as unknown as Window),
    ).toBe(false)
  })

  it('asks for the dark scheme specifically', () => {
    const asked: string[] = []
    const host = {
      matchMedia: (query: string) => {
        asked.push(query)
        return { matches: true }
      },
    } as unknown as Window
    expect(systemPrefersDark(host)).toBe(true)
    expect(asked).toEqual(['(prefers-color-scheme: dark)'])
  })
})

describe('applyTheme', () => {
  it('marks the root only for a dark dashboard', () => {
    const { attributes, doc } = fakeDocument()
    applyTheme(doc, 'dark', true)
    expect(attributes.get('data-theme')).toBe('dark')
    applyTheme(doc, 'light', true)
    expect(attributes.has('data-theme')).toBe(false)
  })

  it('never darkens the landing page, whatever is stored', () => {
    for (const theme of ['light', 'dark'] satisfies Theme[]) {
      const { attributes, doc } = fakeDocument()
      applyTheme(doc, theme, false)
      expect(attributes.has('data-theme')).toBe(false)
    }
  })

  it('leaves the landing page light on the way home and relights on the way back', () => {
    const { attributes, doc } = fakeDocument()
    applyTheme(doc, 'dark', true)
    applyTheme(doc, 'dark', false)
    expect(attributes.has('data-theme')).toBe(false)
    applyTheme(doc, 'dark', true)
    expect(attributes.get('data-theme')).toBe('dark')
  })

  it('takes the browser bar colour off the palette rather than restating it', () => {
    const { meta, doc } = fakeDocument('#0f1320')
    applyTheme(doc, 'dark', true)
    expect(meta.content).toBe('#0f1320')
  })

  it('leaves the bar colour alone when the palette cannot be read', () => {
    const { meta, doc } = fakeDocument('')
    applyTheme(doc, 'dark', true)
    expect(meta.content).toBe('')
  })
})
