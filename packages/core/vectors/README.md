# NNS conformance vectors

A shipped deliverable, not internal tests (spec §14). These files are the
artifact; `vectors.test.ts` is only one consumer of them. **An independent
implementation reads the JSON, not the TypeScript.**

They exist because of the three places implementations fork *silently* rather
than loudly:

| Area | File | Spec |
|---|---|---|
| Merkle leaf byte layout | `merkle.json` | §8.1 |
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

## Where these vectors assume a reading the spec does not fix

Each is argued in `docs/decisions.md`. A conforming implementation must match
them, but the spec should settle them before launch:

1. **Numeric fields are canonical decimal** — no sign, leading zeros or
   whitespace. `NNS1Okikename|0123` is `MALFORMED_PAYLOAD`.
2. **`data` in a log line is hex.** Raw text would let a payload containing a
   newline forge an entire log line.
3. **Effects due at the same height fire in a fixed order**, and a maturing
   transfer runs before an expiry it collides with.
4. **A `G` is checked for sufficient value before availability**, so an
   underfunded registration for a taken name forfeits rather than refunds.
5. **`A` (auction) forfeits with `AUCTION_NOT_IN_V1`** — by protocol version,
   not by omission. An implementation that honoured auctions would derive a
   different root.
6. **Proof steps carry a side.** §8.3's bare hash array is not verifiable under
   odd-node promotion.
