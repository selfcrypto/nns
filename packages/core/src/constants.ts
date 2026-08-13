/**
 * Protocol constants — spec §3.
 *
 * Only settled values live here. The five §3 entries still marked **OPEN**
 * (`LAUNCH_HEIGHT`, `TREASURY_ADDRESS`, `PROTOCOL_ADDRESS`, `ADMIN_ADDRESS`,
 * `MARKETPLACE_ADDRESS`) plus `RESERVED_NAMES` are injected through
 * {@link ./config.ts | NnsConfig} instead, so nothing invented can be baked
 * into a build and reach mainnet unnoticed.
 *
 * No magic number appears anywhere else in this package.
 *
 * Two unit conventions, applied without exception:
 * - **Amounts are `bigint` luna.** 1 NIM = 100,000 luna. Never a float, and
 *   never a `number`, so `floor(price * rate)` in §6 `M` cannot silently lose
 *   precision.
 * - **Heights are `number`.** The chain is nowhere near 2^53.
 */

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
  /** Client warns beyond this (§8.5). Seconds; core itself never reads a clock. */
  ANCHOR_STALENESS_LIMIT_SEC: 7_200,

  // ── Addresses that are settled (§3) ───────────────────────────────────────
  /**
   * Canonical Nimiq burn address. Decodes to 20 zero bytes, which is also the
   * §8.1 encoding of an *unset* recovery address — see `docs/decisions.md`.
   */
  BURN_ADDRESS: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
} as const)

/**
 * The shape of a constants profile. Structurally `CONSTANTS`, with the literal
 * value types widened so a profile can state different figures for the same
 * fields.
 */
export type Constants = {
  readonly [K in keyof typeof CONSTANTS]: (typeof CONSTANTS)[K] extends bigint
    ? bigint
    : (typeof CONSTANTS)[K] extends number
      ? number
      : (typeof CONSTANTS)[K] extends string
        ? string
        : (typeof CONSTANTS)[K]
}

// ── Profiles ─────────────────────────────────────────────────────────────────

/**
 * ÷1000, to the nearest block, never below one block. Applied to the eight
 * profiled waiting periods; the two sub-block quotients this rounds
 * (`OFFER_IRREVOCABLE` → 8.64, `CHECKPOINT_INTERVAL` → 0.72) are noted inline.
 */
const div1000 = (blocks: number): number => Math.max(1, Math.round(blocks / 1000))

/**
 * The `fast` profile: every §3 waiting period ÷1000, the two fee bands ÷100.
 *
 * What a profile may vary is deliberately narrow — eight timing constants and
 * two fees. Everything else is identical in every profile, because it is not
 * ours to scale: the 64-byte data ceiling and `FINALITY_RULE` are the chain's,
 * and the wire format, name rules and governance bounds are the protocol's
 * shape rather than its tempo.
 *
 * The orderings the mainnet figures guarantee survive the division:
 * `RECOVERY_TIMELOCK` (259) > `XFER_TIMELOCK` (43), `OFFER_IRREVOCABLE` (9) <
 * `OFFER_MAX_LIFETIME` (1 296), and both fee bands stay inside
 * `PRICE_FLOOR`/`PRICE_CEILING` with `FEE_LONG` ≤ `FEE_STANDARD` — the profile
 * suite in `constants.test.ts` pins all of them.
 */
const FAST: Constants = Object.freeze({
  ...CONSTANTS,
  XFER_TIMELOCK: div1000(CONSTANTS.XFER_TIMELOCK), //           43   (~43 s)
  RECOVERY_TIMELOCK: div1000(CONSTANTS.RECOVERY_TIMELOCK), //   259
  GOVERNANCE_DELAY: div1000(CONSTANTS.GOVERNANCE_DELAY), //     43
  TERM_LENGTH: div1000(CONSTANTS.TERM_LENGTH), //           157 680  (~1.8 d)
  GRACE_PERIOD: div1000(CONSTANTS.GRACE_PERIOD), //           7 776
  OFFER_IRREVOCABLE: div1000(CONSTANTS.OFFER_IRREVOCABLE), //     9   (8.64 rounded up)
  OFFER_MAX_LIFETIME: div1000(CONSTANTS.OFFER_MAX_LIFETIME), // 1 296
  CHECKPOINT_INTERVAL: div1000(CONSTANTS.CHECKPOINT_INTERVAL), // 1   (0.72, floored at one block)
  FEE_STANDARD: CONSTANTS.FEE_STANDARD / 100n, //            40 NIM
  FEE_LONG: CONSTANTS.FEE_LONG / 100n, //                     4 NIM
})

export type ProfileName = 'mainnet' | 'fast'

export const isProfileName = (value: string): value is ProfileName => value === 'mainnet' || value === 'fast'

/**
 * Named constants profiles.
 *
 * `mainnet` **is** {@link CONSTANTS} — the same frozen object, the §3 values,
 * the only profile whose roots mean anything outside a test bench. `fast`
 * compresses the protocol's tempo so a full name lifecycle — register, expire,
 * grace, release — fits a test run against a local chain instead of five
 * years.
 *
 * Selection happens once, in `defineConfig` (default `mainnet`, loudly warned
 * otherwise); the choice rides on the state (`NnsState.profile`) from
 * `initialState` onward and is committed into the checkpoint (`checkpoint()`),
 * so a root derived under `fast` is domain-separated from every mainnet root
 * and can never be quoted as a conformance baseline. Conformance vectors are
 * mainnet, always.
 */
export const PROFILES: Readonly<Record<ProfileName, Constants>> = Object.freeze({
  mainnet: CONSTANTS,
  fast: FAST,
})
