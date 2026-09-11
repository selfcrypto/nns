import { describe, expect, it } from 'vitest'
import { effectiveSender, htlcAuthorizer, SENDER_TYPE_HTLC } from './attribution.js'
import { formatAddress, parseAddress } from './address.js'
import { CONSTANTS } from './constants.js'
import { encodeRegister, encodeSetTarget } from './codec.js'
import { LAUNCH_PRICES, initialState, type NnsState } from './state.js'
import { feeFor, reduce, type ChainTransaction } from './reduce.js'
import { testConfig, ALICE } from './test-fixtures.js'

/**
 * Real mainnet material, block 59,516,314: the `G` that registered
 * `nimiqpaytest` from Nimiq Pay's HTLC. EarlyResolve — the co-signer's
 * signature first, then the contract sender's (the user's Local wallet,
 * whose key also signed the plain-account transaction that created the
 * contract; same 32-byte public key appears in both proofs below).
 */
const MAINNET_EARLY_RESOLVE =
  '010091b21f4b100273bd7034f6369c29d1f7ba72dba7de6720ad3cd8b8191621891300668acc228bf8ad0a832757b1e92b549e07f775937c2b4d2818d555943bef1c8421728d8f7bd4695d85fb3b626b541dcb0e3fbd791357d8720596c3b89547f506009e1ffbdc365402365800270b0b68904e51514e8bb05e48cd5e7310ba1412f6a2008525da9a0f4d04539a1a606df4b39307eeec06df1cf2e2c3d65030bcf4f675967425e34eb68cee64d3b7e9c6ea935ddc1ffa110565ead6a92aaf912d7fb1fb03'
const MAINNET_BASIC_PROOF =
  '009e1ffbdc365402365800270b0b68904e51514e8bb05e48cd5e7310ba1412f6a20087af1127e961998040ca145986a5b540101e52a0c5aadf3bb667fa5715e91a41a7483d8115c08b10387b0f7dda4666af11ec321c3f976910b4f795993fb3fb0f'

/** The addresses that mainnet run used. */
const LOCAL = parseAddress('NQ88 XL24 NHPU MYVX 67AC TXLX NQX1 R471 EGM9')
const HTLC_1 = parseAddress('NQ89 R3HN 70XQ 2E5A L4YS CV2Q UL5J 84TX 8L8H')
const HTLC_2 = parseAddress('NQ70 T4QS RKSL TGQT S7F5 B53K G67D FRUX X09J')
const CO_SIGNER = parseAddress('NQ14 LU5R UH54 92SH GEN4 U63C SV4V 7N49 YYU4')

describe('htlcAuthorizer — byte-exact, mainnet-verified', () => {
  it('reads the contract sender out of a real EarlyResolve proof', () => {
    // The sender signature is the second of the two; the first is Nimiq's
    // co-signer, which must never be the attribution.
    const authorizer = htlcAuthorizer(MAINNET_EARLY_RESOLVE)
    expect(authorizer).not.toBeNull()
    expect(formatAddress(authorizer!)).toBe(formatAddress(LOCAL))
    expect(formatAddress(authorizer!)).not.toBe(formatAddress(CO_SIGNER))
  })

  it('reads the lone sender signature out of a TimeoutResolve proof', () => {
    // Synthesized: discriminant 0x02 followed by the same sender sigproof the
    // EarlyResolve carries as its second — a timeout spend by the same key.
    const senderSigproof = MAINNET_EARLY_RESOLVE.slice(2 + 98 * 2)
    const authorizer = htlcAuthorizer('02' + senderSigproof)
    expect(authorizer).not.toBeNull()
    expect(formatAddress(authorizer!)).toBe(formatAddress(LOCAL))
  })

  it('refuses everything that is not the one verified shape', () => {
    const cases: readonly string[] = [
      MAINNET_BASIC_PROOF, //                    a basic-account proof, no discriminant
      '00' + MAINNET_EARLY_RESOLVE.slice(2), //  RegularTransfer: hash-lock claim, not attributed
      MAINNET_EARLY_RESOLVE.slice(0, -2), //     truncated
      MAINNET_EARLY_RESOLVE + '00', //           trailing bytes
      // Sender sigproof declares a non-Ed25519 algorithm (ES256/WebAuthn):
      MAINNET_EARLY_RESOLVE.slice(0, 2 + 98 * 2) + '01' + MAINNET_EARLY_RESOLVE.slice(2 + 98 * 2 + 2),
      // Non-empty merkle path in the sender sigproof (multisig shape):
      MAINNET_EARLY_RESOLVE.slice(0, 2 + 98 * 2 + 66) + '01' + MAINNET_EARLY_RESOLVE.slice(2 + 98 * 2 + 68),
      'zz', //                                    not hex
      '', //                                      empty
    ]
    for (const proof of cases) expect(htlcAuthorizer(proof)).toBeNull()
  })
})

describe('effectiveSender', () => {
  const base = { sender: HTLC_1 }

  it('attributes an HTLC send to its authorizing key', () => {
    const attributed = effectiveSender({ ...base, senderType: SENDER_TYPE_HTLC, proof: MAINNET_EARLY_RESOLVE })
    expect(formatAddress(attributed)).toBe(formatAddress(LOCAL))
  })

  it('leaves every other sender untouched — basic accounts, absent fields, unparsable proofs', () => {
    expect(effectiveSender({ ...base })).toBe(HTLC_1)
    expect(effectiveSender({ ...base, senderType: 0, proof: MAINNET_BASIC_PROOF })).toBe(HTLC_1)
    expect(effectiveSender({ ...base, senderType: SENDER_TYPE_HTLC })).toBe(HTLC_1)
    expect(effectiveSender({ ...base, senderType: SENDER_TYPE_HTLC, proof: 'ff' })).toBe(HTLC_1)
  })
})

describe('reduce under attribution — ownership survives the contract', () => {
  const config = testConfig()
  const height = CONSTANTS.LAUNCH_HEIGHT + 10

  const fromHtlc = (
    contract: typeof HTLC_1,
    built: { recipient: never; value: bigint; data: string } | ReturnType<typeof encodeRegister>,
    blockNumber: number,
    txIndex: number,
  ): ChainTransaction => ({
    blockNumber,
    txIndex,
    hash: `${blockNumber}-${txIndex}`,
    sender: contract,
    recipient: built.recipient,
    value: built.value,
    recipientData: built.data,
    executionResult: true,
    networkId: config.networkId,
    senderType: SENDER_TYPE_HTLC,
    proof: MAINNET_EARLY_RESOLVE,
  })

  const register = (state: NnsState) =>
    reduce(state, fromHtlc(HTLC_1, encodeRegister({ name: 'examplename', fee: feeFor('examplename', LAUNCH_PRICES) }), height, 0), config)

  it('a G from the contract registers to the authorizing key, not the contract', () => {
    const { state, verdict } = register(initialState())
    expect(verdict.kind).toBe('OK')
    const record = state.names.get('examplename')
    expect(record).toBeDefined()
    expect(formatAddress(record!.owner)).toBe(formatAddress(LOCAL))
  })

  it('the key still owns the name from a DIFFERENT contract — the whole point', () => {
    // Contract 1 registered the name and was then destroyed; the wallet now
    // signs from contract 3. Same Local key authorizes both, so the owner
    // check passes. Under account attribution this S forfeits NOT_OWNER and
    // the name is orphaned forever — mainnet `nimiqpaytest`, 2026-08-21.
    const registered = register(initialState()).state
    const repoint = encodeSetTarget({ name: 'examplename', target: ALICE })
    const { state, verdict } = reduce(registered, fromHtlc(HTLC_2, repoint, height + 5, 0), config)
    expect(verdict.kind).toBe('OK')
    expect(formatAddress(state.names.get('examplename')!.target)).toBe(formatAddress(ALICE))
  })

  it('without a proof the same S forfeits NOT_OWNER — the orphaning, reproduced', () => {
    const registered = register(initialState()).state
    const repoint = encodeSetTarget({ name: 'examplename', target: ALICE })
    const { proof: _dropped, ...tx } = fromHtlc(HTLC_2, repoint, height + 5, 0)
    const { verdict } = reduce(registered, tx, config)
    expect(verdict).toMatchObject({ kind: 'FORFEIT', reason: 'NOT_OWNER' })
  })
})
