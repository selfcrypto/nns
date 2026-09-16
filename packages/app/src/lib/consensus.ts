/**
 * Whether the node behind our RPC has consensus, asked **once per load**.
 *
 * There is no interval here and there must never be one. The cost of a poll
 * in this app is not one request, it is one request per open client: a
 * one-second chain-height readout shipped on 2026-09-16 and spent the relay's
 * entire per-IP read refill on its own, which 429'd the next send — and the
 * per-client multiplication would have reached the node itself long before
 * the rate limiter was the thing anyone noticed (Kike, same day: *"a lot of
 * people accessing all at the same time would burn the RPC"*). One node sits
 * behind one credential. The read budget is a backstop against abuse, not a
 * licence to spend up to it.
 *
 * So this asks on mount and then stops. The answer is a statement about the
 * moment the app loaded, which is all a liveness light needs to be: a session
 * that starts against a healthy node and a session that starts against a dead
 * one are the two cases worth telling apart, and a reload is what re-asks.
 *
 * `isConsensusEstablished` rather than a height, because a node **without**
 * consensus still answers `getBlockNumber`, with a stale one. The height
 * proves the relay replied; only this proves the node is actually following
 * the chain. It joined the relay's allowlist for this
 * (`relay/src/allowlist.ts`, 2026-09-16).
 */

import { useEffect, useState } from 'react'
import { defaultTransport } from './history'

/**
 * `null` while the question is out or when it could not be asked at all.
 * A failed request is **not** `false`: "we could not reach the relay" and
 * "the node told us it has no consensus" are different facts, and only the
 * second is news about the chain.
 */
export type Consensus = boolean | null

/** The node's own answer, or null for anything that is not a boolean. */
export function parseConsensus(answer: unknown): Consensus {
  return typeof answer === 'boolean' ? answer : null
}

/**
 * The one in-flight ask, shared by every caller for the life of the page.
 *
 * `IdentityBar` mounts more than once — the masthead's corner and an
 * empty-state card can both be on screen — and a per-instance `useEffect`
 * would make the request count a function of the layout. Memoising the
 * promise at module scope makes "once per load" true by construction rather
 * than by each caller remembering, which is the property that has to hold.
 */
let asked: Promise<Consensus> | null = null

function askOnce(): Promise<Consensus> {
  asked ??= (() => {
    const transport = defaultTransport()
    if (transport === null) return Promise.resolve<Consensus>(null)
    // Unreachable is not "no consensus": the light stays unlit instead.
    return transport('isConsensusEstablished', []).then(parseConsensus, () => null)
  })()
  return asked
}

/** For tests, which must not inherit a previous case's answer. */
export function resetConsensusForTest(): void {
  asked = null
}

/** Asked once per page load, shared across every caller. Never on a timer. */
export function useConsensus(): Consensus {
  const [consensus, setConsensus] = useState<Consensus>(null)

  useEffect(() => {
    let cancelled = false
    void askOnce().then((answer) => {
      if (!cancelled) setConsensus(answer)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return consensus
}
