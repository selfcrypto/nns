# NNS conformance vectors

A shipped deliverable, not internal tests (spec §14). These files are the
artifact; `vectors.test.ts` is only one consumer of them. **An independent
implementation reads the JSON, not the TypeScript.**

They exist because of the three places implementations fork *silently* rather
than loudly:

| Area | File | Spec |
|---|---|---|
| Merkle leaf byte layout | `merkle.json` | §8.1 |
| The checkpoint commitment, byte for byte | `merkle.json` | §8.1 |
| Canonical ordering across a multi-transaction block | `ordering.json` | §5.2 |
| Name validation, positional-digit and boundary rules | `names.json` | §4.1, §4.2 |

`codec.json` and `reduce.json` cover the wire format (§5, §6) and the replay
rules (§7). The named case `failed_G_does_not_register_name` lives in
`reduce.json`.

## Conventions

- **Hex** is lowercase and unprefixed, throughout.
- **Amounts** are luna as decimal *strings*, because they can exceed a double.
  Never parse them as floats.
- **Heights** are JSON numbers. The chain is nowhere near 2^53.
- **Addresses** appear as aliases (`ALICE`, `TREASURY`) resolved through each
  file's `addresses` map, which holds real `NQ…` strings with valid checksums.
  A field may also carry a literal `NQ…` string.
- **`text` and `data`** are the same message: `text` is the readable ASCII form
  for review, `data` is its lowercase hex. A runner should assert they agree —
  that is what stops the reviewable field and the machine field drifting apart.
- The fixture addresses are arbitrary. The five §3 addresses are still **OPEN**,
  and nothing may depend on their identity.

## Which fields are hand-authored

Everything a human should check is written by hand: inputs, expected verdicts,
expected owners, expected reason codes, and the `note` on each case explaining
what it pins down.

Only mechanically derived values are generated, by `fill.ts`: `data` (hex of
`text`), the Merkle `enc` / `leaf` / `root` values, and the log lines and
hashes in `ordering.json`. Regenerate with:

```sh
npx tsx vectors/fill.ts
```

The runner re-derives every one of them independently, so a wrong generated
value fails the suite rather than hiding in it.

## File shapes

### `names.json`

Five case lists: `cases` (names), `labels`, `hosts`, `refs`, `queries`. Each
case has an `id`, the input, and `valid: true|false` with a `reason` code when
invalid. `reserved` on a name case supplies `RESERVED_NAMES` for that case
only; it defaults to empty.

### `codec.json`

- `roundTrip.cases` — encode `message` and get `data`; parse `data` and get
  `message` back. `build` names the §6 builder and its arguments; `recipient`
  and `value` are the other two transaction fields (§5.3, §5.4). `byteLength`,
  where present, is the size §6 states for that message.
- `parseOnly.cases` — read-side only, including payloads no builder will
  produce. `result` is `{ok: true, message}` or `{ok: false, reason}`.
- `builderErrors.cases` — each must throw. Builders fail loudly where the chain
  fails silently.

### `merkle.json`

- `leaves.cases` — a record, its §8.1 `enc` preimage, and its `leaf` hash.
- `roots.cases` — names (plus `roots.defaults` and optional per-name
  `overrides`) and the resulting `root`.
- `sorting.cases` — bytewise-lexicographic ordering.
- `proofs` — inclusion proofs over a fixed five-leaf tree, and non-inclusion.
- `checkpoints` — the §8.1 commitment. `state` is the part of the registry the
  clause requires committed and `logHash` is an input; `nameRoot`,
  `pricesRoot`, `pendingRoot`, `unreservedRoot` and `commitment` are derived.
  `tags` lists the domain-separation byte for each component. The empty forms
  are pinned deliberately: an empty name tree is 32 zero bytes, while an empty
  pending or unreserved set is `keccak256(0x04)` / `keccak256(0x0A)` — the tag
  byte alone.

  **These commitments are r29 as of the 2026-09-11 fold.** The `prices`
  digest under tag `0x03` is two fields — `fee_base`, `commission_bp` —
  since §10.1 collapsed the two governed prices into one base fee, so
  `COMMITMENT_LAYOUT` is 6 and **every commitment in this file moved**
  (`prices_moved_by_a_P` now doubles the base). The leaf gained `evm:20B` at r26
  (`COMMITMENT_LAYOUT` 5; `evm_set_is_twenty_raw_bytes` pins the encoding),
  so every commitment over a state with a name in it moved at that bump.
  r28 added the open-auction entry under tag `0x0B`, between offers and
  governance — `one_open_auction_no_bid` pins the unmet-starting-price form (20 zero
  bytes and a zero bid), `one_open_auction_with_bid` the standing bid — and
  moved **no other value**: an empty category contributes nothing, so
  `COMMITMENT_LAYOUT` stays 5 on r22's argument, and `every_pending_category`
  is again the one case whose value moved because its state did.
  The unreserved set (tag `0x0A`, r16) is the
  sixth component; an r15 implementation reproduces all four component digests
  and none of the commitments. `one_fired_unreserve` is the pair that shows
  why the component exists — a released name has no leaf and no pending entry,
  so without `0x0A` it is invisible to the checkpoint.

  **r22 removed the pending `U` (tag `0x09`), and that moved no bytes.** The
  pending set concatenates its categories with no separators and no entry
  count, so a category with no entries contributed nothing even while it
  existed: every case here whose state was reachable under r21 keeps its r21
  value byte for byte. The two r17 cases that pinned the recipient inside a
  pending entry are **deleted** — their state cannot occur — and
  `every_pending_category` lost its fourth entry, which makes it the one value
  in this file that moved, and it moved because its state did.

### `ordering.json` and `reduce.json`

`ordering.json` authors one block's transactions in **response order**,
which deliberately never matches canonical order: a runner ranks them per
§5.2 (r27 — `(blockNumber, hash ascending bytewise)` over the block's
`NNS1`-prefixed transactions, before any §7.5 discard) and then reduces in
rank order, pinning the owner, each transaction's `txIndex`, the log lines,
the log hash and the root. A transaction authored without `txIndex` must be
excluded from the universe and never reduced. `reduce.json` runs `steps`
against a fresh state: each step is a transaction (`tx` + expected `verdict`),
a bare height advance (`advanceTo`), or an intermediate `check`.

**`advanceTo` is not decoration.** Expiry, grace release, timelock maturity and
governance activation are driven by height, not by messages. An implementation
that only advances state when a transaction arrives will pass most of these
scenarios and produce a wrong root at any checkpoint taken during a quiet
stretch.

A `check` reads the state at that point. Beyond `names`, `resolves` and
`prices` it may carry `absent`, `height`, `transfers`, `offers`, `auctions`
(r28 — `bidder: null` asserts no bid has met the starting price),
`pendingGovernance`, `unreserved`, `outstanding` and `logLines`
(`pendingUnreserve` was one until r22 removed the pending `U`); a `null`
value in any of the pending maps asserts the entry is **gone**, which is what
a scheduled effect firing actually looks like. `outstanding` is keyed by
`refKey` (`"height:txIndex"`) and each key's leg list is exhaustive and
ordered; it exists because §6 `M` discharge is the one rule whose outcome no
verdict, root, or log-hash assertion can see — every `M` earns the same `OK`
line whatever it discharged, and §8.1 keeps obligations out of the
commitment — so without this field a discharge vector could not be expressed
at all. Two more fields exist for the
boundary scenarios below:

- **`label`** snapshots the four §8.1 component digests — `nameRoot`,
  `pricesRoot`, `pendingRoot`, `unreservedRoot`. That is the commitment minus
  the height and the log hash, on purpose: `commitmentFrom` binds the height,
  so two checkpoints a block apart differ whether or not anything happened,
  and comparing whole commitments would prove nothing about a boundary.
- **`since`** + **`changed`** compares against an earlier label. `changed` is
  **exhaustive**: every component not named in it MUST be byte-identical.

### The `boundary_*` scenarios — exact firing heights

One scenario per §7.3 height-driven category — six since r28 — each
asserting the transition at exactly `h` **and its absence at `h-1`**.

They exist because every other way of observing these effects is blind to a
one-block error. A checkpoint is only taken every `CHECKPOINT_INTERVAL`
blocks, so "the root differs across the gap" cannot distinguish `h` from
`h+1`; and none of these effects earns a §7.4 verdict token, so a replay can
agree with a second implementation on all 28 tokens, produce matching roots at
every checkpoint, and still fire an effect a block early. Each scenario
therefore asserts `logLines` on both sides of the crossing as well: **a height
advance MUST never emit a §8.2 line.**

| Scenario | Fires at | Stated by |
|---|---|---|
| `boundary_offer_expires_at_OFFER_MAX_LIFETIME` | `opened + OFFER_MAX_LIFETIME` | §6 `O` "auto-expiring at" |
| `boundary_auction_closes_at_end_height` | `end_height`, as moved by extensions | §6 `A` (r28); sixth category, after the maturing `X` |
| `boundary_transfer_matures_at_XFER_TIMELOCK` | `landing + XFER_TIMELOCK` | §6 `X` "Takes effect at" |
| `boundary_governance_activates_at_effective_height` | `effective_height` | §6 `P` |
| `boundary_expiry_grace_and_the_fall_to_available` | `expiry`, then `expiry + GRACE_PERIOD` | §7.3's interval table (r21) |
| `boundary_renewal_window_closes_with_the_grace_period` | `expiry + GRACE_PERIOD` | same |

Three of these are timed by constants r20 moved — `TERM_LENGTH`,
`GRACE_PERIOD` and `GOVERNANCE_DELAY` — so what the vectors pin is the
boundary arithmetic, not the transition.

**There were two more, and r22 removed the effect rather than the vector.**
`boundary_unreserve_releases_at_effective_height` and its award twin pinned a
`U` firing at `effective_height`; a `U` now fires in the block it lands in and
has no height to pin (§6 `U`). Their replacements are named
`unreserve_release_completes_in_its_landing_block` and
`unreserve_award_completes_in_its_landing_block`, and they assert the negative
instead: the whole effect is in the landing block, and advancing a full
`GOVERNANCE_DELAY` past it moves **no** component. They are deliberately *not*
named `boundary_*`, so the census above keeps meaning "one per height-driven
category" rather than quietly counting a vector that no longer pins a height.

### `checkOrder` — which check runs first

Forty-four cases in `reduce.json`'s own section, not scenarios. Each is a
message that satisfies **two** rejection conditions at once: `verdict` is the
token the earlier check produces, and `insteadOf` is the same probe rebuilt to
trip only the later one, run against the same pre-state and required to earn
the other token. Both halves are the assertion — swap the checks and the first
expectation fails; delete the later check and the second does.

`setup` names an entry in `checkOrder.setups`. `pinnedBy` names the clause
fixing the order, or is `null`. `insteadOfUnreachable` replaces `insteadOf`
where the later token cannot be produced at all (one row: with an auction
open on a name, no `A` for it reaches the checks behind `AUCTION_OPEN`).

**Twenty-five of the forty-four orderings are fixed by the spec; nineteen
are implementation choices.** The 2026-09-11 fold split `U`'s last row by
recipient — `NAME_NOT_RESERVED` for a release, `NAME_NOT_AVAILABLE` for an
award — and `U_invalid_name_beats_name_not_available` pins the award's
row behind the name syntax as the release's twin does. r28 activated `A` and stated its whole order
in §7.4's table — name state, sender, `AUCTION_OPEN`, `BELOW_MIN_PRICE`,
`INSUFFICIENT_NOTICE` — and the `AUCTION_OPEN` row's place in `O` and `X`;
its two version-forfeit rows went and seven citing that table came. §7.4 fixes `G`'s five-check order ("recipient, name
syntax, reservation, **value, then availability**"), `REFUND_FLOOR` converting
a refund into a forfeit, the parse chain ("hex → `NNS1` prefix → length →
type → payload" — pinning the two `parse_*` rows since r23, below), and —
since r21, shortened by r22 — a `U`'s four ("sender, recipient, name syntax,
reservation"). §7.5 runs before a message is parsed. Everything
else is a bullet list read as an order it never claimed to be, and the tokens
carried forward as PROVEN-AT-R19 still lean on it: `INVALID_HOST`,
`NAME_NOT_FOUND`, `BELOW_MIN_PRICE`, `WRONG_SENDER` and `MALFORMED_PAYLOAD`
sit behind a `pinnedBy: null` row. Three more — `INVALID_RECIPIENT`,
`NOT_ADMIN` and `NAME_NOT_RESERVED` — did until r21 ratified `U`'s order.
`INSUFFICIENT_NOTICE` was a fourth; r22 took it out of `U` altogether, so its
only remaining ordering is `P`'s, which is still free.

**Three of these were unstated when the vectors were written, and the spec now
states them.** Each is now a `pinnedBy` row rather than a free one, and the
vectors are the evidence for the clause rather than a substitute for it:

- **`U`'s recipient before the rest of it.** Through r20 §7.4 listed a `U`'s
  forfeits with notice *ahead* of the recipient and never claimed to be an
  order. r21 reorders the bullet and states the order outright — the recipient
  leads because since r17 it is an *operand* choosing release from award (§5.3),
  so a `U` naming `BURN_ADDRESS` is neither operation, and judging anything else
  about it reports a defect it does not have. r22 then removed the notice row
  the recipient used to lead, without touching that reasoning: the pair is now
  `U_invalid_recipient_beats_invalid_name`, and the recipient leads the name
  rows instead.
- **`A`'s routing before everything else.** Through r20 "every `A` forfeits
  `AUCTION_NOT_IN_V1`" was absolute and the §5.3 exception was implicit; r21
  stated it, and r28 removed the version forfeit altogether — the pair is now
  `A_wrong_recipient_beats_name_not_found`, routing ahead of the name rows
  exactly as for every other routed type.
- **The two `parse_*` rows, since r23's §5.2 amendment.** Through r22 §5.2
  said an unknown type or an over-length payload is "ignored" while §7.4
  forfeited both and §8.2 logged them — so what the null marker recorded was
  a dispute over the tokens' *existence*, not their position: no clause could
  pin an order between two verdicts one half of the spec said were never
  written. r23 ratifies the §7.4/§7.6/§8.2 reading (the one these vectors and
  `core` always took), and the parse chain "hex → `NNS1` prefix → length →
  type → payload" now pins both rows. The scenario
  `the_NNS1_prefix_is_the_ignore_boundary` carries the boundary itself: the
  unknown-type member is mainnet-reachable for dust, so the fork was live.

The expiry pair was the fourth, and §7.3 now carries an interval table for it —
`[registration, registration + TERM_LENGTH)` and `[expiry, expiry +
GRACE_PERIOD)`.

## The readings these vectors pin

Each was found while implementing `core` and ratified into the spec by r15. They are listed here because each is a place two
implementations fork *silently* if they read the clause differently:

1. **Numeric fields are canonical decimal** — no sign, leading zeros or
   whitespace. `NNS1Okikename|0123` is `MALFORMED_PAYLOAD` (§5.2).
2. **`data` in a log line is hex.** Raw text would let a payload containing a
   newline forge an entire log line (§8.2).
3. **Effects due at the same height fire in a fixed order** and before that
   block's transactions; a maturing transfer runs before an expiry it collides
   with (§7.3).
4. **A `G` is checked for sufficient value before availability**, so an
   underfunded registration for a taken name forfeits rather than refunds
   (§7.4).
5. **`A` (auction) is a v1 rule since r28.** Through r27 every `A` forfeited
   `AUCTION_NOT_IN_V1` by protocol version, so that an implementation
   honouring auctions could not silently derive a different root from one that
   did not; r28 activated it before anything launched, when "a stated height"
   is simply `LAUNCH_HEIGHT`. The six `auction_*` / `admin_auction_*` /
   `grace_reset_cancels_an_auction_*` scenarios pin the rules: bids are `B`s
   dispatched by state, the outbid bidder is refunded at once, a late bid
   moves the end, the close is a height effect owing two legs by the winning
   bid's ref, and the grace reset cancels with a refund.
6. **Proof steps carry a side.** §8.3's pre-r15 bare hash array is not
   verifiable under odd-node promotion.
7. **An `O` price below `MIN_PRICE` forfeits**, and `MIN_PRICE` is `FEE_BASE`
   *at that message's height* — so a `P` that moves `FEE_BASE` moves the floor
   (§3, §6 `O`).
9. **One base fee, frozen multipliers, a lifetime that is a term, and awards
   of any ownerless name** (§10.1, §10.4, §6 `U`; 2026-09-11 fold).
   `the_open_bands_are_multiples_of_FEE_BASE` prices each open band from
   `FEE_BASE` and, in its first step, pins the reprice a rules rebuild does
   to a pre-fold 5-character registration; `a_released_two_character_name_is_
   priced_by_its_own_band` pins 200× for a `G`, an `N` and an `N|L` after a
   release; `G_lifetime_*`, `N_lifetime_*` and `a_lifetime_expires_like_any_
   term` pin the hundred-term expiry as a plain height the ordinary §7.3
   effects reach; the `unreserve_*` scenarios added the same day pin an
   award of a never-reserved name (nothing enters the unreserved set), of a
   held name (`NAME_NOT_AVAILABLE`, in `REGISTERED` and in `GRACE`, then
   `OK` after the fall), a lifetime award, a release ignoring `L`, and the
   same-block `G`/`U` pair both ways round for an available name.
   `P_at_each_rail` pins the inclusive rails on the one price field.
8. **The checkpoint commitment layout** (§8.1), down to the tag bytes and the
   empty forms. r16 added a sixth component, the unreserved set under `0x0A`:
   a `U` that has fired leaves no leaf and no pending entry, so before it two
   indexers disagreeing about whether a name was released committed identical
   bytes.
