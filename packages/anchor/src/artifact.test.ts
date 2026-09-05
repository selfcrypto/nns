import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ANCHORED_TOPIC0, ARTIFACT, INIT_CODE_HASH } from './artifact.js'
import { compileAnchor, eventSignature, readContractSource, SETTINGS } from './compile.js'
import type { AbiEntry } from './compile.js'
import { renderArtifactModule } from './render.js'

const abi: readonly AbiEntry[] = ARTIFACT.abi
const events = abi.filter((e) => e.type === 'event')
const functions = abi.filter((e) => e.type === 'function')

function keccakHex(bytes: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(bytes))}`
}

describe('the committed artifact is the compilation of the committed source', () => {
  // The point of committing a generated file. Without this, `artifact.ts` is
  // a claim about `NnsAnchor.sol` that nothing checks, and a hand-edit — or a
  // contract change without a regenerate — ships silently.

  it('recompiles to the committed artifact, byte for byte', () => {
    expect(compileAnchor()).toEqual(ARTIFACT)
  })

  it('renders to the committed file exactly', () => {
    // Not just "the same values": the same bytes the generator would write.
    // A reformatted-by-hand artifact that no longer round-trips would pass a
    // value comparison and then drift on the next regenerate.
    const path = fileURLToPath(new URL('./artifact.ts', import.meta.url))
    expect(renderArtifactModule(compileAnchor())).toBe(readFileSync(path, 'utf8'))
  })

  it('pins which source bytes were compiled', () => {
    const digest = createHash('sha256').update(readContractSource(), 'utf8').digest('hex')
    expect(ARTIFACT.sourceHash).toBe(`0x${digest}`)
  })

  it('pins the compiler settings that decide the bytecode', () => {
    // Every one of these is an input to the bytecode, which is the identity
    // `verify` and the publisher check deployments against. `paris` in
    // particular is a deliberate choice, not a default: it keeps the
    // contract free of PUSH0 and the Cancun opcodes, which is what lets §9
    // say it deploys unchanged anywhere EVM.
    expect(ARTIFACT.solcVersion).toMatch(/^0\.8\.30\+commit\./)
    expect(ARTIFACT.evmVersion).toBe('paris')
    expect(ARTIFACT.evmVersion).toBe(SETTINGS.evmVersion)
    expect(ARTIFACT.optimizer).toEqual({ enabled: true, runs: 200 })
  })
})

describe('the Anchored event seam', () => {
  // What every client reads. A change to the event's name, parameter types or
  // parameter order moves topic 0, and a reader filtering on the old value
  // silently finds no anchors — which a client reports as "no anchor" rather
  // than as a bug. These are the assertions that make that impossible to do
  // by accident.

  it('has exactly one event, Anchored, non-anonymous', () => {
    expect(events).toHaveLength(1)
    expect(events[0]?.name).toBe('Anchored')
    // An anonymous event has no topic 0, so filtering by signature stops
    // working entirely and any contract can forge one.
    expect(events[0]?.anonymous).toBe(false)
  })

  it('carries the §9 signature', () => {
    expect(eventSignature(events[0]!)).toBe('Anchored(bytes32,address,uint64,uint64,bytes32)')
    expect(ARTIFACT.anchoredSignature).toBe('Anchored(bytes32,address,uint64,uint64,bytes32)')
  })

  it('topic 0 is keccak256 of the signature derived from the ABI', () => {
    // Derived from the ABI rather than from a second hardcoded string, so the
    // committed topic cannot agree with a signature the contract stopped
    // having.
    const signature = eventSignature(events[0]!)
    expect(ANCHORED_TOPIC0).toBe(keccakHex(new TextEncoder().encode(signature)))
    expect(ANCHORED_TOPIC0).toBe('0x05d81b8d9808f1fa1f651e2e7dc51bf6900cfd074532e3a0eccacf57055b668d')
  })

  it('indexes root and publisher, and not nimiqHeight', () => {
    // §9: the client's queries are "anchors for this root" and "anchors by
    // this publisher", both topic filters, which is what makes a
    // permissionless anchor() safe against spam. nimiqHeight stays unindexed
    // — the client knows the height it asked about and checks the field.
    expect(events[0]?.inputs?.map((i) => [i.name, i.type, i.indexed === true])).toEqual([
      ['root', 'bytes32', true],
      ['publisher', 'address', true],
      ['nimiqHeight', 'uint64', false],
      ['timestamp', 'uint64', false],
      ['logDigest', 'bytes32', false],
    ])
  })

  it('leaves a topic free', () => {
    // A non-anonymous event may index three parameters. Two are used, so
    // there is room for one more without a breaking change — worth knowing
    // before someone reaches for the one nimiqHeight is not allowed to take.
    const indexed = events[0]?.inputs?.filter((i) => i.indexed === true) ?? []
    expect(indexed).toHaveLength(2)
  })
})

describe('the contract has no surface beyond anchor()', () => {
  // §9's permissionlessness is not a comment, it is the absence of ABI
  // entries. Adding `onlyOwner`, an `owner()` getter, a publisher registry or
  // an upgrade hook all show up here as a new entry, so the reflex fix turns
  // the suite red instead of quietly reintroducing the thing §2.1 cannot
  // survive.

  it('exposes exactly one function: anchor', () => {
    expect(functions.map((f) => f.name)).toEqual(['anchor'])
  })

  it('takes (bytes32, uint64, bytes32) and returns nothing', () => {
    expect(functions[0]?.inputs?.map((i) => [i.name, i.type])).toEqual([
      ['root', 'bytes32'],
      ['nimiqHeight', 'uint64'],
      ['logDigest', 'bytes32'],
    ])
    expect(functions[0]?.outputs).toEqual([])
  })

  it('is nonpayable, and the contract cannot receive value', () => {
    // No payable function, no receive, no fallback: the contract cannot be
    // paid, so it never holds value and there is nothing to rescue — which
    // is the argument for it having no owner in the first place.
    expect(functions[0]?.stateMutability).toBe('nonpayable')
    expect(abi.some((e) => e.stateMutability === 'payable')).toBe(false)
    expect(abi.some((e) => e.type === 'receive' || e.type === 'fallback')).toBe(false)
  })

  it('has no constructor', () => {
    // Two reasons. No constructor arguments means the init code is the same
    // bytes for everyone, so any deployment of it is byte-identical and
    // checkable against the committed artifact. And a constructor is where
    // an owner would be set.
    expect(abi.some((e) => e.type === 'constructor')).toBe(false)
  })

  it('has no errors and no other events', () => {
    // No custom errors because anchor() has no `require` — validation would
    // be a protocol rule enforced by a contract that cannot see Nimiq state.
    expect(abi.filter((e) => e.type !== 'function' && e.type !== 'event')).toEqual([])
    expect(abi).toHaveLength(2)
  })
})

describe('deployment identity', () => {
  it('initCodeHash is keccak256 of the creation bytecode', () => {
    // With no constructor arguments the creation bytecode *is* the init
    // code. The hash is kept for factory (CREATE2) deployments by third
    // parties; this package's own deploy is plain CREATE.
    expect(INIT_CODE_HASH).toBe(keccakHex(hexToBytes(ARTIFACT.bytecode.slice(2))))
  })

  it('the creation code carries the runtime code it deploys', () => {
    // Sanity that the two were taken from the same compilation: creation code
    // is a deployer stub followed by the runtime code it returns.
    expect(ARTIFACT.bytecode).toContain(ARTIFACT.deployedBytecode.slice(2, 64))
    expect(ARTIFACT.deployedBytecode.length).toBeLessThan(ARTIFACT.bytecode.length)
  })

  it('embeds the event topic in the runtime code', () => {
    // The emitted topic is a constant in the bytecode. If this stops holding,
    // the deployed contract is not emitting the event the ABI describes.
    expect(ARTIFACT.deployedBytecode).toContain(ANCHORED_TOPIC0.slice(2))
  })
})
