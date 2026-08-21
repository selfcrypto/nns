import { describe, expect, it } from 'vitest'
import { encodeRegister, encodeSetTarget, parseAddress } from '@nns/core'
import { hexToText } from './hex'
import { paySendTransaction, type PaySendOutcome } from './sdk'
import type { NimiqProvider } from '@nimiq/mini-app-sdk'

/**
 * The Pay boundary, pinned against what the 2026-08-21 probe measured on a
 * shipped build rather than against the declarations, which are wrong about
 * the return value and silent about the encoding.
 */

type SentTx = { recipient: string; value: number; fee?: number; data: string }

function providerThat(answer: unknown): { provider: NimiqProvider; sent: SentTx[] } {
  const sent: SentTx[] = []
  const provider = {
    sendBasicTransactionWithData: (tx: SentTx) => {
      sent.push(tx)
      return Promise.resolve(answer)
    },
  } as unknown as NimiqProvider
  return { provider, sent }
}

const TREASURY = 'NQ42 5QRF L5AV J6K3 BQHQ FAE8 XXHR TS8Y 9YRA'
const HASH = '5eb2028cc3d0d4007d270632b0d299c92f23cc34a4b10a3782d489746280d56d'

describe('paySendTransaction', () => {
  it('hands the wallet TEXT, never the hex — the payload is utf-8 encoded there', async () => {
    // Measured: passing the hex string landed 28 bytes on chain for a 14-byte
    // message, decoding to the literal hex digits. Text is the only encoding
    // that survives the wallet.
    const { provider, sent } = providerThat(HASH)
    const built = encodeRegister({ name: 'example', fee: 200_000_000n })

    await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: built.value,
      dataHex: built.data,
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.data).toBe('NNS1Gexample')
    expect(sent[0]?.data).not.toBe(built.data)
    // What the wallet will put on chain is exactly what core encoded.
    expect(hexToText(built.data)).toBe(sent[0]?.data)
  })

  it('passes value through unchanged and signs an explicit zero fee', async () => {
    const { provider, sent } = providerThat(HASH)
    await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: 200_000_000n,
      dataHex: encodeRegister({ name: 'example', fee: 200_000_000n }).data,
    })
    expect(sent[0]?.value).toBe(200_000_000)
    expect(sent[0]?.fee).toBe(0)
  })

  it('never supplies validityStartHeight — that height belongs to the wallet plane', async () => {
    const { provider, sent } = providerThat(HASH)
    await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: 1n,
      dataHex: encodeSetTarget({ name: 'example', target: parseAddress(TREASURY) }).data,
    })
    expect(sent[0]).not.toHaveProperty('validityStartHeight')
  })

  it('returns the wallet answer as a hash, not as a serialized transaction', async () => {
    const { provider } = providerThat(HASH)
    const outcome = await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: 1n,
      dataHex: encodeSetTarget({ name: 'example', target: parseAddress(TREASURY) }).data,
    })
    expect(outcome).toEqual({ ok: true, hash: HASH } satisfies PaySendOutcome)
  })

  it('reads an ErrorResponse as failure — a wallet failure is a value, not a throw', async () => {
    const { provider } = providerThat({ error: { type: 'REQUEST_FAILED', message: 'node unreachable' } })
    const outcome = await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: 1n,
      dataHex: encodeSetTarget({ name: 'example', target: parseAddress(TREASURY) }).data,
    })
    expect(outcome).toEqual({ ok: false, declined: false, detail: 'node unreachable' })
  })

  it('reads a closed confirmation sheet as declined, not as a failure', async () => {
    const { provider } = providerThat({ error: { type: 'USER_REJECTED', message: 'The user rejected the request' } })
    const outcome = await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: 1n,
      dataHex: encodeSetTarget({ name: 'example', target: parseAddress(TREASURY) }).data,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ declined: true })
  })

  it('refuses a payload that is not valid UTF-8 rather than letting the wallet mangle it', async () => {
    const { provider, sent } = providerThat(HASH)
    const outcome = await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: 1n,
      dataHex: 'ff',
    })
    expect(outcome.ok).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('refuses a value past the SDK number boundary instead of narrowing it silently', async () => {
    const { provider, sent } = providerThat(HASH)
    const outcome = await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      dataHex: encodeSetTarget({ name: 'example', target: parseAddress(TREASURY) }).data,
    })
    expect(outcome.ok).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('treats an answer that is neither an error nor a string as a failure, not a send', async () => {
    const { provider } = providerThat(undefined)
    const outcome = await paySendTransaction(provider, {
      recipient: TREASURY,
      valueLuna: 1n,
      dataHex: encodeSetTarget({ name: 'example', target: parseAddress(TREASURY) }).data,
    })
    expect(outcome.ok).toBe(false)
  })
})

describe('hexToText', () => {
  it('round-trips every NNS payload, which core guarantees is ASCII', () => {
    expect(hexToText(encodeRegister({ name: 'example', fee: 1n }).data)).toBe('NNS1Gexample')
    expect(hexToText(encodeRegister({ name: 'example', ref: 'promo', fee: 1n }).data)).toBe('NNS1Gexample|promo')
  })

  it('round-trips a multi-byte NC message, which TextEncoder produced', () => {
    const hex = [...new TextEncoder().encode('NC1alice|héllo 🌍')]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(hexToText(hex)).toBe('NC1alice|héllo 🌍')
  })

  it('answers null for bytes that are not valid UTF-8, and for non-hex', () => {
    expect(hexToText('ff')).toBeNull()
    expect(hexToText('c3')).toBeNull()
    expect(hexToText('zz')).toBeNull()
    expect(hexToText('abc')).toBeNull()
  })
})
