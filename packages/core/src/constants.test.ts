import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseAddress } from './address.js'
import { CONSTANTS, LUNA_PER_NIM, feeMultiplier } from './constants.js'
import { RESERVED_NAMES } from './reserved-names.js'
import { validateNameSyntax } from './name.js'

/** §4.1 rule 6's published half, pinned: see 'equals the published RESERVED_NAMES list'. */
const PUBLISHED_COUNT = 22635
const PUBLISHED_SHA256 = 'd2491e6f3576e8ad403c4bcb813d41e652fa8c46d0a602df6ab2e2a90fd5a921'

describe('CONSTANTS — §3', () => {
  it('is frozen, so nothing downstream can edit a protocol rule at runtime', () => {
    expect(Object.isFrozen(CONSTANTS)).toBe(true)
  })

  it('states every amount in luna, matching the NIM figures §3 prints', () => {
    expect(LUNA_PER_NIM).toBe(100_000n)
    expect(CONSTANTS.FEE_BASE).toBe(62_500_000n) //          625 NIM
    expect(CONSTANTS.PRICE_FLOOR).toBe(100_000n) //         1 NIM
    expect(CONSTANTS.PRICE_CEILING).toBe(10_000_000_000n) // 100,000 NIM
  })

  it('keeps the launch prices inside the governance bounds they are subject to', () => {
    expect(CONSTANTS.FEE_BASE).toBeGreaterThanOrEqual(CONSTANTS.PRICE_FLOOR)
    expect(CONSTANTS.FEE_BASE).toBeLessThanOrEqual(CONSTANTS.PRICE_CEILING)
    expect(CONSTANTS.COMMISSION_RATE).toBeLessThanOrEqual(CONSTANTS.COMMISSION_CEILING)
  })

  it('prices every length from FEE_BASE over the seven §10.1 rows', () => {
    // The table as §3 prints it, one assertion per row edge. Frozen: a P
    // moves FEE_BASE, never a multiplier (§10.6).
    const rows: Array<[number, bigint]> = [
      [1, 200n],
      [2, 200n],
      [3, 100n],
      [4, 50n],
      [5, 25n],
      [6, 10n],
      [7, 5n],
      [11, 5n],
      [12, 1n],
      [CONSTANTS.MAX_NAME_LEN, 1n],
    ]
    for (const [length, times] of rows) expect(feeMultiplier(length), `length ${length}`).toBe(times)
    // The yearly figures the spec quotes, in NIM (§10.1): $5 at the open
    // bands' top, and the released short names above it.
    const nim = (length: number): bigint => (CONSTANTS.FEE_BASE * feeMultiplier(length)) / LUNA_PER_NIM
    expect([nim(2), nim(3), nim(4), nim(5), nim(6), nim(8), nim(12)]).toEqual([
      125_000n,
      62_500n,
      31_250n,
      15_625n,
      6_250n,
      3_125n,
      625n,
    ])
  })

  it('has no band outside 1…MAX_NAME_LEN — a name §4.1 rejects is never priced', () => {
    expect(() => feeMultiplier(0)).toThrow(RangeError)
    expect(() => feeMultiplier(CONSTANTS.MAX_NAME_LEN + 1)).toThrow(RangeError)
    expect(() => feeMultiplier(1.5)).toThrow(RangeError)
    // Rows ascend and the last one ends exactly at the ceiling, so every
    // length in range has exactly one row.
    const edges = CONSTANTS.FEE_MULTIPLIERS.map((row) => row.upTo)
    expect(edges).toEqual([...edges].sort((a, b) => a - b))
    expect(edges.at(-1)).toBe(CONSTANTS.MAX_NAME_LEN)
  })

  it('prices a lifetime at ten yearly fees and a hundred terms, as a plain height (§10.4)', () => {
    expect(CONSTANTS.LIFETIME_MULTIPLIER).toBe(10n)
    expect(CONSTANTS.LIFETIME_TERMS).toBe(100)
    // A century out from any height the chain can reach stays a safe integer
    // and a u64 — the expiry needs no sentinel and §8.1 encodes it as ever.
    const lifetime = CONSTANTS.LIFETIME_TERMS * CONSTANTS.TERM_LENGTH
    expect(lifetime).toBe(3_153_600_000)
    expect(Number.isSafeInteger(CONSTANTS.LAUNCH_HEIGHT + lifetime)).toBe(true)
  })

  it('cannot use a DUST_VALUE of 0 — the network rejects it (§5.4)', () => {
    expect(CONSTANTS.DUST_VALUE).toBeGreaterThan(0n)
  })

  it('caps D below the global data ceiling, so it keeps the same margin (§6 D)', () => {
    expect(CONSTANTS.MAX_DELEGATE_MESSAGE_BYTES).toBeLessThan(CONSTANTS.MAX_DATA_BYTES)
  })

  it('states the sizes §6 gives its largest messages', () => {
    const prefix = CONSTANTS.PROTOCOL_ID.length + 1 // NNS1 + type character
    // Literal pins: recomputed from constants, but asserted against the numbers
    // §6 prints. The *relation* they feed is the test below, kept separate so a
    // profile that moved one of these still reaches the budget check.
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + CONSTANTS.MAX_REF_LEN + 2).toBe(56) // G with |L
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 2).toBe(31) // N and U with |L
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15).toBe(45) // O
    expect(prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15 + 1 + 10).toBe(56) // A
    expect(prefix + 15 + 1 + 5 + 1 + 10).toBe(37) // P
  })

  it('leaves every message type room inside the 64-byte budget (§5.1, §6)', () => {
    const prefix = CONSTANTS.PROTOCOL_ID.length + 1
    const sizes = [
      prefix + CONSTANTS.MAX_NAME_LEN + 1 + CONSTANTS.MAX_REF_LEN + 2, // G with |L
      prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15, // O
      prefix + CONSTANTS.MAX_NAME_LEN + 1 + 15 + 1 + 10, // A
      CONSTANTS.MAX_DELEGATE_MESSAGE_BYTES, // D
    ]
    for (const size of sizes) expect(size).toBeLessThanOrEqual(CONSTANTS.MAX_DATA_BYTES)
  })

  it('orders the name-length thresholds as §4.1 requires', () => {
    expect(CONSTANTS.MIN_NAME_LEN).toBeLessThan(CONSTANTS.MAX_NAME_LEN)
  })

  it('has no recovery timelock — `R` was removed in r20', () => {
    expect(CONSTANTS).not.toHaveProperty('RECOVERY_TIMELOCK')
  })

  it('has no governance rate limit — both were removed in r20 (§10.6)', () => {
    // Deleted rather than widened: a limit loose enough to permit legitimate
    // repricing is loose enough for an attacker to walk through, so the notice
    // window is what protects and these two only implied otherwise. Pinned so
    // reintroducing one is a deliberate edit here as well as in reduce.ts.
    expect(CONSTANTS).not.toHaveProperty('PRICE_MAX_FACTOR')
    expect(CONSTANTS).not.toHaveProperty('PRICE_MIN_INTERVAL')
  })

  it('gives a governance change a full day of notice (§10.6)', () => {
    // The whole of the protection against a hostile P.
    expect(CONSTANTS.GOVERNANCE_DELAY).toBe(86_400)
  })

  it('gives that notice more room than a transfer timelock (§10.6)', () => {
    // Twice XFER_TIMELOCK rather than equal to it as it was through r19, since
    // the notice window is no longer one protection among several.
    //
    // Split out of the literal pin above deliberately: this is a *relation*,
    // and behind `toBe(86_400)` it never ran on a compressed-tempo branch —
    // the literal throws first and takes the relation with it. Every
    // relational assertion in this file has to survive a profile edit, because
    // that branch is where the constants are most likely to be wrong.
    // `scripts/check-tempo-relations.mjs` is the fork-time run of all of them.
    expect(CONSTANTS.GOVERNANCE_DELAY).toBeGreaterThan(CONSTANTS.XFER_TIMELOCK)
  })

  it('keeps the grace period shorter than the term it follows (§7.3, §10.4)', () => {
    // The two move together — r20 shortened both — and a grace period at or
    // past a full term would let a name sit unresolvable for longer than it
    // was ever owned, with §10.4's reminder (GRACE_PERIOD × 2) firing before
    // the registration it warns about.
    expect(CONSTANTS.GRACE_PERIOD).toBeLessThan(CONSTANTS.TERM_LENGTH)
    expect(CONSTANTS.GRACE_PERIOD * 2).toBeLessThan(CONSTANTS.TERM_LENGTH)
  })

  it('keeps the anti-sniping extension inside the shortest auction (§6 A, r28)', () => {
    // A late bid moves the end to `bid + AUCTION_EXTENSION`; an extension at
    // or past AUCTION_MIN_DURATION would let one bid define a longer window
    // than the opener was allowed to. A relation, so it survives a tempo
    // profile — `scripts/check-tempo-relations.mjs` runs it at fork time.
    expect(CONSTANTS.AUCTION_EXTENSION).toBeLessThan(CONSTANTS.AUCTION_MIN_DURATION)
    // The cap is judged after the floor, so a window between the two is the
    // only legal one — an empty band would refuse every A.
    expect(CONSTANTS.AUCTION_MIN_DURATION).toBeLessThan(CONSTANTS.AUCTION_MAX_DURATION)
    expect(CONSTANTS.AUCTION_MAX_DURATION).toBeLessThan(CONSTANTS.TERM_LENGTH)
  })

  it('equals the mainnet values, field for field', () => {
    // Every value restated as an inline literal — never derived from
    // constants.ts, or an edit there would move both sides. Compressed-tempo
    // testing edits CONSTANTS on a throwaway branch that is never merged;
    // this is the test that
    // fails CI if such an edit ever reaches master. It also covers
    // CHECKPOINT_INTERVAL, which no conformance vector exercises.
    // RESERVED_NAMES is not a member (it is its own export, so a bundle can
    // drop it) and is pinned separately below, as a set.
    const values = CONSTANTS
    expect(values).toStrictEqual({
      // Not a §3 value: the revision these rules claim to be, pinned here so
      // a fold that moves a rule and forgets the number fails on the way out.
      SPEC_REVISION: 31,
      PROTOCOL_ID: 'NNS1',
      MAX_DATA_BYTES: 64,
      MAX_DELEGATE_MESSAGE_BYTES: 58,
      MIN_NAME_LEN: 5,
      MAX_NAME_LEN: 24,
      MAX_LABEL_LEN: 24,
      MAX_HOST_LEN: 30,
      MAX_REF_LEN: 24,
      DUST_VALUE: 1n,
      REFUND_FLOOR: 100_000n,
      LISTING_FEE: 0n,
      FEE_BASE: 62_500_000n, //                625 NIM
      FEE_MULTIPLIERS: [
        { upTo: 2, times: 200n },
        { upTo: 3, times: 100n },
        { upTo: 4, times: 50n },
        { upTo: 5, times: 25n },
        { upTo: 6, times: 10n },
        { upTo: 11, times: 5n },
        { upTo: 24, times: 1n },
      ],
      LIFETIME_MULTIPLIER: 10n,
      LIFETIME_TERMS: 100,
      PRICE_FLOOR: 100_000n, //                  1 NIM
      PRICE_CEILING: 10_000_000_000n, //   100,000 NIM
      COMMISSION_RATE: 250n,
      COMMISSION_CEILING: 1_000n,
      COMMISSION_MAX_STEP: 250n,
      BURN_SHARE_BP: 2_000n,
      BASIS_POINTS: 10_000n,
      GOVERNANCE_DELAY: 86_400,
      XFER_TIMELOCK: 43_200,
      TERM_LENGTH: 31_536_000,
      GRACE_PERIOD: 2_592_000,
      OFFER_MAX_LIFETIME: 1_296_000,
      AUCTION_MIN_INCREMENT_BP: 500n,
      AUCTION_MIN_DURATION: 86_400,
      AUCTION_MAX_DURATION: 604_800,
      AUCTION_EXTENSION: 600,
      CHECKPOINT_INTERVAL: 60,
      SEGMENT_LENGTH: 31_536_000,
      RESOLVER_QUORUM: 2,
      ANCHOR_QUORUM: 2,
      ANCHOR_STALENESS_LIMIT_SEC: 172_800,
      // The launch freeze's second half (2026-08-14). The height and the
      // four addresses are the operator-supplied battery cast; launch
      // replaces them in a second freeze that edits these exact literals
      // (the launch freeze). Compact form: parseAddress strips the spaces.
      LAUNCH_HEIGHT: 62_275_680,
      TREASURY_ADDRESS: 'NQ39M3TJ2NC1G4PJ07JFBFKGQ3X6AK7KJ7YT',
      PROTOCOL_ADDRESS: 'NQ91SQRCL91XD5QK6A211UV711EY7YA3BBRT',
      ADMIN_ADDRESS: 'NQ950MNSX5BJ3SMVXA2E7059BU9FAXX6J4MX',
      MARKETPLACE_ADDRESS: 'NQ55SY337HS4DP5NH9P09PMG7MD8PTL8N2P5',
      BURN_ADDRESS: 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    })
  })

  it('keeps the four §3 role addresses pairwise distinct (§3, §10.6)', () => {
    // The check `defineConfig` ran at every startup, asserted once now that
    // the values are literals: the treasury/protocol split is what makes the
    // burn base exact, the admin key is cold while the treasury is hot, and
    // the marketplace is "distinct from both".
    const roles = [
      CONSTANTS.TREASURY_ADDRESS,
      CONSTANTS.PROTOCOL_ADDRESS,
      CONSTANTS.ADMIN_ADDRESS,
      CONSTANTS.MARKETPLACE_ADDRESS,
    ]
    expect(new Set(roles).size).toBe(roles.length)
    // And none of them is the burn address, which decodes to the §8.1
    // "unset" sentinel of 20 zero bytes.
    for (const role of roles) expect(role).not.toBe(parseAddress(CONSTANTS.BURN_ADDRESS))
  })

  it('sits LAUNCH_HEIGHT above the PoS genesis, where batch numbering starts', () => {
    expect(CONSTANTS.LAUNCH_HEIGHT).toBeGreaterThan(3_456_000)
  })

  it('equals the published RESERVED_NAMES list, as a set — order is not protocol (§4.1)', () => {
    // The same hand-moved pin as above, in the form a ten-thousand-name list
    // can carry: the count and the sha256 of the sorted, newline-joined set.
    // An inline copy of every name would be the third copy of the list in the
    // repo (the category files, the generated module, the test) for no extra
    // strength — any change still turns this red, and the literal still has
    // to be moved by hand. Sorting first is what keeps it a *set* pin:
    // resorting the constant must never be a protocol change or a red run.
    // The count is what catches a duplicate that the set digest would swallow.
    const sorted = [...new Set(RESERVED_NAMES)].sort()
    expect(RESERVED_NAMES).toHaveLength(PUBLISHED_COUNT)
    expect(sorted).toHaveLength(PUBLISHED_COUNT)
    expect(createHash('sha256').update(sorted.join('\n')).digest('hex')).toBe(PUBLISHED_SHA256)
  })

  it('holds no duplicate entry — membership is a set (§4.1 rule 6)', () => {
    // Split out of the literal list pin above: a duplicate is what set
    // comparison alone swallows, and behind that pin this never ran on a tempo
    // branch — which is exactly the branch that appends throwaway entries to
    // the list.
    expect(new Set(RESERVED_NAMES).size).toBe(RESERVED_NAMES.length)
  })

  it('keeps every published entry registrable, so no entry reserves nothing', () => {
    // An entry that no `G` could ever carry — uppercase, too short, a digit in
    // the wrong place — silently reserves nothing at all: the name it looks
    // like stays registrable and nobody finds out until it is taken. §4.1
    // never normalises, so this is exact.
    for (const name of RESERVED_NAMES) {
      expect(validateNameSyntax(name), name).toEqual({ ok: true })
      expect(name.length, name).toBeGreaterThanOrEqual(CONSTANTS.MIN_NAME_LEN)
      expect(name, name).toBe(name.toLowerCase())
    }
  })

  it('leaves the published list to the names the by-rule route cannot reach', () => {
    // 1–4 character names are members by rule (§4.1, r18) and are deliberately
    // not materialised. An entry here would be either redundant or, worse,
    // read as the list being the only route.
    expect(RESERVED_NAMES.filter((name) => name.length < CONSTANTS.MIN_NAME_LEN)).toEqual([])
  })

  it('freezes the list itself, not just the object holding it', () => {
    // Object.freeze is shallow; a frozen CONSTANTS with a live array is a
    // consensus input any caller could push onto.
    expect(Object.isFrozen(RESERVED_NAMES)).toBe(true)
  })
})
