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
