/**
 * The adapter seam of the two-adapter intent, now live. One `Wallet` shape;
 * Pay and Hub differ only in connect, signing and identity — everything
 * above this module is shared.
 *
 * Sends: the Hub path signs (`hub.ts`) and broadcasts through the operator
 * RPC endpoint (`sendRawTransaction`); the Pay path stays gated behind the
 * §10.5 probe and answers `probe-gated` until it runs on a post-fork build.
 */

import { NO_IDENTITY, loadHubAddresses, saveHubAddresses, withAddress, type Identity, type StorageLike } from './identity'
import { hubChooseAddress, hubSignTransaction } from './hub'
import { connectWallet, devAddressOverride } from './sdk'
import { isDefiniteRejection, type HistoryTransport } from './history'

export interface SubmitRequest {
  readonly sender: string
  readonly recipient: string
  readonly value: bigint
  readonly dataHex: string
}

export type SubmitOutcome =
  | { readonly ok: true; readonly hash: string | null; readonly serializedTxHex: string | null }
  | { readonly ok: false; readonly reason: 'declined' | 'probe-gated' | 'no-rpc' | 'failed'; readonly detail?: string }

export interface Wallet {
  readonly identity: Identity
  /** Hub only: one popup, one more address in the set. Null elsewhere. */
  readonly connect: (() => Promise<Identity>) | null
  readonly submit: (request: SubmitRequest, transport: HistoryTransport | null) => Promise<SubmitOutcome>
}

export async function detectWallet(storage: StorageLike, search: string): Promise<Wallet> {
  const paySession = await connectWallet()
  if (paySession !== null) {
    return {
      identity: { kind: 'pay', addresses: [paySession.address] },
      connect: null,
      // Every fee-bearing Pay send is a §10.5 forfeit if the sheet
      // substitutes its own value; nothing sends from Pay until the probe
      // answers (packages/app/CLAUDE.md, "Open").
      submit: () => Promise.resolve({ ok: false, reason: 'probe-gated' }),
    }
  }
  return hubWallet(storage, search)
}

function hubWallet(storage: StorageLike, search: string): Wallet {
  let addresses = loadHubAddresses(storage)
  const override = devAddressOverride(search)
  if (override !== null) addresses = withAddress(addresses, override)

  const identity = (): Identity =>
    addresses.length === 0 ? { ...NO_IDENTITY, kind: 'hub' } : { kind: 'hub', addresses }

  return {
    get identity() {
      return identity()
    },

    connect: async () => {
      const chosen = await hubChooseAddress()
      if (chosen !== null) {
        addresses = withAddress(addresses, chosen)
        saveHubAddresses(storage, addresses)
      }
      return identity()
    },

    submit: async (request, transport) => {
      if (transport === null) return { ok: false, reason: 'no-rpc' }
      let height: number
      try {
        const answer = await transport('getBlockNumber', [])
        if (typeof answer !== 'number') return { ok: false, reason: 'failed', detail: 'no block number' }
        height = answer
      } catch (error) {
        return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
      }
      const signed = await hubSignTransaction({
        sender: request.sender,
        recipient: request.recipient,
        valueLuna: request.value,
        dataHex: request.dataHex,
        validityStartHeight: height,
      })
      if (signed === 'declined') return { ok: false, reason: 'declined' }
      try {
        await transport('sendRawTransaction', [signed.serializedTxHex])
      } catch (error) {
        // Only a proven rejection is a failure. Anything ambiguous — a 5xx,
        // a timeout, a dead proxy — may have relayed the transaction, so it
        // falls through to the confirm loop: a "failed" here invites a
        // retry, a retry re-signs at a fresh validity height, and that is a
        // different transaction and a second fee.
        if (isDefiniteRejection(error)) {
          return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
        }
      }
      return { ok: true, hash: signed.hash, serializedTxHex: signed.serializedTxHex }
    },
  }
}
