/**
 * The hot key: where it comes from, and how briefly it is usable.
 *
 * **This is the only module in the workspace that reads a Nimiq private key**,
 * and only `issue-main.ts` imports it. `reconcile`, `watch`, `ledger` and
 * `issue.ts` itself do not reach it, which `import-graph.test.ts` walks and
 * asserts — so "which commands can spend" is a property of the import graph
 * rather than a claim in a comment.
 *
 * ## Two keys, because §6 `M` names two senders
 *
 * A `B`'s legs are paid by `MARKETPLACE_ADDRESS`, a refunded `G`'s by
 * `TREASURY_ADDRESS`. An `M` from the wrong sender does not merely fail — §6
 * `M` says it forfeits, so the money leaves *and* the debt stays. Both keys are
 * therefore checked against the §3 addresses **locally, before the node hears
 * anything**: `core.keypairFromPrivateKey` derives the address from the key
 * bytes, and a mismatch is refused at startup. Either key may be absent; a
 * deployment that only ever owes from one address should only hold one.
 *
 * ## The key reaches the node, and comes back locked
 *
 * Nimiq signs in the node's wallet, so the key is handed over once with
 * `importRawKey` (idempotent — `docs/rpc-reference.md` §5) and the address is
 * unlocked only for the moment of one send. §5.4 is the reason for the shape of
 * {@link createNodeWallet}: **an unlocked account is spendable by anyone who can
 * reach the RPC**, lock state is shared and changes under you, and
 * `isAccountUnlocked` is the only thing worth trusting about it. So every send
 * unlocks, confirms the unlock, signs, and locks again in a `finally` —
 * including when the send throws, which is exactly when an unlocked hot key
 * would otherwise be left behind.
 *
 * `lockAccount` returns `null` on success, not `true` (§5.3), so its result is
 * never tested; the confirmation is a second `isAccountUnlocked`.
 */

import { CONSTANTS, formatAddress, keypairFromPrivateKey, parseAddress, type Address } from '@nns/core'

import { EnvError, type EnvSource } from './env.js'
import type { IssuerRpc, Wallet } from './issue.js'
import type { Logger } from '@nns/indexer'

/** One sender's key, already proven to derive the address it will pay from. */
export interface HotKey {
  readonly address: Address
  /** 32 bytes, lowercase hex. Never logged, never written anywhere. */
  readonly privateKey: string
  /** Which §3 address this is, for error messages a human can act on. */
  readonly role: 'MARKETPLACE_ADDRESS' | 'TREASURY_ADDRESS'
  /** The variable it came from. */
  readonly variable: string
}

const KEY_VARIABLES = [
  { variable: 'NNS_SETTLEMENT_MARKETPLACE_KEY', role: 'MARKETPLACE_ADDRESS' as const, of: () => CONSTANTS.MARKETPLACE_ADDRESS },
  { variable: 'NNS_SETTLEMENT_TREASURY_KEY', role: 'TREASURY_ADDRESS' as const, of: () => CONSTANTS.TREASURY_ADDRESS },
]

/**
 * Read whatever keys the environment holds, and prove each one before use.
 *
 * The proof is local: the key's own public key derives an address (§3's
 * `blake2b-256(publicKey)[0..20]`, `core`'s one impure module's pure half), and
 * that address must be the §3 address whose debts it will pay. Getting this
 * wrong is not a failed transaction but a forfeited one.
 *
 * An empty map is legal and means "dry run only" — `issue --send` refuses
 * later, when it knows which senders actually owe anything.
 */
export function loadHotKeys(env: EnvSource): ReadonlyMap<Address, HotKey> {
  const keys = new Map<Address, HotKey>()
  for (const { variable, role, of } of KEY_VARIABLES) {
    const raw = env[variable]?.trim()
    if (raw === undefined || raw === '') continue
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new EnvError(`${variable} must be a 32-byte private key as 64 hex characters (no 0x prefix)`)
    }
    const privateKey = raw.toLowerCase()

    let derived: Address
    try {
      derived = keypairFromPrivateKey(privateKey).address
    } catch (cause) {
      throw new EnvError(`${variable} is not a usable Ed25519 private key — ${(cause as Error).message}`)
    }
    const expected = of()
    if (derived !== expected) {
      throw new EnvError(
        `${variable} derives ${formatAddress(derived)}, but ${role} is ${formatAddress(expected)}. ` +
          `An M from the wrong sender is forfeited, not rejected (§6 M) — the money would leave and the debt would stay`,
      )
    }
    keys.set(expected, Object.freeze({ address: expected, privateKey, role, variable }))
  }
  return keys
}

/**
 * A {@link Wallet} over the node's wallet.
 *
 * `importRawKey` is called on every use rather than once at startup. It is
 * idempotent (the same address comes back, no error), it costs one call on a
 * path that already costs four, and it means a node that was restarted, or
 * whose wallet was cleared, heals itself instead of failing every send until
 * someone notices.
 */
export function createNodeWallet(rpc: IssuerRpc, keys: ReadonlyMap<Address, HotKey>, logger?: Logger): Wallet {
  const senders = [...keys.keys()]

  const importKey = async (key: HotKey): Promise<void> => {
    const imported = await rpc.call<string>('importRawKey', [key.privateKey, null])
    // The node telling us it stored a different address than the one we derived
    // would mean our derivation and its derivation disagree — which would make
    // every check in `loadHotKeys` meaningless.
    let derived: Address
    try {
      derived = parseAddress(imported)
    } catch {
      throw new EnvError(`importRawKey returned ${JSON.stringify(imported)}, which is not an address`)
    }
    if (derived !== key.address) {
      throw new EnvError(
        `importRawKey stored ${formatAddress(derived)} for a key this process derived ${formatAddress(key.address)} from — ` +
          `the node and core disagree about address derivation`,
      )
    }
  }

  return {
    senders,

    async withSigningKey<T>(sender: Address, body: () => Promise<T>): Promise<T> {
      const key = keys.get(sender)
      if (key === undefined) {
        throw new EnvError(
          `no key for ${formatAddress(sender)} — set the variable for that §3 address (${KEY_VARIABLES.map((entry) => entry.variable).join(' or ')})`,
        )
      }
      await importKey(key)
      await rpc.call('unlockAccount', [sender, null, null])
      // §5.4: always ask, never infer. `unlockAccount` returning `true` is not
      // the same claim as the account being unlocked now.
      if ((await rpc.call<boolean>('isAccountUnlocked', [sender])) !== true) {
        throw new EnvError(`${formatAddress(sender)} is still locked after unlockAccount — refusing to sign`)
      }
      try {
        return await body()
      } finally {
        // The failure path is the one that matters: a send that threw is
        // exactly when a funded hot key would otherwise be left unlocked for
        // anyone who can reach the RPC.
        await rpc.call('lockAccount', [sender])
        if ((await rpc.call<boolean>('isAccountUnlocked', [sender])) === true) {
          logger?.warn('issue.key.still-unlocked', { sender })
        }
      }
    },
  }
}
