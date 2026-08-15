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

  **These commitments are r17.** The unreserved set (tag `0x0A`, r16) is the
  sixth component; an r15 implementation reproduces all four component digests
  and none of the commitments. `one_fired_unreserve` is the pair that shows
  why the component exists — a released name has no leaf and no pending entry,
  so without `0x0A` it is invisible to the checkpoint. r17 put a 20-byte
  `recipient` inside the pending-`U` entry (`0x09`): zeros for a release, the
  awardee for an award. `pending_award_commits_the_awardee` is that pair — an
  r16 implementation reproduces every case without a pending `U` and diverges
  on every one that carries one.

### `ordering.json` and `reduce.json`

`ordering.json` runs one block's transactions in array order and pins the
owner, the log lines, the log hash and the root. `reduce.json` runs `steps`
against a fresh state: each step is a transaction (`tx` + expected `verdict`),
a bare height advance (`advanceTo`), or an intermediate `check`.

**`advanceTo` is not decoration.** Expiry, grace release, timelock maturity and
governance activation are driven by height, not by messages. An implementation
that only advances state when a transaction arrives will pass most of these
scenarios and produce a wrong root at any checkpoint taken during a quiet
stretch.

A `check` reads the state at that point. Beyond `names`, `resolves` and
`prices` it may carry `absent`, `height`, `transfers`, `offers`,
`pendingUnreserve`, `pendingGovernance`, `unreserved` and `logLines`; a `null`
value in any of the pending maps asserts the entry is **gone**, which is what
a scheduled effect firing actually looks like. Two more fields exist for the
boundary scenarios below:

- **`label`** snapshots the four §8.1 component digests — `nameRoot`,
  `pricesRoot`, `pendingRoot`, `unreservedRoot`. That is the commitment minus
  the height and the log hash, on purpose: `commitmentFrom` binds the height,
  so two checkpoints a block apart differ whether or not anything happened,
  and comparing whole commitments would prove nothing about a boundary.
- **`since`** + **`changed`** compares against an earlier label. `changed` is
  **exhaustive**: every component not named in it MUST be byte-identical.

### The `boundary_*` scenarios — exact firing heights

Seven scenarios, one per §7.3 height-driven effect, each asserting the
transition at exactly `h` **and its absence at `h-1`**.

They exist because every other way of observing these effects is blind to a
one-block error. A checkpoint is only taken every `CHECKPOINT_INTERVAL`
blocks, so "the root differs across the gap" cannot distinguish `h` from
`h+1`; and none of these effects earns a §7.4 verdict token, so a replay can
agree with a second implementation on all 27 tokens, produce matching roots at
every checkpoint, and still fire an effect a block early. Each scenario
therefore asserts `logLines` on both sides of the crossing as well: **a height
advance MUST never emit a §8.2 line.**

| Scenario | Fires at | Stated by |
|---|---|---|
| `boundary_offer_expires_at_OFFER_MAX_LIFETIME` | `opened + OFFER_MAX_LIFETIME` | §6 `O` "auto-expiring at" |
| `boundary_transfer_matures_at_XFER_TIMELOCK` | `landing + XFER_TIMELOCK` | §6 `X` "Takes effect at" |
| `boundary_governance_activates_at_effective_height` | `effective_height` | §6 `P` |
| `boundary_unreserve_releases_at_effective_height` | `effective_height` | §6 `U`, release row |
| `boundary_unreserve_awards_at_effective_height` | `effective_height` | §6 `U`, award row |
| `boundary_expiry_grace_and_the_fall_to_available` | `expiry`, then `expiry + GRACE_PERIOD` | **inferred — see below** |
| `boundary_renewal_window_closes_with_the_grace_period` | `expiry + GRACE_PERIOD` | same |

Four of these are timed by constants r20 moved — `TERM_LENGTH`,
`GRACE_PERIOD` and `GOVERNANCE_DELAY` — so what the vectors pin is the
boundary arithmetic, not the transition.

### `checkOrder` — which check runs first

Thirty-six cases in `reduce.json`'s own section, not scenarios. Each is a
message that satisfies **two** rejection conditions at once: `verdict` is the
token the earlier check produces, and `insteadOf` is the same probe rebuilt to
trip only the later one, run against the same pre-state and required to earn
the other token. Both halves are the assertion — swap the checks and the first
expectation fails; delete the later check and the second does.

`setup` names an entry in `checkOrder.setups`. `pinnedBy` names the clause
fixing the order, or is `null`. `insteadOfUnreachable` replaces `insteadOf`
where the later token cannot be produced at all (only `A`, whose §6 clause
makes `BELOW_MIN_PRICE` unreachable by construction).

**Eleven of the thirty-six orderings are fixed by the spec; twenty-five are
implementation choices.** §7.4 fixes exactly two things — `G`'s five-check
order ("recipient, name syntax, reservation, **value, then availability**") and
`REFUND_FLOOR` converting a refund into a forfeit — plus §7.5 running before a
message is parsed and §6 `A`'s version forfeit outranking the price floor.
Everything else is a bullet list read as an order it never claimed to be, and
the tokens carried forward as PROVEN-AT-R19 lean on it heavily: `INVALID_HOST`,
`NAME_NOT_FOUND`, `BELOW_MIN_PRICE`, `INVALID_RECIPIENT`,
`INSUFFICIENT_NOTICE`, `NOT_ADMIN`, `NAME_NOT_RESERVED`, `WRONG_SENDER` and
`MALFORMED_PAYLOAD` all sit behind a `pinnedBy: null` row.

**One of them contradicts the spec's prose.** §7.4 lists a `U`'s forfeits as
"from any sender other than `ADMIN_ADDRESS`, **with less than
`GOVERNANCE_DELAY` notice**, **awarding to `BURN_ADDRESS`**, …" — notice ahead
of the recipient. The reducer checks the recipient first, because the recipient
decides which of two operations the message even *is* (§6 `U`:
`PROTOCOL_ADDRESS` releases, anything else awards). A `U` to the burn address
with short notice is the message that tells them apart, and it is
`U_invalid_recipient_beats_insufficient_notice`. See `docs/decisions.md`.

**The expiry pair is inferred, not stated.** §6 `G` fixes
`expiry = block_height + TERM_LENGTH` and §7.3 draws
`REGISTERED ──expiry──▶ GRACE ──+30d──▶ AVAILABLE`, but no clause says whether
the arrow fires *at* `expiry` or after it. These vectors take the half-open
reading — the term is `[registration, expiry-1]`, exactly `TERM_LENGTH`
blocks, and `GRACE` is `[expiry, expiry+GRACE_PERIOD-1]`, exactly
`GRACE_PERIOD` — because it is the only one under which those constants are
the lengths §3 calls them, and because it is the same form §6 `X` and §6 `U`
state outright with "at". §7.3's own same-height collision case (a maturing
`X` against an expiry) also presumes both are computed that way. It still
wants one sentence in §7.3; see `docs/decisions.md`.

## The readings these vectors pin

Each was found while implementing `core`, argued in `docs/decisions.md`, and
ratified into the spec by r15. They are listed here because each is a place two
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
5. **`A` (auction) forfeits with `AUCTION_NOT_IN_V1`** — by protocol version,
   not by omission. An implementation that honoured auctions would derive a
   different root. A below-floor reserve takes the same forfeit (§6 `A`).
6. **Proof steps carry a side.** §8.3's pre-r15 bare hash array is not
   verifiable under odd-node promotion.
7. **An `O` price below `MIN_PRICE` forfeits**, and `MIN_PRICE` is `FEE_LONG`
   *at that message's height* — so a `P` that moves `FEE_LONG` moves the floor
   (§3, §6 `O`).
8. **The checkpoint commitment layout** (§8.1), down to the tag bytes and the
   empty forms. r16 added a sixth component, the unreserved set under `0x0A`:
   a `U` that has fired leaves no leaf and no pending entry, so before it two
   indexers disagreeing about whether a name was released committed identical
   bytes.
