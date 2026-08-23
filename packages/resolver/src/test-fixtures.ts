/**
 * Fixtures: a real name tree from `@nns/core`, rendered into §8.3 documents.
 *
 * The rendering here is written **independently of `packages/api/src/proofs.ts`**
 * and deliberately not imported from it. If both sides shared one renderer, a
 * test that a proof verifies would only be testing that a function agrees
 * with itself; two renderings of the same §8.3 wording, checked against each
 * other through core, is the smallest thing that can catch a wire-format
 * divergence — which is the one failure mode this whole design exists to
 * prevent.
 */

import {
  addressFromBytes,
  commitmentFrom,
  formatAddress,
  merkleNonInclusion,
  merkleProof,
  merkleRoot,
  type Address,
  type CheckpointComponents,
  type MerkleProof,
  type NameRecord,
} from '@nns/core'

export const address = (seed: number): Address => addressFromBytes(new Uint8Array(20).fill(seed))

export const record = (name: string, overrides: Partial<NameRecord> = {}): NameRecord => ({
  name,
  owner: address(1),
  target: address(2),
  evm: '',
  expiry: 215_725_374,
  status: 'REGISTERED',
  host: '',
  ...overrides,
})

export const treeOf = (records: readonly NameRecord[]): { names: Map<string, NameRecord> } => ({
  names: new Map(records.map((r) => [r.name, r])),
})

const hex0x = (bytes: Uint8Array): string =>
  `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`

/** §8.3's leaf fields, verbatim. `delegate` is §8.1's host, `''` when unset. */
function leafJson(proof: MerkleProof): Record<string, unknown> {
  return {
    name: proof.record.name,
    owner: formatAddress(proof.record.owner),
    target: formatAddress(proof.record.target),
    evm: proof.record.evm,
    expiry: proof.record.expiry,
    status: proof.record.status,
    delegate: proof.record.host,
    leaf_index: proof.index,
    proof: proof.steps.map((step) => ({ hash: hex0x(step.hash), side: step.side })),
  }
}

export const CHECKPOINT_HEIGHT = 58_732_560

export function inclusionJson(records: readonly NameRecord[], name: string): Record<string, unknown> {
  const state = treeOf(records)
  const proof = merkleProof(state, name)
  if (proof === null) throw new Error(`fixture: "${name}" is not in the tree`)
  return {
    ...leafJson(proof),
    root: hex0x(proof.root),
    nimiq_height: CHECKPOINT_HEIGHT,
    anchor: null,
  }
}

export function nonInclusionJson(records: readonly NameRecord[], name: string): Record<string, unknown> {
  const state = treeOf(records)
  const proof = merkleNonInclusion(state, name)
  return {
    kind: proof.kind,
    previous: 'previous' in proof ? leafJson(proof.previous) : null,
    next: 'next' in proof ? leafJson(proof.next) : null,
    root: hex0x(proof.root),
    nimiq_height: CHECKPOINT_HEIGHT,
    anchor: null,
  }
}

export const rootHex = (records: readonly NameRecord[]): string => hex0x(merkleRoot(treeOf(records)))

// ── Checkpoint documents, with a commitment that is actually §8.1's ─────────

const filled = (byte: number): Uint8Array => new Uint8Array(32).fill(byte)

/** The five digests and the height of a checkpoint over `records`. */
export function checkpointComponents(
  records: readonly NameRecord[],
  height: number = CHECKPOINT_HEIGHT,
): CheckpointComponents {
  return {
    height,
    nameRoot: merkleRoot(treeOf(records)),
    pricesRoot: filled(0x11),
    pendingRoot: filled(0x22),
    unreservedRoot: filled(0x33),
    logHash: filled(0x44),
  }
}

/** What listed publishers would have anchored for that checkpoint (§9). */
export const commitmentOf = (records: readonly NameRecord[], height: number = CHECKPOINT_HEIGHT): string =>
  hex0x(commitmentFrom(checkpointComponents(records, height)))

/**
 * A `GET /checkpoints/{height}` body whose `commitment` really is §8.1 over
 * the five digests beside it — which is the property the anchor check
 * recomputes, so a fixture that faked it would test nothing.
 */
export function checkpointJson(
  records: readonly NameRecord[],
  options: { readonly height?: number; readonly overrides?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const height = options.height ?? CHECKPOINT_HEIGHT
  const components = checkpointComponents(records, height)
  return {
    checkpoint: {
      height,
      layout: 3,
      nameRoot: hex0x(components.nameRoot),
      pricesRoot: hex0x(components.pricesRoot),
      pendingRoot: hex0x(components.pendingRoot),
      unreservedRoot: hex0x(components.unreservedRoot),
      logHash: hex0x(components.logHash),
      commitment: hex0x(commitmentFrom(components)),
      ...options.overrides,
    },
    height,
  }
}

/** A `GET /resolve/{name}` body, as `packages/api` serves it. */
export function resolveJson(
  records: readonly NameRecord[],
  name: string,
  options: { readonly proof?: boolean; readonly height?: number; readonly live?: Partial<NameRecord> } = {},
): Record<string, unknown> {
  const base = records.find((r) => r.name === name)
  if (base === undefined) throw new Error(`fixture: no record for "${name}"`)
  const live = { ...base, ...options.live }
  return {
    name,
    target: formatAddress(live.target),
    status: live.status,
    expiry: live.expiry,
    host: live.host,
    proof: options.proof === false ? null : inclusionJson(records, name),
    height: options.height ?? CHECKPOINT_HEIGHT + 41,
  }
}

/** A `GET /available/{name}` body for a free name. */
export function availableJson(
  records: readonly NameRecord[],
  name: string,
  options: { readonly proof?: boolean; readonly height?: number } = {},
): Record<string, unknown> {
  return {
    name,
    available: true,
    proof: options.proof === false ? null : nonInclusionJson(records, name),
    height: options.height ?? CHECKPOINT_HEIGHT + 41,
  }
}
