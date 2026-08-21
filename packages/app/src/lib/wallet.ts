/**
 * The adapter seam of the two-adapter intent, now live on both halves. One
 * `Wallet` shape; Pay and Hub differ only in connect, signing and identity —
 * everything above this module is shared.
 *
 * Sends: the Hub path signs (`hub.ts`) and broadcasts through the operator
 * RPC endpoint (`sendRawTransaction`). The Pay path sends through the wallet
 * itself (`sdk.ts`), which both signs and broadcasts — so it needs no
 * transport and works with none configured.
 *
 * The §10.5 gate came off on 2026-08-21: the probe ran on a post-fork build
 * and the confirmation sheet honoured an app-supplied `value` and `fee`
 * exactly. What the same run found instead is the constraint this file now
 * carries — **Pay chooses which address signs, and there is no sender
 * parameter to overrule it.** So the Pay identity is the whole set
 * `listAccounts()` reports rather than its first entry, and an owner action
 * the wallet signs with the wrong set member is caught where every other
 * silent failure is: the effect never appears and `performSend` says
 * `unconfirmed`.
 */

import {
  NO_IDENTITY,
  clearHubAddresses,
  loadHubAddresses,
  saveHubAddresses,
  withAddress,
  type Identity,
  type StorageLike,
} from './identity'
import { hubChooseAddress, hubSignTransaction } from './hub'
import { connectWallet, devAddressOverride, paySendTransaction, type WalletSession } from './sdk'
import { isDefiniteRejection, type HistoryTransport } from './history'

export interface SubmitRequest {
  readonly sender: string
  readonly recipient: string
  readonly value: bigint
  readonly dataHex: string
}

export type SubmitOutcome =
  | { readonly ok: true; readonly hash: string | null; readonly serializedTxHex: string | null }
  | { readonly ok: false; readonly reason: 'declined' | 'no-rpc' | 'failed'; readonly detail?: string }

export interface Wallet {
  readonly identity: Identity
  /** Hub only: one popup, one more address in the set. Null elsewhere. */
  readonly connect: (() => Promise<Identity>) | null
  /**
   * Hub only: forget the set, so a different address can be chosen. Null on the
   * Pay path, where identity is the host's and there is nothing to disconnect
   * from.
   */
  readonly disconnect: (() => Identity) | null
  readonly submit: (request: SubmitRequest, transport: HistoryTransport | null) => Promise<SubmitOutcome>
}

export async function detectWallet(storage: StorageLike, search: string): Promise<Wallet> {
  const paySession = await connectWallet()
  if (paySession !== null) return payWallet(paySession)
  return hubWallet(storage, search)
}

function payWallet(session: WalletSession): Wallet {
  // Canonical spaced form, like every other address entering the set: the
  // identicon bug of 2026-08-21 was one spelling meeting another.
  let addresses: readonly string[] = []
  for (const address of session.addresses) addresses = withAddress(addresses, address)

  return {
    // Nothing to connect to and nothing to disconnect from: the host's
    // accounts are the identity, with no prompt and no persistence.
    identity: { kind: 'pay', addresses },
    connect: null,
    disconnect: null,

    // No transport: the wallet signs and broadcasts in one call, so a Pay
    // send works with no RPC endpoint configured. The confirm loop above
    // still needs one for the chat flows, and asks for it itself.
    submit: async (request) => {
      const sent = await paySendTransaction(session.provider, {
        recipient: request.recipient,
        valueLuna: request.value,
        dataHex: request.dataHex,
      })
      if (!sent.ok) {
        return sent.declined
          ? { ok: false, reason: 'declined' }
          : { ok: false, reason: 'failed', detail: sent.detail }
      }
      // A 32-byte hash, despite the declarations calling it the serialized
      // transaction (probed). It is passed on for polls that can key on a
      // hash and is never treated as confirmation — §5.3.
      return { ok: true, hash: sent.hash, serializedTxHex: null }
    },
  }
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

    disconnect: () => {
      addresses = []
      clearHubAddresses(storage)
      // Dev-only wrinkle: `devAddressOverride` reads an address out of the URL
      // and `detectWallet` re-adds it, so a disconnect does not survive a
      // reload while that query parameter is present. Dev path only.
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
