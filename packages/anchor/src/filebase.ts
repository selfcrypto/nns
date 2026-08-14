/**
 * Implementation B, named: Filebase, over its S3-compatible API.
 *
 * Filebase runs its own UnixFS importer behind an S3 `PUT` and **reports the
 * CID it minted in the `x-amz-meta-cid` response header** — that header is
 * the whole reason this edge can sit behind {@link IpfsAdd}. Its import
 * parameters are not ours to set, which is exactly why the §8.2
 * two-implementation gate in `publish.ts` is the check this edge must
 * satisfy on every run: the reported CID must equal implementation A's byte
 * for byte and parse under `core.digestFromCid`, or the publisher
 * hard-stops. Nothing Filebase-specific exists outside this module;
 * swapping the second implementation is an environment change alone.
 *
 * The request signing is AWS SigV4 (region `us-east-1`, service `s3`,
 * path-style), hand-rolled over `@noble/hashes` — three signed headers,
 * pinned in `filebase.test.ts` against signatures independently produced by
 * the `aws4` reference library. Credentials are env-only and never leave
 * this module.
 *
 * `pin: false` (the dry-run mode) has no S3 equivalent of kubo's
 * `only-hash`, so this edge uploads under a separate `dryrun-` key and
 * deletes it after reading the CID — the separate prefix is load-bearing:
 * the content-derived key means a dry run after a real send would otherwise
 * delete the very object the anchor points at.
 */

import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { IpfsError, type AddOptions, type IpfsAdd } from './ipfs.js'

export interface FilebaseEndpoint {
  readonly bucket: string
  readonly accessKey: string
  readonly secretKey: string
  /** The service's fixed address; overridable for tests. */
  readonly endpoint: string
  readonly label: string
}

export const FILEBASE_ENDPOINT_DEFAULT = 'https://s3.filebase.com'

const SIGNED_HEADERS = 'host;x-amz-content-sha256;x-amz-date'
const EMPTY_HASH = bytesToHex(sha256(new Uint8Array(0)))

const hex = (bytes: Uint8Array): string => bytesToHex(bytes)

/** 20260814T030000Z / 20260814 from a Date, the two SigV4 spellings. */
function amzDates(clock: () => Date): { amzDate: string; dateStamp: string } {
  const iso = clock().toISOString() // 2026-08-14T03:00:00.000Z
  const amzDate = `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

interface SignInput {
  readonly method: 'PUT' | 'DELETE'
  readonly host: string
  readonly path: string
  readonly payloadHash: string
  readonly amzDate: string
  readonly dateStamp: string
}

export function signV4(input: SignInput, accessKey: string, secretKey: string): string {
  const canonicalHeaders =
    `host:${input.host}\n` +
    `x-amz-content-sha256:${input.payloadHash}\n` +
    `x-amz-date:${input.amzDate}\n`
  const canonicalRequest = [input.method, input.path, '', canonicalHeaders, SIGNED_HEADERS, input.payloadHash].join(
    '\n',
  )
  const scope = `${input.dateStamp}/us-east-1/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, hex(sha256(utf8ToBytes(canonicalRequest)))].join(
    '\n',
  )
  const kDate = hmac(sha256, utf8ToBytes(`AWS4${secretKey}`), utf8ToBytes(input.dateStamp))
  const kRegion = hmac(sha256, kDate, utf8ToBytes('us-east-1'))
  const kService = hmac(sha256, kRegion, utf8ToBytes('s3'))
  const kSigning = hmac(sha256, kService, utf8ToBytes('aws4_request'))
  const signature = hex(hmac(sha256, kSigning, utf8ToBytes(stringToSign)))
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`
}

export function createFilebaseAdd(
  endpoint: FilebaseEndpoint,
  fetchImpl: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
): IpfsAdd {
  const base = new URL(endpoint.endpoint)
  const host = base.host

  async function request(method: 'PUT' | 'DELETE', key: string, body: Uint8Array | null): Promise<Response> {
    const payloadHash = body === null ? EMPTY_HASH : hex(sha256(body))
    const { amzDate, dateStamp } = amzDates(clock)
    const path = `/${endpoint.bucket}/${key}`
    const authorization = signV4(
      { method, host, path, payloadHash, amzDate, dateStamp },
      endpoint.accessKey,
      endpoint.secretKey,
    )
    return await fetchImpl(`${base.origin}${path}`, {
      method,
      headers: {
        authorization,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
      },
      ...(body === null ? {} : { body: new Uint8Array(body) }),
    })
  }

  return {
    label: endpoint.label,
    async add(bytes: Uint8Array, options: AddOptions): Promise<string> {
      // Content-derived key: the same snapshot always lands on the same
      // object, so a re-run overwrites instead of accumulating, and the
      // dry-run prefix keeps `pin: false` cleanup away from pinned objects.
      const key = `${options.pin ? '' : 'dryrun-'}nns-log-${hex(sha256(bytes)).slice(0, 32)}`

      const response = await request('PUT', key, bytes)
      if (!response.ok) {
        throw new IpfsError(`${endpoint.label}: PUT answered ${response.status} ${await response.text()}`)
      }
      const cid = response.headers.get('x-amz-meta-cid')
      if (cid === null || cid === '') {
        throw new IpfsError(
          `${endpoint.label}: response carried no x-amz-meta-cid header — the endpoint is not an ` +
            'IPFS-backed Filebase bucket, or the API changed. Nothing can be anchored through it.',
        )
      }

      if (!options.pin) {
        const cleanup = await request('DELETE', key, null)
        // 204 is the S3 success; failing to clean up a dry-run object is
        // loud because "dry run stores nothing" is a promise, not a hope.
        if (!cleanup.ok && cleanup.status !== 404) {
          throw new IpfsError(
            `${endpoint.label}: dry-run cleanup DELETE answered ${cleanup.status} — object ${key} may remain`,
          )
        }
      }
      return cid
    },
  }
}
