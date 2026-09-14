import { describe, expect, it } from 'vitest'
import { readClipboard } from './clipboard'

const reading = (value: string | Error) => ({
  readText: () => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)),
})

describe('readClipboard', () => {
  it('hands back what the clipboard held', async () => {
    expect(await readClipboard(reading('https://nimiqnames.com/pay/kike?amount=25'))).toEqual({
      kind: 'text',
      text: 'https://nimiqnames.com/pay/kike?amount=25',
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
