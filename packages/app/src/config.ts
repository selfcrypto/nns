import { DEFAULT_RESOLVERS, type ResolverEndpoint } from '@nns/resolver'

/**
 * Deployment configuration, from Vite env vars at build time.
 *
 * - `VITE_NNS_RESOLVERS`: JSON array of `{ "name": …, "url": … }`. Appended
 *   after `DEFAULT_RESOLVERS`, never replacing it — the day the shipped
 *   default has entries, this app picks them up by upgrading `@nns/resolver`.
 * - `VITE_NNS_QUORUM`: how many resolvers must agree. **Defaults to 1**: the
 *   launch decision (resolver README, "At launch, the quorum is 1") is an
 *   explicit deployment override with a single named operator, and this app
 *   is that deployment. `@nns/resolver` makes the shortfall loud on every
 *   result; the UI renders it via the "Verified by N resolvers" line.
 */
export interface AppConfig {
  readonly resolvers: readonly ResolverEndpoint[]
  readonly quorum: number
}

export class ConfigParseError extends Error {
  override readonly name = 'ConfigParseError'
}

export function parseResolverList(raw: string | undefined): readonly ResolverEndpoint[] {
  if (raw === undefined || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigParseError('VITE_NNS_RESOLVERS is not valid JSON — expected [{"name": "...", "url": "https://..."}]')
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigParseError('VITE_NNS_RESOLVERS must be a JSON array of {name, url} entries')
  }
  return parsed.map((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigParseError(`VITE_NNS_RESOLVERS[${index}] is not an object`)
    }
    const { name, url } = entry as { name?: unknown; url?: unknown }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ConfigParseError(`VITE_NNS_RESOLVERS[${index}].name must be a non-empty string — the name is what disagreement reports show, not decoration`)
    }
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      throw new ConfigParseError(`VITE_NNS_RESOLVERS[${index}].url must be an http(s) URL`)
    }
    return { name, url }
  })
}

export function parseQuorum(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1
  const quorum = Number(raw)
  if (!Number.isInteger(quorum) || quorum < 1) {
    throw new ConfigParseError('VITE_NNS_QUORUM must be a positive integer')
  }
  return quorum
}

export function appConfig(): AppConfig {
  return {
    resolvers: [...DEFAULT_RESOLVERS, ...parseResolverList(import.meta.env['VITE_NNS_RESOLVERS'] as string | undefined)],
    quorum: parseQuorum(import.meta.env['VITE_NNS_QUORUM'] as string | undefined),
  }
}

/**
 * The operator-run, CORS-open, read-only RPC endpoint the NC inbox reads
 * history from (docs/app-chat.md §4). Optional: without it the Inbox shows
 * its setup state and nothing else changes.
 */
export function historyEndpoint(): string | null {
  const raw = import.meta.env['VITE_NNS_HISTORY'] as string | undefined
  if (raw === undefined || raw.trim() === '') return null
  if (!/^https?:\/\//.test(raw)) throw new ConfigParseError('VITE_NNS_HISTORY must be an http(s) URL')
  return raw
}
