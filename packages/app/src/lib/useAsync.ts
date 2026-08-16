import { useEffect, useState } from 'react'

export type Async<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'error'; readonly error: unknown }

/**
 * The app's whole data-fetching machinery. Pass `null` to stay idle. The
 * cancelled flag only prevents a stale write; nothing is aborted mid-flight —
 * the resolver instance carries its own timeouts.
 */
export function useAsync<T>(run: (() => Promise<T>) | null, deps: readonly unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: 'idle' })

  useEffect(() => {
    if (run === null) {
      setState({ status: 'idle' })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    run().then(
      (value) => {
        if (!cancelled) setState({ status: 'done', value })
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', error })
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's cache key
  }, deps)

  return state
}
