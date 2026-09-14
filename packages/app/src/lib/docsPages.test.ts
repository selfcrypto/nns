/**
 * The documentation pages read in the same session as the screens do, so the
 * app's wording rules bind them too (`docs/README.md`, "Voice").
 *
 * This is the pages' half of `wording.test.ts`'s em-dash guard. `README.md` is
 * excluded on purpose: it is the authoring guide rather than a page anybody
 * reads in the app, and it has to quote the character it bans.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  GATE_REASON_TEXT,
  alarmHeadline,
  buyAcknowledgeLabel,
  graceLine,
  justRegisteredLine,
  pinMismatchTitle,
  reservedLine,
  targetChangedLine,
  usdtNoGasLine,
} from './wording'

const DIR = new URL('../../docs/', import.meta.url)

const pages = (): readonly { readonly file: string; readonly text: string }[] =>
  readdirSync(DIR)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .map((file) => ({ file, text: readFileSync(new URL(file, DIR), 'utf8') }))

describe('no em dash splits a sentence a reader reads (2026-09-14)', () => {
  it('finds the pages at all, so the sweep below cannot pass vacuously', () => {
    expect(pages().length).toBeGreaterThan(10)
  })

  it('holds for every page', () => {
    const offenders = pages()
      .flatMap(({ file, text }) =>
        text.split('\n').map((line, index) => ({ file, line: index + 1, text: line })),
      )
      .filter((row) => row.text.includes('—'))
      .map((row) => `${row.file}:${row.line} ${row.text.trim()}`)
    expect(offenders).toEqual([])
  })
})

/**
 * The pages quote the app, so a rewritten string leaves the documentation
 * describing a screen that no longer says that. It happened the same day this
 * was written: the wording pass changed eight of these and every quote of them
 * in `app.md` had to be found by eye.
 */
describe('what the pages quote is what the app says', () => {
  // The pages are written with ASCII apostrophes and the app with typographic
  // ones, so the fold is over punctuation the reader cannot tell apart. What
  // is being pinned is the sentence.
  const plain = (text: string): string => text.replace(/\u2019/g, "'")
  const app = (): string => plain(readFileSync(new URL('app.md', DIR), 'utf8'))

  it('holds for every line app.md puts in quotation marks', () => {
    const quoted = [
      reservedLine(),
      justRegisteredLine(),
      graceLine('≈ date'),
      usdtNoGasLine(),
      pinMismatchTitle(),
      alarmHeadline(),
      targetChangedLine(),
      GATE_REASON_TEXT['in-grace'],
      GATE_REASON_TEXT['auction-open'],
      buyAcknowledgeLabel(),
    ]
    expect(quoted.filter((line) => !app().includes(plain(line)))).toEqual([])
  })
})
