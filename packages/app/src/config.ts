import { CONSTANTS } from '@nns/core'
import { DEFAULT_RESOLVERS, type ResolverEndpoint } from '@nns/resolver'

/**
 * Deployment configuration, from Vite env vars at build time.
 *
 * - `VITE_NNS_RESOLVERS`: JSON array of `{ "name": …, "url": … }`. Appended
 *   after `DEFAULT_RESOLVERS`, never replacing it. Since 2026-09-13 that
 *   default is two public endpoints, so an operator adds only their **own**
 *   box here — and adding one that is already in the default is not a
 *   mistake this file has to catch: `@nns/resolver` drops a repeated URL and
 *   warns on every result.
 * - `VITE_NNS_QUORUM`: how many resolvers must agree. **Defaults to 2**,
 *   `CONSTANTS.RESOLVER_QUORUM`, because the shipped default list now meets
 *   it — the 1 this defaulted to was a deployment fact (one public endpoint
 *   existed) that stopped being true, and a default that silently keeps
 *   enforcing the weaker rule after the reason expired is the worst kind.
 *   `@nns/resolver` still makes a configured shortfall loud on every result;
 *   the UI renders it via the "Verified by N resolvers" line.
 */
export interface AppConfig {
  readonly resolvers: readonly ResolverEndpoint[]
  readonly quorum: number
}

export class ConfigParseError extends Error {
  override readonly name = 'ConfigParseError'
}

/**
 * An endpoint this bundle may talk to: an absolute `http(s)` URL, or a
 * **root-relative path** meaning "the origin that served this bundle".
 *
 * The relative form is what makes the image domain-agnostic. The
 * nginx already serves `/api/` and `/rpc` on the same origin as the bundle, so
 * requiring an absolute URL here was the only thing forcing an operator's
 * hostname into a build arg — and therefore a separate image per domain. With
 * `/api`, one `web` image runs on any hostname and a domain change needs no
 * rebuild. Every consumer concatenates and hands the result to `fetch`
 * (`api.ts`'s `request`, `chatIndex.ts`, `history.ts`'s `fetchTransport`,
 * `@nns/resolver`'s `join`), all of which resolve a relative URL against the
 * document — so nothing downstream has to change.
 *
 * `//host/path` is **rejected**. A protocol-relative URL reads as same-origin
 * and is not: it is an absolute cross-origin request wearing a leading slash,
 * which is exactly the confusion this predicate exists to prevent.
 */
function isEndpointUrl(url: string): boolean {
  return /^https?:\/\//.test(url) || /^\/(?!\/)/.test(url)
}

/** How the three messages below describe an acceptable value. */
const URL_SHAPE = 'an http(s) URL or a same-origin path like /api'

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
    if (typeof url !== 'string' || !isEndpointUrl(url)) {
      throw new ConfigParseError(`VITE_NNS_RESOLVERS[${index}].url must be ${URL_SHAPE}`)
    }
    return { name, url }
  })
}

export function parseQuorum(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return CONSTANTS.RESOLVER_QUORUM
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
 * The operator-run, CORS-open RPC endpoint — read history for the NC inbox
 * (docs/app-chat.md §4), `getBlockNumber` for a validity start height, and
 * `sendRawTransaction` to broadcast what the Hub signed. Allowlist exactly
 * those three upstream. Optional: without it the Inbox shows its setup
 * state and Hub sends cannot broadcast.
 */
export function rpcEndpoint(): string | null {
  const raw = import.meta.env['VITE_NNS_RPC'] as string | undefined
  if (raw === undefined || raw.trim() === '') return null
  if (!isEndpointUrl(raw)) throw new ConfigParseError(`VITE_NNS_RPC must be ${URL_SHAPE}`)
  return raw
}

/**
 * The optional NC chat index. When set, the Inbox
 * reads messages from it instead of pulling each address's whole transaction
 * history from the node — the same messages, without shipping the ~99% that
 * are not chat, and without the 500-transaction window that pull carries.
 *
 * Unset is a supported deployment, not a degraded one: the Inbox falls back to
 * `VITE_NNS_RPC`. An operator runs the index or does not.
 */
export function chatEndpoint(): string | null {
  const raw = import.meta.env['VITE_NNS_CHAT'] as string | undefined
  if (raw === undefined || raw.trim() === '') return null
  if (!isEndpointUrl(raw)) throw new ConfigParseError(`VITE_NNS_CHAT must be ${URL_SHAPE}`)
  return raw.replace(/\/+$/, '')
}

/** The Nimiq Hub the desktop adapter opens popups against. */
export function hubEndpoint(): string {
  const raw = import.meta.env['VITE_NNS_HUB_URL'] as string | undefined
  return raw !== undefined && raw.trim() !== '' ? raw : 'https://hub.nimiq.com'
}

/** Shown by the Hub in every popup. */
export const APP_NAME = 'NNS'
