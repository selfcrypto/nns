import { formatAddress, LUNA_PER_NIM, tryParseAddress } from '@nimiqnames/core'

/**
 * Digits in threes: `1234567` → `1,234,567`. The integer part only — a
 * fraction is never grouped.
 *
 * A comma, because every decimal this app writes is a point (`lunaToNim`
 * below, and `docsFormat.ts`, which is where this function was first written
 * and now imports it), so the two can never be read for each other *within a
 * page*. It stays ambiguous to a reader who writes `1,5` for one and a half,
 * which is why `parseNimAmount` refuses a comma-grouped amount by name rather
 * than guessing at it.
 */
export function group(value: bigint | number): string {
  const digits = (typeof value === 'bigint' ? value : Math.trunc(value)).toString()
  const sign = digits.startsWith('-') ? '-' : ''
  const body = sign === '' ? digits : digits.slice(1)
  return sign + body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * A grouped amount, in either notation: a comma with exactly three digits
 * behind it, or two or more period-separated runs of three — each with an
 * optional fraction after it, because `18,765.84304` is the shape a balance
 * takes and it is every bit as grouped as `18,765`.
 *
 * Shared by both parsers (`parseNimAmount`, `parseUsdtAmount`), which read a
 * comma as a *decimal point* for the keyboards that write `1,5`. That makes
 * `12,345` two honest readings — twelve thousand, or twelve and a third — and
 * a money field is the last place to guess between them, so the shape is
 * refused by name rather than interpreted.
 *
 * A single period with three decimals is deliberately absent: `12.345` is
 * unambiguous in the notation this app writes, and has always meant 12.345.
 */
export function looksGrouped(text: string): boolean {
  return /^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$|^[0-9]{1,3}(?:\.[0-9]{3}){2,}(?:,[0-9]+)?$/.test(text)
}

/**
 * The NIM of an integer luna, five decimals, trailing zeros trimmed. The
 * `whole` argument is the *only* difference between the two exports below,
 * which is the point: one of them is read and the other is typed, and the
 * split is a comma.
 */
function nim(luna: bigint, whole: (value: bigint) => string): string {
  const w = luna / LUNA_PER_NIM
  const frac = luna % LUNA_PER_NIM
  if (frac === 0n) return whole(w)
  return `${whole(w)}.${frac.toString().padStart(5, '0').replace(/0+$/, '')}`
}

/** Integer luna → NIM, grouped. **For reading.** */
export function lunaToNim(luna: bigint): string {
  return nim(luna, group)
}

/**
 * The same number, ungrouped. **For a field**, whose contents are parsed
 * again — `parseNimAmount` reads the comma `lunaToNim` writes as a decimal
 * point, so filling an input from the grouped form puts a value in it that
 * the app then refuses.
 *
 * Which is not hypothetical: Pay's MAX button did exactly that the day
 * grouping shipped, offering a balance of `18,765.84304` and rejecting it on
 * the next keystroke (Kike, 2026-09-14). `format.test.ts` pins the round trip
 * through the parser so the pair cannot drift apart again.
 */
export function lunaToNimInput(luna: bigint): string {
  return nim(luna, String)
}

/**
 * A future height as an approximate wall-clock date. Blocks are ~1 s but not
 * exactly, so everything derived from this must render as an estimate — the
 * `≈` prefix in `formatApproxDate` is required by docs/app-states.md.
 */
export function approxDate(height: number, head: number, nowMs: number): Date {
  return new Date(nowMs + (height - head) * 1000)
}

export function formatApproxDate(date: Date, locale?: string): string {
  return `≈ ${date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })}`
}

/** A block count as a rough duration: "~12 h", "~30 d". */
export function blocksApprox(blocks: number): string {
  const days = blocks / 86_400
  if (days >= 2) return `~${Math.round(days)} d`
  const hours = blocks / 3_600
  if (hours >= 2) return `~${Math.round(hours * 10) / 10} h`
  return `~${Math.max(1, Math.round(blocks / 60))} min`
}

/**
 * When something lands, as time remaining rather than as a calendar date.
 *
 * A date is the right rendering for an expiry a year out and the wrong one for
 * a timelock. `XFER_TIMELOCK` is 43,200 blocks on mainnet and 600 in a tempo
 * era; both came out of `formatApproxDate` as the day it already is, so the
 * one number the line existed to carry was the one it did not say (Kike,
 * 2026-09-15). Anything already due reads as the next block, because that is
 * when the effect fires (§7.3).
 */
export function formatApproxIn(blocksLeft: number): string {
  return blocksLeft <= 0 ? 'at the next block' : `in ${blocksApprox(blocksLeft)}`
}

/**
 * The conventional spaced form, whatever spelling arrived.
 *
 * Addresses reach the UI two ways and they do not agree: `@nimiqnames/resolver`
 * returns the branded compact 36 characters, the API serves the spaced groups
 * of four. Everything on screen wants the spaced one — it is what the wallet,
 * the Hub and the explorer show, `ellipsizeAddress` below silently no-ops on
 * anything else, and an identicon is a *hash of the string it is handed*, so
 * the two spellings of one address draw two different pictures and only the
 * spaced one matches every other Nimiq surface.
 *
 * Unparsable input is returned untouched: display code never rejects.
 */
export function displayAddress(input: string): string {
  const parsed = tryParseAddress(input)
  return parsed === null ? input : formatAddress(parsed)
}

/** Spaced Nimiq address shortened for list rows. Full form belongs anywhere money moves. */
export function ellipsizeAddress(address: string): string {
  const parts = displayAddress(address).split(' ')
  if (parts.length !== 9) return address
  return `${parts[0]} ${parts[1]} … ${parts[8]}`
}

/**
 * A sentence, cut into the runs that are the name and the runs that are not.
 *
 * Review lines arrive as plain strings so `actions.ts` stays free of markup,
 * but the name inside them is still a name: §4.3 wants it in the
 * confusable-safe face wherever it is shown, and a sheet that asks "clear the
 * host for ricomaverick?" should point at the word it means (Kike,
 * 2026-09-15). A match counts only when neither neighbour is a character a
 * name or a hostname can contain, so `rico` is not marked inside
 * `ricomaverick` or inside `rico.example.com`.
 */
export function splitAroundName(line: string, name: string): readonly { readonly text: string; readonly isName: boolean }[] {
  if (name === '') return [{ text: line, isName: false }]
  const parts: { text: string; isName: boolean }[] = []
  let kept = 0
  let from = 0
  for (;;) {
    const at = line.indexOf(name, from)
    if (at === -1) break
    from = at + name.length
    if (joins(line, at - 1, -1) || joins(line, from, 1)) continue
    if (at > kept) parts.push({ text: line.slice(kept, at), isName: false })
    parts.push({ text: name, isName: true })
    kept = from
  }
  if (kept < line.length) parts.push({ text: line.slice(kept), isName: false })
  return parts
}

/**
 * Whether the character at `index` continues a name or a hostname rather than
 * ending one. A dot only continues one when a label follows it in the reading
 * direction — otherwise every name at the end of a sentence would look like
 * the head of a hostname and go unmarked.
 */
function joins(line: string, index: number, direction: 1 | -1): boolean {
  const char = line[index]
  if (char === undefined) return false
  if (/[A-Za-z0-9-]/.test(char)) return true
  if (char !== '.') return false
  const next = line[index + direction]
  return next !== undefined && /[A-Za-z0-9]/.test(next)
}
