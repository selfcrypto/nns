/**
 * What the three long-running loops (`watch`, `ledger`, `issue`) share: how they
 * stop, and how they sit out a source that is not answering.
 *
 * ## Stopping between cycles, never inside one
 *
 * Without a handler, Node's default for SIGTERM is to exit at once, and no
 * `finally` runs. For `issue` that is not a tidiness problem: the hot key is
 * locked in `withSigningKey`'s `finally` (keys.ts), and the node ignores
 * `unlockAccount`'s duration (rpc-reference §5.4), so a `docker stop` that
 * lands between unlock and lock leaves a funded key open to anyone who can
 * reach the RPC until the next payment happens to lock it. The compose file
 * already gives the process `stop_grace_period: 30s` and `init: true`; this is
 * the half that makes the grace period mean something.
 *
 * The first SIGTERM or SIGINT asks the loop to stop at the end of the cycle in
 * progress and cuts a sleep short. A second one gets Node's default, so an
 * operator can still stop a process that is stuck.
 */

import { SourceUnavailable } from './source.js'

export function stopOnSignals(announce: (message: string) => void = console.log): AbortSignal {
  const controller = new AbortController()
  const request = (name: NodeJS.Signals) => () => {
    announce(`${name} received — stopping after the cycle in progress.`)
    controller.abort()
  }
  process.once('SIGTERM', request('SIGTERM'))
  process.once('SIGINT', request('SIGINT'))
  return controller.signal
}

/** Resolves after `ms`, or as soon as `signal` aborts — whichever is first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}

/**
 * Poll, and sit out a source that is not answering — one interval at a time,
 * saying so every time.
 *
 * Returns the poll's result, or `null` when the source was unavailable and
 * the cycle should be skipped. Only {@link SourceUnavailable} is sat out, and
 * only by a long-running loop: every other failure is a statement about the
 * log (a hash, a commitment, a rewind, a fork) and still ends the process,
 * exactly as before. `--once` fails on anything, because a one-shot run has no
 * next cycle to wait for.
 *
 * The skipped cycle prints `(retry in Ns)` and never the loop's own
 * `(next … in Ns)` line, so a supervisor watching for healthy cycles — a push
 * heartbeat, a log alert — still sees an outage that lasts, while a deploy's
 * five-second 502 no longer restarts the process.
 */
export async function pollThroughOutage<T>(
  poll: () => Promise<T>,
  options: { readonly once: boolean; readonly pollSeconds: number; readonly signal?: AbortSignal },
): Promise<T | null> {
  try {
    return await poll()
  } catch (error) {
    if (options.once || !(error instanceof SourceUnavailable)) throw error
    console.error(`${error.name}: ${error.message}`)
    console.log(`(retry in ${options.pollSeconds}s)`)
    await sleep(options.pollSeconds * 1000, options.signal)
    return null
  }
}
