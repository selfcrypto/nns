/**
 * The IPFS surface the publisher uses: hand bytes to a service, get the CID
 * string *it* minted back.
 *
 * This package never derives a CID from bytes — §8.2 reserves that for
 * reference implementations, and "The CID is a locator, not a verifier"
 * (`docs/decisions.md`) is the argument. The §8.2 mitigation for a
 * misconfigured or buggy service is operational and lives in `publish.ts`:
 * the same snapshot goes through **two independent implementations**, and a
 * disagreement between them is a hard stop, never a choice of one.
 *
 * The edge speaks the kubo RPC (`POST /api/v0/add`), which kubo itself and
 * several pinning providers expose. Every §8.2 DAG parameter is passed
 * explicitly — most deliberately `raw-leaves=false`, because kubo flips raw
 * leaves **on** the moment `cid-version=1` is given, and a raw-leaves root
 * for a single-chunk snapshot has the wrong codec entirely.
 */

export class IpfsError extends Error {
  override readonly name = 'IpfsError'
}

export interface AddOptions {
  /**
   * `pin: true` stores and pins — the send path, run before broadcasting so
   * the anchored digest never points at nothing. `pin: false` asks the
   * service to compute the CID without keeping the content (`only-hash`),
   * which is what lets a dry run exercise the two-implementation agreement
   * check with no side effect.
   */
  readonly pin: boolean
}

export interface IpfsAdd {
  /** For operator-facing messages: which service said what. */
  readonly label: string
  /** Returns the CID string the service minted for these bytes. */
  add(bytes: Uint8Array, options: AddOptions): Promise<string>
}

/** §8.2's parameter table as kubo RPC query settings, pinned in one place. */
export const KUBO_ADD_PARAMS: Readonly<Record<string, string>> = {
  'cid-version': '1',
  'raw-leaves': 'false',
  chunker: 'size-262144',
  hash: 'sha2-256',
  trickle: 'false',
  'inline': 'false',
}

export interface KuboEndpoint {
  /** Base URL of the kubo RPC, e.g. `http://127.0.0.1:5001`. */
  readonly url: string
  /** Verbatim `Authorization` header value, for services that need one. */
  readonly auth?: string | undefined
  readonly label: string
}

export function createKuboAdd(endpoint: KuboEndpoint, fetchImpl: typeof fetch = fetch): IpfsAdd {
  const base = endpoint.url.replace(/\/+$/, '')

  return {
    label: endpoint.label,
    async add(bytes: Uint8Array, options: AddOptions): Promise<string> {
      const query = new URLSearchParams(KUBO_ADD_PARAMS)
      query.set('pin', options.pin ? 'true' : 'false')
      if (!options.pin) query.set('only-hash', 'true')

      const form = new FormData()
      // The copy pins the type to a non-shared buffer and detaches the part
      // from whatever view the caller holds. The log is ~15 MB at the
      // ceiling; a copy an hour is nothing.
      form.append('file', new Blob([new Uint8Array(bytes)]), 'nns-log')

      const response = await fetchImpl(`${base}/api/v0/add?${query.toString()}`, {
        method: 'POST',
        body: form,
        headers: endpoint.auth === undefined ? {} : { authorization: endpoint.auth },
      })
      if (!response.ok) {
        throw new IpfsError(`${endpoint.label}: add answered ${response.status} ${await response.text()}`)
      }

      // One JSON object per line; a single file yields one, and the last
      // line is the root either way.
      const text = (await response.text()).trim()
      const last = text.split('\n').at(-1)
      if (last === undefined || last === '') throw new IpfsError(`${endpoint.label}: add answered an empty body`)
      let hash: unknown
      try {
        hash = (JSON.parse(last) as Record<string, unknown>)['Hash']
      } catch {
        throw new IpfsError(`${endpoint.label}: add answered non-JSON: ${last.slice(0, 200)}`)
      }
      if (typeof hash !== 'string' || hash === '') {
        throw new IpfsError(`${endpoint.label}: add answered no Hash field`)
      }
      return hash
    },
  }
}
