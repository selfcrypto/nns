import { useEffect, useRef } from 'react'
import type { SearchOutcome } from './search'
import type { Async } from './useAsync'

/** Every `PROPAGATING_RETRY_MS` while the outcome is `propagating`, at most this many times. */
export const PROPAGATING_RETRY_MS = 3_000
export const PROPAGATING_RETRY_LIMIT = 20

/**
 * A `propagating` outcome is the seconds after a change lands, while one
 * resolver has the block and another has not (`QUORUM_LAGGING`). The user
 * has nothing to do about it but wait, so the screen asks again on its own
 * every few seconds — bounded, because a resolver that is genuinely stuck
 * behind would otherwise be polled for as long as the card is open.
 *
 * Returns whether a retry is still scheduled, so the card can say "checking
 * again" only while it is true.
 */
export function useRetryWhilePropagating(outcome: Async<SearchOutcome>, retry: () => void): boolean {
  const attempts = useRef(0)
  const propagating = outcome.status === 'done' && outcome.value.kind === 'propagating'
  if (!propagating) attempts.current = 0
  const retrying = propagating && attempts.current < PROPAGATING_RETRY_LIMIT

  useEffect(() => {
    if (!retrying) return
    const timer = setTimeout(() => {
      attempts.current += 1
      retry()
    }, PROPAGATING_RETRY_MS)
    return () => clearTimeout(timer)
    // `outcome` is the trigger: each answer that is still propagating schedules the next ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome, retrying])

  return retrying
}
