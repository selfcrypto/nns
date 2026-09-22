/**
 * A fixed-window counter per key, in memory. The endpoints that send mail or
 * mint tokens on request from the open internet are limited per IP and per
 * contact; a restart resets the counters, which is fine for a limit whose
 * job is to stop a loop, not to bill anyone.
 */

export class Limiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>()

  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
  }

  /** Count one hit for `key`; true if it is within the limit. */
  take(key: string): boolean {
    const at = this.now()
    const entry = this.hits.get(key)
    if (entry === undefined || at - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: at })
      return true
    }
    entry.count++
    return entry.count <= this.limit
  }

  /** Forget windows that have closed, so the map does not grow with every IP that ever called. */
  sweep(): void {
    const at = this.now()
    for (const [key, entry] of this.hits) if (at - entry.windowStart >= this.windowMs) this.hits.delete(key)
  }
}
