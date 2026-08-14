import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { createFilebaseAdd, signV4, type FilebaseEndpoint } from './filebase.js'
import { IpfsError } from './ipfs.js'

const CID = 'bafybeicg2rebjoofv4kbyovkw7af3rpiitvnl6i7ckcywaq6xjcxnc2mby'
const BODY = utf8ToBytes('hello world\n')
const BODY_HASH = 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447'

// AWS SigV4 test-vector credentials — the well-known documentation pair,
// never a real secret.
const ACCESS = 'AKIDEXAMPLE'
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'

const ENDPOINT: FilebaseEndpoint = {
  bucket: 'nns-anchor-test',
  accessKey: ACCESS,
  secretKey: SECRET,
  endpoint: 'https://s3.filebase.com',
  label: 'filebase',
}

/** 2026-08-14T03:00:00Z, the instant both pinned signatures were minted at. */
const CLOCK = () => new Date('2026-08-14T03:00:00Z')

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
}

function capture(
  respond: (call: Captured) => Response,
): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  return {
    calls,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const call: Captured = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
      }
      calls.push(call)
      return respond(call)
    }) as typeof fetch,
  }
}

const ok = () => new Response('', { status: 200, headers: { 'x-amz-meta-cid': CID } })
const deleted = () => new Response(null, { status: 204 })

describe('signV4', () => {
  // Both expected strings were produced independently by the `aws4`
  // reference library (2026-08-14) over the same inputs — the seam that
  // keeps this hand-rolled signer honest.

  it('matches the aws4 reference signature for a PUT', () => {
    expect(
      signV4(
        {
          method: 'PUT',
          host: 's3.filebase.com',
          path: '/nns-anchor-test/nns-log-abc123',
          payloadHash: BODY_HASH,
          amzDate: '20260814T030000Z',
          dateStamp: '20260814',
        },
        ACCESS,
        SECRET,
      ),
    ).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260814/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=1f9baed53eced1e2cd3ddf5daa3714f0594af3c7b867713934df3309f71c6bab',
    )
  })

  it('matches the aws4 reference signature for an empty-body DELETE', () => {
    expect(
      signV4(
        {
          method: 'DELETE',
          host: 's3.filebase.com',
          path: '/nns-anchor-test/dryrun-nns-log-abc123',
          payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          amzDate: '20260814T030000Z',
          dateStamp: '20260814',
        },
        ACCESS,
        SECRET,
      ),
    ).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260814/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=67d433a838da6646edfc49b328ed3968e9638cbe41b0cdc0ffb0b63f84051d4d',
    )
  })
})

describe('createFilebaseAdd', () => {
  it('PUTs to a content-derived key and returns the CID Filebase reports', async () => {
    const { fetch, calls } = capture(ok)
    const add = createFilebaseAdd(ENDPOINT, fetch, CLOCK)

    await expect(add.add(BODY, { pin: true })).resolves.toBe(CID)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    const key = `nns-log-${bytesToHex(sha256(BODY)).slice(0, 32)}`
    expect(call.url).toBe(`https://s3.filebase.com/nns-anchor-test/${key}`)
    expect(call.method).toBe('PUT')
    expect(call.headers['x-amz-content-sha256']).toBe(BODY_HASH)
    expect(call.headers['x-amz-date']).toBe('20260814T030000Z')
    // The header is fully deterministic here, so pin it end to end.
    expect(call.headers['authorization']).toBe(
      signV4(
        {
          method: 'PUT',
          host: 's3.filebase.com',
          path: `/nns-anchor-test/${key}`,
          payloadHash: BODY_HASH,
          amzDate: '20260814T030000Z',
          dateStamp: '20260814',
        },
        ACCESS,
        SECRET,
      ),
    )
  })

  it('pin: false uploads under a dry-run key and deletes it afterwards', async () => {
    // The prefix is load-bearing: the content-derived key means a dry run
    // after a real send would otherwise delete the pinned object.
    const { fetch, calls } = capture((call) => (call.method === 'PUT' ? ok() : deleted()))
    const add = createFilebaseAdd(ENDPOINT, fetch, CLOCK)

    await expect(add.add(BODY, { pin: false })).resolves.toBe(CID)

    const key = `dryrun-nns-log-${bytesToHex(sha256(BODY)).slice(0, 32)}`
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', `https://s3.filebase.com/nns-anchor-test/${key}`],
      ['DELETE', `https://s3.filebase.com/nns-anchor-test/${key}`],
    ])
    expect(calls[1]!.headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('refuses a response without x-amz-meta-cid — the header is the whole contract', async () => {
    const { fetch } = capture(() => new Response('', { status: 200 }))
    const add = createFilebaseAdd(ENDPOINT, fetch, CLOCK)
    await expect(add.add(BODY, { pin: true })).rejects.toThrow(/x-amz-meta-cid/)
  })

  it('names the service on an HTTP failure, and on a failed dry-run cleanup', async () => {
    const failing = createFilebaseAdd(ENDPOINT, capture(() => new Response('denied', { status: 403 })).fetch, CLOCK)
    await expect(failing.add(BODY, { pin: true })).rejects.toThrow(/filebase.*403/)

    const badCleanup = createFilebaseAdd(
      ENDPOINT,
      capture((call) => (call.method === 'PUT' ? ok() : new Response('', { status: 500 }))).fetch,
      CLOCK,
    )
    await expect(badCleanup.add(BODY, { pin: false })).rejects.toThrow(IpfsError)
  })
})
