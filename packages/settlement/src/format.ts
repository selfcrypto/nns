/** The two report formatters share these; neither computes on them. */

/** 1 NIM = 100,000 luna, and luna is `bigint`. Rendered, never computed on. */
export function nim(luna: bigint): string {
  const negative = luna < 0n
  const magnitude = negative ? -luna : luna
  const whole = magnitude / 100_000n
  const fraction = (magnitude % 100_000n).toString().padStart(5, '0')
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`
}

/** Width of `formatAddress` output: 36 characters in nine groups, eight spaces. */
export const ADDRESS_COLUMN = 44
