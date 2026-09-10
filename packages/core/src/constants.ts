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
 * `LAUNCH_HEIGHT` and the four §3 addresses followed at the second half of
 * the freeze (2026-08-14): the operator supplied the funded addresses whose
 * keys are held in `~/.nns`, deciding that this whole cast is replaced at
 * launch by a **second freeze** — a deliberate commit that edits these pinned
 * literals (`tasks/08` step 7 bumps the height; the addresses are regenerated
 * with it). What may never happen is a *silent* placeholder: every value here
 * is pinned by `constants.test.ts`, so replacing one is a red diff on a
 * literal, not a config drift.
 *
 * The only configuration left is `networkId` ({@link ./config.ts | NnsConfig}):
 * mainnet and testnet honestly differ, so two honest deployments may
 * legitimately disagree about it.
 *
 * No magic number appears anywhere else in this package.
 *
 * Two unit conventions, applied without exception:
 * - **Amounts are `bigint` luna.** 1 NIM = 100,000 luna. Never a float, and
 *   never a `number`, so `floor(price * rate)` in §6 `M` cannot silently lose
 *   precision.
 * - **Heights are `number`.** The chain is nowhere near 2^53.
 */

import { parseAddress } from './address.js'
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
  /**
   * Referrer on a registration, §6 `G` — a registered name, so it equals
   * `MAX_NAME_LEN`. `G` at its largest is 54 bytes (§5.1's ceiling is 64).
   */
  MAX_REF_LEN: 24,

  // ── Value (§5.4) ──────────────────────────────────────────────────────────
  /**
   * Value for non-fee-bearing messages. Cannot be 0: the network rejects a
   * `value` of 0, verified twice on mainnet 2026-08-06.
   */
  DUST_VALUE: 1n,
  /**
   * Below this, a refundable amount is forfeited instead (§7.4). 1 NIM since
   * r29 (was 10,000 luna): a whole number reads in every price and every
   * document, and nothing an honest client sends is a fraction of a NIM.
   */
  REFUND_FLOOR: nim(1n),
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
  FEE_STANDARD: nim(2_000n),
  /**
   * Names of 12+ characters. Governable within the bounds below.
   *
   * §3 also defines `MIN_PRICE` as `FEE_LONG` — but as the value *in effect at
   * a message's height*, not this launch figure, so there is deliberately no
   * `MIN_PRICE` entry here. Use `minPrice(state.prices)` from `state.ts`.
   */
  FEE_LONG: nim(400n),
  /**
   * Governance hard lower bound, either band — a **fat-finger rail, not attack
   * protection** (§10.6). A key that can set the price to the floor is already
   * a key the registry has to fork away from.
   */
  PRICE_FLOOR: nim(1n),
  /** Governance hard upper bound, either band. Same rail, other end. */
  PRICE_CEILING: nim(100_000n),
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
  /**
   * Minimum notice before a governance change bites. ~24 h.
   *
   * **This is the whole of the protection against a hostile `P`**, now that the
   * rate limits are gone (§10.6): a malicious change is visible on-chain for a
   * day before it does anything, and the remedy is a coordinated fork, not a
   * bound. It was 43,200 (~12 h) while `PRICE_MAX_FACTOR` and
   * `PRICE_MIN_INTERVAL` were expected to do part of that work.
   */
  GOVERNANCE_DELAY: 86_400,

  // ── Timelocks and terms (§6, §10.4) ───────────────────────────────────────
  /**
   * How long a pending `X` waits, and so the window in which the owner can
   * cancel their own transfer with a `K` (§6 `X`, §6 `K`). ~12 h.
   *
   * Guards a mistyped recipient, not a stolen key: `O` + `B` moves a name in
   * two blocks with no timelock at all (§6 `B`, §2).
   */
  XFER_TIMELOCK: 43_200,
  /** ~1 y. */
  TERM_LENGTH: 31_536_000,
  /** Resolution off, renewal still allowed. ~30 d. */
  GRACE_PERIOD: 2_592_000,
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
  /** Log segment boundary (§8.8). ~1 y — was 3,153,600 (~36 days) through r28, a tenth of what the label said; nothing reads it yet. */
  SEGMENT_LENGTH: 31_536_000,
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

  // ── Launch (§3, §7.2) ─────────────────────────────────────────────────────
  /**
   * Indexers start here, not at genesis; the checkpoint at this height is
   * §8.1's genesis. Frozen 2026-08-14 at the height the indexer deployment
   * already started from, 60 blocks above the node's measured history horizon
   * (58,842,660) so the determinism harness can run against this exact value.
   *
   * **Provisional by design, not by accident**: `tasks/08` step 7 bumps this
   * pinned literal to a future mainnet height in a deliberate commit before
   * going live, and the compressed-tempo battery edits it on its throwaway
   * branch. Neither is a config override — there is no env var for it.
   */
  LAUNCH_HEIGHT: 58_842_720,

  // ── Addresses that are settled (§3) ───────────────────────────────────────
  /**
   * The four §3 role addresses, frozen 2026-08-14 (launch freeze, second
   * half). These are the funded battery addresses whose keys the operator
   * holds in `~/.nns` — chosen deliberately: the battery must test the build
   * that ships, and launch replaces the whole cast in a second freeze (see
   * the header). All four are pairwise distinct (§3, §10.6), asserted once in
   * `constants.test.ts` now that they are literals rather than at every
   * startup.
   */
  /** Receives fees — and only fees (§5.3). */
  TREASURY_ADDRESS: parseAddress('NQ28 TKBF VF67 HP8R Y812 5FNM NNDN TS7Q F5G3'),
  /** Receives dust-only signalling, and acts as the §5.3 sentinel. */
  PROTOCOL_ADDRESS: parseAddress('NQ38 NKD4 7ALG YRDQ DXL8 PARE 7JRS JGJD MAU8'),
  /** Governance only; cold key, distinct from the treasury (§10.6). */
  ADMIN_ADDRESS: parseAddress('NQ80 6XNV JDFY YEKF HMM3 UCYK VBLP 7H6Y FNXS'),
  /** `B` escrow and `M` settlement; the only NNS hot wallet (§3). */
  MARKETPLACE_ADDRESS: parseAddress('NQ71 TPMV QN9D MV6A 1HX1 NL2Q 4CJG 5J8M QPTB'),
  /**
   * Canonical Nimiq burn address. Decodes to 20 zero bytes, which is also the
   * §8.1 encoding of an *unset* recovery address — see `docs/decisions.md`.
   */
  BURN_ADDRESS: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
} as const)
