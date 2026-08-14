import { formatAddress } from '@nns/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DelegateError, LookupError, ProofError, QuorumError } from './errors.js'
import { NnsResolver } from './resolve.js'
import { CHECKPOINT_HEIGHT, address, availableJson, record, resolveJson, rootHex } from './test-fixtures.js'
import type { HttpFetch, ResolverEndpoint } from './transport.js'

// ── A network made of functions ─────────────────────────────────────────────

type Reply = { readonly status: number; readonly body: unknown } | 'unreachable'
type Host = (path: string) => Reply

function fakeFetch(hosts: Record<string, Host>): HttpFetch {
  return async (url) => {
    const parsed = new URL(url)
    const host = hosts[parsed.host]
    if (host === undefined) throw new Error(`no stub for ${parsed.host}`)
    const reply = host(parsed.pathname)
    if (reply === 'unreachable') throw new Error('ECONNREFUSED')
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    }
  }
}

const serves = (body: unknown, status = 200): Host => () => ({ status, body })

/**
 * A host that answers `/resolve/...` with `body` and `/checkpoints/{h}` from
 * `checkpoints` — what a real API does, and what §8.5 #2's cross-height
 * comparison needs to exist before it can run.
 */
const servesWithCheckpoints = (body: unknown, checkpoints: Record<number, Reply>): Host =>
  (path) => {
    const match = /^\/checkpoints\/([0-9]+)$/.exec(path)
    if (match === null) return { status: 200, body }
    return checkpoints[Number(match[1])] ?? { status: 404, body: { error: 'CHECKPOINT_PENDING' } }
  }

/** A `/checkpoints/{height}` 200 body, as `packages/api` serves it. */
const checkpointBody = (height: number, nameRoot: string) => ({
  status: 200,
  body: {
    checkpoint: {
      height,
      layout: 3,
      nameRoot,
      pricesRoot: `0x${'11'.repeat(32)}`,
      pendingRoot: `0x${'22'.repeat(32)}`,
      unreservedRoot: `0x${'33'.repeat(32)}`,
      logHash: `0x${'44'.repeat(32)}`,
      commitment: `0x${'55'.repeat(32)}`,
    },
    height,
  },
})

const A: ResolverEndpoint = { name: 'reference', url: 'https://a.example' }
const B: ResolverEndpoint = { name: 'community', url: 'https://b.example' }
const C: ResolverEndpoint = { name: 'third', url: 'https://c.example/' }

const RECORDS = [record('alpha'), record('kikeee', { target: address(5) }), record('zulued')]
const WIDER = [...RECORDS, record('mikeee')]

const resolverOver = (hosts: Record<string, Host>, endpoints: readonly ResolverEndpoint[] = [A, B], quorum?: number) =>
  new NnsResolver({
    resolvers: endpoints,
    ...(quorum === undefined ? {} : { quorum }),
    fetch: fakeFetch(hosts),
    onWarning: () => {},
  })

afterEach(() => {
  vi.restoreAllMocks()
})

// ── resolve ─────────────────────────────────────────────────────────────────

describe('resolve', () => {
  it('returns PROVEN when two resolvers agree and the proof verifies', async () => {
    const body = resolveJson(RECORDS, 'kikeee')
    const result = await resolverOver({ 'a.example': serves(body), 'b.example': serves(body) }).resolve('kikeee')

    expect(result.verification).toBe('PROVEN')
    expect(result.address).toBe(address(5))
    expect(result.quorum).toMatchObject({ required: 2, queried: 2, agreed: 2, resolvers: ['reference', 'community'] })
    expect(result.checkpoint?.height).toBe(CHECKPOINT_HEIGHT)
  })

  it('returns PROOF_PENDING without complaint when no checkpoint proves the name yet', async () => {
    // §8.7: the name is registered, resolves and takes payments. The proof is
    // simply not due. This must not read as an error anywhere.
    const body = resolveJson(RECORDS, 'kikeee', { proof: false })
    const result = await resolverOver({ 'a.example': serves(body), 'b.example': serves(body) }).resolve('kikeee')

    expect(result.verification).toBe('PROOF_PENDING')
    expect(result.address).toBe(address(5))
    expect(result.warnings.map((w) => w.code)).toContain('PROOF_PENDING')
    expect(result.checkpoint).toBeNull()
  })

  it('halts on a tampered proof even though the other resolver is honest', async () => {
    // The tempting behaviour is to drop the liar and answer from the honest
    // one. That would let whoever controls a single resolver degrade the
    // quorum silently, which is the hole §8.5 #2 exists to close.
    const honest = resolveJson(RECORDS, 'kikeee')
    const forged = resolveJson(RECORDS, 'kikeee')
    ;(forged['proof'] as Record<string, unknown>)['target'] = formatAddress(address(66))

    const resolver = resolverOver({ 'a.example': serves(honest), 'b.example': serves(forged) })
    await expect(resolver.resolve('kikeee')).rejects.toThrow(ProofError)
  })

  it('halts when resolvers give different answers', async () => {
    const a = resolveJson(RECORDS, 'kikeee')
    const b = resolveJson(RECORDS, 'kikeee', { live: { target: address(6) } })

    const error = await resolverOver({ 'a.example': serves(a), 'b.example': serves(b) })
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(QuorumError)
    expect((error as QuorumError).code).toBe('QUORUM_DISAGREEMENT')
    expect((error as QuorumError).replies.map((r) => r.resolver)).toEqual(['reference', 'community'])
  })

  it('halts when two resolvers publish different roots for the same checkpoint', async () => {
    const a = resolveJson(RECORDS, 'kikeee')
    // A real proof, from a genuinely different tree, at the same height. Both
    // verify against their own roots; both cannot be the same checkpoint.
    const b = resolveJson(WIDER, 'kikeee')

    const error = await resolverOver({ 'a.example': serves(a), 'b.example': serves(b) })
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect((error as QuorumError).code).toBe('QUORUM_ROOT_MISMATCH')
  })

  it('compares roots across checkpoint heights via /checkpoints/{height}', async () => {
    // §8.5 #2's root half used to be skipped whenever the resolvers were a
    // boundary apart — which is the normal case, so the check that catches a
    // divergent operator almost never ran. The ahead resolver is now asked
    // what it had at the behind one's boundary.
    const a = resolveJson(RECORDS, 'kikeee')
    const b = resolveJson(RECORDS, 'kikeee')
    ;(b['proof'] as Record<string, unknown>)['nimiq_height'] = CHECKPOINT_HEIGHT - 720
    const agreed = rootHex(RECORDS)

    const result = await resolverOver({
      'a.example': servesWithCheckpoints(a, { [CHECKPOINT_HEIGHT - 720]: checkpointBody(CHECKPOINT_HEIGHT - 720, agreed) }),
      'b.example': serves(b),
    }).resolve('kikeee')

    expect(result.verification).toBe('PROVEN')
    // The comparison ran and passed, so the warning is gone entirely.
    expect(result.warnings.map((w) => w.code)).not.toContain('ROOT_HEIGHTS_DIFFER')
    expect(result.checkpoint?.height).toBe(CHECKPOINT_HEIGHT)
  })

  it('halts when the ahead resolver had a different root at the behind one’s boundary', async () => {
    // Not lag: both parties reached that boundary and disagree about what was
    // in it. The same hard failure as a same-height mismatch.
    const a = resolveJson(RECORDS, 'kikeee')
    const b = resolveJson(RECORDS, 'kikeee')
    ;(b['proof'] as Record<string, unknown>)['nimiq_height'] = CHECKPOINT_HEIGHT - 720

    const error = await resolverOver({
      'a.example': servesWithCheckpoints(a, {
        [CHECKPOINT_HEIGHT - 720]: checkpointBody(CHECKPOINT_HEIGHT - 720, `0x${'ab'.repeat(32)}`),
      }),
      'b.example': serves(b),
    })
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect((error as QuorumError).code).toBe('QUORUM_ROOT_MISMATCH')
    expect((error as QuorumError).message).toContain(String(CHECKPOINT_HEIGHT - 720))
  })

  it('keeps the warning, with a reason, when the ahead resolver cannot serve that height', async () => {
    // An absent checkpoint is never read as agreement. 410 means this server
    // does not retain it — ask another one, do not assume it matched.
    const a = resolveJson(RECORDS, 'kikeee')
    const b = resolveJson(RECORDS, 'kikeee')
    ;(b['proof'] as Record<string, unknown>)['nimiq_height'] = CHECKPOINT_HEIGHT - 720

    const result = await resolverOver({
      'a.example': servesWithCheckpoints(a, {
        [CHECKPOINT_HEIGHT - 720]: { status: 410, body: { error: 'CHECKPOINT_NOT_RETAINED' } },
      }),
      'b.example': serves(b),
    }).resolve('kikeee')

    expect(result.verification).toBe('PROVEN')
    const warning = result.warnings.find((w) => w.code === 'ROOT_HEIGHTS_DIFFER')
    expect(warning?.detail).toContain('CHECKPOINT_NOT_RETAINED')
    expect(warning?.detail).toContain('reference')
  })

  it('keeps the warning when the ahead resolver is unreachable for the second round-trip', async () => {
    const a = resolveJson(RECORDS, 'kikeee')
    const b = resolveJson(RECORDS, 'kikeee')
    ;(b['proof'] as Record<string, unknown>)['nimiq_height'] = CHECKPOINT_HEIGHT - 720

    const result = await resolverOver({
      'a.example': (path) => (path.startsWith('/checkpoints/') ? 'unreachable' : { status: 200, body: a }),
      'b.example': serves(b),
    }).resolve('kikeee')

    expect(result.verification).toBe('PROVEN')
    expect(result.warnings.map((w) => w.code)).toContain('ROOT_HEIGHTS_DIFFER')
  })

  it('does not make the extra round-trip when the resolvers are at the same height', async () => {
    // The comparison costs a request per ahead resolver, and the common case
    // needs none: same height is already compared directly.
    const body = resolveJson(RECORDS, 'kikeee')
    const paths: string[] = []
    const spy = (b: unknown): Host => (path) => {
      paths.push(path)
      return { status: 200, body: b }
    }
    const result = await resolverOver({ 'a.example': spy(body), 'b.example': spy(body) }).resolve('kikeee')

    expect(result.verification).toBe('PROVEN')
    expect(paths.some((p) => p.startsWith('/checkpoints/'))).toBe(false)
  })

  it('reports pending depth, not proof, when the target changed since the checkpoint', async () => {
    const body = resolveJson(RECORDS, 'kikeee', { live: { target: address(6) } })
    const result = await resolverOver({ 'a.example': serves(body), 'b.example': serves(body) }).resolve('kikeee')

    // The proof verified — for the old target. Calling this "verified
    // on-chain" would be false about the address the user is about to pay.
    expect(result.verification).toBe('PROOF_PENDING')
    expect(result.address).toBe(address(6))
    expect(result.warnings.map((w) => w.code)).toContain('TARGET_CHANGED_SINCE_CHECKPOINT')
  })

  it('fails when too few resolvers answer', async () => {
    const body = resolveJson(RECORDS, 'kikeee')
    const error = await resolverOver({ 'a.example': () => 'unreachable', 'b.example': serves(body) })
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect((error as QuorumError).code).toBe('QUORUM_UNMET')
  })

  it('meets quorum from the resolvers that are up', async () => {
    const body = resolveJson(RECORDS, 'kikeee')
    const result = await resolverOver(
      { 'a.example': () => 'unreachable', 'b.example': serves(body), 'c.example': serves(body) },
      [A, B, C],
    ).resolve('kikeee')

    expect(result.quorum).toMatchObject({ queried: 3, agreed: 2 })
  })

  it('treats a syncing resolver as absent, not as a disagreement', async () => {
    const body = resolveJson(RECORDS, 'kikeee')
    const result = await resolverOver(
      { 'a.example': serves({ error: 'NOT_SYNCED' }, 503), 'b.example': serves(body), 'c.example': serves(body) },
      [A, B, C],
    ).resolve('kikeee')

    expect(result.quorum.agreed).toBe(2)
  })

  it('reports an unregistered name only after every resolver has been heard', async () => {
    const absent = serves({ error: 'NOT_FOUND', name: 'kikeee', height: 1 }, 404)
    const error = await resolverOver({ 'a.example': absent, 'b.example': absent })
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LookupError)
    expect((error as LookupError).code).toBe('NOT_FOUND')
  })

  it('halts when one resolver has the name and another does not', async () => {
    const error = await resolverOver({
      'a.example': serves(resolveJson(RECORDS, 'kikeee')),
      'b.example': serves({ error: 'NOT_FOUND', name: 'kikeee', height: 1 }, 404),
    })
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect((error as QuorumError).code).toBe('QUORUM_DISAGREEMENT')
  })

  it('refuses a name in grace, where §7.3 turns resolution off', async () => {
    const grace = serves({ error: 'IN_GRACE', name: 'kikeee', expiry: 1, height: 2 }, 404)
    const error = await resolverOver({ 'a.example': grace, 'b.example': grace })
      .resolve('kikeee')
      .catch((e: unknown) => e)

    expect((error as LookupError).code).toBe('IN_GRACE')
  })

  it('rejects a query that is not a name before touching the network', async () => {
    const resolver = resolverOver({})
    // `no-` fails §4.1 rule 4. A well-formed short name (`no`) is reserved
    // by rule (r18) and — awarded by a `U` — resolves like any other, so it
    // goes to the network rather than failing structurally.
    await expect(resolver.resolve('no-')).rejects.toThrow(/not a name/)
    await expect(resolver.resolve('a.b.c')).rejects.toThrow(/not a name/)
  })
})

// ── Quorum policy ───────────────────────────────────────────────────────────

describe('quorum configuration', () => {
  it('refuses a quorum it cannot meet', () => {
    expect(() => new NnsResolver({ resolvers: [A], quorum: 2, fetch: fakeFetch({}) })).toThrow(/cannot be met/)
  })

  it('is loud about running below RESOLVER_QUORUM', async () => {
    const console_ = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resolver = new NnsResolver({ resolvers: [A], quorum: 1, fetch: fakeFetch({ 'a.example': serves(resolveJson(RECORDS, 'kikeee')) }) })

    // Once at construction, even for an app that renders no warnings...
    expect(console_).toHaveBeenCalledOnce()
    // ...and on every result, for one that does.
    const result = await resolver.resolve('kikeee')
    expect(result.warnings.map((w) => w.code)).toContain('QUORUM_BELOW_SPEC')
    expect(result.quorum.required).toBe(1)
  })

  it('says on every result that the anchor was never checked', async () => {
    const body = resolveJson(RECORDS, 'kikeee')
    const result = await resolverOver({ 'a.example': serves(body), 'b.example': serves(body) }).resolve('kikeee')
    expect(result.warnings.map((w) => w.code)).toContain('ANCHOR_NOT_CHECKED')
  })
})

// ── §8.6 delegation ─────────────────────────────────────────────────────────

describe('dotted queries', () => {
  const DELEGATING = [record('alpha'), record('binance', { target: address(5), host: 'nns.binance.com' })]
  const parent = () => serves(resolveJson(DELEGATING, 'binance'))
  const host = serves({ address: formatAddress(address(77)), ttl: 300 })

  it('answers from the delegate host and marks the answer unproven', async () => {
    const result = await resolverOver({
      'a.example': parent(),
      'b.example': parent(),
      'nns.binance.com': host,
    }).resolve('kike.binance')

    expect(result.verification).toBe('DELEGATED')
    expect(result.address).toBe(address(77))
    expect(result.name).toBe('binance')
    expect(result.delegate).toEqual({ parent: 'binance', label: 'kike', host: 'nns.binance.com', ttl: 300 })
    expect(result.warnings.map((w) => w.code)).toContain('DELEGATED_ANSWER')
  })

  it('caps the cached ttl at one hour and serves the second query from cache', async () => {
    const asked = vi.fn(() => ({ status: 200, body: { address: formatAddress(address(77)), ttl: 86_400 } }))
    const resolver = resolverOver({ 'a.example': parent(), 'b.example': parent(), 'nns.binance.com': asked })

    const first = await resolver.resolve('kike.binance')
    await resolver.resolve('kike.binance')

    expect(first.delegate?.ttl).toBe(3_600)
    expect(asked).toHaveBeenCalledOnce()
  })

  it('fails when the parent designates no delegate host', async () => {
    const plain = serves(resolveJson(RECORDS, 'alpha'))
    const error = await resolverOver({ 'a.example': plain, 'b.example': plain })
      .resolve('kike.alpha')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DelegateError)
    expect((error as DelegateError).code).toBe('PARENT_NOT_DELEGATING')
  })

  it('fails when the delegate host does not answer', async () => {
    const error = await resolverOver({
      'a.example': parent(),
      'b.example': parent(),
      'nns.binance.com': () => 'unreachable',
    })
      .resolve('kike.binance')
      .catch((e: unknown) => e)

    expect((error as DelegateError).code).toBe('DELEGATE_FAILED')
  })

  it('still proves the parent — a bad parent proof halts the delegated query too', async () => {
    const forged = resolveJson(DELEGATING, 'binance')
    ;(forged['proof'] as Record<string, unknown>)['delegate'] = 'evil.example'

    const resolver = resolverOver({ 'a.example': parent(), 'b.example': serves(forged), 'nns.binance.com': host })
    await expect(resolver.resolve('kike.binance')).rejects.toThrow(ProofError)
  })
})

// ── available ───────────────────────────────────────────────────────────────

describe('available', () => {
  it('proves a free name absent from the tree', async () => {
    const body = availableJson(RECORDS, 'freeee')
    const result = await resolverOver({ 'a.example': serves(body), 'b.example': serves(body) }).available('freeee')

    expect(result).toMatchObject({ available: true, verification: 'PROVEN', reason: null })
    expect(result.checkpoint?.height).toBe(CHECKPOINT_HEIGHT)
  })

  it('halts on a forged non-inclusion proof', async () => {
    const honest = availableJson(RECORDS, 'freeee')
    const forged = availableJson(RECORDS, 'freeee')
    // Claim the two bracketing leaves are the whole story while pointing the
    // "next" leaf at something that does not bracket the name at all.
    const proof = forged['proof'] as Record<string, unknown>
    proof['next'] = (availableJson(RECORDS, 'aaaaab')['proof'] as Record<string, unknown>)['next']

    const resolver = resolverOver({ 'a.example': serves(honest), 'b.example': serves(forged) })
    await expect(resolver.available('freeee')).rejects.toThrow(ProofError)
  })

  it('reports a taken name as unproven, because unavailability carries no §8.3 proof', async () => {
    const taken = serves({
      name: 'kikeee',
      available: false,
      reason: 'TAKEN',
      status: 'REGISTERED',
      expiry: 215_725_374,
      height: 58_732_601,
    })
    const result = await resolverOver({ 'a.example': taken, 'b.example': taken }).available('kikeee')

    expect(result).toMatchObject({ available: false, reason: 'TAKEN', verification: 'PROOF_PENDING' })
  })

  it('halts when resolvers disagree about availability', async () => {
    const error = await resolverOver({
      'a.example': serves(availableJson(RECORDS, 'freeee')),
      'b.example': serves({ name: 'freeee', available: false, reason: 'TAKEN', height: 1 }),
    })
      .available('freeee')
      .catch((e: unknown) => e)

    expect((error as QuorumError).code).toBe('QUORUM_DISAGREEMENT')
  })

  it('refuses a dotted query — §4.4 labels are never registrable', async () => {
    await expect(resolverOver({}).available('kike.binance')).rejects.toThrow(/not a registrable name/)
  })
})
