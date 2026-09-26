import { CONSTANTS } from '@nimiqnames/core'
import type { PayLinkForm } from './lib/payRequest'
import { DEFAULT_RESOLVERS, type ResolverEndpoint } from '@nimiqnames/resolver'

/**
 * Deployment configuration, from Vite env vars at build time.
 *
 * - `VITE_NNS_RESOLVERS`: JSON array of `{ "name": …, "url": … }`. Appended
 *   after `DEFAULT_RESOLVERS`, never replacing it. Since 2026-09-13 that
 *   default is two public endpoints, so an operator adds only their **own**
 *   box here — and adding one that is already in the default is not a
 *   mistake this file has to catch: `@nimiqnames/resolver` drops a repeated URL and
 *   warns on every result.
 * - `VITE_NNS_QUORUM`: how many resolvers must agree. **Defaults to 2**,
 *   `CONSTANTS.RESOLVER_QUORUM`, because the shipped default list now meets
 *   it — the 1 this defaulted to was a deployment fact (one public endpoint
 *   existed) that stopped being true, and a default that silently keeps
 *   enforcing the weaker rule after the reason expired is the worst kind.
 *   `@nimiqnames/resolver` still makes a configured shortfall loud on every result;
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
 * `@nimiqnames/resolver`'s `join`), all of which resolve a relative URL against the
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
    throw new ConfigParseError('VITE_NNS_RESOLVERS is not valid JSON. Expected [{"name": "...", "url": "https://..."}]')
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
      throw new ConfigParseError(`VITE_NNS_RESOLVERS[${index}].name must be a non-empty string. The name is what disagreement reports show, not decoration.`)
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

/**
 * The optional notification service (`packages/notify`, tasks/26). When set,
 * the corner panel offers Notifications for the acting address and the
 * `#/probe-sign` page can be used. Unset renders nothing: a self-hoster has no
 * notifier, and a control whose fix is a service they do not run is worse
 * than no control (§2.2).
 */
export function notifyEndpoint(): string | null {
  const raw = import.meta.env['VITE_NNS_NOTIFY'] as string | undefined
  if (raw === undefined || raw.trim() === '') return null
  if (!isEndpointUrl(raw)) throw new ConfigParseError(`VITE_NNS_NOTIFY must be ${URL_SHAPE}`)
  return raw.replace(/\/+$/, '')
}

/**
 * Where a transaction can be checked by someone who does not take this app's
 * word for it (Rico, 2026-09-15: *"to give more confidence to the service"*).
 *
 * A **template**, not a base, because the two Nimiq explorers disagree about
 * URL shape and neither is wrong: `https://nimiq.watch/#{hash}` routes on the
 * fragment, `https://www.nimiqhub.com/tx/{hash}` on the path. One placeholder,
 * `{hash}`, absorbs both and anything later.
 *
 * Both were checked in a browser against a real data-carrying transaction
 * before this shipped, because a link that proves a transaction exists while
 * hiding its payload proves nothing about a message: each renders the data
 * under a field labelled *Message*.
 *
 * Set-but-malformed throws rather than falling back. A silent default would
 * turn "the operator chose this" into "nobody noticed", which is the rule
 * every other variable here follows.
 */
const DEFAULT_EXPLORER = 'https://nimiq.watch/#{hash}'

export function parseExplorerTemplate(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_EXPLORER
  const template = raw.trim()
  if (!/^https?:\/\//.test(template)) {
    throw new ConfigParseError('VITE_NNS_EXPLORER must be an http(s) URL')
  }
  if (!template.includes('{hash}')) {
    throw new ConfigParseError('VITE_NNS_EXPLORER must contain {hash}, the placeholder for the transaction hash')
  }
  return template
}

export const explorerTxUrl = (hash: string): string =>
  parseExplorerTemplate(import.meta.env['VITE_NNS_EXPLORER'] as string | undefined).replace('{hash}', hash)

/**
 * The §9 anchor contract and how to read it (`VITE_NNS_ANCHORS`, 2026-09-26).
 * One JSON object:
 *
 * ```json
 * {"chain": "Sepolia", "contract": "0x…", "rpcs": ["https://…", "https://…"],
 *  "publishers": ["0x…"], "lookbackBlocks": 45000, "explorer": "https://…"}
 * ```
 *
 * `chain` is what the page prints — the reader cannot learn it from an
 * endpoint, and "Polygon" hard-coded in a hint was wrong the day the
 * publisher went to Sepolia. `rpcs` needs **two**, for the reason the reader
 * refuses one (§9: a single endpoint can serve a false anchor). `publishers`
 * needs at least one: the reader ignores every address not listed, so a
 * configured contract with nobody listed is a page that says "none" about a
 * chain full of anchors. `lookbackBlocks` defaults to the reader's; public
 * endpoints cap `eth_getLogs` well below that and answer a wider range with
 * an error, so a deployment on one sets it (`deploy/service/.env.example`).
 * `explorer` is a page a reader can check the contract on, optional.
 *
 * Unset is a supported deployment: the Stats page says no chain is
 * configured. Set-but-malformed throws, like every other variable here.
 * Today its only consumer is the Stats page; wiring it into `createResolver`'s
 * `anchors` policy is a separate decision, since that check is a hard stop
 * on every resolve.
 */
export interface AnchorConfig {
  readonly chain: string
  readonly contract: `0x${string}`
  readonly rpcs: readonly string[]
  readonly publishers: readonly string[]
  readonly lookbackBlocks: bigint | null
  readonly explorer: string | null
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function parseAnchorConfig(raw: string | undefined): AnchorConfig | null {
  if (raw === undefined || raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ConfigParseError('VITE_NNS_ANCHORS is not valid JSON. Expected {"chain", "contract", "rpcs", "publishers"}')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigParseError('VITE_NNS_ANCHORS must be a JSON object')
  }
  const { chain, contract, rpcs, publishers, lookbackBlocks, explorer } = parsed as Record<string, unknown>
  if (typeof chain !== 'string' || chain.trim() === '') {
    throw new ConfigParseError('VITE_NNS_ANCHORS.chain must name the chain, as the page prints it (e.g. "Sepolia")')
  }
  if (typeof contract !== 'string' || !EVM_ADDRESS.test(contract)) {
    throw new ConfigParseError('VITE_NNS_ANCHORS.contract must be a 20-byte EVM address')
  }
  if (!Array.isArray(rpcs) || rpcs.length < 2 || !rpcs.every((url) => typeof url === 'string' && isEndpointUrl(url))) {
    throw new ConfigParseError(`VITE_NNS_ANCHORS.rpcs must list at least two endpoints, each ${URL_SHAPE}. One endpoint is not a cross-check (§9)`)
  }
  if (!Array.isArray(publishers) || publishers.length === 0 || !publishers.every((address) => typeof address === 'string' && EVM_ADDRESS.test(address))) {
    throw new ConfigParseError('VITE_NNS_ANCHORS.publishers must list at least one 20-byte EVM address. The reader ignores every address not listed')
  }
  if (lookbackBlocks !== undefined && (!Number.isSafeInteger(lookbackBlocks) || (lookbackBlocks as number) < 1)) {
    throw new ConfigParseError('VITE_NNS_ANCHORS.lookbackBlocks must be a positive integer')
  }
  if (explorer !== undefined && (typeof explorer !== 'string' || !/^https?:\/\//.test(explorer))) {
    throw new ConfigParseError('VITE_NNS_ANCHORS.explorer must be an http(s) URL')
  }
  return {
    chain: chain.trim(),
    contract: contract.toLowerCase() as `0x${string}`,
    rpcs: rpcs as string[],
    publishers: (publishers as string[]).map((address) => address.toLowerCase()),
    lookbackBlocks: lookbackBlocks === undefined ? null : BigInt(lookbackBlocks as number),
    explorer: explorer === undefined ? null : (explorer as string),
  }
}

export const anchorConfig = (): AnchorConfig | null => parseAnchorConfig(import.meta.env['VITE_NNS_ANCHORS'] as string | undefined)

/** The Nimiq Hub the desktop adapter opens popups against. */
export function hubEndpoint(): string {
  const raw = import.meta.env['VITE_NNS_HUB_URL'] as string | undefined
  return raw !== undefined && raw.trim() !== '' ? raw : 'https://hub.nimiq.com'
}

/**
 * Which shape the payment link takes (`lib/payRequest.ts`, `PayLinkForm`).
 * `path` unless told otherwise: it is the shape a chat can draw a card for,
 * and `deploy/service/nginx.conf` answers it. A host serving the bundle with
 * no server rule of its own sets `VITE_NNS_PAY_LINKS=hash`.
 */
export function payLinkForm(): PayLinkForm {
  const raw = import.meta.env['VITE_NNS_PAY_LINKS'] as string | undefined
  return raw?.trim().toLowerCase() === 'hash' ? 'hash' : 'path'
}

/** Shown by the Hub in every popup. */
export const APP_NAME = 'NNS'
