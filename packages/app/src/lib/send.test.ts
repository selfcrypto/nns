import { describe, expect, it } from 'vitest'
import { performSend } from './send'
import type { SubmitOutcome, Wallet } from './wallet'

const REQUEST = {
  sender: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
  recipient: 'NQ34 248H 248H 248H 248H 248H 248H 248H 248H',
  value: 1n,
  dataHex: '4e43',
}

const walletThat = (outcome: SubmitOutcome): Wallet => ({
  identity: { kind: 'hub', addresses: [REQUEST.sender] },
  connect: null,
  disconnect: null,
  submit: () => Promise.resolve(outcome),
})

const instantly = (): Promise<void> => Promise.resolve()

describe('performSend', () => {
  it('confirms when the effect appears, and reports the phases in order', async () => {
    const phases: string[] = []
    let polls = 0
    const result = await performSend({
      wallet: walletThat({ ok: true, hash: 'h', serializedTxHex: '00' }),
      transport: () => Promise.resolve(null),
      request: REQUEST,
      confirm: { poll: () => Promise.resolve(++polls >= 3), timeoutMs: 90_000, intervalMs: 3_000 },
      onPhase: (phase) => phases.push(phase),
      sleep: instantly,
    })
    expect(result).toEqual({ status: 'confirmed' })
    expect(phases).toEqual(['submitting', 'confirming'])
    expect(polls).toBe(3)
  })

  it('a declined sheet is declined — resolved value, not a throw (rpc-reference §8)', async () => {
    const result = await performSend({
      wallet: walletThat({ ok: false, reason: 'declined' }),
      transport: null,
      request: REQUEST,
      confirm: { poll: () => Promise.resolve(true) },
      sleep: instantly,
    })
    expect(result).toEqual({ status: 'declined' })
  })

  it('no-rpc is blocked, not a failure', async () => {
    const result = await performSend({
      wallet: walletThat({ ok: false, reason: 'no-rpc' }),
      transport: null,
      request: REQUEST,
      confirm: { poll: () => Promise.resolve(true) },
      sleep: instantly,
    })
    expect(result).toEqual({ status: 'blocked', reason: 'no-rpc' })
  })

  it('an effect that never appears is unconfirmed with the hash — never "failed", never "sent"', async () => {
    const result = await performSend({
      wallet: walletThat({ ok: true, hash: 'abc', serializedTxHex: '00' }),
      transport: null,
      request: REQUEST,
      confirm: { poll: () => Promise.resolve(false), timeoutMs: 9_000, intervalMs: 3_000 },
      sleep: instantly,
    })
    expect(result).toEqual({ status: 'unconfirmed', hash: 'abc' })
  })

  it('polls that never answered end as unchecked, not unconfirmed — the checker was down, not the send', async () => {
    const result = await performSend({
      wallet: walletThat({ ok: true, hash: 'abc', serializedTxHex: '00' }),
      transport: null,
      request: REQUEST,
      confirm: { poll: () => Promise.reject(new Error('proxy down')), timeoutMs: 9_000, intervalMs: 3_000 },
      sleep: instantly,
    })
    expect(result).toEqual({ status: 'unchecked', hash: 'abc' })
  })

  it('one answered poll is enough to make the timeout an honest unconfirmed', async () => {
    let polls = 0
    const result = await performSend({
      wallet: walletThat({ ok: true, hash: 'abc', serializedTxHex: '00' }),
      transport: null,
      request: REQUEST,
      confirm: {
        poll: () => {
          polls += 1
          return polls === 1 ? Promise.resolve(false) : Promise.reject(new Error('proxy died mid-loop'))
        },
        timeoutMs: 9_000,
        intervalMs: 3_000,
      },
      sleep: instantly,
    })
    expect(result).toEqual({ status: 'unconfirmed', hash: 'abc' })
  })

  it('a flaky poll does not sink a send that later confirms', async () => {
    let polls = 0
    const result = await performSend({
      wallet: walletThat({ ok: true, hash: 'h', serializedTxHex: '00' }),
      transport: null,
      request: REQUEST,
      confirm: {
        poll: () => {
          polls += 1
          if (polls === 1) return Promise.reject(new Error('flake'))
          return Promise.resolve(true)
        },
        timeoutMs: 9_000,
        intervalMs: 3_000,
      },
      sleep: instantly,
    })
    expect(result).toEqual({ status: 'confirmed' })
  })
})
