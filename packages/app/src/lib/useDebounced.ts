import { useEffect, useState } from 'react'

/**
 * The search box queries as it is typed, so it needs to know when typing has
 * stopped. Hand-rolled rather than depended on: a debounce is nine lines, and
 * this package's dependency discipline is the §2.2 argument that
 * every package in an app whose product is "trust this address" is
 * supply-chain surface.
 *
 * Returns the settled value and a `flush` that adopts the live one at once —
 * the Lookup button and Enter are explicit intent and must not wait out the
 * delay.
 *
 * The delay is not cosmetic. Each settled value is a real `available()` or
 * `resolve()` with a Merkle proof to verify, and the resolver behind `/api/`
 * rate-limits nothing, so this is what keeps a typed word to one request
 * instead of one per character.
 */
export function useDebounced<T>(value: T, ms: number): [T, () => void] {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    if (value === settled) return
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
    // `settled` is deliberately out of the dep list: including it restarts the
    // timer on its own commit, which is a loop, not a debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ms])

  return [settled, () => setSettled(value)]
}
