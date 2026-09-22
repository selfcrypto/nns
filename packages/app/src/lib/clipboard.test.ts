import { afterEach, describe, expect, it, vi } from 'vitest'
import { readClipboard, writeClipboard } from './clipboard'

afterEach(() => {
  vi.unstubAllGlobals()
})

const reading = (value: string | Error) => ({
  readText: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)),
})

describe('readClipboard', () => {
  it('hands back what the clipboard held', async () => {
    expect(await readClipboard(reading('https://nimiqnames.com/pay/rico?amount=25'))).toEqual({
      kind: 'text',
      text: 'https://nimiqnames.com/pay/rico?amount=25',
    })
  })

  it('is empty for an empty clipboard, and for whitespace', async () => {
    expect(await readClipboard(reading(''))).toEqual({ kind: 'empty' })
    expect(await readClipboard(reading('  \n '))).toEqual({ kind: 'empty' })
  })

  // A WebView can answer the permission prompt for the page, so a refusal is
  // the ordinary case, not the broken one.
  it('is refused when the read throws, and when there is no clipboard', async () => {
    expect(await readClipboard(reading(new Error('NotAllowedError')))).toEqual({ kind: 'refused' })
    expect(await readClipboard(null)).toEqual({ kind: 'refused' })
  })
})

/**
 * A fake `document` good enough for the textarea fallback, because the app's
 * Vitest environment is `node` and there is no real one. It records what was
 * selected, so a test can assert the copy carried the right text rather than
 * only that `execCommand` was reached.
 */
const fakeDocument = (execCommand: ((command: string) => boolean) | null) => {
  const attached: unknown[] = []
  const selected: string[] = []
  return {
    doc: {
      ...(execCommand === null ? {} : { execCommand }),
      createElement: () => ({
        value: '',
        style: {} as Record<string, string>,
        focus: () => {},
        select(this: { value: string }) {
          selected.push(this.value)
        },
      }),
      body: {
        appendChild: (node: unknown) => attached.push(node),
        removeChild: (node: unknown) => attached.splice(attached.indexOf(node), 1),
      },
    },
    attached,
    selected,
  }
}

describe('writeClipboard', () => {
  it('writes through the host clipboard when it has one', async () => {
    const written: string[] = []
    const outcome = await writeClipboard('NQ52 A3NY X8U8 XKDX TPBN 6E9C 5CYN 80JL KF8N', {
      writeText: (text) => {
        written.push(text)
        return Promise.resolve()
      },
    })
    expect(outcome).toBe('ok')
    expect(written).toEqual(['NQ52 A3NY X8U8 XKDX TPBN 6E9C 5CYN 80JL KF8N'])
  })

  // The case the app was getting wrong: Pay's WebView can ship without
  // `navigator.clipboard`, and every copy but the Inbox's gave up there.
  it('falls back to the textarea when there is no host clipboard', async () => {
    const { doc, selected } = fakeDocument(() => true)
    vi.stubGlobal('document', doc)
    expect(await writeClipboard('NQ52 A3NY', null)).toBe('ok')
    expect(selected).toEqual(['NQ52 A3NY'])
  })

  // A refusal from one mechanism says nothing about the other.
  it('falls back when the host clipboard throws', async () => {
    const { doc, selected } = fakeDocument(() => true)
    vi.stubGlobal('document', doc)
    const outcome = await writeClipboard('NQ52 A3NY', { writeText: () => Promise.reject(new Error('NotAllowedError')) })
    expect(outcome).toBe('ok')
    expect(selected).toEqual(['NQ52 A3NY'])
  })

  it('leaves no textarea behind, whether the copy took or not', async () => {
    const took = fakeDocument(() => true)
    vi.stubGlobal('document', took.doc)
    await writeClipboard('NQ52 A3NY', null)
    expect(took.attached).toEqual([])

    const refused = fakeDocument(() => {
      throw new Error('blocked')
    })
    vi.stubGlobal('document', refused.doc)
    expect(await writeClipboard('NQ52 A3NY', null)).toBe('failed')
    expect(refused.attached).toEqual([])
  })

  it('is a failure, not a lie, where neither mechanism exists', async () => {
    vi.stubGlobal('document', fakeDocument(null).doc)
    expect(await writeClipboard('NQ52 A3NY', null)).toBe('failed')
    vi.stubGlobal('document', undefined)
    expect(await writeClipboard('NQ52 A3NY', null)).toBe('failed')
  })

  it('is a failure when the host takes the command and does nothing', async () => {
    vi.stubGlobal('document', fakeDocument(() => false).doc)
    expect(await writeClipboard('NQ52 A3NY', null)).toBe('failed')
  })
})
