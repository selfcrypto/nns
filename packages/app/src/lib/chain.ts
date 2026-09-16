/**
 * The chain's own numbers, live, for the strip under the masthead.
 *
 * Two heights, and the distance between them is the wait every send has been
 * explaining in words. The chain's head moves every second; the registry
 * advances one whole batch at a time (`FINALITY_RULE` — the indexer never
 * takes state past the last finalised macro block, `indexer/src/chain.ts`),
 * so the registry trails the head by up to a batch and jumps 60 at a time.
 * Showing both says *why* a confirmation takes a minute, without the app
 * claiming anything about what the network did.
 *
 * Neither number costs new plumbing. `getBlockNumber` is one of the relay's
 * five allowlisted methods (`relay/src/allowlist.ts`) and the app already
 * sends it for a validity start height (`wallet.ts`); the registry's height
 * rides on `/params`, which three screens fetch already.
 *
 * **Consensus and the network id are deliberately absent.** Both are SDK
 * reads (`sdk.ts`: `isConsensusEstablished`, `getNetwork`), the SDK's provider
 * is not on `Wallet`, and neither earns widening the app's central wallet
 * abstraction: consensus reads "established" on every sample a user will ever
 * see, and a head that stops ticking says a node is in trouble more loudly
 * than a green pill does. Outside Pay they are not available at all — the
 * relay serves neither method, and a field the browser build has to invent is
 * worse than one it does not show.
 */

import { useEffect, useState } from 'react'
import { apiBase } from './nns'
import { getParams } from './api'
import { defaultTransport } from './history'

/**
 * **The relay's read budget is what sets this, not the block time.**
 *
 * `relay/src/server.ts` gives each client IP a bucket of capacity 30
 * refilling at 60 a minute: one token per second, sustained. This strip
 * polled the head every 1,000 ms, which spends that entire allowance on
 * chrome and leaves nothing for the app's real reads. What that looks like
 * is not a slow strip, it is a **send that cannot go out**: a Hub transfer
 * needs `getBlockNumber` for its validity height and then
 * `sendRawTransaction`, and both came back 429 with the bucket pinned at
 * zero (Kike, 2026-09-16, mid demo prep, on a name he was transferring). Two
 * tabs made it two tokens a second against a one-a-second refill.
 *
 * Ten seconds is 6 reads a minute, a tenth of the refill, so the strip is
 * never the reason something else is refused. The head is a number that
 * moves on its own and nobody is reading it to the second; a send that
 * fails is the only thing here anyone would actually notice.
 */
const CHAIN_INTERVAL_MS = 10_000

/**
 * A height, or null for anything that is not one. The RPC answers a number;
 * everything else — an error body that got this far, a null, a string — is
 * not a height and must not be rendered as one.
 */
export function parseHeight(answer: unknown): number | null {
  return typeof answer === 'number' && Number.isInteger(answer) && answer > 0 ? answer : null
}

/**
 * How far the registry trails the chain, or null when either number is
 * missing. Negative is clamped away rather than shown: the two heights come
 * from two services sampled at different moments, and a registry that reads
 * one block ahead of a stale head is a sampling artefact, not news.
 */
export function registryLag(head: number | null, registry: number | null): number | null {
  if (head === null || registry === null) return null
  return Math.max(0, head - registry)
}

/**
 * Poll a value, keeping the last good answer when a poll fails.
 *
 * A failed request leaves the previous number on screen deliberately. The
 * strip reports the chain, and one unanswered fetch is not a fact about the
 * chain — blanking on it would make a flaky connection look like a stalled
 * network. What a genuinely stalled node looks like here is the number
 * sitting still, which is what it should look like.
 */
function usePolled<T>(read: () => Promise<T | null>, intervalMs: number): T | null {
  const [value, setValue] = useState<T | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const next = await read()
        if (!stopped && next !== null) setValue(next)
      } catch {
        // Keep the last good value; the next round asks again.
      }
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
    }
    void tick()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is re-created per render by design; the interval is the key
  }, [intervalMs])

  return value
}

export interface ChainStatus {
  /** The chain's head, or null until the first answer (and forever without an RPC). */
  readonly head: number | null
  /** The height the registry has verified: the last finalised macro block it scanned. */
  readonly registry: number | null
}

/**
 * Both heights, read in one tick.
 *
 * Together rather than on two schedules, because the strip subtracts them.
 * Sampled apart, the fresher number walks away from the stale one and the
 * gap becomes a statement about this file's polling rather than about the
 * chain: a registry read 5 s after a 15 s-old head can even overtake it,
 * which `registryLag` would clamp to "up to date" while the registry was
 * genuinely a batch behind.
 */
export function useChainStatus(): ChainStatus {
  const status = usePolled<ChainStatus>(async () => {
    const transport = defaultTransport()
    const [head, registry] = await Promise.all([
      transport === null
        ? Promise.resolve(null)
        : transport('getBlockNumber', []).then(parseHeight, () => null),
      getParams(apiBase()).then(
        (params) => parseHeight(params.height),
        () => null,
      ),
    ])
    // One endpoint answering is worth rendering; neither is not, and
    // returning null keeps the last good pair on screen.
    return head === null && registry === null ? null : { head, registry }
  }, CHAIN_INTERVAL_MS)

  return status ?? { head: null, registry: null }
}
