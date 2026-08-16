/**
 * Token buckets, per key (client IP — the only key an unauthenticated
 * surface has) and one shared for the global broadcast ceiling. Clock
 * injectable; pruning keeps the map from growing with every IP that ever
 * connected.
 */

export interface BucketOptions {
  readonly capacity: number
  readonly refillPerMinute: number
  readonly now?: () => number
}

export interface TakeResult {
  readonly ok: boolean
  readonly retryAfterSec: number
}

export interface Buckets {
  take(key: string): TakeResult
  prune(maxAgeMs?: number): void
  size(): number
}

interface Bucket {
  tokens: number
  updated: number
}

export function createBuckets({ capacity, refillPerMinute, now = Date.now }: BucketOptions): Buckets {
  const buckets = new Map<string, Bucket>()
  const refillPerMs = refillPerMinute / 60_000

  return {
    take(key) {
      const at = now()
      const bucket = buckets.get(key) ?? { tokens: capacity, updated: at }
      bucket.tokens = Math.min(capacity, bucket.tokens + (at - bucket.updated) * refillPerMs)
      bucket.updated = at
      buckets.set(key, bucket)
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return { ok: true, retryAfterSec: 0 }
      }
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)) }
    },
    prune(maxAgeMs = 600_000) {
      const at = now()
      for (const [key, bucket] of buckets) {
        if (at - bucket.updated > maxAgeMs) buckets.delete(key)
      }
    },
    size: () => buckets.size,
  }
}
