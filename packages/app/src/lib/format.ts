import { LUNA_PER_NIM } from '@nns/core'

/** Integer luna → NIM display string, trailing zeros trimmed. */
export function lunaToNim(luna: bigint): string {
  const whole = luna / LUNA_PER_NIM
  const frac = luna % LUNA_PER_NIM
  if (frac === 0n) return whole.toString()
  return `${whole}.${frac.toString().padStart(5, '0').replace(/0+$/, '')}`
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

/** Spaced Nimiq address shortened for list rows. Full form belongs anywhere money moves. */
export function ellipsizeAddress(address: string): string {
  const parts = address.split(' ')
  if (parts.length !== 9) return address
  return `${parts[0]} ${parts[1]} … ${parts[8]}`
}
