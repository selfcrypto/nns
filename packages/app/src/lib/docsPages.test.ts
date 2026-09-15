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
  OWNER_GROUP_TITLE,
  OWNER_TILE,
  REQUEST_TILE,
  SHARE_TILE,
  TAB_LABEL,
  WARNING_TEXT,
  alarmBody,
  alarmHeadline,
  buyAcknowledgeLabel,
  delegateFailedLine,
  graceLine,
  justRegisteredLine,
  pinMismatchTitle,
  renewDueLine,
  reservedLine,
  sendConfirmedLine,
  sendConfirmingLine,
  sendRejectedLine,
  sendSettlingLine,
  sendSubmittingLine,
  sendUncheckedLine,
  sendUnconfirmedLine,
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
 * in the pages had to be found by eye. Since the pages were split into sections
 * (2026-09-15) a quote may sit on any page, so the sweep is over all of them.
 */
describe('what the pages quote is what the app says', () => {
  // The pages are written with ASCII apostrophes and the app with typographic
  // ones, so the fold is over punctuation the reader cannot tell apart. What
  // is being pinned is the sentence.
  const plain = (text: string): string => text.replace(/\u2019/g, "'")
  const all = (): string => plain(pages().map(({ text }) => text).join('\n'))

  it('holds for every line a page puts in quotation marks', () => {
    const quoted = [
      reservedLine(),
      justRegisteredLine(),
      graceLine('≈ date'),
      usdtNoGasLine(),
      pinMismatchTitle(),
      alarmHeadline(),
      alarmBody('PROOF_INVALID'),
      alarmBody('ANCHOR_MISMATCH'),
      targetChangedLine(),
      delegateFailedLine('kike'),
      delegateFailedLine('exchange'),
      GATE_REASON_TEXT['in-grace'],
      GATE_REASON_TEXT['auction-open'],
      buyAcknowledgeLabel(),
      renewDueLine('≈ date'),
      WARNING_TEXT.ANCHOR_NOT_CHECKED,
      sendSubmittingLine(),
      sendConfirmingLine(),
      sendConfirmedLine(),
      sendSettlingLine(),
      sendRejectedLine(),
      sendUnconfirmedLine(),
      sendUncheckedLine(),
    ]
    const text = all()
    expect(quoted.filter((line) => !text.includes(plain(line)))).toEqual([])
  })

  // Every tile, group and tab is named in the pages exactly as the app spells
  // it: "one word per thing" (Kike, 2026-09-15) includes the capitals.
  it('names the owner tiles and groups as the app does', () => {
    const text = all()
    for (const tile of Object.values(OWNER_TILE)) expect(text).toContain(tile.title)
    for (const group of Object.values(OWNER_GROUP_TITLE)) expect(text).toContain(group)
    expect(text).toContain(SHARE_TILE.title)
    expect(text).toContain(REQUEST_TILE.title)
    expect(text).toContain(TAB_LABEL.names)
  })
})
