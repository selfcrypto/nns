/**
 * Protocol constants — spec §3.
 *
 * A value belongs here if **every honest implementation on the same network
 * must agree on it byte for byte**; it is configuration only if two honest
 * deployments may legitimately differ. `RESERVED_NAMES` and the `O`
 * `LISTING_FEE` were injected while their values were unknown and are frozen
 * here now that they are not — an injected consensus input is a
 * silent-divergence surface, since two indexers with different `.env` files
 * derive different roots and the disagreement first shows up as a
 * `QUORUM_ROOT_MISMATCH` in somebody's client.
 *
 * Still injected through {@link ./config.ts | NnsConfig}, and only until the
 * operator supplies them: `LAUNCH_HEIGHT` and the four §3 addresses
 * (`TREASURY_ADDRESS`, `PROTOCOL_ADDRESS`, `ADMIN_ADDRESS`,
 * `MARKETPLACE_ADDRESS`). Nothing invented may be baked into a build and reach
 * mainnet unnoticed, so they stay out of here until they are real.
 *
 * No magic number appears anywhere else in this package.
 *
 * Two unit conventions, applied without exception:
 * - **Amounts are `bigint` luna.** 1 NIM = 100,000 luna. Never a float, and
 *   never a `number`, so `floor(price * rate)` in §6 `M` cannot silently lose
 *   precision.
 * - **Heights are `number`.** The chain is nowhere near 2^53.
 */

import { RESERVED_NAMES } from './reserved-names.js'

/** 1 NIM in luna. */
export const LUNA_PER_NIM = 100_000n

const nim = (amount: bigint): bigint => amount * LUNA_PER_NIM

export const CONSTANTS = Object.freeze({
  // ── Wire format (§5.1, §5.2) ──────────────────────────────────────────────
  /** Prefix of every NNS message. 4 ASCII bytes. */
  PROTOCOL_ID: 'NNS1',
  /**
   * `MAX_BASIC_TX_RECIPIENT_DATA_SIZE`. A **byte** budget, not a character
   * count. 65 bytes is accepted by the RPC and then silently dropped by the
   * network — verified on mainnet 2026-08-06.
   */
  MAX_DATA_BYTES: 64,
  /**
   * `D` is the largest message in the protocol and §6 caps it tighter than
   * the global ceiling, so it keeps the same margin as everything else.
   */
  MAX_DELEGATE_MESSAGE_BYTES: 58,

  // ── Names (§4.1, §4.4) ────────────────────────────────────────────────────
  /** 1–4 character names are withheld for auction (§4.1). */
  MIN_NAME_LEN: 5,
  /** Threshold for the cheap band (§10.1). */
  LONG_NAME_LEN: 12,
  MAX_NAME_LEN: 24,
  /** Subdomain label, §4.4. */
  MAX_LABEL_LEN: 24,
  /** Delegate resolver host, §6 `D`. */
  MAX_HOST_LEN: 30,
  /**
   * §4.1 rule 6, the **published half** of `RESERVED_NAMES`.
   *
   * Authored in `reserved-names.json` and compiled into `reserved-names.ts` by
   * `scripts/gen-reserved-names.ts` — the JSON is a reviewable diff, the
   * generated module is what ships, and **nothing reads the JSON at runtime**: a
   * list loaded from disk is a list two operators can hold different copies of.
   *
   * 1–4 character names are the other half and appear here nowhere: since r18
   * they are members *by rule* (length plus rules 2–5, `isShortReserved`), never
   * materialised into the ~1.7M entries that route would need.
   *
   * Stored sorted so a reviewer can read it, **not** because order means
   * anything — this is a set, and `constants.test.ts` pins it order-insensitively
   * so that resorting it is never a protocol change.
   *
   * **This list is not final.** It is battery-grade: enough to exercise the
   * `G`/`U`/award paths against real entries, not enough to launch behind.
   * Completing it is a blocking pre-launch step (`tasks/08-launch-freeze.md`),
   * and it is free only until `LAUNCH_HEIGHT`.
   *
   * The asymmetry that governs edits: a name left off is registrable by anyone
   * the block after `LAUNCH_HEIGHT` and no rule takes it back — **under-reserving
   * is permanent**. A name reserved by mistake is released, or awarded to the
   * right party, with one `U` (§6 `U`) — **over-reserving is reversible**.
   * *Adding* an entry is out of scope for governance (§10.6) and so is free only
   * until `LAUNCH_HEIGHT`; after it, an addition is a spec revision.
   */
  RESERVED_NAMES,
  /** Integrator referrer id, §6 `G`. */
  MAX_REF_LEN: 12,

  // ── Value (§5.4) ──────────────────────────────────────────────────────────
  /**
   * Value for non-fee-bearing messages. Cannot be 0: the network rejects a
   * `value` of 0, verified twice on mainnet 2026-08-06.
   */
  DUST_VALUE: 1n,
  /** Below this, a refundable amount is forfeited instead (§7.4). */
  REFUND_FLOOR: 10_000n,
  /**
   * Listing fee on `O` (§6 `O`, §10.3). **Zero** — §12 item 3 settled by
   * taking its second option, dropping the fee rather than inventing a `P`
   * field for it.
   *
   * It is a constant and not governance, because no `P` field carries it: an
   * ungovernable price is the one price that cannot track NIM, and §10.6's own
   * argument says a fixed luna amount goes stale. A listing that never settles
   * should cost nothing beyond the network fee, and a listing that does settle
   * is already charged `COMMISSION_RATE` at the moment money actually moves.
   *
   * Consequences worth knowing: an `O` therefore carries `DUST_VALUE` (§5.4
   * rejects a `value` of 0), and `INSUFFICIENT_VALUE` is unreachable for `O`
   * at this value — reachable for `G` and `N` as ever. Making it non-zero is a
   * spec revision from a stated height, like any other frozen §3 number.
   */
  LISTING_FEE: 0n,

  // ── Pricing and governance bounds (§10.1, §10.6) ──────────────────────────
  /** Names of 5–11 characters. Governable within the bounds below. */
  FEE_STANDARD: nim(4_000n),
  /**
   * Names of 12+ characters. Governable within the bounds below.
   *
   * §3 also defines `MIN_PRICE` as `FEE_LONG` — but as the value *in effect at
   * a message's height*, not this launch figure, so there is deliberately no
   * `MIN_PRICE` entry here. Use `minPrice(state.prices)` from `state.ts`.
   */
  FEE_LONG: nim(400n),
  /** Governance hard lower bound, either band. */
  PRICE_FLOOR: nim(1n),
  /** Governance hard upper bound, either band. */
  PRICE_CEILING: nim(100_000n),
  /** Maximum change per adjustment, either band. */
  PRICE_MAX_FACTOR: 2n,
  /** Minimum gap between accepted `P` messages. ~7 d. */
  PRICE_MIN_INTERVAL: 604_800,
  /** Marketplace cut on a settled sale, basis points. Governable. */
  COMMISSION_RATE: 250n,
  /** Governance hard upper bound, basis points. */
  COMMISSION_CEILING: 1_000n,
  /** Maximum change per adjustment, basis points. */
  COMMISSION_MAX_STEP: 250n,
  /** Share of all treasury revenue forwarded to `BURN_ADDRESS`. Not governable. */
  BURN_SHARE_BP: 2_000n,
  /** Denominator for every basis-point figure above. */
  BASIS_POINTS: 10_000n,
  /** Minimum notice before a governance change bites. ~12 h. */
  GOVERNANCE_DELAY: 43_200,

  // ── Timelocks and terms (§6, §10.4) ───────────────────────────────────────
  /** Veto window for `X` and `R`. ~12 h. */
  XFER_TIMELOCK: 43_200,
  /** Recovery-address reclaim, for an `X` sent by the recovery address. ~3 d. */
  RECOVERY_TIMELOCK: 259_200,
  /** ~5 y. */
  TERM_LENGTH: 157_680_000,
  /** Resolution off, renewal still allowed. ~90 d. */
  GRACE_PERIOD: 7_776_000,
  /** Seller cannot cancel an `O` before this. ~2.4 h. */
  OFFER_IRREVOCABLE: 8_640,
  /** Then the offer auto-expires. ~15 d. */
  OFFER_MAX_LIFETIME: 1_296_000,

  // ── Auctions (§6 `A`) ─────────────────────────────────────────────────────
  /** Minimum raise over the standing bid, basis points (5%). */
  AUCTION_MIN_INCREMENT_BP: 500n,
  /** Shortest permitted auction. ~24 h. */
  AUCTION_MIN_DURATION: 86_400,
  /** Anti-sniping extension. ~10 min. */
  AUCTION_EXTENSION: 600,

  // ── State and verification (§8) ───────────────────────────────────────────
  /** Root recomputed and published every this many blocks. ~12 min. */
  CHECKPOINT_INTERVAL: 720,
  /** Log segment boundary (§8.8). ~1 y. */
  SEGMENT_LENGTH: 3_153_600,
  /** Independent resolvers a client must agree before acting (§8.5). */
  RESOLVER_QUORUM: 2,
  /** Independent publishers whose roots must match (§9). */
  ANCHOR_QUORUM: 2,
  /**
   * Client warns beyond this (§8.5). Seconds; core itself never reads a
   * clock. 48 h: one missed daily-floor anchor of margin under §9's
   * on-change cadence (was 2 h against the hourly cadence, same margin at
   * the old scale).
   */
  ANCHOR_STALENESS_LIMIT_SEC: 172_800,

  // ── Addresses that are settled (§3) ───────────────────────────────────────
  /**
   * Canonical Nimiq burn address. Decodes to 20 zero bytes, which is also the
   * §8.1 encoding of an *unset* recovery address — see `docs/decisions.md`.
   */
  BURN_ADDRESS: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
} as const)
