# NNS — Nimiq Name Service

**Protocol specification, v1 draft — revision 20**

> **Working draft, circulated for review.** Nothing here is frozen — the
> wire format in §5 and §6 in particular is still open pending the encoding
> test in §12. Holes, objections, and "this will age badly against our
> roadmap" are the most useful responses this document can get.

A name registry for Nimiq with no smart contracts. Registrations are carried in
transaction data; a deterministic indexer replays them into a `name → address`
mapping; a Nimiq Pay mini app lets users send to `kike` instead of an address.

> **Review status.** Everything marked **OPEN** is undecided or unverified.
> Everything else reflects decisions already taken.

> **Revisions are per day, not per change.** Everything decided on one day is
> folded into that day's revision, however many separate changes it covers, so
> a revision number stays something an implementation can claim to implement
> rather than a changelog id.

> **Changes in revision 20 — the recovery address is removed, four §3 numbers
> move, and governance loses its rate limits.** One message type deleted, one §3 constant gone, and it moves
> bytes: the §8.1 name leaf loses a 20-byte field, so **every root changes** and
> `COMMITMENT_LAYOUT` goes to `4`. The four constants at the end of this list
> move no bytes of their own — no layout, no message, no migration — but the
> reducer computes expiries and fee comparisons from them, so they change every
> root a second time.
> - **§6 — `R` is deleted, and with it the recovery address.** The mechanism
>   did not survive its own threat model. A holder of the owner key — the
>   party recovery exists to defend against — deletes a pending
>   recovery-initiated `X` with a bare `K` at `DUST_VALUE`, indefinitely:
>   `K` cancels everything currently cancellable and takes no account of who
>   scheduled it. The thief needs **one** unopposed `XFER_TIMELOCK` window;
>   the recovery holder must win **every** round for `RECOVERY_TIMELOCK` to
>   ever complete a reclaim. Worse, a second `X` supersedes the first
>   regardless of sender, and the owner's replacement matures on the shorter
>   `XFER_TIMELOCK` — so the thief's transfer lands ~215,940 blocks *before*
>   the recovery attempt it overwrote. Neither is tunable by moving constants:
>   any ordering that fixes it must let the recovery address outrank the
>   owner, which is a strictly worse trust model than having no recovery
>   address at all. Separately, `O` + `B` moves a name in **two blocks** with
>   no timelock and clears the recovery field outright (§7.3). A protection
>   that a careful reading of this document defeats is worse than none,
>   because it is advertised.
> - **§2 — a lost owner key is a lost name**, stated plainly, as in ENS. The
>   `X` timelock stays, but it is now scoped honestly: it protects against a
>   **mistyped recipient**, not against a thief, since `O` + `B` bypasses it.
> - **§3 — `RECOVERY_TIMELOCK` is gone.** Every `X` waits `XFER_TIMELOCK`.
> - **§8.1 — the name leaf drops `recovery:20B`, and the pending-recovery
>   entry (tag `0x06`) is deleted.** The pending-transfer entry (tag `0x05`)
>   drops its trailing `via_recovery:u8`, which could only ever be `0x00`
>   now. Tags are **not renumbered**: `0x06` is retired and left as a hole, so
>   an implementation written against r19 mismatches loudly on a tag it knows
>   rather than silently on one it thinks it understands.
> - **§8.3 — the proof document drops `recovery`.** The rule it was added to
>   demonstrate in r19 is unchanged and still load-bearing: the document
>   carries *every* field the §8.1 leaf encodes, and `delegate` is now the
>   field that witnesses it.
> - **§7.4 — `NOT_OWNER_OR_RECOVERY` collapses into `NOT_OWNER`.** With one
>   authorised sender there is nothing for the longer token to distinguish.
> - **§5.3 — one sentinel operation, not two.** Clearing a recovery address
>   was the second operation that needed `PROTOCOL_ADDRESS` to dodge the
>   self-transaction rule; only `S` resetting a target to the owner's own
>   address remains.
> - **`R` is removed from the wire, not reserved.** `NNS1R…` now takes
>   `UNKNOWN_TYPE` and forfeits like any unrecognised type. Nothing has
>   launched, so there is no deployed client to keep a slot for.
> - **§3, §10.4 — `TERM_LENGTH` 157,680,000 → 31,536,000 blocks (~5 y → ~1 y).**
>   At five years nothing expires until 2031: expiry, grace, the fall to
>   `AVAILABLE` and re-registration would sit unexercised through the entire
>   formative period. A one-year term runs them in front of real owners inside
>   the first year. The consequence §10.4 now states rather than deferring:
>   renewal has one year of runway, so `N` must be reachable in the client and
>   the §10.4 reminder must fire before the launch cohort comes due.
> - **§3, §7.3, §10.4 — `GRACE_PERIOD` 7,776,000 → 2,592,000 blocks
>   (90 d → 30 d)**, paired to the shorter term. Its role is unchanged: a
>   window to notice a missed renewal in, not a second term. The client
>   reminder is still `GRACE_PERIOD` × 2 before expiry, now 60 days.
> - **§3, §10.1 — `FEE_STANDARD` 4,000 → 2,000 NIM (~$1/year at ~$0.0005/NIM).**
>   Governable as before, and the launch figure only.
> - **`FEE_LONG` is unchanged at 400 NIM**, and `MIN_PRICE` with it. It is the
>   anti-spam floor that bounds the log (§8.2), and §10.1's argument for it is
>   untouched by the standard band moving.
> - **§3, §10.6 — `PRICE_MAX_FACTOR` and `PRICE_MIN_INTERVAL` are removed
>   entirely.** A rate limit loose enough not to obstruct legitimate repricing
>   during NIM volatility is also loose enough for an attacker to walk through:
>   there is no setting that both protects and permits. What protects is the
>   notice window — a hostile `P` is public before it bites — and past that, a
>   fork, since `ADMIN_ADDRESS` is a §3 constant and cannot be rotated in-band.
>   ENS avoids the whole problem by pricing in USD through an oracle, which a
>   chain with no smart contracts cannot do; §10.6 now says so rather than
>   implying the limits stood in for it.
> - **§3 — `GOVERNANCE_DELAY` 43,200 → 86,400 blocks (~12 h → ~24 h),** because
>   it is now the whole of the protection rather than one bound among several.
> - **`PRICE_FLOOR` and `PRICE_CEILING` stay**, restated as fat-finger rails
>   against a misplaced decimal in an honest `P` — never as attack protection.
> - **§7.4 — `TOO_SOON` is removed from the vocabulary**, being unreachable
>   without a frequency bound, and `GOVERNANCE_BOUND_VIOLATED` loses its
>   price-step arm. The verdict vocabulary is **27 tokens** (`OK`, 23 forfeit,
>   3 refund), of which `OVER_LENGTH` stays unreachable on mainnet.

> **Changes in revision 19 — the launch freeze, as far as it can go.** Prose
> only. **No bytes move**: nothing here enters the §8.1 preimage or the §8.2
> log hash, and every root derived under r18 is unchanged.
> - **§3, §4.1 — `RESERVED_NAMES`'s published half is published**, in
>   `packages/core/src/constants.ts`, and is a constant rather than a
>   deployment setting: every honest implementation on the same network must
>   agree on it byte for byte, so an injected list was a silent-divergence
>   surface. It is **not final** — additions are free until `LAUNCH_HEIGHT`
>   and out of governance scope afterwards (§10.6), so completing it is a
>   blocking pre-launch step, listed in §12 beside the five §3 values that
>   are still **OPEN**.
> - **§3, §6 `O`, §10.6, §12 item 3 — the `O` listing fee is settled at
>   `LISTING_FEE` = 0**, taking §12 item 3's second option. No `P` field
>   carries it, so it was never governable; an ungovernable price is the one
>   price that cannot track NIM, and §10.6's own argument says a fixed luna
>   amount goes stale. A listing that never settles should cost nothing beyond
>   the network fee, and one that does settle is already charged
>   `COMMISSION_RATE` at the moment money moves (§10.3). Consequences: an `O`
>   carries `DUST_VALUE`, since §5.4 rejects a `value` of 0; and
>   `INSUFFICIENT_VALUE` is unreachable for `O` at this value. Raising it is a
>   spec revision from a stated height, like any other frozen §3 number.
> - **`LAUNCH_HEIGHT` and the four §3 addresses stay OPEN** and stay injected
>   through deployment configuration until they are supplied. `networkId` is
>   the one value that stays configuration on the merits — mainnet and testnet
>   honestly differ.

> **Changes in revision 18 — short names are reserved, not invalid.** One
> change, reverting one r17 rule, and it moves bytes — pre-launch, with no
> real registration behind any existing root:
> - **§4.1 — every 1–4 character name satisfying rules 2–5 is a member of
>   `RESERVED_NAMES` at launch, by rule rather than enumeration.** Membership
>   is checked by measuring the length and running rules 2–5, never by
>   materialising the ~1.7 million short names into a list; the published
>   list carries only the named entries (`nimiq`, exchanges, brands). Rule
>   1's floor binds only while a name is still reserved: once a fired `U`
>   removes a short name from the reserved set, it is a normal name — a `G`
>   registers it at the normal fee, and every owner operation works on it.
> - **§6 `U`, §7.4 — the r17 narrowing of `INVALID_NAME` to `U` is
>   reverted.** r17 forfeited any `U` naming a 1–4 character name, on the
>   premise that a short name can never be a valid registration. Under §4.1
>   as amended that premise no longer holds — and under r17's own rules it
>   had quietly turned "held for later auction" into *lost*: `MIN_NAME_LEN`
>   blocked every `G`, the narrowing blocked every `U`, and `A` is deferred,
>   so nothing in the protocol could ever release or award a short name. A
>   `U` now works on a short name exactly as on any other reserved name —
>   release and award both. Awards are a designed feature here as for long
>   names: handing `nq` to an exchange so it can run a delegate host is
>   handing `binance` to Binance, two characters shorter. `U`'s name check
>   is rules 2–5 plus the rule 1 ceiling; the floor never binds a `U`,
>   because every well-formed short name is reserved by rule.
> - **What moves.** No layout changes and `COMMITMENT_LAYOUT` does not bump:
>   the same state still commits the same bytes. What changes is which
>   messages are *accepted* — a `U` naming a short name was a forfeit line
>   and is now `OK`; a `G` for a still-held short name writes
>   `RESERVED_NAME` where it wrote `INVALID_NAME`; an awarded or released
>   short name puts a leaf in the checkpoint tree that r17 said could not
>   exist. Log-hash class, not layout class — replaying the same chain under
>   r17 and r18 rules diverges at the first short-name `U` or `G`.

> **Changes in revision 17 — `U` can award a name, not only release it.**
> One change, in one message type, and it moves bytes:
> - **§6 `U`, §7.3, §5.3 — a `U` has two behaviours now, and the transaction
>   recipient picks between them.** Sent to `PROTOCOL_ADDRESS` it *releases*
>   the name to `AVAILABLE` at `effective_height`, exactly as in r16. Sent to
>   any other address it *awards* it: at `effective_height` the name becomes
>   `REGISTERED` to that address, `owner` and `target` both set to it, a full
>   `TERM_LENGTH`, and it leaves `RESERVED_NAMES`. No fee — a name given away
>   is a gift. The reason is §6.2: releasing a reserved name and hoping the
>   intended holder registers it first is a race against everyone watching the
>   chain, and the `U` itself announces the name `GOVERNANCE_DELAY` blocks in
>   advance. Handing `binance` to Binance has to skip `AVAILABLE` entirely.
>   The payload is untouched, so no message grew.
> - **The notice period is unchanged and still does the work.**
>   `GOVERNANCE_DELAY` is measured from the landing block as in r16, so an
>   award is public for twelve hours before it binds and a compromised admin
>   key cannot take the reserved namespace instantly — nor take it directly at
>   all: an award to `ADMIN_ADDRESS` is a self-transaction, which the network
>   drops silently (§5.3).
> - **§8.1 — the pending `U` entry (tag `0x09`) now commits a `recipient`.**
>   It encoded `len(name) ‖ name ‖ effective_height`, which is enough to agree
>   that a name is being unreserved and not enough to agree *who gets it*: two
>   indexers reading the same `U` differently would have derived identical
>   checkpoints right up until it fired. A release commits **20 zero bytes**, an
>   award the awardee's 20 — the "unset address" convention already used for a
>   cleared recovery. **This changes the commitment**: any checkpoint with a
>   pending `U` in it has a different value under r17 than under r16.
> - **§7.4 — three new forfeit tokens, one widened, and `U` leaves
>   `WRONG_RECIPIENT`.**
>   `INVALID_RECIPIENT` rejects an award to `BURN_ADDRESS`, which has no key
>   and is also the all-zero address that §8.1 uses to mean *no* recipient —
>   permitting it would give a release and an award to it the same bytes.
>   `NAME_NOT_RESERVED` rejects a `U` naming a name that was never reserved or
>   was already released — under r16 that was an odd no-op, under r17 it would
>   hand away a name somebody may own. `UNRESERVE_PENDING` rejects a second
>   `U` for a name that already has one pending, which is what makes a pending
>   `U` fire against exactly the state it was validated against. `U` no longer
>   has a routed recipient to be wrong about, so its recipient is checked as
>   the operand it now is.
> - **§7.4, §6 `U` — `INVALID_NAME` widens to `U`, rules 1–5 of §4.1.** This
>   one narrows r16: a `U` naming a 1–4 character name used to be a legal
>   release, and is now a forfeit. Those names are reserved *and* below
>   `MIN_NAME_LEN`, so releasing one only ever produced a name nothing could
>   register — but an **award** of one would put a leaf in the checkpoint tree
>   for a name §4.1 says cannot exist and every conforming client rejects
>   before it queries. A message type that can create a registration has to
>   respect the rules on what a registration may be. Rule 6 stays inverted for
>   `U`: its name must be reserved.

> **Amended within r17, 2026-08-13, on corrections from the Nimiq team.**
> Deferred-to-v2 material and one open question only; no bytes move. §16.2
> had the fee-gate blocked by Nimiq Pay's size-derived fee tiers topping out
> around 276 luna — those tiers are the **web wallet's**. The mini-app
> provider's `sendBasicTransaction` takes a `fee` parameter, while the
> native Nimiq Pay UI sets the fee to 0 and does not let a user edit it, so
> whether an app-supplied fee survives to signing is the remaining question
> (§12), pending one send test once consensus returns. And network fees go
> to the **validators** — pooled per batch, paid at the next macro block —
> which promotes the fee-gate from one mechanism of three to the *preferred*
> v2 anti-spam mechanism: the money leaves the system, so no
> `PROTOCOL_ADDRESS` accumulation, no periodic burn, no `F` ceremony.

> **Amended within r17, 2026-08-13 — two §7.4 clarifications, no bytes
> move.** `INVALID_HOST`'s condition now names every §6 `D` host rule,
> character set included: the row granted the token only for over-length and
> scheme hosts while `MALFORMED_PAYLOAD` claimed "does not parse per §6", so
> two conforming implementations could token a bad-character host differently
> and fork the log hash. `core` already read it the way the row now states.
> And a note records that `OVER_LENGTH` is unreachable on mainnet — the
> network's 64-byte data cap equals the §5.1 budget, so the token stays in
> the vocabulary but can never appear in a real log.

> **Amended within r17, 2026-08-14 — §8.3's proof document was missing a
> leaf field. No bytes move.** The example document had no `recovery`, but
> the §8.1 leaf *encodes* the recovery address, so a client following §8.5 —
> which rebuilds the leaf preimage from the document's fields and recombines
> it with the proof — could not build the preimage for any record with a
> recovery address set. The document was unverifiable exactly where it
> mattered, and a verifier that checks a hash it was handed instead of one it
> rebuilt is verifying nothing about the fields beside it. The example now
> carries `"recovery": null`, and a paragraph states the rule the example was
> only ever implying: **a proof document carries every field the §8.1 leaf
> encodes.** Nothing about the leaf preimage, the tree or the commitment
> changed — this is the wire format catching up with §8.1, which is why it is
> an amendment and not a revision. Found by `packages/api` when its first
> verification test tried to rebuild a leaf; the served documents,
> `openapi.yaml` and a test that strips `recovery` and expects verification
> to fail all followed the same day.

> **Amended within r17, 2026-08-14 — §9 anchoring is permissionless, and the
> allowlist was two contracts at once. No bytes move.** §9 described two
> incompatible designs: `anchor()` was `onlyPublisher` and callable "by any
> registered publisher" — a contract-level allowlist — while the same section
> called `ANCHOR_PUBLISHERS` a client-side list and not a protocol constant,
> and §10.7 said publisher admission was by allowlist. Resolved **in favour
> of permissionless**, which is also what r9 introduced multi-publisher
> anchoring as ("any indexer may anchor its own root"); `onlyPublisher` was
> the later inconsistency.
> - **§9 — `anchor()` loses `onlyPublisher` and takes no access control.**
>   With no publisher registry the contract needs no owner, no admin function
>   and no upgrade path: it is an append-only event emitter with one external
>   function. §2.1's trust signal is that *independent* parties agree, and a
>   contract-level allowlist would hand the operator the power to exclude a
>   dissenting publisher — silencing the disagreement anchoring exists to
>   expose — while buying nothing, since the same operator ships the client
>   that holds the list either way (§2.2).
> - **§9 — the `Anchored` event gains `address indexed publisher`,
>   `msg.sender`.** This closes a contradiction recorded but not amended
>   during the resolver session: §9's prose said the event carried the
>   publisher and its Solidity signature did not, which cost a client an
>   `eth_getTransactionByHash` per anchor to learn who published it. `root`
>   and `publisher` are both `indexed` so a permissionless contract's spam
>   costs a client nothing — junk roots never match the topic filter.
>   `nimiqHeight` stays unindexed: the client knows the height it is asking
>   about and MUST check the field against it.
> - **§8.5 #1 — "publisher" is now defined as an address on the client's
>   `ANCHOR_PUBLISHERS` list.** Required by the change above: with anyone able
>   to emit an anchor, an undefined "`ANCHOR_QUORUM` independent publishers"
>   would be satisfiable by two addresses an attacker created. Unknown
>   publishers are ignored — not counted, and not a mismatch either.
> - **§10.7 — the stipend roster is treasury policy, not contract
>   permission.** The free-riding mitigation is unchanged in substance and
>   only ever needed to be a payment decision: an allowlist never excluded a
>   mirroring free-rider anyway, since qualifying for the stipend makes them a
>   known party by construction. Not paying someone is unilateral and
>   reversible; excluding them from the contract is neither.
>
> Nothing here enters the §8.1 preimage or the §8.2 log hash. The event's
> signature hash changes, which would be a breaking ABI change against a
> deployed contract — `packages/anchor` is unwritten and nothing is deployed,
> so the cost is zero today and would not be later.

> **Amended within r17, 2026-08-14 — §9 names its chain, and says what that
> chain does not give you. No bytes move.** Building `packages/anchor` needed
> a chain, and §9 offered "a cheap L2 (Base or Arbitrum), monthly to L1
> mainnet" — a decision deferred by listing options.
> - **§9 — v1 anchors to Polygon PoS (chain id 137), hourly, and to nothing
>   else.** Explicitly the PoS chain, not Polygon zkEVM. Chosen because Nimiq
>   already runs its stablecoin rails there, which makes it the chain the team
>   and community already operate and makes the most likely first independent
>   publisher — the Nimiq team — one that already has keys, funding and
>   monitoring on it. Anchoring is worth what the number of independent
>   publishers makes it worth (§2.1), so that number is the only thing the
>   choice should optimise. Base was the alternative and was picked on RPC
>   availability, which optimises nothing that matters here.
> - **§9 — monthly Ethereum L1 anchoring is dropped.** A second chain doubles
>   what every publisher must fund, key and monitor, and it was buying a
>   data-availability property §9 now declines to claim (below). Adding it
>   later is a deployment decision, not a revision.
> - **§9 — a new subsection states that the chain is not a protocol rule.**
>   Chain id, address and RPC are configuration; the contract is chain-neutral
>   Solidity and takes one `CREATE2` address anywhere EVM. Written down
>   explicitly so no later session treats the chain as load-bearing and
>   "corrects" it back into the protocol.
> - **§9 — the sidechain tradeoff is stated rather than implied.** Polygon PoS
>   checkpoints state roots to Ethereum but does not post transaction data
>   there, so its anchors are **not** reconstructible from L1 the way a
>   rollup's are. §9 now says so, next to the three things that bound the
>   cost: the anchor is one tier beside §8.4 replay and §8.2 IPFS publication,
>   its failure mode is a loud client warning, and it is one config value away
>   from a different chain. Claiming rollup-grade availability for a sidechain
>   is exactly the overclaim §2.1 exists to prevent.
> - **§9 — the injected-provider chain list is withdrawn, not updated.** It
>   enumerated mainnet, Base, Arbitrum, Optimism, BNB Chain and Sepolia; per
>   Nimiq's developer documentation the reachable set is whatever their RPC
>   provider supports, extensible without a client change, and it includes
>   Polygon PoS. A list in a spec goes stale silently, so §9 states the rule
>   and tells future editors not to re-add one.
> - **§8.5 #3, §9 — "root" is disambiguated.** What §9 anchors is the §8.1
>   **checkpoint commitment**; an inclusion proof verifies against the
>   **name root**, one of its six components. §8.5 #3 read as though they were
>   one value. It now specifies both steps — commitment against the anchor,
>   then proof against that document's `nameRoot` — because checking a proof
>   against an unverified `nameRoot` establishes only that one party is
>   internally consistent, which §2.1 says it always is. §9 also states that a
>   publisher takes the commitment verbatim and never recomputes it.
> - Headings and cross-references move from "Ethereum anchoring" to **"EVM
>   anchoring"** (§9, §2, §8.4, §8.5, §8.7, §12, §14), since neither the
>   anchor chain nor the requirement is Ethereum specific.
>
> Nothing here touches the §8.1 preimage, the §8.2 log hash or the event
> signature. `packages/anchor` deliverable 1 — the contract — lands against
> this text.

> **Amended within r17, 2026-08-14 — the CID is a locator, not a verifier.
> No bytes move.** §8.2 and §8.4 read as though clients re-derive the root
> CID from fetched bytes as a verification step. They do not, and nothing
> needs them to: integrity rests on the keccak256 `log_hash` committed inside
> the anchored checkpoint, and the IPFS transport itself refuses content that
> does not match the CID it was asked for. The DAG parameter table stays
> normative as the flag set the *producer* — the party doing the add — must
> use (with a note that kubo's `--cid-version=1` flips raw leaves on by
> default, so `--raw-leaves=false` must be explicit), and the only CID
> computation a client performs is rebuilding the CID **string** from the
> event's 32-byte digest, every other component being a constant of §8.2. A
> wrong CID in an anchor costs discoverability, never integrity, and the
> mitigation is operational: a publisher adds each snapshot through two
> independent implementations and anchors only when the CIDs agree. This
> cancels the planned UnixFS/dag-pb derivation in `core` — reimplementing
> the reference implementation in order to check the reference
> implementation is inverted. See "The CID is a locator, not a verifier" in
> `docs/decisions.md`.

> **Amended within r17, 2026-08-14 — cadence is on change with a daily
> floor, superseding hourly; `ANCHOR_STALENESS_LIMIT` becomes 48 h. No bytes
> move.** Building the publisher showed what the hourly cadence actually
> buys and what it actually costs. Gas was never the cost — r12 established
> that when it moved daily to hourly. The costs are **pin churn and
> operational noise**: every anchor obligates a log snapshot pinned on two
> independent services (§8.2), so an hourly schedule mints ~8,700 pinned
> snapshots a year per publisher — almost all of them anchoring a commitment
> identical to the last, since registry traffic is bursty and mostly absent.
> §9 now reads: the publisher runs on a schedule, anchors **when the current
> commitment differs from the one it last anchored**, and anchors
> **unconditionally when its newest anchor is older than 24 h**, so a live
> quiet registry still produces a fresh attestation daily and §8.5 #8's
> staleness check stays meaningful. `ANCHOR_STALENESS_LIMIT` moves 2 h →
> **48 h** — the same one-missed-anchor margin at the new scale. What bounds
> the wider window: a day-wide not-yet-anchored gap is proportionate because
> every prior anchor already chains the history (the commitment binds
> `log_hash`, cumulative), §8.7 says anchoring never gated usability anyway,
> and the §8.4 tiers above the anchor are untouched. Corollary, recorded in
> `docs/decisions.md`: pin retention is **keep-all** — at a daily ceiling
> the retention question dissolves rather than needing an answer.

> **Changes in revision 16 — what building the indexer and sending on
> mainnet found.** Six changes. One moves bytes, three close holes that made
> a divergence invisible, and two are lessons that cost real transactions to
> learn:
> - **§8.1 — the unreserved set joins the commitment, under tag `0x0A`.**
>   Tags ran `0x00`–`0x09` and `0x09` is a *pending* `U`; a `U` that had
>   already fired was committed nowhere. The released name has no leaf in
>   the name tree either, so two indexers disagreeing about whether a
>   reserved name is released derived **identical checkpoints** — and went
>   on doing so until somebody registered the name. Encoded as a flat
>   bytewise-ordered name list, empty form `keccak256(0x0A)`. **This
>   changes the commitment**: r16 roots do not match r15 roots.
> - **§8.1 — checkpoint heights are absolute multiples of
>   `CHECKPOINT_INTERVAL`**, from block zero, never offsets from
>   `LAUNCH_HEIGHT`. `LAUNCH_HEIGHT` is still **OPEN**, and an anchor that
>   moves with an unsettled config value is an anchor two operators can
>   disagree about while both implementing the clause honestly.
> - **§6 `P`/`U`, §10.6, §7.4 — `GOVERNANCE_DELAY` runs from the block the
>   message lands in**, not from when it was built. "Current height" read as
>   send time; an indexer cannot see send time and two indexers could not
>   agree on it. §6 `P` was also missing the notice bound entirely — it was
>   only ever stated for `U` and in §10.6. Verified the expensive way on
>   mainnet 2026-08-13: a `P` and a `U` carrying `head + 10,000` forfeited
>   `INSUFFICIENT_NOTICE` and are on-chain permanently. **A governance
>   message is unretractable**, which is now said out loud.
> - **§5.3, §11.5 — an unfunded sender is a third silent-drop route**,
>   alongside self-transactions (§5.3) and over-length payloads (§5.1). The
>   RPC accepts, returns a hash, and the transaction is never mined. Since
>   every message carries at least `DUST_VALUE`, `MARKETPLACE_ADDRESS` and
>   `ADMIN_ADDRESS` — which sign but have no income — go quiet rather than
>   erroring when they drain. New §11.5 requires a balance precheck before
>   signing and an alert threshold well above zero.
> - **§7.4 — the verdict vocabulary is now enumerated, normative and
>   closed.** §7.4 described forfeit and refund in prose while §8.2 committed
>   the `<verdict>` *token* into the log hash; the 26 exact strings existed
>   only in the reference implementation. Two implementations could agree
>   about every rejection and still derive different log hashes by spelling
>   one differently — the gap §8.1's layout had before r15. Each token now
>   has a row naming its exact string, the message types that may carry it,
>   and its condition, plus the within-message check order that decides which
>   token a message earns. No token changed, so **this does not move bytes**;
>   it makes the bytes reproducible from the spec alone. Also corrects §7.4's
>   first forfeit bullet, which listed un-prefixed data as a forfeit when
>   §7.5 discards it unlogged.
> - **§8.2 — the IPFS clause said two incompatible things and is rewritten.**
>   It specified the `raw` codec, which addresses a *single block* hashed
>   over its own bytes, and in the same sentence a fixed chunk size, which
>   only means anything for a multi-block DAG whose root hashes over
>   structure. A ~15 MB log is also far past what a raw block can hold. It is
>   now a **UnixFS file, `dag-pb` root, CIDv1, sha2-256**, with every
>   DAG-shaping parameter pinned in a table — chunker **262,144 bytes**,
>   balanced layout, 174 links per node, **raw leaves off**. Raw leaves are
>   off because with them on, a log small enough to fit one chunk has a `raw`
>   root: the codec would vary with file size, and reconstructing a CID from
>   a bare digest requires it to be a constant. §9's `logDigest` is
>   correspondingly the digest of the snapshot's **root CID**, not of the log
>   bytes — it is not the keccak256 log hash, which is a different digest
>   over different bytes and is already committed inside `root`. **No
>   consensus bytes move**: no root, no log hash, and nothing has been
>   anchored yet.
>
> **Changes in revision 15 — ratifying what the reference implementation
> found.** `packages/core` (441 tests) surfaced nine spec gaps, four of which
> change bytes: two conforming implementations reading them differently
> would derive different roots. All are now pinned:
> - **§8.2:** the log line's `<data>` field is **lowercase hex**, never raw
>   text — a raw payload containing a newline would forge an entire log
>   line and silently change the checkpoint. Addresses in log lines use the
>   compact 36-character `NQ` form for the same reason.
> - **§7.3:** height-driven effects due at one height fire in a fixed order
>   (governance, unreserve, maturing `X`, maturing `R`, expiry, grace
>   release, offer expiry; ties bytewise by name), and **before that
>   block's transactions**. State also advances on height alone —
>   implementations must apply due effects at least every
>   `CHECKPOINT_INTERVAL`, not only when a message arrives.
> - **§5.2:** numeric wire fields are canonical decimal — no sign, no
>   leading zeros, or the message is malformed.
> - **§8.1:** the checkpoint commitment enumeration gains pending `P` and
>   pending `U`, and the byte-exact layout — tag bytes, field encodings,
>   ordering, and how the components combine — is written out in the clause
>   itself, so an independent implementation never has to read ours. The
>   conformance vectors now pin that layout rather than defining it.
> - **§8.3:** proof steps carry `{hash, side}` plus the leaf index — a bare
>   hash array is unverifiable under odd-node promotion.
> - **§7.4:** `G` checks value before availability, so an underfunded `G`
>   for a taken name forfeits (client-preventable) rather than refunds.
> - **§6 `O`:** price MUST be ≥ `MIN_PRICE` (= `FEE_LONG`), and the same
>   floor applies to `A`'s reserve. A price of 0 was unsatisfiable; a floor
>   of 1 luna, considered first, was worse than useless — it sits below
>   `REFUND_FLOOR`, so losing bidders would have been *forfeited* rather
>   than refunded, and `floor(1 × 5%) = 0` erases the auction increment
>   rule entirely, admitting unlimited dust bids each carrying a refund
>   obligation.
> - **§6 `A` v1 status:** parsed, logged, forfeited `AUCTION_NOT_IN_V1`.
>   An implementation honouring auctions would derive a different root, so
>   deferral must be a protocol version, not an omission.
> - Smaller readings pinned: `K` cancels everything currently cancellable
>   and forfeits `NOTHING_TO_CANCEL` when idle; an `M` matching no
>   outstanding leg is accepted and changes nothing (the debt stays
>   visible). `R`/`U` payload typo (`<n>` → `<name>`); §4.2's short
>   examples annotated as digit-rule illustrations below `MIN_NAME_LEN`.
>
> **Changes in revision 14 — `PROTOCOL_ADDRESS`.**
> - **Signals are separated from money.** A new `PROTOCOL_ADDRESS` receives
>   every `DUST_VALUE`-only message (`K`, `D`, `P`, `U`, and the `S`-reset
>   and `R`-clear sentinels). `TREASURY_ADDRESS` now receives **fees and
>   nothing else** (§5.3, §5.4).
> - This makes §10.2's burn base exact rather than approximate: every luna
>   arriving at the treasury is revenue, so *balance* and *revenue* stop
>   diverging by an unbounded pile of protocol dust.
> - It also gives explorers a single address to tag as **"NNS Protocol"**,
>   which is where all protocol signalling is visible in one place — and a
>   better sentinel than the treasury, since nobody would ever legitimately
>   resolve a name to a protocol sink (§5.3).
> - The key is generated and kept in cold storage, never imported into any
>   node: it is needed to prove control for explorer tagging, and to return
>   funds someone eventually misdirects there (§11).
> - **Everything moved off the 64-byte ceiling.** `MAX_NAME_LEN` 32 → 24,
>   `MAX_REF_LEN` 26 → 12, `MAX_HOST_LEN` 40 → 30, and `D`'s combined
>   name-plus-host limit 58 → 52. The largest message in the protocol is now
>   `D` at 58 bytes; `G` with a referrer is 42. Previously both `G` and `D`
>   could hit exactly 64. Sitting on the ceiling was dangerous because the
>   over-limit failure is silent (§5.1) — a client counting one byte
>   differently would lose the longest messages with no error anywhere.
> - §4.1 now records **why the separator is `-` and not `_`**, so the
>   question is answered in the document rather than re-argued later.
> - **Credits removed entirely.** A losing `G` is now refunded from
>   `TREASURY_ADDRESS` through the same `M` settlement message the
>   marketplace uses (§6 `M`, §7.4). The argument for credits was that a
>   ledger entry needs no key — but the treasury already spends, since the
>   burn share is forwarded from it, so refunds add no new class of hot key.
>   For a ~$2 registration fee, consensus-state arithmetic, a committed
>   ledger, an expiry policy and overpayment rules were a large amount of
>   machinery bought at the wrong price. §7.4 now has two outcome columns
>   instead of three, and §10.5 is gone.
> - **A refund floor** (`REFUND_FLOOR`) stops an attacker from converting
>   cheap invalid messages into an unbounded pile of refund transactions
>   (§7.4).
> - **From external review**: `tx_index` stated as zero-based (§8.2);
>   anchor-staleness warning (§8.5); client preflight against the size
>   ceiling (§8.5); renewal reminders as required client behaviour (§10.4);
>   an explicit MEV re-evaluation trigger rather than a vague future concern
>   (§6.2); the delegate response signature format defined now so delegates
>   can opt in later without a spec revision (§8.6); and test vectors named
>   as a deliverable (§14).
> - **v1 scope cut back.** Anti-spam machinery — signalling fees, ownership
>   and no-op filters, per-name rate windows — was specified and then
>   removed. Each is a rule every independent implementation must match
>   exactly, added against an attack nobody has run, on a protocol with no
>   users. §7.6 is now one sentence; the analysis moved to §16 so it can be
>   adopted whole if spam ever appears.
> - **New §16 — deferred to v2**, recording what was considered, why it was
>   cut, and what would trigger revisiting it. Registration remains the only
>   economic gate in v1.
> - **New §8.8 — segments and snapshots**, specified but not implemented in
>   v1: the format must be agreed before anyone depends on it, but the first
>   boundary is a year out.
> - **New §6 `A` — auctions.** Price-discovery for contested names, with a
>   bidding window instead of an ordering race. Deliberately additive: an
>   unknown message type is ignored (§5.2), so `A` can ship after the wire
>   format freezes without breaking any indexer.
>
> **Changes in revision 13 — first empirical results.**
> Probed against mainnet on 2026-08-06 from our own node. Four assumptions
> tested; three confirmed, one wrong, and one constraint found that the
> specification had missed entirely.
> - **`value: 0` is rejected by the network** (§5.4). `DUST_VALUE` is now
>   justified by evidence rather than caution, and the OPEN item is closed.
> - **64-byte data limit confirmed at the protocol level** (§5.1): 64 bytes
>   was included in a block, 65 and 128 never were — even though the node
>   will happily *construct* a 256-byte transaction locally. The wallet's
>   64-character cap is a byte budget, verified with multi-byte characters.
> - **Transaction data is hex over RPC** in both directions, UTF-8 bytes
>   underneath (§5.1). Non-ASCII round-trips byte-identically.
> - **No transaction index exists on the RPC object** (§5.2, §7.2).
>   Canonical order is `(block_number, position in the block body array)`.
>   Confirmed with three blocks that each carried two of our transactions.
> - **New §7.5 — transactions the indexer must ignore**: failed executions
>   (`executionResult: false`), reward transactions, and any transaction
>   whose `networkId` is not ours. Albatross includes failed transactions in
>   blocks, so without this rule a failed `G` could take a name.
> - **Sender and recipient must differ** (§5.3) — Nimiq rejects
>   self-transactions, silently: the RPC accepts them and returns a hash,
>   then the network drops them. This broke two message types as specified.
>   `S` pointing a name back at the owner's own address, and `R` clearing
>   the recovery address, are both now sent to `TREASURY_ADDRESS` as a
>   sentinel recipient (§6 `S`, §6 `R`).
>
> **Changes in revision 12.**
> - **Anchoring moves from daily to hourly** on the L2 (§9). At ~30k gas an
>   anchor costs fractions of a cent, so a daily cadence was frugality with
>   nothing to be frugal about. It shrinks the not-yet-anchored window from
>   24 h to at most 1 h.
> - **New §8.7 states explicitly that anchoring never gates usability.** A
>   name resolves as soon as its registration is final; checkpoints and
>   anchors add verification depth on top of a name that already works.
>   The spec implied this everywhere and said it nowhere.
> - Client wording for a recent registration reworded as a **depth
>   indicator rather than a warning** (§8.5). Alarming language is reserved
>   for genuine mismatches.
>
> **Changes in revision 11 — the log becomes fetchable without us.**
> - **The NNS log is published to IPFS** and addressed by CID (§8.2). The
>   log hash was already committed in every checkpoint, so tampering was
>   already detectable; what IPFS adds is **availability independent of the
>   operator** — Tier 1 verification no longer starts by downloading a file
>   from the party being checked (§8.4).
> - **`Anchored` carries the log CID** alongside the root and height (§9).
>   One attestation now covers both *what the state was* and *where the
>   evidence lives*. With multi-publisher anchoring, divergent publishers
>   each anchor their own log, so anyone can diff them and identify the
>   exact transaction mishandled — divergence stops being "someone
>   deviated" and becomes "here is where".
> - CIDs are carried as a 43-character base64url digest, not a URL and
>   never a shortener: a shortener is a mutable indirection controlled by
>   somebody, which destroys the property being sought (§8.2).
> - **Pinning stated honestly** (§8.2): IPFS gives integrity, not
>   persistence. Unpinned content disappears, so the guarantee is only as
>   good as the pinning commitments behind it.
>
> **Changes in revision 10.**
> - **New §2.2 — client delivery.** A hostile frontend defeats every
>   client-side check in §8.5, because the checking code is served by the
>   same party. Stated plainly, with the mitigations ranked: wallet-native
>   resolution is the real fix; third-party adoption of the resolver package
>   limits the blast radius meanwhile.
> - **Referrer field on `G`** (§6 `G`): `NNS1G<name>|<ref>`, optional,
>   recording which integrator drove a registration so a share can be paid.
>   Added now because adding a wire field after the format freeze is a spec
>   version (§10.7).
> - **Integrator share and independent-publisher stipend** (§10.7), both
>   treasury policy rather than protocol rules — and the stipend reframed:
>   anchoring gas is a few dollars a year, so the cost being recognised is
>   operational attention, not money.
>
> **Changes in revision 9 — what the trust model actually guarantees.**
> - **New §2.1** states the guarantee honestly: proofs and anchoring stop
>   *equivocation and retroactive rewriting*, not fraud. A single operator
>   who is both state producer and sole anchor publisher can serve a
>   globally consistent lie. What defeats it is that correct state is
>   **recomputable from the chain without the operator**.
> - **Resolver quorum (§8.5).** The app MUST query at least
>   `RESOLVER_QUORUM` independent resolvers and hard-fail on disagreement.
>   This is what turns third-party detection into per-user protection.
> - **Multi-publisher anchoring (§9).** Any indexer may anchor its own root;
>   clients treat matching roots from independent publishers as the trust
>   signal, not any single anchor. `ANCHOR_PUBLISHERS` is a client-side
>   list, and the reference publisher key SHOULD be a multisig.
> - **First-use pinning promoted from SHOULD to MUST** (§8.5) — the
>   strongest per-user defence against a mass redirect.
> - §2 gains rows for the operator-forges-state attack and for API-level
>   censorship, which replay detects but cannot prevent.
>
> **Changes in revision 8.**
> - **Marketplace commission**, now that escrow gives the protocol a point of
>   interception. `M` settling a winning `B` pays the seller
>   `price − floor(price × COMMISSION_RATE)` and forwards the remainder to
>   `TREASURY_ADDRESS` (§6 `M`). Refunds are never deducted from.
> - **The rate is on-chain, carried by `P`** as a third field with its own
>   bounds (§6 `P`, §10.6). A config-file commission would have been the
>   first operator-private setting to affect publicly-owed amounts, breaking
>   the *settled vs. owed* audit that justifies the custody.
> - Commission counts toward the `BURN_SHARE` base — all NNS revenue burns
>   20% (§10.2).
> - Table of contents added; `§` references resolve to the numbered
>   headings below (non-normative).
> - **Correction to r7:** Nimiq Pay *does* inject `window.ethereum` and
>   supports Base, Arbitrum, Optimism, and Sepolia. Anchors are read through
>   the injected provider, cross-checked against an independent public RPC
>   (§9). The r7 claim that no EVM provider exists was wrong.
>
> **Changes in revision 7.**
> - **Escrowed marketplace.** `B` now pays `MARKETPLACE_ADDRESS`, not the
>   seller. Ownership still moves deterministically on the first valid `B`,
>   but every losing or invalid `B` is now *refundable* — a new §7.4 class —
>   instead of forfeited to the seller. A new `M` (settlement) message
>   discharges each debt on-chain, making *settled vs. owed* auditable
>   exactly like the burn share. Direct buyer-to-seller payment let a race
>   loser's money land in the seller's pocket with no recourse; that outcome
>   is rejected outright, at the acknowledged cost of one custodial hot
>   wallet (§6 `B`).
> - `CANCEL_DELAY` (introduced in r6) removed: with escrow, a seller's
>   cancel-front-run costs the buyer a refund wait, not their money.
> - **Governance retuned for NIM price regimes:** `PRICE_FLOOR` 100 → 1 NIM
>   and `PRICE_MIN_INTERVAL` ~30 d → ~7 d, so fees can track a fast market
>   move in weeks rather than months; the bounds themselves are documented
>   as versioned spec constants, with sustained regime change handled by a
>   spec revision (§10.6).
>
> Earlier: r6 hardened the marketplace and determinism (grace names in the
> tree, `R`/`U` messages, exact encodings, `0`/`1` boundary clause adopted);
> r5 added delegated subdomains and two-band pricing; r4 removed
> commit–reveal; r3 added the positional digit rule; r2 confirmed SDK
> feasibility.

## Contents

**[1. Design principles](#1-design-principles)**

**[2. Threat model](#2-threat-model)**

- [2.1 What the guarantee actually is](#21-what-the-guarantee-actually-is)
- [2.2 Client delivery — the limit of every client-side rule](#22-client-delivery--the-limit-of-every-client-side-rule)

**[3. Constants](#3-constants)**

**[4. Name rules](#4-name-rules)**

- [4.1 Validity](#41-validity)
- [4.2 Positional digit rule](#42-positional-digit-rule)
- [4.3 Rendering (SHOULD)](#43-rendering-should)
- [4.4 Dotted queries](#44-dotted-queries)

**[5. Transaction encoding](#5-transaction-encoding)**

- [5.1 Budget and encoding](#51-budget-and-encoding)
- [5.2 Layout](#52-layout)
- [5.3 Routing](#53-routing)
- [5.4 Value](#54-value)

**[6. Message types](#6-message-types)**

- [6.1 Registration is a single transaction](#61-registration-is-a-single-transaction)
- [6.2 Front-running: accepted, and why](#62-front-running-accepted-and-why)
- Message types — referenced by letter (`§6` + the letter), never by number,
  so inserting a type never renumbers the others:
  [`G` Register](#g--register) · [`S` Set resolution target](#s--set-resolution-target) · [`X` Transfer ownership](#x--transfer-ownership) · [`D` Set delegate resolver](#d--set-delegate-resolver) · [`K` Cancel](#k--cancel) · [`N` Renew](#n--renew) · [`O` Offer](#o--offer) · [`B` Buy](#b--buy) · [`A` Auction](#a--auction) · [`M` Settlement](#m--settlement) · [`P` Governance](#p--governance) · [`U` Unreserve](#u--unreserve) · [`F` Burn attestation](#f--burn-attestation)

**[7. Indexer rules](#7-indexer-rules)**

- [7.1 Scanning — one code path, no address index](#71-scanning--one-code-path-no-address-index)
- [7.2 Replay](#72-replay)
- [7.3 Name state machine](#73-name-state-machine)
- [7.4 Rejection: forfeit versus refund](#74-rejection-forfeit-versus-refund)
- [7.5 Transactions the indexer must ignore](#75-transactions-the-indexer-must-ignore)
- [7.6 What earns a log line](#76-what-earns-a-log-line)

**[8. State, log, and verification](#8-state-log-and-verification)**

- [8.1 Merkle tree](#81-merkle-tree)
- [8.2 The NNS log](#82-the-nns-log)
- [8.3 Proof format](#83-proof-format)
- [8.4 Tiered verification](#84-tiered-verification)
- [8.5 Client verification](#85-client-verification)
- [8.6 Delegated resolution](#86-delegated-resolution)
- [8.7 What gates usability, and what does not](#87-what-gates-usability-and-what-does-not)
- [8.8 Segments and snapshots](#88-segments-and-snapshots)

**[9. EVM anchoring](#9-evm-anchoring)**

**[10. Economics](#10-economics)**

- [10.1 Pricing — two bands](#101-pricing--two-bands)
- [10.2 Where fees go, and the burn share](#102-where-fees-go-and-the-burn-share)
- [10.3 Revenue lines beyond registration](#103-revenue-lines-beyond-registration)
- [10.4 Term length](#104-term-length)
- [10.5 Payment exactness](#105-payment-exactness)
- [10.6 Governance](#106-governance)
- [10.7 Ecosystem payouts — deliberately not protocol rules](#107-ecosystem-payouts--deliberately-not-protocol-rules)

**[11. Node and operational requirements](#11-node-and-operational-requirements)**

- [11.1 What the indexer needs](#111-what-the-indexer-needs)
- [11.2 Do not co-locate with a validator](#112-do-not-co-locate-with-a-validator)
- [11.3 Start the history sync early](#113-start-the-history-sync-early)
- [11.4 Public fallback](#114-public-fallback)
- [11.5 Sending addresses MUST be balance-checked and alerted on](#115-sending-addresses-must-be-balance-checked-and-alerted-on)

**[12. Open questions](#12-open-questions)**

**[13. Build order](#13-build-order)**

**[14. Deliverables](#14-deliverables)**

**[15. Positioning](#15-positioning)**

**[16. Deferred to v2](#16-deferred-to-v2)**

- [16.1 Name reveal (anti-MEV registration)](#161-name-reveal-anti-mev-registration)
- [16.2 Pricing signalling messages](#162-pricing-signalling-messages)
- [16.3 Rate limiting and backoff](#163-rate-limiting-and-backoff)
- [16.4 Log compaction](#164-log-compaction)
- [16.5 Signed delegate responses](#165-signed-delegate-responses)
- [16.6 Richer records](#166-richer-records)

---

## 1. Design principles

1. **The chain provides ordering, not enforcement.** Nimiq has four account
   types — Basic, Vesting, HTLC, and the single Staking contract. There is no
   general smart contract layer, so no consensus rule can enforce name
   ownership. NNS is a deterministic interpretation of transaction history,
   in the same family as Ordinals and BRC-20 on Bitcoin.
2. **Determinism over authority.** Any two correct implementations replaying
   the same history MUST produce byte-identical state roots. Every parameter
   that can change lives on-chain, never in an operator's config.
3. **Verifiable, not trusted.** Clients verify Merkle proofs against publicly
   anchored roots rather than trusting an API response.
4. **Verification must be cheap enough that people actually do it.** This is
   why registration has a price floor at all: the log is the verification
   artifact, and an artifact nobody can afford to download is not a guarantee.
5. **Fail closed.** Any malformed, ambiguous, or unaffordable message is
   ignored entirely.
6. **The protocol is not the police.** Where a rule would block many
   legitimate names to catch a rare abuse, it belongs in the interface layer.
7. **Simplicity is a security property.** Every message type is a surface for
   divergence between implementations.
8. **Delegate rather than store.** Where a use case needs unbounded names,
   push the state to whoever benefits from it (§8.6) instead of absorbing it
   into consensus.

---

## 2. Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Indexer operator rewrites the mapping | Merkle inclusion proofs verified client-side; roots anchored on an EVM chain (§9) | A name newer than the last anchor is trusted until the next checkpoint |
| **Operator forges a whole state and anchors it** | Not stopped by proofs — a sole publisher's lie is internally consistent. Defeated by independent replay (Tier 3), client quorum (§8.5), and multi-publisher anchoring (§9) | Users of a single resolver with a single anchor publisher are exposed; see §2.1 |
| Operator refuses to answer for a name (API censorship) | Detectable — the entry is in the published log and any independent resolver answers it | Not preventable; users must switch resolver endpoints |
| Log-growth spam | **Not mitigated in v1** — only registration is priced (§7.6). Mechanisms designed and deferred (§16.2, §16.3) | Spam scales with names owned (~$200 of names sustains ~6.5 GB/year); visible in the log, and answerable by raising `FEE_LONG` within a week (§10.6) |
| **Operator serves a malicious frontend** | Not mitigated by any protocol mechanism — see §2.2. Bounded by wallet-native resolution and by third-party apps shipping their own clients | Users of the operator's own mini app are fully exposed while it is served |
| Operator serves a different root per victim | Roots fetched from a public RPC, not from the NNS API | None, if the client checks the anchor |
| Anchor publisher key compromise | Tier 1/3 replay detects divergence; clients alarm and halt on anchor/replay mismatch (§8.5) | Disputed state until a correct root is anchored from a rotated key |
| Operator fabricates entries | Published NNS log; entries spot-checkable by transaction hash | None |
| Operator omits entries (censorship) | Independent full replay by any history-node operator (Tier 3, §8.4) | Requires at least one honest independent operator |
| **State-bloat denial of service** | Non-zero fee in every band (§10.1) | Bounded by cost: ~$0.20 per junk name |
| Registration front-running | Accepted, not mitigated — see §6.2 | A mempool observer or block producer can take a name from a user |
| Seller cancels against an incoming `B` | Buyer's payment sits at `MARKETPLACE_ADDRESS` and is refunded via `M` (§6) | Nuisance only — the buyer waits for a refund instead of losing funds |
| Two buyers pay for one offer | First in canonical order wins; the loser is refunded via `M` | Refund depends on the marketplace operator — custodial, but auditable |
| Marketplace operator defaults or is compromised | Ownership never depends on the operator; owed vs. settled is computable from the log and publicly visible (§6 `M`) | In-flight settlement funds (bounded by open offers) can be lost; sellers of just-consumed offers are the most exposed |
| Bulk land-grab at launch | Thorough `RESERVED_NAMES`; the fee | Squatting of unreserved names remains possible |
| **Malicious or compromised delegate resolver** | Not covered by proofs — clients MUST label delegated results differently (§8.5) | A parent can misdirect its own subdomains; scope limited to that parent |
| Confusable names (digit/letter) | Digits barred between letters, and `0`/`1` barred at either end — the boundary clause adopted in r6 (§4.2) | Accepted residual: confusions needing neither an interior digit nor a leading/trailing `0`/`1` |
| Confusable names (multigraph) | Rendering (§4.3), identicons, first-use pinning (§8.5) | Accepted residual |
| Admin key compromise | **`GOVERNANCE_DELAY`'s ~24 h of public notice, and then a fork.** Every change is on-chain before it bites; the price rails (`PRICE_FLOOR`/`PRICE_CEILING`) are fat-finger protection, not a defence, and there are no rate limits (§10.6). A `U` award reaches only `RESERVED_NAMES`, never a name with an owner | Visible, and reversible only by coordination: `ADMIN_ADDRESS` is a §3 constant, so a stolen key is routed around by a spec revision, not rotated. Within a day it can reprice the registry anywhere inside the rails and give away reserved names one announced `U` at a time |
| **Owner key compromise** | **None. A lost or stolen owner key is a lost name**, as in ENS | Total and immediate: `O` + `B` moves the name in two blocks (§6 `B`), so not even the `X` timelock delays a thief who reads this document. v1 removed the recovery address rather than advertise a defence the owner key itself defeats (r20) |
| Mistyped `XFER` recipient | `XFER_TIMELOCK` with owner veto via `K` — this, and not key compromise, is what the timelock is for | Permanent if unnoticed within `XFER_TIMELOCK` |
| Chain reorganisation | State advances only on macro-block-finalised batches | None |
| Operator disappears | MIT indexer, one-command run, log published to IPFS and addressed from the anchor (§8.2, §9) | Users must switch resolver endpoints; the log survives only while somebody pins it |

**Not claimed:** NNS is not a rollup and Nimiq is not an L2 of Ethereum.
Anchoring provides attestation, not adjudication. It binds the operator to
past claims; it does not let Ethereum reconstruct or arbitrate NNS state.

### 2.1 What the guarantee actually is

Stated plainly, because it is easy to overclaim and a reviewer will test it:

**Proofs and anchoring alone do not stop a dishonest operator.** An operator
who is both the state producer and the sole anchor publisher can build a
false state, build a tree over it, anchor that root, and serve proofs that
verify against it. Every check in §8.5 passes. What those mechanisms buy is
narrower and still worth having: the operator cannot tell different stories
to different users (one root, publicly anchored), and cannot rewrite a past
claim (the anchor is timestamped and non-repudiable).

**Three things defeat the forgery:**

1. **Independent replay (Tier 3, §8.4).** Transaction history lives on
   Nimiq, not with the operator. Anyone applying the published rules to the
   same history derives the true root; a divergence from the operator's root
   is *proof* of deviation, and diffing the two logs identifies the exact
   transaction mishandled.
2. **Client quorum (§8.5).** Detection by a third party does not help a user
   mid-transaction unless the client checks more than one source. Querying
   independent resolvers and failing on disagreement is what converts a
   community-level guarantee into a per-user one.
3. **Multi-publisher anchoring (§9).** Matching roots from *independent*
   publishers are the trust signal. A single publisher's anchor only proves
   they said it.

**The property that makes the attack pointless** is that correct state is
recomputable from the chain **without the operator's cooperation**. If the
operator steals the namespace, the community re-derives correct state,
publishes it, and clients point elsewhere; the stolen names are honoured
only by a resolver nobody uses. Contrast a custodial registry, where the
data exists nowhere else and theft is final.

So the guarantee is *the registry can be reconstituted without the
operator*, not *the operator cannot cheat*. Everything in §8 and §9 exists
to make the first statement cheap enough to be true in practice.

**Outside the guarantee entirely:** API-level censorship (detectable, not
preventable), the marketplace hot wallet (auditable, not trustless, §6 `B`),
and delegate resolver answers (§8.6, by design).

### 2.2 Client delivery — the limit of every client-side rule

Every requirement in §8.5 — verify the proof, meet the resolver quorum, pin
on first use — is a promise about code that the operator serves at page
load. A mini app is JavaScript fetched from a domain, so **the party being
checked also delivers the checker.** An operator can serve an honest bundle
to everyone and a hostile one to a single device; nothing on-chain records
it, and no bundle hash helps, because whatever would verify the hash was
served by the same party.

Scope of the attack:

- **It can** display any address for any name, so a user sends funds to the
  operator. That is sufficient.
- **It cannot** forge registry state, take ownership of names, or hide
  afterwards: the recipient address is on-chain and contradicts the
  registry, so the theft is provable after the fact. This makes it a
  one-shot reputational suicide rather than a sustainable position — but it
  is no comfort to the victim.

Mitigations, strongest first:

1. **Wallet-native resolution.** If resolution runs inside Nimiq Pay itself
   — signed, store-distributed, reviewed — the client is not the
   operator's to swap. This is the only mitigation that closes the hole
   rather than narrowing it, and it is the strongest reason for the project
   to become part of Nimiq rather than an app beside it. **To be explicit:
   this is a strengthening, not a requirement.** The protocol, the indexer,
   the verification model in §8, and the mini app all stand on their own —
   independent replay and resolver quorum defend the state layer with or
   without wallet involvement. What wallet-native resolution removes is a
   residual risk in the *delivery* layer that the mitigations below narrow
   but cannot close.
2. **The resolver package in third-party apps (§14).** Other mini apps ship
   their own bundles from their own domains, so their users are outside the
   operator's reach entirely. Wide adoption of the package is therefore a
   security property, not only a distribution strategy.
3. **Content-hash pinning by the host**, if the mini-app framework can pin a
   build rather than a live URL. **OPEN:** to be asked of the Nimiq team.
4. **Independent deployments.** The frontend is MIT; anyone may host it, and
   users who prefer not to trust the operator's domain can use another.

This is the ordinary trust boundary of every web frontend in the ecosystem,
but it deserves stating here because NNS is a system whose entire product is
a mapping the user is being asked to trust.

---

## 3. Constants

Blocks are ~1 s; 60 blocks = 1 batch ≈ 1 min; 43,200 blocks = 1 epoch ≈ 12 h.
NIM figures assume ~$0.0005/NIM.

| Constant | Proposed value | Notes |
|---|---|---|
| `PROTOCOL_ID` | `NNS1` | 4 ASCII bytes, prefix of every message |
| `LAUNCH_HEIGHT` | **OPEN** | Indexers start here, not at genesis |
| `TREASURY_ADDRESS` | **OPEN** | Receives fees — and only fees |
| `PROTOCOL_ADDRESS` | **OPEN** | Receives dust-only signalling messages and acts as the §5.3 sentinel; key held cold, never in a node |
| `REFUND_FLOOR` | 10,000 luna | Below this, a refundable amount is forfeited instead (§7.4) |
| `ANCHOR_STALENESS_LIMIT` | 48 h | Client warns beyond this (§8.5). One missed daily-floor anchor of margin (§9) |
| `SEGMENT_LENGTH` | 3,153,600 blocks (~1 y) | Log segment boundary (§8.8) |
| `AUCTION_MIN_INCREMENT` | 5% | Minimum raise over the standing bid (§6 `A`) |
| `MIN_PRICE` | `FEE_LONG` | Floor on an `O` price and an `A` reserve (§6) |
| `AUCTION_MIN_DURATION` | 86,400 blocks (~24 h) | Shortest permitted auction (§6 `A`) |
| `AUCTION_EXTENSION` | 600 blocks (~10 min) | Anti-sniping extension (§6 `A`) |
| `ADMIN_ADDRESS` | **OPEN** | Governance only; cold key, distinct from treasury |
| `MARKETPLACE_ADDRESS` | **OPEN** | `B` escrow and `M` settlement; the only NNS hot wallet, distinct from both |
| `BURN_ADDRESS` | `NQ07 0000 0000 0000 0000 0000 0000 0000 0000` | Canonical Nimiq burn address |
| `RESERVED_NAMES` | Published list + by rule (§4.1) | The published half is in the reference implementation's constants; **still incomplete** — additions are free until `LAUNCH_HEIGHT` and out of scope afterwards (§10.6) |
| `LISTING_FEE` | 0 | Value owed on an `O` (§6 `O`). Not governable: no `P` field carries it (§10.6, §12 item 3) |
| `MIN_NAME_LEN` | 5 chars | 1–4 reserved by rule (§4.1) for later award or auction; the floor binds only while a name is reserved |
| `LONG_NAME_LEN` | 12 chars | Threshold for the cheap band |
| `MAX_NAME_LEN` | 24 chars | Longer than any handle people actually use; keeps messages well inside 64 bytes |
| `MAX_LABEL_LEN` | 24 chars | Subdomain label (§4.4) |
| `MAX_HOST_LEN` | 30 chars | Delegate resolver host (§6 `D`); `resolver.binance.com` is 20 |
| `MAX_REF_LEN` | 12 chars | Integrator referrer id (§6 `G`) — fits real names (`coinbase` is 8) with room to spare |
| `FEE_STANDARD` | 2,000 NIM (~$1) | Names of 5–11 characters; governable |
| `FEE_LONG` | 400 NIM (~$0.20) | Names of 12+ characters; governable |
| `BURN_SHARE` | 20% | Of all revenue received, forwarded to `BURN_ADDRESS` |
| `COMMISSION_RATE` | 250 bp (2.5%) | Marketplace cut on a settled sale; governable |
| `COMMISSION_CEILING` | 1,000 bp (10%) | Governance hard upper bound |
| `COMMISSION_MAX_STEP` | 250 bp | Maximum change per adjustment |
| `PRICE_FLOOR` | 1 NIM | Governance hard lower bound, either band — chosen so a name stays ≤ ~$1 even at $1/NIM. A fat-finger rail, not attack protection (§10.6) |
| `PRICE_CEILING` | 100,000 NIM | Governance hard upper bound, either band |
| `GOVERNANCE_DELAY` | 86,400 blocks (~24 h) | Minimum notice before a change bites — and, since the rate limits were removed, the whole of what bounds a hostile `P` (§10.6) |
| `XFER_TIMELOCK` | 43,200 blocks (~12 h) | Window in which the owner can cancel their own pending `X` with a `K` (§6). Guards a mistyped recipient, not a thief (§2) |
| `TERM_LENGTH` | 31,536,000 blocks (~1 y) | See §10.4 |
| `GRACE_PERIOD` | 2,592,000 blocks (~30 d) | Resolution off, renewal still allowed |
| `OFFER_IRREVOCABLE` | 8,640 blocks (~2.4 h) | Seller cannot cancel |
| `OFFER_MAX_LIFETIME` | 1,296,000 blocks (~15 d) | Then auto-expires |
| `CHECKPOINT_INTERVAL` | 720 blocks (~12 min) | Root recomputed and published |
| `RESOLVER_QUORUM` | 2 | Independent resolvers a client must agree before acting (§8.5) |
| `ANCHOR_QUORUM` | 2 | Independent publishers whose roots must match (§9) |
| `DUST_VALUE` | 1 luna | Value for non-fee-bearing messages (§5.4) |
| `FINALITY_RULE` | last finalised macro block | State never advances past it |

---

## 4. Name rules

### 4.1 Validity

A candidate name is **valid** if and only if all hold:

1. Length between `MIN_NAME_LEN` and `MAX_NAME_LEN` inclusive. **The floor
   binds only while a name is reserved:** a 1–4 character name satisfying
   rules 2–5 is a member of `RESERVED_NAMES` by rule (below), so while it is
   held it fails rule 6, not rule 1 — and once a fired `U` (§6 `U`) removes
   it from the reserved set, the floor no longer applies and it is a normal
   name. The ceiling is unconditional.
2. Characters drawn only from `a-z`, `0-9`, and `-` (ASCII, lowercase).
3. Contains at least one letter.
4. Does not begin or end with `-`, and contains no two consecutive `-`.
5. Satisfies the positional digit rule (§4.2).
6. Not currently in `RESERVED_NAMES` — on neither membership route below,
   or already removed by a fired `U`.

`.` is **not** a valid character in a registered name. Dots appear only in
queries, as resolution syntax (§4.4).

**Why `-` and not `_`.** Most social platforms use the underscore, so the
choice deserves a reason. An underscore **disappears under an underline**,
and names will be rendered as links in wallets and explorers — `self_crypto`
underlined reads as `self crypto` or `selfcrypto`, which is exactly the
confusion class §4.2 exists to remove. Hyphens are also legal in DNS labels
where underscores are not, so a name can bridge into a hostname later;
resolution syntax is already dotted (§4.4). Rules 2 and 4 above are, arrived
at independently, GitHub's username rules. Allowing **both** separators would
be the worst option: `my-name` and `my_name` would be a manufactured
collision pair.

**On length.** `MAX_NAME_LEN` is 24. Every naming system built for humans
lands between 15 and 39 — X 15, Farcaster 16, Instagram 30, Telegram 32,
GitHub 39 — and the outlier, ENS, is unbounded only because it hashes labels
rather than storing them, which is also where its homoglyph problems live.
Past roughly 20 characters a name stops being recognisable at a glance, and
recognition is the entire product: `kike` instead of an address.

Implementations MUST reject rather than normalise. Uppercase input is not
lowercased — it is invalid.

`RESERVED_NAMES` has two membership routes, checked in this order or any
other — they are disjoint:

- **By list:** a versioned list published in the repo, covering `nimiq`,
  Nimiq's own products, major exchanges, wallets, and obvious brand terms.
  It is a **constant**, not a deployment setting — two indexers running
  different lists derive different roots and neither is detectably wrong at
  startup. It is also **not yet complete**: adding an entry is free until
  `LAUNCH_HEIGHT` and out of governance scope afterwards (§10.6), and the
  asymmetry below says which way to err.
- **By rule:** every name of length 1–4 satisfying rules 2–5. Membership is
  checked exactly that way — measure the length, run rules 2–5 — never by
  materialising the ~1.7 million short names into the published list. A
  short name failing rules 2–5 is on neither route: it is plain invalid and
  can never be released.

Short names are **reserved, not invalid** — held back for later release,
award (§6 `U`) or auction (§6 `A`), not lost. A `U` moves one out of the
reserved set exactly as it moves `binance` out, and from that point it is a
normal name.

> **This list is the primary defence against a launch land-grab** and deserves
> an afternoon of real work rather than a token twenty entries. With
> single-transaction registration, an empty namespace is trivially scriptable
> on day one.
>
> **Err long, never short.** A name left off is registrable by anyone the block
> after `LAUNCH_HEIGHT`, and no rule takes it back once it has an owner (§10.6)
> — under-reserving is **permanent**. A name reserved by mistake is released,
> or awarded to the right party, with one `U` (§6 `U`) — over-reserving is
> **reversible**, and costs one announced governance message.

### 4.2 Positional digit rule

**Digits may appear only at the start or the end of a name, never between
letters.** Formally: strip any leading run of digits and any trailing run of
digits; the remainder MUST contain no digits.

| Valid | Invalid |
|---|---|
| `layer`, `web3`, `2fa`, `bitcoin7`, `21kike` | `n1m1q`, `nimiq0pay`, `g00gle`, `b1tc0in`, `1ayer`, `sud0` |

*(`web3` and `2fa` illustrate the digit rule only — at 1–4 characters they
are reserved by rule (§4.1) and registrable only after a `U` releases them.
Do not turn them into acceptance tests.)*

Lowercase-only already removes `I`/`l` and `O`/`0` at the capital end. This
rule removes the rest of the realistic surface, because impersonating a name
requires substituting a character *inside* it. One clause, no lookup table.

Deliberately **not** addressed: multigraph confusions (`rn`/`m`, `cl`/`d`,
`vv`/`w`). Blocking those rejects ordinary words — `corner` and `comer`,
`barn` and `bam`. Handled at the interface layer (§4.3, §8.5).

**Boundary clause — adopted in r6.** Additionally, **`0` and `1` may not be
the first or last character** of a name. This closes the boundary collisions
(`nimiq0`/`nimiqo`, `1kike`/`lkike`) while preserving `web3`, `x2`, `2fa`,
`bitcoin7`. Desirable names do not begin or end in `0` or `1`, so the
casualty list is effectively empty.

### 4.3 Rendering (SHOULD)

Integrators SHOULD render names in a typeface that separates `0`/`o`, `1`/`l`,
and `rn`/`m`. The reference resolver package ships the required CSS so
adopting apps inherit correct rendering.

Recommended: Inter with `font-feature-settings: "ss02", "zero"`; or a
monospace face for the name field alone — JetBrains Mono and IBM Plex Mono
provide these by default.

Integrators SHOULD also display the **Nimiq identicon** of the resolved
address alongside the name.

### 4.4 Dotted queries

A dot is **resolution syntax, not a registrable character**. `a.b` means *ask
b's delegate resolver about a*.

A query is a **dotted query** if it contains exactly one `.`. It splits into
`label` and `parent`:

- `parent` MUST be a currently `REGISTERED` name with a delegate host set (§6 `D`)
- `label` MUST be 1…`MAX_LABEL_LEN` characters from `a-z`, `0-9`, `-`, not
  beginning or ending with `-`, with no consecutive `-`
- The positional digit rule does **not** apply to labels — they are not
  scarce, not sold, and not confusable with registered names because the
  parent disambiguates them
- More than one `.` is invalid in v1. Nested delegation may come in v2

Labels are never protocol state. NNS stores nothing about them, the log never
grows from them, and the Merkle tree never contains them.

---

## 5. Transaction encoding

### 5.1 Budget and encoding

Basic Nimiq transactions cap `recipient_data` at **64 bytes**
(`MAX_BASIC_TX_RECIPIENT_DATA_SIZE`). Every message must fit.

**Verified empirically** (mainnet, 2026-08-06): a 64-byte payload was
included in a block; 65-byte and 128-byte payloads were accepted by the RPC,
returned transaction hashes, and were then **silently dropped** — they never
appeared in any block. Note that the node will construct a 256-byte
transaction locally without complaint, so local construction proves nothing
about network acceptance. The limit is a **byte** budget, not a character
count: the Nimiq wallet accepts 64 ASCII characters or 32 two-byte
characters, and both are 64 bytes.

**Encoding.** The field holds raw bytes. Over JSON-RPC they are represented
as **lowercase hex in both directions** — a transaction carrying
`NNS1Gtestname` is sent as `4e4e533147746573746e616d65` and read back
identically. The RPC field names are `recipientData` and `senderData`, not
`data`. Wallets take plain text and encode it themselves; NNS clients using
the RPC directly must hex-encode. Non-ASCII UTF-8 round-trips byte-identically,
though §4.1 restricts names to ASCII regardless.

### 5.2 Layout

```
NNS1 <type> <payload>
```

- Bytes 0–3: `NNS1`
- Byte 4: one uppercase type character
- Bytes 5+: type-specific payload, `|`-delimited where multi-field

Any message not starting with `NNS1`, carrying an unknown type character, or
exceeding 64 bytes is ignored.

All fields use text-safe encoding (ASCII plus base64url); raw binary is never
used, so a message is human-readable in a block explorer.

**Numeric fields are canonical decimal:** a plain integer with no sign, no
leading zeros, no whitespace, never empty. `0123` as a height or price makes
the message `MALFORMED_PAYLOAD`. Exactly one representation per value is the
only reading under which two encodings of the same message are impossible —
anything looser lets implementations accept different message sets and
diverge.

**Canonical order** is `(block_number ascending, position in the block body
array ascending)`. The RPC transaction object carries **no index, position,
or ordering field** — verified 2026-08-06 against the full object, whose
fields are `hash, blockNumber, timestamp, confirmations, size,
relatedAddresses, from, fromType, to, toType, value, fee, senderData,
recipientData, flags, validityStartHeight, proof, networkId,
executionResult`. Order therefore comes from array position in the block
body, and every implementation must derive it the same way or roots diverge.
Blocks routinely carry several transactions, so this is not a corner case.

### 5.3 Routing

| To `TREASURY_ADDRESS` or `PROTOCOL_ADDRESS` | To the counterparty | To `BURN_ADDRESS` |
|---|---|---|
| `G` register, `N` renew, `K` cancel, `O` offer, `D` delegate, `A` auction, `P` governance, `U` unreserve *releasing* a name | `S` set, `X` transfer, `U` unreserve *awarding* a name | `F` burn attestation |

**`U` is the only type whose recipient chooses what it does.** For every other
type the recipient is a route: it says where the message belongs and is checked
against that one answer. A `U` to `PROTOCOL_ADDRESS` releases the name; a `U`
to anything else awards the name to that address (§6 `U`). The recipient is
therefore an operand, and §7.4 checks it as one — `U` has no `WRONG_RECIPIENT`
row. The single address it may not name is `BURN_ADDRESS`.

**Sender and recipient must differ.** Nimiq rejects self-transactions, and it
does so *silently*: the RPC accepts the transaction, returns a hash, and the
network then drops it — no error is surfaced anywhere. Every message type
must therefore have a recipient that cannot be the sender. One operation
would otherwise be unsendable, and it uses `PROTOCOL_ADDRESS` as a sentinel
recipient: `S` resetting a name's target to the owner's own address (§6).
Through r19 there was a second — `R` clearing the recovery address — which
went with `R` itself.

The same rule bounds the `U` award for free: a `U` is signed by
`ADMIN_ADDRESS`, so an award *to* `ADMIN_ADDRESS` is a self-transaction and can
never be mined. A compromised admin key cannot move a reserved name into the
address it already controls; it has to name some other address, in public,
`GOVERNANCE_DELAY` blocks ahead.

**Three routes to a silent drop, not two.** The RPC accepting a transaction and
returning a hash means nothing; there are three known ways for a well-formed
NNS message to be accepted, hashed, and never mined:

| Route | Where |
|---|---|
| Payload over 64 bytes | §5.1 |
| Sender equals recipient | above |
| **Sender cannot cover `value` + `fee`** | here |

The third was found the hard way on mainnet 2026-08-13, sending from an
`ADMIN_ADDRESS` that had drained to 0. Every NNS message carries at least
`DUST_VALUE` (§5.4), so an address with no income eventually stops being able
to send at all — and it stops *quietly*, indistinguishably from a healthy send.
`getTransactionByHash` returning "not found" after the transaction should have
been included is the only signal there is, so a client MUST NOT treat a
returned hash as confirmation that a message was sent. See §11.5 for what this
requires of the addresses NNS itself signs from.

**Two protocol addresses, split by purpose.** `TREASURY_ADDRESS` receives
money — registration and renewal fees, listing fees, marketplace commission.
`PROTOCOL_ADDRESS` receives everything that carries only `DUST_VALUE`:
`K`, `D`, `P`, a releasing `U`, and the two sentinels above.

The split earns its keep three ways. It makes the burn base in §10.2 exact:
every luna reaching the treasury is revenue, instead of revenue plus an
unbounded accumulation of signalling dust that must be subtracted before any
accounting is trustworthy. It gives block explorers one address to label as
*NNS Protocol*, where all protocol signalling is visible together. And it is
a better sentinel than the treasury — resolving a name to a donation address
is at least conceivable, while resolving one to a protocol sink never is, so
the sentinel can never collide with a legitimate intent.

`P` (governance) is sent from `ADMIN_ADDRESS` to `PROTOCOL_ADDRESS`, and so is
a `U` that releases a name; a `U` that awards one is sent from `ADMIN_ADDRESS`
to the awardee.
`B` (buy) is sent to `MARKETPLACE_ADDRESS`; `M` (settlement) is sent from
`MARKETPLACE_ADDRESS` to the seller being paid or the buyer being refunded
(§6).

`S`, `X`, and `R` put the counterparty in the transaction recipient so Nimiq
Pay's native confirmation dialog displays the destination address and its
identicon before signing, in the wallet's own trusted UI. (`B` lost this
property in r7 — the buyer's wallet dialog now shows the marketplace address,
so the client UI must present the offer's name, price, and seller itself.)
The indexer does not rely on this split for discovery; see §7.1.

### 5.4 Value

Fee-bearing messages (`G`, `N`, `O`) carry the fee and go to
`TREASURY_ADDRESS`. Non-fee-bearing messages carry `DUST_VALUE`: `S`, `X` and
`R` to their counterparty, and `K`, `D`, `A`, `P` plus the two §5.3
sentinels to `PROTOCOL_ADDRESS`. `F` and `M` carry the amount being moved (§6).

A `U` carries `DUST_VALUE` under both of its behaviours — to
`PROTOCOL_ADDRESS` when it releases a name, to the awardee when it awards one.
**An award is free in both directions**: the recipient pays nothing, because
the name is a gift and a fee they never agreed to would be unpayable by the
admin on their behalf, and the admin pays nothing beyond the dust, because
`TREASURY_ADDRESS` collecting a fee from itself is bookkeeping, not revenue.

`DUST_VALUE` cannot be 0: **a `value` of 0 is rejected by the network**,
verified twice on mainnet (2026-08-06) with everything else held constant.
A `fee` of 0 *is* accepted for data-carrying transactions, so no minimum-fee
rule is needed.

---

## 6. Message types

### 6.1 Registration is a single transaction

Commit–reveal was removed in revision 4. Registration is one transaction; the
first valid one for a given name wins, in canonical order. This deleted the
`C` and `R` types, salts, the account-binding hazard, two delay constants, the
tier declaration field, and four rejection cases.

Note that removing commit–reveal also made **length-based pricing cheap
again**: with `G`, the name is visible in the same transaction, so the indexer
simply measures it. The tier no longer has to be declared, so the wire field,
the mismatch check, and its rejection code never come back (§10.1).

### 6.2 Front-running: accepted, and why

Removing commit–reveal re-opens the possibility that a mempool observer takes
a name after seeing someone else's intent. The judgement to accept it:

1. **Low bot activity.** Nimiq has no established MEV infrastructure.
2. **The prize is thin.** Every 1–4 character name is reserved by rule
   (§4.1), so a sniper's maximum reward is a 5+ character name.
3. **It defended the wrong threat.** The realistic risk is a scripted bulk
   land-grab in the first hours, and commit–reveal does nothing against that —
   a grabber isn't racing anyone, they're just paying.

Paying a maximum fee does **not** solve front-running: equal fees leave
ordering to propagation and to the block producer's own policy, and a producer
running a bot has absolute priority regardless of fee.

The mitigation that does work is `RESERVED_NAMES` (§4.1).

**This judgement is contingent, and the contingency is written down rather
than left to memory.** Both premises above depend on Nimiq's current state:
if NIM appreciates or MEV tooling arrives, a 5-character name stops being a
thin prize and mempool sniping becomes worth automating. **v2 MUST
re-evaluate anti-MEV registration when any of these holds:**

- the median observed `FEE_STANDARD` in USD exceeds ~$20
- more than 1% of registrations in a month are lost to a same-block race
  (measurable directly from `REFUND` verdicts in the log, §8.2)
- any third party is observed running a registration bot

The likely answer is a soft commitment rather than full commit–reveal: `G`
carries `keccak256(name ‖ salt)` and a second message reveals it. A 32-byte
digest is 43 characters in base64url, so the committing message fits
comfortably inside the budget (§5.1). Recording the trigger and the sketch
now means the decision is a measurement, not an argument.

### `G` — Register

```
NNS1G<name>
NNS1G<name>|<ref>
```

- **Size:** 5 + `MAX_NAME_LEN` + 1 + `MAX_REF_LEN` = **42 bytes** max, well
  inside the verified 64-byte ceiling (§5.1)
- **To:** `TREASURY_ADDRESS`
- **Value:** ≥ the fee for this name's length band at this block height
  (§10.1, §10.6)
- `ref`: **optional** integrator identifier, 1…`MAX_REF_LEN` characters from
  `a-z`, `0-9`, `-`. Records which application drove the registration so an
  integrator share can be paid (§10.7). It has **no effect on validity,
  price, or ownership**: an unknown, malformed, or absent `ref` is recorded
  as absent and the registration proceeds normally. Deliberately inert — a
  revenue-sharing detail must never be able to reject a paid registration

The field exists in r10 rather than later because adding one after the
format freeze would require a new spec version; leaving it unused costs
nothing.

Valid if `name` is valid per §4.1 and `AVAILABLE` at this transaction's
position in canonical order. On success the name is registered to the sender
with `target = sender` and `expiry = block_height + TERM_LENGTH`.

Ties within a block resolve by ascending transaction index, which is
already unique within a block. Never by timestamp.

### `S` — Set resolution target

```
NNS1S<name>
```

- **To:** the new resolution target, value `DUST_VALUE`
- **To reset the target to the owner's own address:** send to
  `PROTOCOL_ADDRESS` instead — the network rejects self-transactions (§5.3),
  so the owner cannot name themselves as recipient
- Sender must be the current owner

Changes where the name resolves; ownership unchanged. This — not `X` — is the
correct operation for "I generated new seeds and want my name to point at the
new address."

### `X` — Transfer ownership

```
NNS1X<name>
```

- **To:** the new owner, value `DUST_VALUE`
- Sender must be the current owner

Takes effect at `height + XFER_TIMELOCK`. Until then the name still resolves
as before and the current owner retains control. A second `X` supersedes the
first and restarts the timelock. On taking effect the transfer resets the
name's dependent state (§7.3).

**What the timelock is for.** `XFER_TIMELOCK` is the window in which **the
owner can cancel their own pending transfer** with a `K` (§6 `K`) — a
second chance on a *mistyped recipient*, nothing more. It is not a defence
against a stolen key, and must not be described as one: a thief holding the
owner key does not need `X` at all, because `O` + `B` moves the name in two
blocks with no timelock (§6 `B`), and the same key sends the only `K` that
could stop it. §2 states the consequence plainly — a lost owner key is a lost
name. r20 removed the recovery address rather than keep a mechanism the owner
key defeats at dust cost.

### `D` — Set delegate resolver

```
NNS1D<name>|<host>
```

- `host`: hostname with optional short path; `https://` is implied and MUST
  NOT be included. Maximum `MAX_HOST_LEN`. Characters drawn only from `a-z`,
  `0-9`, `.`, `-`, `/` (ASCII); MUST NOT begin or end with `.` or `-`, MUST
  NOT begin with `/`, and MUST NOT contain consecutive `.` or `/`. Anything
  else forfeits `INVALID_HOST` (§7.4) — every one of these rules, the
  character set included, resolves to that one token, and validation must be
  exact or indexers diverge on the same message.
- **Size:** 5 + `len(name)` + 1 + `len(host)` ≤ 58, so name and host together
  MUST NOT exceed **52** characters. `D` is the largest message in the
  protocol; the limit is 58 rather than 64 so it keeps the same margin as
  everything else (§5.1)
- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender must be the current owner

Enables dotted queries under this name (§4.4, §8.6). An empty `host` clears
the delegation and disables subdomain resolution for the name.

Example: `NNS1Dbinance|nns.binance.com` — 28 bytes.

### `K` — Cancel

```
NNS1K<name>
```

- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender must be the current owner

Vetoes a pending `X`, or withdraws an `O` past `OFFER_IRREVOCABLE` —
all effective on inclusion, and **a single `K` cancels everything currently
cancellable** on the name. A `K` with nothing to cancel forfeits with
`NOTHING_TO_CANCEL`: the value at stake is `DUST_VALUE`, and the log then
records why the message had no effect instead of a misleading `OK`. The r6 `CANCEL_DELAY` is gone: with escrowed
settlement (§6 `B`), a cancellation racing an incoming `B` costs the buyer a
refund wait rather than their money, so the delay no longer bought anything.

### `N` — Renew

```
NNS1N<name>
```

- **To:** `TREASURY_ADDRESS`
- **Value:** the fee for this name's length band at this height
- Sender: anyone

Extends expiry by `TERM_LENGTH` from the current expiry, not from the renewal
height, so early renewal is never penalised.

### `O` — Offer

```
NNS1O<name>|<price_in_luna>
```

- **Size:** 5 + `MAX_NAME_LEN` + 1 + 15 = **45 bytes** max
- **To:** `TREASURY_ADDRESS`
- **Value:** `LISTING_FEE`. Settled at **0** (§3, §12 item 3), so an `O`
  carries `DUST_VALUE` — §5.4 rejects a `value` of 0 outright, and dust is
  the only sendable encoding of "no fee". The check survives at zero because
  the fee is a constant rather than a literal, but `INSUFFICIENT_VALUE` is
  unreachable for `O` while it stays there (§7.4)
- **`price` MUST be ≥ `MIN_PRICE`.** Below it the message forfeits:
  client-preventable. `MIN_PRICE` is `FEE_LONG` — the cheapest a name can be
  registered from scratch — so an offer can never be priced below what a
  buyer would pay to simply register a fresh long name instead. Being
  defined *as* a governed constant rather than a fixed luna amount, it
  tracks the NIM price through §10.6 instead of going stale like any
  hardcoded figure would (§10.6's own argument, applied here).

  It is therefore `FEE_LONG` **as in effect at this message's own block
  height**, the same rule §6 `M` states for the commission rate: an
  implementation comparing against the launch constant agrees with everyone
  else until the first `P` moves `FEE_LONG` and disagrees, silently, from
  that block on. The active value is committed to in every checkpoint
  (§8.1), so a client can prove the floor it is about to be held to.

  Three things make a token floor unworkable, and they are worth recording
  so nobody lowers it later: a price of 0 is unsatisfiable, since `B` must
  carry the price exactly and the network rejects `value: 0` (§5.4); any
  floor below `REFUND_FLOOR` means a losing bidder is **forfeited rather
  than refunded**, contradicting §7.4; and a floor small enough that
  `floor(price × AUCTION_MIN_INCREMENT)` rounds to 0 erases the auction
  increment rule, admitting unlimited dust bids that each oblige an `M`
  refund. At `FEE_LONG` all three are far below the floor, which is the
  point: the floor is set by what a name costs, not by what arithmetic
  tolerates
- Sender must be the current owner

Irrevocable for `OFFER_IRREVOCABLE` blocks, then cancellable via `K`,
auto-expiring at `OFFER_MAX_LIFETIME`.

### `B` — Buy

```
NNS1B<name>
```

- **To:** `MARKETPLACE_ADDRESS`
- **Value:** must equal the offer price **exactly**

The first valid `B` in canonical order wins: **ownership moves to the buyer
immediately and deterministically**, with the same dependent-state resets as
`X` (§7.3), and the buyer inherits the name's current expiry. Settlement
never gates the transfer — the marketplace operator handles money, never
names, so a stalled or dishonest operator cannot touch resolution or
ownership.

The winning payment creates a debt: the marketplace owes the seller the
price, discharged with `M`. Every other `B` — the race loser, a `B` against
a cancelled or expired offer, a wrong value — creates the opposite debt: the
marketplace owes its sender a refund, also discharged with `M` (§7.4).

This is the one deliberately custodial piece of NNS. The direct
buyer-to-seller alternative was rejected in r7 because it let a race
loser's money land in the seller's pocket with no recourse — worse than
bounded, auditable custody. Exposure is limited to funds in flight between a
`B` and its `M`, and the log makes any shortfall permanently visible.

### `M` — Settlement

```
NNS1M<height>|<tx_index>
```

- **Size:** 5 + 10 + 1 + 5 = **21 bytes** max
- **To:** the party being paid or refunded
- **Value:** the amount owed for the referenced transaction
- Sender MUST be `MARKETPLACE_ADDRESS` (for a `B`) or `TREASURY_ADDRESS`
  (for a refunded `G`) — whichever address holds the funds

References the transaction being settled by block height and transaction
index — the same canonical identity used everywhere else. No effect on name
state; it exists so *settled vs. owed* is computable from the log, exactly
like the burn commitment (§10.2). One `M` per settled transaction. The
operator SHOULD settle only past finalised macro blocks, mirroring
`FINALITY_RULE`.

**An `M` matching no outstanding leg is accepted and changes nothing** — the
debt it failed to discharge stays standing, which is how "the log makes any
shortfall permanently visible" actually works. Only an `M` from the wrong
sender forfeits.

**Amount owed:**

| Referenced `B` | Owed to | Amount |
|---|---|---|
| Winning (`OK`) | Seller | `price − commission` |
| Winning (`OK`) | `TREASURY_ADDRESS` | `commission = floor(price × rate)` |
| `REFUND` (§7.4) | Buyer | the full value sent, **never deducted from** |

`rate` is `COMMISSION_RATE` as in effect at the `B`'s own block height
(§10.6), in basis points. Deducting from a refund would reintroduce a
smaller version of the outcome r7 removed: a buyer who lost a race paying
for the privilege.

Rounding is `floor`, with the seller taking the remainder, so the two legs
of a sale sum to the price exactly with no dust unaccounted for. A winning
`B` therefore settles as two `M` transactions — seller and treasury.

The rate lives on-chain precisely so this table is checkable. If the cut
were an operator config value, an auditor replaying the log could not
distinguish a legitimate commission from a skim, and *settled vs. owed*
would stop meaning anything — which is the entire justification for
accepting custody in §6 `B`.

### `A` — Auction

```
NNS1A<name>|<reserve>|<end_height>
```

- **Size:** 5 + 24 + 1 + 15 + 1 + 10 = **56 bytes** max
- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender must be the current owner, or `ADMIN_ADDRESS` for a name in
  `RESERVED_NAMES`
- `end_height` must be at least `AUCTION_MIN_DURATION` ahead

**v1 status: parsed, logged, and forfeited with `AUCTION_NOT_IN_V1`.** This
is a protocol-version statement, not an implementation gap: a v1-conformant
implementation MUST take that forfeit, because one that honoured auctions
would derive a different root from one that did not. Activating `A` is a
spec-version event from a stated height. A `B` naming a non-existent auction
refunds under `OFFER_NOT_OPEN`. The `reserve` carries the same `MIN_PRICE`
floor as an `O` price, for the same reasons, and the increment rule depends
on it: at a token reserve the 5% raise rounds to zero and the auction
becomes a dust-spam surface. In v1 no `A` reaches that check — a
below-floor reserve still forfeits `AUCTION_NOT_IN_V1`, because the reason
code goes into the log and the log is committed to (§8.2). The floor check
precedes this one on the version that activates auctions.

When active, `A` opens a bidding window instead of settling by ordering.
Bids reuse `B`, naming the auction rather than an offer, and sit at
`MARKETPLACE_ADDRESS` exactly as marketplace payments do.

Rules, all deterministic from the log:

- A bid must exceed the standing bid by at least `AUCTION_MIN_INCREMENT`, or
  meet the reserve if it is the first. Anything else is `REFUND`
- Each time a bid arrives within `AUCTION_EXTENSION` of `end_height`, the end
  moves to `bid_height + AUCTION_EXTENSION`. Without this, sniping the last
  block reproduces the race the auction exists to avoid
- At the end height the highest bid wins; ties break by canonical order
  (§5.2). The name transfers with the same dependent-state resets as `X`
  (§7.3), the winning bid settles to the seller via `M` less commission, and
  **every losing bid is refunded via `M`** — the machinery already exists
- If the reserve is never met, the name stays with its owner and all bids
  are refunded

**Why this is not how ordinary registration works.** Making the highest payer
win a same-block race would be worse than ordering: today, taking a name from
someone requires controlling ordering, which means being the block producer;
under price priority, any mempool watcher takes it for one extra luna. That
converts front-running from a producer-only capability into a scripted one
(§6.2). An auction avoids this because the window is explicit and known to
everyone in advance — price discovery where it is worth having, without
turning a fixed-price registration into a blind bidding war.

**Deliberately additive.** Unknown message types are ignored (§5.2), so `A`
can ship after the wire format freezes. It is the one significant feature
that is not blocked by the freeze deadline, and it is the natural mechanism
for releasing the withheld 1–4 character names (§4.1).

### `P` — Governance

```
NNS1P<fee_standard>|<fee_long>|<commission_bp>|<effective_height>
```

- **Size:** 5 + 15 + 1 + 15 + 1 + 5 + 1 + 10 = **53 bytes** max
- **To:** `PROTOCOL_ADDRESS`, value `DUST_VALUE`
- Sender MUST be `ADMIN_ADDRESS`
- `commission_bp`: marketplace rate in basis points, 0 … `COMMISSION_CEILING`
- `effective_height` ≥ **the height of the block this message lands in** +
  `GOVERNANCE_DELAY`

All three parameters are set in one message so they can never drift out of
order or out of sync.
Bounds and scope in §10.6. Rejected if any bound is violated — every indexer
enforces them independently.

**A `P` accepted while another is still pending replaces it.** There is at most
one pending `P` (§8.1), and it is always the most recently accepted one; the
superseded change never takes effect and earns no further log line. This is the
same rule §6 `X` states for the other repeatable message, and it is what makes
§8.1's single-entry pending `P` a consequence rather than an assumption. It
became reachable in the ordinary case when r20 removed `PRICE_MIN_INTERVAL`:
two `P`s may now be accepted a block apart, so "the second one queues" and "the
second one replaces" would otherwise be a live disagreement between two
implementations at any height. Bounds are still measured against the **active**
prices, never against a pending `P`'s.

**Notice is measured from inclusion, not from sending.** The indexer sees only
the block a message landed in; it has no idea when the message was built, and
two indexers could not agree on it if it did. A governance message therefore
has to carry enough notice to survive however long it waits in the mempool.

Get this wrong and there is no second attempt at the same message: it takes an
`INSUFFICIENT_NOTICE` forfeit and stays on-chain permanently. **A governance
message is unretractable** — there is no `K` for a `P` or a `U`, and nothing
that has landed can be recalled. Verified on mainnet 2026-08-13: a `P` and a
`U` built with `head + 10,000` against a `GOVERNANCE_DELAY` of 43,200 — the
value at the time — both forfeited, and both are still there. Clients MUST compute `effective_height`
from a fresh head with margin above `GOVERNANCE_DELAY`, never from the exact
minimum.

### `U` — Unreserve

```
NNS1U<name>|<effective_height>
```

- **Size:** 5 + `MAX_NAME_LEN` + 1 + 10 = **40 bytes** max
- **To:** `PROTOCOL_ADDRESS` to *release* the name, any other address to
  *award* it to that address. Value `DUST_VALUE` either way (§5.4)
- Sender MUST be `ADMIN_ADDRESS`
- `name` MUST satisfy §4.1 rules 2–5 and the rule 1 ceiling (the floor never
  binds a `U` — every well-formed short name is reserved by rule, §4.1),
  MUST be in `RESERVED_NAMES` (rule 6 inverted), MUST NOT already have been
  released, and MUST NOT already be the subject of a pending `U`
- `effective_height` ≥ **the height of the block this message lands in** +
  `GOVERNANCE_DELAY`, measured and unretractable exactly as for `P` above

**Two behaviours, chosen by the recipient.** The payload is identical in both
cases; the transaction recipient decides what happens at `effective_height`:

| Recipient | Effect at `effective_height` |
|---|---|
| `PROTOCOL_ADDRESS` | **Release.** `name` leaves `RESERVED_NAMES` and is `AVAILABLE` under the normal rules |
| Any other address | **Award.** `name` leaves `RESERVED_NAMES` and becomes `REGISTERED` to that address: `owner` and `target` both set to it, `expiry = effective_height + TERM_LENGTH`, no delegate host, nothing pending |

Either way the name joins the unreserved set committed to in every checkpoint
(§8.1). This is the wire mechanism for the release power in §10.6. *Adding* to
the list remains impossible without a new spec version — that direction takes
names away from people.

**Why an award is its own outcome, and not a release the recipient races
for.** Releasing a reserved name to `AVAILABLE` and expecting the intended
holder to register it first is a race, and §6.2 accepts that races go to
whoever watches the chain hardest. The `U` is the worst possible starting
position for the honest party: it names the name `GOVERNANCE_DELAY` blocks in
advance, in public, so a sniper has a day to prepare a `G` for the
exact block. Handing `binance` to Binance therefore has to skip `AVAILABLE`
entirely — and the alternative, an admin racing on the partner's behalf and
then transferring, is the same race with an extra `X` and a period where the
admin owns a name it was given to pass on.

**An award is still bounded by the notice period**, which is where the
governance argument in §10.6 survives contact with this power. `GOVERNANCE_DELAY`
is measured from the landing block exactly as for `P`, so an award is visible
on-chain for a day before it binds, and a rogue admin key hands out
reserved names one publicly announced `U` at a time rather than all at once.
It cannot award to itself at all: that is a self-transaction, dropped silently
by the network (§5.3). And it can never touch a name anybody already owns —
`U` operates only on `RESERVED_NAMES`, which by definition holds names with no
owner.

**The one forbidden recipient is `BURN_ADDRESS`** (`INVALID_RECIPIENT`, §7.4).
It has no key, so a name awarded there would be unusable and unrecoverable
until `TERM_LENGTH` and the grace period ran out — dropping a name down a hole
for a year is not a power §10.6 grants, and it is not distinguishable from
a mistake. It is also the all-zero address, which is how §8.1 encodes *no*
recipient: allowing it would make an award to it and a release commit
identical bytes.

**Short names are `U` operands like any other reserved name.**
`RESERVED_NAMES` holds every 1–4 character name satisfying §4.1 rules 2–5 by
rule, and rule 1's floor binds only while a name is reserved — so a released
short name is a normal name the next `G` registers at the normal fee, and an
awarded one is a normal registration from `effective_height`. r17 forfeited
these as `INVALID_NAME`, on the premise that a short name can never be a
valid registration; §4.1 no longer says that, and the r17 rule had turned
"held for later auction" into *lost* — `MIN_NAME_LEN` blocked every `G`, the
narrowing blocked every `U`, `A` is deferred, so nothing could ever release
or award one. Awarding a short name is the same designed use as awarding a
long one: handing `nq` to an exchange so it can run a delegate host is
handing `binance` to Binance, two characters shorter. What `INVALID_NAME`
still guards for `U` is rules 2–5 and the length ceiling (§7.4): a name
failing those is one no client accepts, is on neither membership route, and
no `U` may create or release it. Only rule 6 is inverted: a `U`'s name must
be reserved, which is the whole point of it.

**One pending `U` per name.** A second `U` naming a name that already has one
pending forfeits `UNRESERVE_PENDING` rather than queueing behind it. That rule
is what makes the effect at `effective_height` unconditional: nothing but a
fired `U` removes a name from `RESERVED_NAMES`, and a reserved name cannot be
registered (§7.4 `RESERVED_NAME`), so a pending `U` always fires against
exactly the state it was validated against. Without it, the second of two
pending `U`s would come due to find the name already released or already
awarded to somebody else, and this document would have to pick which of two
unsatisfying answers every implementation must give.

### `F` — Burn attestation

```
NNS1F
```

- **Size:** **5 bytes**
- **To:** `BURN_ADDRESS`, value = amount being burned
- Sender: `TREASURY_ADDRESS`

Tags a treasury-to-burn transfer so it enters the log and the burn dashboard
(§10.2). No protocol effect; it exists to make the burn commitment auditable.

---

## 7. Indexer rules

### 7.1 Scanning — one code path, no address index

The indexer walks **batches** from `LAUNCH_HEIGHT` using
`getTransactionsByBatchNumber`, filtering every transaction on the `NNS1` data
prefix. That is the entire discovery mechanism.

It deliberately does **not** use `getTransactionsByAddress`:

1. **It works on any history node.** Address-indexed queries require the
   node's transaction index, roughly doubling storage (~1TB → ~2TB). Batch
   scanning needs history but no index, so any validator already running a
   history node can host an indexer by pointing at their existing RPC.
2. **It is one code path, not two.** `S`, `X`, and `B` go to arbitrary
   recipients and always required prefix scanning.
3. **It avoids a known bug.** `getTransactionsByAddress` paginates on a
   transaction hash cursor, and Nimiq issue #2514 reports invalid hashes for
   reward inherents in that call path.

Cost is round trips: 720 batches per day of chain. With `LAUNCH_HEIGHT` at
protocol launch, a full replay is a few thousand local RPC calls.

Inherents and reward transactions MUST be filtered before prefix matching.

### 7.2 Replay

1. Start at `LAUNCH_HEIGHT`.
2. Process transactions in canonical order: ascending `block_number`, then
   ascending position in the block body array (§5.2 — there is no index
   field on the RPC object).
2b. Discard everything §7.5 excludes **before** applying any rule.
3. Advance state only through the last **finalised macro block**.
4. Persist state plus a cursor so restarts resume rather than resync. In
   steady state only the most recent batch is read, so tailing works against a
   pruning node; history is required only for bootstrap and rebuilds.

### 7.3 Name state machine

```
RESERVED ──U to PROTOCOL_ADDRESS───▶ AVAILABLE
RESERVED ──U to any other address──▶ REGISTERED (awardee)

AVAILABLE ──G──▶ REGISTERED ──expiry──▶ GRACE ──+30d──▶ AVAILABLE
                      │
                      ├──X (after timelock)──▶ REGISTERED (new owner)
                      ├──S──────────────────▶ target changed
                      ├──D──────────────────▶ delegate host set/cleared
                      └──O + B──────────────▶ REGISTERED (buyer)
```

During `GRACE` the name does not resolve, dotted queries under it fail, and
it can still be renewed by the former owner. Grace names remain in the
checkpoint tree with `status = GRACE` (§8.1), so a client can prove both the
state and the height at which it ends.

**Height-driven effects, and their order.** State advances on height as
well as on messages: expiry, grace release, timelock maturity, and
governance activation all fire at a height whether or not any transaction
arrives. An implementation MUST apply due effects at least at every
`CHECKPOINT_INTERVAL` boundary — one that advances only on messages passes
almost every test and then commits a root containing an expired name still
`REGISTERED` at any checkpoint taken during a quiet stretch.

Effects due at one height fire **before that block's transactions**, in a
fixed order: governance activation, unreserve activation, maturing `X`,
expiry to `GRACE`, grace release to `AVAILABLE`, offer
expiry — ties within a category bytewise by name. The order is
consensus-relevant: a maturing `X` colliding with an expiry genuinely
diverges (transfer-first hands the name over and then places it in `GRACE`;
expire-first voids the transfer). Transfer fires first because it was
scheduled before the expiry came due, and because the grace reset exists to
stop a lapsed name answering for subdomains, not to void a transfer already
in flight.

**Unreserve activation covers both kinds of `U`.** The second step of that
order applies a released name and an awarded one alike: the name leaves
`RESERVED_NAMES` and joins the unreserved set (§8.1), and an award additionally
creates the `REGISTERED` record — `owner` and `target` the awardee,
`expiry = effective_height + TERM_LENGTH`, delegate host unset,
nothing pending. Ties within the step stay bytewise by name.

Because height-driven effects fire **before that block's transactions**, an
award beats every `G` in the block it takes effect in, including one built by
somebody who saw the `U` coming: at that height the name is already
`REGISTERED`, so the `G` is neither reserved nor available and takes
`LOST_REGISTRATION_RACE` — a refund, since losing to a state change inside the
block is precisely the concurrency loss §7.4 refunds. This is the ordering rule
doing the work the award was introduced for.

**Dependent-state resets.** When a transfer takes effect (`X` after its
timelock, or `B`): `owner` and `target` both become the new owner, the
delegate host is cleared, open offers are cancelled, and any pending `X` is
void. A clean slate is the safe default — in
particular, the old target must not keep receiving funds sent to the name —
and the new owner reconfigures explicitly. On entering `GRACE`: the delegate
host is cleared (a lapsed name cannot keep answering for its subdomains),
and open offers and any pending `X` are cancelled. On falling to
`AVAILABLE`, all state for the name is cleared.

### 7.4 Rejection: forfeit versus refund

**Refund for losses caused by concurrency, forfeit for losses the client could
have prevented or the user chose.**

Where one message could fall in both columns, the check order decides — and
for `G` it is fixed: recipient, name syntax, reservation, **value, then
availability**. An underfunded `G` for an already-taken name therefore
forfeits: underpaying is the client's own preventable error, and it claims
the message before the race does.

**Forfeit** — value not recoverable through the protocol:

- Data prefixed `NNS1` but carrying an unknown type, an unparseable payload,
  or more than 64 bytes. Data *not* prefixed `NNS1` is not a forfeit — §7.5
  discards it before it is parsed, and it earns no log line
- Wrong recipient for the message type
- Insufficient value for a fee-bearing message
- `G` whose name is invalid per §4.1 or reserved — checkable offline
- `G` for a name in `GRACE` — the status and its end height are provable
  from the checkpoint tree (§8.1), so a correct client prevents it
- `S`, `O`, `D`, `X`, `K` from anyone other than the current owner
- `O` whose price is below `MIN_PRICE` (§6 `O`). The floor is `FEE_LONG` as
  in effect at that height, and the active prices are committed to in every
  checkpoint (§8.1), so a correct client can prove it before sending. The
  payload is checked before the value carried, exactly as a `G`'s name
  syntax is: a message whose own payload is unusable is rejected on that
  ground whatever it paid
- `X`, `S`, `D`, `R` on an expired or grace-period name
- `D` whose host exceeds `MAX_HOST_LEN` or includes a scheme
- `P` from any sender other than `ADMIN_ADDRESS`, or violating a §10.6 bound
- `U` from any sender other than `ADMIN_ADDRESS`, with less than
  `GOVERNANCE_DELAY` notice, awarding to `BURN_ADDRESS`, naming a name that
  fails §4.1 rules 2–5 or the length ceiling (the floor never binds a `U`,
  §6 `U`), naming a name that is not
  reserved or has already been released, or naming one that already has a `U`
  pending (§6 `U`). For both `P` and `U`, notice is counted from the
  height of the block the message landed in (§6 `P`), so a message that sat
  too long in the mempool takes an `INSUFFICIENT_NOTICE` forfeit even though
  it was correct when it was built — and cannot be withdrawn

**Refundable** — recorded in the log with a `REFUND` verdict. The value sits
at whichever address received it, which owes the sender a refund discharged
via `M` (§6):

- `G` for a name that was `AVAILABLE` when the client checked but was
  registered by a transaction ordered ahead of this one — owed by
  `TREASURY_ADDRESS`
- Any `B` that does not win an open offer — the race loser, a `B` against a
  cancelled or expired offer, or a `B` whose value is not exactly the price
  — owed by `MARKETPLACE_ADDRESS`

Registration and purchase races are the same kind of loss and are handled
the same way. Earlier revisions gave registration a *credit* ledger instead,
reasoning that a ledger entry needs no key while a refund does; but the
treasury already spends (the burn share is forwarded from it), so refunds
introduce no new class of hot key, and the machinery was disproportionate to
a fee of a couple of dollars.

**`REFUND_FLOOR`.** An amount below `REFUND_FLOOR` is forfeited rather than
refunded. Without a floor, an attacker could send thousands of trivially
underfunded messages and convert them into an obligation to broadcast
thousands of transactions. Nothing an honest user does falls below it.

Note that a malformed or unknown `ref` (§6 `G`) is **not** in either column:
it is ignored and the registration proceeds. Accounting must never be able
to reject a paid registration.

Nothing in the forfeit column can be triggered by an honest user of a correct
client.

Rejected messages are recorded in the NNS log (§8.2) with their reason code,
so independent replays can confirm the rejection was correct rather than
merely observing an absence.

#### The verdict vocabulary

The prose above says which *column* a rejection falls in. That is not enough:
§8.2 commits the `<verdict>` token into the log hash, so two implementations
that agree perfectly about which messages are rejected, and disagree by one
character about what to call a rejection, derive different log hashes and
therefore different checkpoints. The vocabulary below is **normative and
closed** — every token an implementation may write into `<verdict>`, and
nothing else may appear there.

`REFUND` and `FORFEIT` are the names of the columns, not tokens. A "`REFUND`
verdict" elsewhere in this document means a log line whose token is one of
the three in the refundable table.

**OK.** One token, `OK`, for every message that takes effect — whatever it
did. An `M` that matches no outstanding obligation is `OK` too: it had no
effect, but it broke no rule, and the debt it failed to discharge stays
visible in the log (§6 `M`).

**Forfeit tokens.** The *Types* column is exhaustive: a token may only appear
against a message of a listed type.

| Token | Types | Condition |
|---|---|---|
| `UNKNOWN_TYPE` | any | `NNS1` prefix, but the type character is not one of the 14 in §6 |
| `OVER_LENGTH` | any | Payload longer than the 64-byte budget (§5.1) |
| `MALFORMED_PAYLOAD` | any | Known type, but the payload does not parse per §6 — wrong field count, empty name, unparseable integer, non-canonical number (§6) |
| `WRONG_RECIPIENT` | `G` `D` `K` `N` `O` `B` `A` `P` `F` | Not the recipient §5.3 routes this type to |
| `INVALID_RECIPIENT` | `U` | Recipient is `BURN_ADDRESS` — the one address a name may not be awarded to (§6 `U`) |
| `WRONG_SENDER` | `M` `F` | `M` from neither `MARKETPLACE_ADDRESS` nor `TREASURY_ADDRESS`; `F` from other than `TREASURY_ADDRESS` |
| `INSUFFICIENT_VALUE` | `G` `N` `O` | Value below the fee this message owes: the band fee for the name at this message's height for `G` and `N` (§10.1), the listing fee for `O` (§6 `O`) — unreachable for `O` while `LISTING_FEE` is 0 |
| `INVALID_NAME` | `G` `U` | Name fails §4.1 rules 2–5 or the rule 1 ceiling. The floor never fires here: a 1–4 character name satisfying rules 2–5 is reserved by rule (§4.1), so a `G` for one takes `RESERVED_NAME` while it is held and is a normal registration once a `U` has released it. Rule 6 is inverted for `U`, since a `U`'s name must be *in* `RESERVED_NAMES` |
| `RESERVED_NAME` | `G` | Name currently in `RESERVED_NAMES` — on the published list or reserved by rule (§4.1) — and not yet removed from it by a fired `U` |
| `NAME_IN_GRACE` | `G` | Name exists in `GRACE` |
| `NAME_NOT_REGISTERED` | `S` `X` `D` `O` | Name absent, expired, or in `GRACE` — these types require `REGISTERED` |
| `NAME_NOT_FOUND` | `K` `N` | Name has no record at all. Distinct from the row above because `K` and `N` are valid against a name in `GRACE` |
| `NOT_OWNER` | `S` `X` `D` `O` `K` | Sender is not the current owner |
| `INVALID_HOST` | `D` | Host fails any §6 `D` rule: over `MAX_HOST_LEN`, a character outside the §6 `D` alphabet (which is how a scheme is caught — `:` is not in it), or a leading/trailing/consecutive-character rule. Never `MALFORMED_PAYLOAD` — a bad host still splits into fields per §5.2, so the payload parses and the host is judged as content |
| `NOT_ADMIN` | `P` `U` | Sender is not `ADMIN_ADDRESS` |
| `INSUFFICIENT_NOTICE` | `P` `U` | `effective_height` less than `GOVERNANCE_DELAY` above the height of the block the message landed in |
| `NAME_NOT_RESERVED` | `U` | Name is absent from `RESERVED_NAMES`, or a `U` for it has already fired |
| `UNRESERVE_PENDING` | `U` | A `U` for this name is already pending and has not reached its `effective_height` (§6 `U`) |
| `GOVERNANCE_BOUND_VIOLATED` | `P` | A §10.6 bound exceeded, measured against the **active** prices |
| `NOTHING_TO_CANCEL` | `K` | Nothing currently cancellable — no pending `X`, no `O` past `OFFER_IRREVOCABLE` |
| `BELOW_MIN_PRICE` | `O` | Price below `MIN_PRICE`, which is `FEE_LONG` at this message's height |
| `AUCTION_NOT_IN_V1` | `A` | Every `A` that survives the recipient check — it precedes every check on the payload, so a below-reserve `A` takes this token rather than `BELOW_MIN_PRICE` (§6 `A`) |
| `BELOW_REFUND_FLOOR` | `G` `B` | A message that would otherwise be refundable, carrying less than `REFUND_FLOOR`. The only token that crosses columns |

`OVER_LENGTH` is **unreachable on mainnet**. The network caps transaction
data at 64 bytes — the same number as the §5.1 budget — so an over-length
payload is dropped before it can be judged: the RPC accepts it and returns a
hash, and it never lands in a block (measured; `docs/rpc-reference.md`). The
token stays in the vocabulary because the budget is the protocol's own rule,
not a hope about the network's — a deployment with a looser data cap must
still forfeit here — but no mainnet log can ever contain it.

**Refund tokens.** Each creates an obligation on the address named, discharged
by an `M` (§6).

| Token | Types | Owed by | Condition |
|---|---|---|---|
| `LOST_REGISTRATION_RACE` | `G` | `TREASURY_ADDRESS` | Name was taken by a transaction ordered ahead of this one |
| `OFFER_NOT_OPEN` | `B` | `MARKETPLACE_ADDRESS` | No open offer: the race loser, a cancelled or expired offer, or a bid against an auction. All refund identically, so the log does not distinguish them |
| `WRONG_PRICE` | `B` | `MARKETPLACE_ADDRESS` | Value is not **exactly** the offer price — over as well as under (§10.5) |

**Check order.** A message can fail several of the rows above at once, and
only the first one reached is written, so the order is as normative as the
strings. Parsing runs **hex → `NNS1` prefix → length → type → payload** —
which is why an over-length payload that is not ours is discarded by §7.5
rather than forfeiting `OVER_LENGTH`, and why an unparseable payload of an
unknown type is `UNKNOWN_TYPE`, not `MALFORMED_PAYLOAD`.

The recipient check then precedes every other check on the types that have
one. `S`, `X` and `R` have none: §5.3 routes them to the target address
itself, so any recipient is meaningful. Since r17 `U` has none either, for a
different reason — its recipient is an operand rather than a route (§5.3), so
it is checked in a row of its own rather than before everything else. After it,
each type runs its rows in this order:

| Type | Order |
|---|---|
| `G` | `INVALID_NAME`, `RESERVED_NAME`, `INSUFFICIENT_VALUE`, `NAME_IN_GRACE`, `LOST_REGISTRATION_RACE` — as fixed above |
| `S` | `NAME_NOT_REGISTERED`, `NOT_OWNER` |
| `D` | `NAME_NOT_REGISTERED`, `NOT_OWNER`, `INVALID_HOST` |
| `X` | `NAME_NOT_REGISTERED`, `NOT_OWNER` |
| `K` | `NAME_NOT_FOUND`, `NOT_OWNER`, `NOTHING_TO_CANCEL` |
| `N` | `NAME_NOT_FOUND`, `INSUFFICIENT_VALUE` |
| `O` | `NAME_NOT_REGISTERED`, `NOT_OWNER`, `BELOW_MIN_PRICE`, `INSUFFICIENT_VALUE` |
| `B` | `OFFER_NOT_OPEN`, `WRONG_PRICE` |
| `M`, `F` | `WRONG_SENDER` |
| `A` | `AUCTION_NOT_IN_V1` |
| `P` | `NOT_ADMIN`, `INSUFFICIENT_NOTICE`, `GOVERNANCE_BOUND_VIOLATED` |
| `U` | `NOT_ADMIN`, `INVALID_RECIPIENT`, `INSUFFICIENT_NOTICE`, `INVALID_NAME`, `NAME_NOT_RESERVED`, `UNRESERVE_PENDING` |

`BELOW_REFUND_FLOOR` is not a position in that order: it substitutes for
whichever refund token the message had already earned.

`U`'s order runs envelope, then operation, then operand. `INVALID_RECIPIENT`
sits directly after `NOT_ADMIN` because the recipient decides which of two
operations the message even is, and a release and an award are not the same
act; `INSUFFICIENT_NOTICE` then keeps `U` parallel with `P`; and the three name
rows run from the most fundamental fact about the name outward — its syntax,
whether it is reserved, whether one `U` for it is already in flight. A name
cannot have a pending `U` without having been reserved and well-formed when
that `U` landed, so each row can assume the ones above it.

What the orders have in common is that a message's **own payload is checked
before the value it carried** — `G`'s name syntax, `O`'s price floor — so a
message that is unusable on its face is rejected on that ground whatever it
paid. They do not put payload before *state*: `O` establishes that the sender
owns a registered name before it looks at the price, because `BELOW_MIN_PRICE`
against a name the sender never owned would be the less informative of two
true answers.

**§7.5 reasons are not verdict tokens.** A transaction discarded for wrong
network, height below `LAUNCH_HEIGHT`, `executionResult: false`, being a
reward transaction, or not carrying the `NNS1` prefix earns **no log line**
at all (§7.6). An implementation naming those states internally must keep
those names out of the `<verdict>` field.

### 7.5 Transactions the indexer must ignore

Applied before any other rule, and before a message is even parsed:

| Condition | Reason |
|---|---|
| `executionResult` is `false` | **Albatross includes failed transactions in blocks.** Without this rule a failed `G` could take a name, and two implementations disagreeing about it would produce different roots |
| Reward transactions | `getTransactionsByBatchNumber` returns them alongside user transactions; they carry no `NNS1` payload but must not be counted in ordering either |
| `networkId` is not ours | Guards against a misconfigured node fed by a different network |
| `recipientData` does not begin with `NNS1` | The ordinary case — most chain traffic is not NNS |

The `executionResult` rule is the one that matters: it is invisible in the
happy path, silently wrong in the unhappy one, and was found only by
inspecting a real transaction object.

### 7.6 What earns a log line

Every message surviving §7.5 is logged, with its verdict. Nothing else is.
That is the whole rule.

Deliberately, there is **no anti-spam machinery in v1**. Fee-bearing messages
(`G`, `N`, `O`) are priced by their own fee, which is what §8.2's growth
bound rests on. Signalling messages (`K`, `D`, `S`, `X`, `R`) are not priced,
so someone who owns a name can emit them repeatedly for the cost of the dust
and the network fee. Registration is the only gate.

**This is an accepted risk, not an oversight.** Filters, per-name rate
windows and signalling fees were all specified and then removed: each is a
rule every independent implementation must match exactly, added against an
attack nobody has yet run, on a protocol with no users. §1 treats simplicity
as a security property, and the response to spam is available in a week
through §10.6 pricing if it ever materialises. §16 records the mechanisms and
the analysis behind them so the work is not lost.

---

## 8. State, log, and verification

### 8.1 Merkle tree

Every `CHECKPOINT_INTERVAL` blocks, build a tree over all names in
`REGISTERED` **or `GRACE`** state.

**Checkpoint heights are absolute multiples of `CHECKPOINT_INTERVAL`** —
counted from block zero, never as offsets from `LAUNCH_HEIGHT`. The schedule
must not move with a config value: `LAUNCH_HEIGHT` is an **OPEN** §3 value, so
an offset schedule is one two operators can disagree about while both honestly
implementing "every `CHECKPOINT_INTERVAL` blocks". Multiples of 720 from zero
need no agreement. `LAUNCH_HEIGHT` itself never gets a checkpoint unless it
happens to be such a multiple; a boundary is strictly above the previous one.

The tree itself:

- Leaves sorted bytewise-lexicographically by name
- `leaf = keccak256(0x00 ‖ enc)`; internal nodes `keccak256(0x01 ‖ left ‖
  right)`. The one-byte domain-separation prefixes prevent a crafted leaf
  from being reinterpreted as an internal node (second-preimage hardening)
- `enc = len(name):u8 ‖ name ‖ owner:20B ‖ target:20B ‖ expiry:u64-BE ‖
  status:u8 ‖ len(host):u8 ‖ host`
  - `name` and `host` are raw ASCII bytes; every variable-length field is
    length-prefixed, so no two distinct states share an encoding
  - Addresses are the raw 20-byte form, never the `NQ` string; an unset
    host has length 0
  - Through r19 a `recovery:20B` field sat between `status` and the host.
    r20 deleted the recovery address (§6), so it is gone and **every root
    changes**; `COMMITMENT_LAYOUT` is `4`
  - `status` is `0x00` for `REGISTERED`, `0x01` for `GRACE`
- Odd nodes promoted unchanged; empty tree → 32 zero bytes

The referrer (§6 `G`) is **not** in the leaf: it is an accounting detail,
not registry state, and lives only in the log.

Grace names are in the tree so that **non-inclusion cleanly means
`AVAILABLE`**. Before r6 a grace name proved *absent*, and a client following
§8.5 to the letter would have let a user pay for an unregistrable name.

The delegate host is inside the leaf so that clients can verify *which*
resolver a parent designated, even though they cannot verify what that
resolver answers.

Three things beyond the name tree are consensus-relevant state and MUST be
committed to in the checkpoint alongside it, or independent replays diverge:

- The **active prices and commission rate** (§10.6).
- The **pending set** — in-flight `X`, open offers, **and any pending `P`
  or `U`**, each with its effective or expiry height. A pending `P` decides
  what a later registration costs, and a pending `U` whether a name is
  registrable at all and — since r17 — who ends up owning it; they are as
  consensus-relevant as a pending transfer.
- The **unreserved set** — the names whose `U` has already taken effect.

The unreserved set was missing through r15, and its absence was the sharpest
hole in this clause. A pending `U` is committed under tag `0x09` and then falls
out of the commitment entirely the moment it fires: the name has no leaf in the
name tree (it is `AVAILABLE`, not `REGISTERED` or `GRACE`), and it is no longer
pending. So two indexers disagreeing about whether a reserved name has been
released — the disagreement that decides whether a registration for it is
honoured or forfeited as reserved — produced **identical checkpoints**, and
stayed identical until somebody actually registered the name. The one class of
divergence this whole design exists to catch was invisible for exactly as long
as it was cheapest to fix. Tag `0x0A` closes it.

**The commitment layout.** Each component is domain-separated by a distinct
tag byte and hashed on its own; the four digests are then bound together with
the log hash and the height into the single value an anchor publishes (§9).

| Tag | Domain |
|---|---|
| `0x00` | name leaf |
| `0x01` | internal node |
| `0x02` | the checkpoint commitment |
| `0x03` | the active prices |
| `0x04` | the pending set |
| `0x05` | a pending `X` |
| `0x06` | a pending `R` |
| `0x07` | an open `O` |
| `0x08` | a pending `P` |
| `0x09` | a pending `U` |
| `0x0A` | the unreserved set |

Field conventions, throughout: heights and luna amounts are **`u64-BE`**;
addresses are the raw **20 bytes**, never the `NQ` string, and an unset address
is 20 zero bytes; a `name` is raw ASCII behind a `u8` length prefix; and `‖` is
plain concatenation — no separators, no padding, no alignment.

```
prices     = keccak256(0x03 ‖ fee_standard:u64-BE ‖ fee_long:u64-BE
                            ‖ commission_bp:u64-BE)
```

The pending set is one entry per pending item, concatenated **in category
order** — transfers, offers, governance, unreserves — and, inside a
category, bytewise-lexicographically by name. There is at most one pending `P`,
and it is the one entry carrying no name.

```
transfer   = 0x05 ‖ len(name):u8 ‖ name ‖ new_owner:20B
                  ‖ effective_height:u64-BE
offer      = 0x07 ‖ len(name):u8 ‖ name ‖ seller:20B ‖ price:u64-BE
                  ‖ opened_height:u64-BE ‖ expiry_height:u64-BE
governance = 0x08 ‖ prices(proposed):32B ‖ effective_height:u64-BE
unreserve  = 0x09 ‖ len(name):u8 ‖ name ‖ recipient:20B
                  ‖ effective_height:u64-BE

pending    = keccak256(0x04 ‖ entry₁ ‖ entry₂ ‖ … ‖ entryₙ)
```

**Tag `0x06` is retired, not reused.** It carried the pending-`R` entry
through r19; r20 deleted `R` (§6) and the transfer entry lost its trailing
`via_recovery:u8`, which distinguished the two timelocks and can now only be
one value. The tag is left as a hole deliberately: an implementation written
against r19 that meets a `0x06` it no longer expects fails on a tag it knows,
rather than misreading a renumbered one it thinks it understands. The pending
`P` entry embeds the 32-byte `prices` digest of the **proposed** prices rather
than their fields.

**A pending `U`'s `recipient` is what makes it a release or an award** (§6
`U`), and it is committed rather than derived. A release commits **20 zero
bytes** — the "unset address" form — and an award
commits the awardee's 20 bytes. Without it, two indexers that agree a `U` is
pending and disagree about who the name goes to derive identical checkpoints
until it fires, which is the shape of hole tag `0x0A` closed in r16, this time
with an owner at stake rather than a status.

The release form is zeros rather than `PROTOCOL_ADDRESS` for two reasons.
`PROTOCOL_ADDRESS` is an **OPEN** §3 value, and no commitment should move with
an unsettled constant — the same argument that put checkpoint heights on
absolute multiples. And what the bytes must carry is *whether* there is a
recipient, not which sentinel expressed it. Zeros are unambiguous here only
because `BURN_ADDRESS` is itself the all-zero address and §7.4 rejects it as an
awardee: permitting that one award would collapse the two forms onto one
encoding, and a release and a burn are not the same act.

With nothing pending the concatenation is empty and `pending` is
`keccak256(0x04)`, the hash of the lone tag byte. Note the asymmetry with the
name tree, whose empty form is 32 zero bytes: the two empty cases are different
values on purpose, so an implementation cannot substitute one for the other.

The unreserved set is a flat list of names — no heights, because a `U` that has
fired carries nothing but the fact that it fired — encoded exactly as a name is
encoded everywhere else in this clause, and ordered the same way the pending
entries within a category are:

```
unreserved = keccak256(0x0A ‖ len(name₁):u8 ‖ name₁
                            ‖ len(name₂):u8 ‖ name₂ ‖ … )
```

Names bytewise-lexicographic, no separators. With nothing unreserved the
concatenation is empty and the digest is `keccak256(0x0A)`, following `pending`
rather than the name tree. A name enters this set when its `U` reaches its
`effective_height` and never leaves it — the set is the record of a governance
act, not of the name's current status, so a later registration of the name does
not remove it.

An **awarded** name enters on exactly the same terms as a released one: the
award is what took it out of `RESERVED_NAMES`, which is what this set records.
The two are told apart by the awarded name's leaf in the name tree, not here,
and that is sufficient — an indexer that mistook an award for a release would
be missing a `REGISTERED` leaf, so the disagreement is caught by `name_root`
without this list needing to carry the recipient a second time.

```
commitment = keccak256(0x02 ‖ name_root:32B ‖ prices:32B ‖ pending:32B
                            ‖ unreserved:32B ‖ log_hash:32B ‖ height:u64-BE)
```

`height` is the checkpoint height and `log_hash` the §8.2 log hash through it.
Settlement obligations (§6 `M`) are deliberately **not** committed: §6 `M` makes
settled-versus-owed computable from the log, which makes them derived state
rather than consensus state.

The reference implementation's `merkle.json` conformance vectors pin every value
above, all three empty forms included. **They are r16 vectors** — regenerated
2026-08-13, when `0x0A` landed in `core`, with six cases added that pin the
unreserved component itself. Every commitment in that file changed value; the
four pre-existing component digests did not.

**r17 has not reached them yet.** The 20-byte `recipient` inside a pending `U`
changes every vector carrying one, and every commitment derived over it, so
until they are regenerated the vectors pin the r16 layout and this clause is
the only statement of r17. Any checkpoint already computed must record which
layout produced it, which is what `COMMITMENT_LAYOUT` and the indexer's
`unreserved_root` column are for.

keccak256 here so proofs stay cheap to verify on-chain if a future version
wants that.

### 8.2 The NNS log

Every `NNS1`-prefixed transaction, in canonical order, one line each.
`tx_index` is the **zero-based** position of the transaction in its block's
body array (§5.2) — stated explicitly because a one-based reading would
produce a different log hash and therefore a different checkpoint, silently.
The `<data>` field carries the message as **lowercase hex, never raw text**:
a malformed but `NNS1`-prefixed payload still earns a line, and nothing
stops such a payload containing a space or a newline — written raw, it
would forge an entire log line and silently change the committed log hash.
Addresses in a log line use the compact 36-character `NQ` form, unspaced,
for the same reason:

```
<block_height> <tx_index> <tx_hash> <sender> <recipient> <value> <data> <verdict>
```

`verdict` is `OK` or a reason code from §7.4. The `data` field carries the
message verbatim, so the referrer of a `G` (§6 `G`) is recoverable from the
log without a dedicated column. Since r17 the `recipient` field is
load-bearing for one type rather than only informative: a `U`'s recipient is
what decides whether it released a name or awarded it, and to whom (§6 `U`).
It was already in the line, so replaying an award needs nothing the log did
not already carry.

The log is small — 100k messages at ~140 bytes is under 15 MB — and it is what
makes verification cheap. **This is why no registration band is free:** at
zero cost an attacker could inflate the log until nobody replays it, killing
Tier 1 verification and with it the trust model. Published alongside every
checkpoint root, with its own hash included in the checkpoint.

**Canonical form**, so the committed hash is reproducible: UTF-8, one line
per message, fields separated by single spaces in the order above, hashes
and other hex fields lowercase, every line terminated by a single `\n`. The
committed log hash is the keccak256 of the file bytes from the first line
through the last message at or below the checkpoint height.

**Publication to IPFS.** Each log snapshot is added to IPFS and referenced
by its CID, which is carried in the `Anchored` event (§9). This does not add
tamper-evidence — the keccak256 above already provides that — it adds
**availability that does not depend on the operator**. Before r11, Tier 1
verification began by downloading the log from the very party being checked;
now anyone can fetch it from any node or gateway, and third parties can pin
their own copies.

**The DAG parameters are normative — and they bind the party doing the
add.** A log snapshot is a **UnixFS file** with a **dag-pb** root, **CIDv1**,
**sha2-256**. A multi-megabyte file is not one block, so its root hash is
over DAG structure rather than over the file bytes, and every parameter that
shapes the DAG changes the root CID. The table is the flag set every
publisher and pinner MUST use, pinned so that independent parties adding the
same bytes mint the same CID:

| Parameter | Value |
|---|---|
| CID version | 1 |
| Root codec | `dag-pb` (`0x70`) |
| Multihash | sha2-256 (`0x12`), 32 bytes |
| Chunker | fixed size, **262,144 bytes** (256 KiB) |
| Layout | balanced — never trickle |
| Max links per node | 174 |
| Raw leaves | **off** |
| Inline blocks | off |

- **Raw leaves are off deliberately**, and it is not a performance choice.
  With raw leaves on, a snapshot short enough to fit in a single chunk has no
  intermediate node at all: the root *is* the leaf, and its codec is `raw`
  rather than `dag-pb`. The codec would then depend on the size of the file,
  which is exactly what a client reconstructing a CID from a bare digest
  cannot know. With raw leaves off, every snapshot — the first one after
  launch and a full segment alike — has a `dag-pb` root, and the codec is a
  constant of this spec. Note that **kubo turns raw leaves on by default the
  moment `--cid-version=1` is given**, so a conforming add passes
  `--raw-leaves=false` explicitly rather than relying on any default
- On the wire, the root CID's **32-byte multihash digest as base64url — 43
  characters**. Everything else is fixed above, so a client rebuilds the full
  CID as CIDv1 + `0x70` + `0x12` + `0x20` + digest. A base32 CIDv1 would be
  59 characters and would fit a message exactly, with no margin; the digest
  form leaves room
- **Never a URL, and never a shortener.** A shortener is a mutable
  indirection controlled by somebody, which destroys exactly the property
  content addressing provides
- Clients MUST NOT trust a gateway to have served the right content, and
  the check is keccak256: hash the fetched bytes and compare against the
  `log_hash` committed inside the anchored checkpoint. The binding check
  costs nothing extra on top: replaying the fetched log derives the
  checkpoint, and a gateway that altered a byte cannot produce the anchored
  root (§8.4). **No client re-derives the root CID from fetched bytes** —
  the CID is a locator, not a verifier; IPFS itself refuses to serve content
  that does not match the CID it was asked for, and the only CID computation
  a client performs is rebuilding the CID *string* from the event's digest,
  above

**Only the producer of a snapshot ever derives a CID from bytes**, and it
does so by running a reference implementation of the table — kubo, or a
pinning service's importer — never by reimplementing UnixFS. A wrong CID in
an anchor costs discoverability, not integrity: the event points at nothing
fetchable, but the anchored commitment still binds the log hash, and any
copy of the bytes still verifies against it. The mitigation is therefore
operational — a publisher adds the snapshot through **two independent
implementations** and requires equal CIDs before anchoring the digest.

Published once per anchor (on change with a daily floor, §9) rather than
once per checkpoint — 120 CIDs a day would be noise, and the unchanged
prefix dedupes anyway. Pinned snapshots are **kept, all of them**: at a
daily ceiling the retention question dissolves — a year of a full registry
is a few gigabytes across two free tiers — rather than needing a pruning
policy that would itself be an availability decision.

**IPFS gives integrity, not persistence.** Unpinned content disappears.
Publication is therefore backed by pinning: the operator's own service, and
independent operators pinning their own copies (§15). Claiming the log is
"on IPFS" without pinning commitments behind it would be precisely the kind
of overclaim §2.1 exists to avoid.

### 8.3 Proof format

```json
{
  "name": "kike",
  "owner": "NQ...",
  "target": "NQ...",
  "expiry": 215725374,
  "status": "REGISTERED",
  "delegate": "nns.binance.com",
  "root": "0x...",
  "nimiq_height": 58060800,
  "leaf_index": 1042,
  "proof": [
    { "hash": "0x...", "side": "left" },
    { "hash": "0x...", "side": "right" }
  ],
  "anchor": { "chain": "ethereum", "tx": "0x...", "block": 23100000 }
}
```

Each proof step carries its **side**, and the leaf index travels with the
proof. A bare array of hashes — the obvious format — is not verifiable
here: §8.1's odd-node promotion makes the tree shape depend on the leaf
count, so neither a sibling's side nor the promotion points can be recovered
from the hashes alone.

The document carries **every field the §8.1 leaf encodes** — `delegate`
included, `""` when unset — because the client re-derives the leaf hash
from these fields and recombines it with the proof (§8.5). Omit one and the
proof stops binding the record: a verifier that cannot rebuild the preimage
is verifying a hash it was handed, which proves nothing about the fields
next to it. This rule has already been broken once: `recovery` was missing
from this example through r16, and the gap was found when the first
verification test tried to rebuild a leaf for a record that had one. That
field is gone with `R` (r20), but the rule it exposed is not — `delegate`
now carries it, and an implementation must keep a test that strips a leaf
field and expects verification to fail.

**Non-inclusion** — needed before a user pays to register — is proven by
returning the two adjacent leaves that lexicographically bracket the queried
name, each with its own proof. When the queried name sorts before the first
or after the last leaf, the single boundary leaf and its proof suffice — the
proof path itself shows the leaf is the extreme one. Because grace names are
in the tree (§8.1), non-inclusion proves `AVAILABLE`, not merely
not-`REGISTERED`.

### 8.4 Tiered verification

**Tier 1 — anyone, no node, seconds.** Fetch the log by the CID in the
anchor (§8.2), replay it with the reference implementation, and compare the
derived checkpoint to the anchored root. The comparison is what verifies the
bytes: the log hash is committed inside the checkpoint, so a gateway that
served altered bytes cannot reach the anchored root. Keccak256 of the fetched
bytes against the committed log hash is a cheaper early check on the same
thing, not a second guarantee; no tier re-derives the CID from the bytes
(§8.2). Catches any manipulation of state or rules — and since r11
the fetch does not route through the operator, so the cheapest tier no longer
depends on the party being checked.

**Tier 2 — anyone with a normal node or a public endpoint.** Spot-check log
entries by transaction hash against any Nimiq RPC, including the free
rate-limited `rpc.nimiqwatch.com`. Catches fabricated entries.

**Tier 3 — any history node.** Full independent replay from `LAUNCH_HEIGHT`.
The only tier that catches **omission**.

Tier 3 is the security-critical one, and §7.1 exists to make it broadly
reachable: any validator already running a history node can point the indexer
at their existing RPC. No new storage, no index, no resync.

It is also the only tier that catches a **forged state** (§2.1): Tiers 1 and
2 check the operator's story for internal consistency, while Tier 3
recomputes the answer from the chain. An NNS with no independent Tier 3
operator has an honest-operator assumption, however many proofs it serves.

### 8.5 Client verification

The mini app MUST:

1. Fetch the latest anchored root from a **public RPC for the anchor chain
   (§9)**, never from
   the NNS API — and from at least `ANCHOR_QUORUM` independent publishers
   (§9), treating a mismatch as a hard failure. `anchor()` is permissionless,
   so "publisher" here means an address **on the client's
   `ANCHOR_PUBLISHERS` list**: anchors from unknown addresses are ignored,
   never counted toward the quorum, and never treated as a mismatch
2. **Query at least `RESOLVER_QUORUM` independent resolvers** and compare
   both the root and the resolved answer. If they disagree, stop and warn —
   never silently prefer one. One resolver plus one anchor publisher is one
   party, and a single party's proofs are internally consistent whether or
   not they are honest (§2.1). Two fetches is the entire cost of closing
   that hole, and the resolver list ships with the client
3. Verify the inclusion proof locally against the agreed root. **"Root"
   means two different digests in this list and the client must not conflate
   them.** What §9 anchors is the §8.1 **checkpoint commitment** — the
   six-component digest, which is the only value that binds the prices, the
   pending set, the unreserved set and the log hash as well as the names. An
   inclusion proof, by contrast, verifies against the **name root**, one of
   those six components. So the check is in two steps: confirm the
   checkpoint document's `commitment` equals the anchored value, then verify
   the proof against that same document's `nameRoot`. Verifying a proof
   against a `nameRoot` from a document whose `commitment` was never checked
   proves only that the server is internally consistent, which is precisely
   what §2.1 says a single party's proofs always are
4. Resolve normally if the name is at or below `nimiq_height` of the anchor
5. If newer than the last anchor, label it as *recently registered — anchor
   pending*. This is a **depth indicator, not a warning**: the name
   resolves, the proof verifies against the current checkpoint, and the
   anchor is simply not due yet (§8.7). Alarming language belongs only to
   genuine mismatches, and using it here would train users to ignore it
6. **Visually distinguish verified from delegated results.** A registered name
   resolved from a proof is *verified on-chain*. A dotted query answered by a
   delegate host is *resolved by `<parent>`* and carries no cryptographic
   guarantee. If both render identically, one compromised partner resolver
   undermines the trust story for the entire registry.

7. **Alarm and halt on anchor mismatch.** If a locally replayed root
   disagrees with the anchored root, surface the conflict and stop resolving
   — never silently prefer either side. A mismatch means the operator or the
   anchor publisher is compromised (§2), and both are somebody else's key.
8. **Warn on a stale anchor.** If the newest anchor is older than
   `ANCHOR_STALENESS_LIMIT`, say so. An offline publisher must not degrade
   security silently — the client cannot tell "nothing to anchor" from
   "the publisher stopped", so it reports the fact rather than guessing
9. **Preflight every message against the size ceiling** before submitting
   it. Over-length messages are accepted by the RPC and then silently
   dropped (§5.1), so a client that does not check produces a transaction
   hash and no effect — the worst possible user experience. Reject locally,
   with a specific error
10. **Warn before `B`.** Show that settlement is custodial: if this `B`
   loses a race or hits a cancelled offer, the refund comes from the
   marketplace operator (§6 `M`), not from the protocol — auditable in the
   log, but a promise, not a rule. Require explicit confirmation.

The app **MUST** pin `name → address` on first use and hard-stop with a
warning if a previously seen mapping changes. Promoted from SHOULD in r9:
this is the strongest per-user defence there is, because it needs no
external party at all. It converts a mass redirect into many simultaneous
alarms, and it covers the multigraph confusions left out of §4.2.

The app MUST check availability via non-inclusion proof before letting a user
register.

### 8.6 Delegated resolution

For a dotted query `label.parent`:

1. Resolve `parent` normally, with proof. If it is not `REGISTERED` or has no
   delegate host, the query fails.
2. `GET https://<host>/nns/v1/resolve/<label>`
3. Expected response: `{"address": "NQ...", "ttl": <seconds>}`
4. Validate that the address is well-formed. Cache for `ttl`, capped at one
   hour by the client.

**Optional signed responses.** A delegate MAY return
`{"address": "NQ...", "ttl": <seconds>, "timestamp": <unix>, "sig": "<base64url>"}`
where `sig` is an Ed25519 signature by the parent's owner key over the ASCII
string `label ‖ "\n" ‖ address ‖ "\n" ‖ ttl ‖ "\n" ‖ timestamp`. Clients that
verify it MUST reject a timestamp older than `ttl`.

v1 requires neither producing nor verifying this, but the format is fixed
**now** so a delegate can opt in later without a spec revision — and so two
delegates cannot invent incompatible schemes in the meantime. What it buys:
proof that the parent authorised a particular answer, so a compromised host
alone cannot fabricate subdomain addresses.

The parent's ownership and its designated host are provable from the
checkpoint; the answer is not. That boundary is exactly right — an exchange
already controls the deposit addresses it is naming — but it MUST be surfaced
to the user per §8.5.

**Why this design.** The exchange registers one name, pays once, and issues
unlimited free subdomains to its users. NNS stores nothing per subdomain, the
log does not grow, and Tier 1 verification is unaffected. The party that
benefits from unbounded names carries the cost of storing them.

### 8.7 What gates usability, and what does not

Three clocks run at different speeds, and only the first determines whether
a name works:

| Clock | Interval | What it gates |
|---|---|---|
| Finality (`FINALITY_RULE`) | ~minutes, last finalised macro block | **The name is registered and resolves** |
| Checkpoint (`CHECKPOINT_INTERVAL`) | ~12 min | A Merkle proof exists for it |
| Anchor (§9) | ~1 h | The root is notarised on the anchor chain (§9) |

**A name is usable at the first clock.** Registration takes effect when the
transaction is final; the indexer applies it, the resolver answers for it,
and payments to it work. Checkpoints and anchors add *verification depth* to
a name that already functions — they are not an activation queue, and no
part of this specification makes resolution wait for them.

The practical consequence is that a name registered between anchors resolves
normally and carries a proof against the current checkpoint, with only the
anchor attestation pending. §8.5 requires the client to show that state
plainly, and to make it read as a depth indicator rather than a problem: a
user who has just paid for a name should not be told something is wrong
with it.

### 8.8 Segments and snapshots

**Specified now, not implemented in v1** — the first boundary is a year
away, and a launch-week resolver replays days, not years. It is written down
because the format must be agreed before anyone depends on it.

Verification must stay cheap as history accumulates, or §2.1's guarantee
becomes theoretical: a resolver that has to replay years of log before it can
answer is a barrier to exactly the independent operators §15 recruits.

- The log is divided into **segments** of `SEGMENT_LENGTH`. A closed segment
  is immutable, keeps its own CID, and stays pinned and anchored.
- At each boundary the operator publishes a **state snapshot**: the full
  contents of the Merkle tree at that height — every leaf, not just the root
  — with its root anchored as usual.
- A verifier chooses. **Fast:** take the anchored snapshot, replay only the
  current segment. **Full:** fetch every archived segment and replay from
  `LAUNCH_HEIGHT`.

**Nothing is ever deleted.** Deleting "invalid" lines would be the wrong
move twice over: the spam that matters is *valid* (§7.6), and a rejection
line is what lets an independent replay confirm the rejection was correct
rather than infer it from an absence (§7.4). Segmentation bounds the working
set without destroying evidence — which is what r11's content addressing
bought: an archived segment remains fetchable at the CID it always had.

**The cost, honestly.** A verifier starting from a snapshot trusts the
anchoring quorum for everything before it instead of deriving it. That is a
real weakening for newcomers, mitigated but not removed by the archives
remaining available; Bitcoin's `assumevalid` makes the same trade for the
same reason. The full path always exists, and §8.5's quorum applies to
snapshot roots exactly as it does to checkpoint roots.

**Compaction within a segment is deliberately not specified for v1.** If it
is ever added, one rule keeps it safe: a line may be omitted only when its
verdict is terminal *and* any obligation it created is discharged — a
`REFUND` line stays until its `M` exists — and the uncompacted segment keeps
its own CID so the compaction itself is checkable.

---

## 9. EVM anchoring

```solidity
event Anchored(
    bytes32 indexed root,
    address indexed publisher,   // msg.sender
    uint64  nimiqHeight,
    uint64  timestamp,
    bytes32 logDigest      // multihash digest of the log snapshot's CID (§8.2)
);
function anchor(bytes32 root, uint64 nimiqHeight, bytes32 logDigest)
    external;                    // permissionless — see below
```

`root` is the **§8.1 checkpoint commitment** at `nimiqHeight` — the
six-component digest, not the name root and not any other component. It is
the only one of the six that binds all of them, and it is the value a client
compares an anchor against before trusting a proof (§8.5 #3). A publisher
takes it verbatim from the checkpoint it is anchoring and never recomputes
it: re-deriving a commitment in a publisher would make the publisher a
second implementation of §8.1, which is the divergence this whole section
exists to detect rather than to contain.

`logDigest` is the 32-byte sha2-256 multihash digest of the log snapshot's
**root CID** — an address, not a hash of the file. It is not the keccak256
log hash of §8.2, which is a hash of the file bytes and is already committed
inside `root` by way of the checkpoint. The two are different digests over
different things and both are load-bearing: `logDigest` says *where the
evidence is*, the keccak256 inside `root` says *what it must contain*.

The client rebuilds the full CID from `logDigest`, since CID version, codec
and hash function are fixed by §8.2. Carrying it in the event costs one extra
word of log data and means a single attestation covers both the state and the
evidence for it.

Events rather than storage — logs live in the receipt trie, are independently
verifiable, and cost a fraction of an `SSTORE`.

Cadence: **on change, with a daily floor**, to one chain. The publisher
runs on a schedule (every few hours), anchors when the current commitment
differs from the one it last anchored — which it already reads from the
chain for idempotency — and anchors **unconditionally when its newest
anchor is older than 24 hours**, so a live publisher over a quiet registry
still attests daily and a stale anchor still means what §8.5 #8 needs it to
mean: the publisher stopped, not the registry. Every root also published to
the NNS API and the repo.

An anchor is an event emission of roughly 30k gas — fractions of a cent on
any cheap EVM chain — so gas was never the constraint; even hourly would
cost a publisher a few dollars a year. What a fixed fast cadence actually
multiplies is **pin churn and operational noise**: each anchor obligates a
log snapshot pinned on two independent services (§8.2), and a bursty,
mostly-quiet registry makes almost all fixed-schedule anchors re-attest an
unchanged commitment. Anchoring on change spends the pins where the
attestations are, and the daily floor bounds the not-yet-anchored window at
a width that is proportionate because every prior anchor already chains the
whole history — the commitment binds the cumulative `log_hash` — and
because anchoring never gates usability (§8.7). Twenty-four hours against
`ANCHOR_STALENESS_LIMIT`'s forty-eight leaves exactly one missed floor
anchor of margin before clients warn, the same margin the hourly design
had at its scale. Per-checkpoint anchoring (120 a day) remains affordable
in gas and remains the wrong trade for the same churn reason.

### The chain is a deployment choice, not a protocol rule

**Nothing in this specification depends on which chain the anchor contract
lives on.** Chain id, contract address and RPC endpoints are client and
publisher *configuration*; the contract below is plain Solidity with no
chain-specific opcode, precompile or assumption, and deployed through
`CREATE2` with a fixed salt it takes the same address on any EVM chain.
Moving to a different chain, or anchoring to a second one in parallel, is a
deployment decision and a change to a config value — it needs **no revision
of this document**. A future reader should treat the chain named below as
current practice, not as a constant of the protocol.

**v1 launches on Polygon PoS — chain id 137, the PoS chain and not
Polygon zkEVM.** The reason is not gas and not RPC availability, both of
which several chains would satisfy. It is that Nimiq already runs its
stablecoin rails on Polygon PoS, so it is the chain the team and the
community already operate on, and the most likely first independent
publisher (§2.1's whole point) is the Nimiq team. A publisher who already
has keys, funding and monitoring on a chain is a publisher who might
actually run the cron; one who would have to stand all of that up on a
chain chosen for its RPC ecosystem probably will not. Anchoring is worth
exactly as much as the number of independent parties doing it, so the
chain should be picked to maximise that number and nothing else.

A non-EVM L2 was considered and rejected on cost, not merit: it would
replace Solidity, the toolchain, the event-signature seam and `eth_getLogs`
decoding for a contract that is one event and one function.

**What Polygon PoS does not give you, stated plainly.** It is a
**sidechain, not a rollup**. It checkpoints its state roots to Ethereum but
does **not** post its transaction data there, so an anchor recorded here is
*not* reconstructible from L1 data the way a rollup's would be: if the
Polygon validator set were to withhold or lose history, the anchors are as
available as that chain and no more. This specification does not claim
rollup-grade data availability for them, and no client should be written as
though it had it.

Three things bound what that costs:

1. **The anchor is one tier of three, not the root of trust.** §8.4's Tier 1
   is replaying the log and deriving the root yourself, which needs no
   Ethereum access at all; §8.2's IPFS publication makes the evidence for
   that replay available independently of both the operator and the anchor
   chain. The anchor adds a timestamped third-party attestation on top. It
   is the tier that degrades most gracefully, because losing it costs
   *notarisation*, not verifiability.
2. **Its failure mode is loud.** A client that cannot read anchors reports
   the fact (§8.5 #8) rather than silently resolving unverified.
3. **It is one config value away from a different chain**, per the
   subsection above — including anchoring to Ethereum L1 as well, should
   the registry's value ever justify the gas.

Monthly anchoring to Ethereum L1 was specified through r17 and is
**dropped**. Its purpose was availability that did not depend on an L2, and
it does not survive contact with the reasoning above: a second chain doubles
what every independent publisher must fund, key and monitor, which is a
direct tax on the one number that makes anchoring worth anything. Paying it
to soften a data-availability property this section now declines to claim is
the wrong trade at launch. Nothing prevents adding it later; per the
subsection above, doing so is a deployment decision.

**Anchoring is permissionless.** `anchor()` has no access control: any
address may call it, and every independent indexer is encouraged to publish
its own root for the same Nimiq height. The contract records who called by
emitting `msg.sender` as the `publisher` field, and **that is the only thing
it does about identity** — it does not decide who counts. There is no
publisher registry, no `onlyPublisher` modifier, and consequently no owner,
no admin function, and no upgrade path: the contract is a deployed
append-only event emitter with a single external function.

**Who counts is decided entirely on the client.** `ANCHOR_PUBLISHERS` is a
**client-side list**, not a protocol constant and not contract state —
shipped with `packages/resolver` and extended as independent indexers come
online. A client fetches the anchors for a root, keeps the ones whose
`publisher` is on its list, and requires at least `ANCHOR_QUORUM` distinct
survivors (§8.5 #1). An anchor from an address the client does not know is
not invalid; it is simply not counted.

Why the allowlist is not in the contract, given §2. The trust signal is that
**independent parties agree** (§2.1) — a single publisher's anchor proves
only that they said it. A contract-level allowlist would put the operator in
charge of who is allowed to be one of those parties, which converts "several
independent parties agree" into "several parties the operator admitted
agree", and an operator who can exclude a dissenting publisher can silence
exactly the disagreement anchoring exists to expose. Nothing is gained in
exchange: the same operator ships the client, so an on-chain allowlist would
not even reduce the client-delivery exposure §2.2 already bounds — it would
add a second lever to the same hand. Between two lists controlled by the
operator, the honest choice is the one that is visibly a client-side default
the user's client can override, not one that looks like a protocol rule.

**Spam is a client-side non-problem, which is what the indexed fields are
for.** A permissionless `anchor()` lets anyone emit anything, so the event
must be cheap to filter without trusting the emitter. `root` and `publisher`
are both `indexed`: the client's primary query is "anchors for *this* root",
a topic filter that a junk root never appears in, and the secondary filter is
by publisher address, also a topic. Garbage anchors therefore cost a client
no bandwidth and no parsing — only the spammer's gas. `nimiqHeight` stays
unindexed deliberately: the client already knows which height it is asking
about and MUST check the field against it, so indexing it would spend the
third topic on a query nobody makes.

Because each publisher anchors its **own** log digest as well as its own
root, two publishers that disagree have both published the evidence for
their disagreement. Anyone can fetch both logs and diff them, turning
"someone deviated" into "here is the transaction they handled differently" —
without either party's cooperation.

The reference publisher key SHOULD be a multisig, and handing a signer to
the Nimiq team or another ecosystem party is the cheapest available
reduction in operator trust: it removes the project's ability to anchor
unilaterally. Note that this is now a statement about one entry in
`ANCHOR_PUBLISHERS`, not about privileged access — under a permissionless
contract the reference publisher has no power another publisher lacks.

Nimiq Pay injects `window.ethereum`. The earlier enumeration here — mainnet,
Base, Arbitrum, Optimism, BNB Chain, Sepolia — was a snapshot and is
**withdrawn**; per Nimiq's developer documentation the reachable set is not
a fixed list but whatever their RPC provider supports, extensible without a
client change, and it explicitly includes **Polygon PoS** (where their own
USDT rails run). Anchors on the chain named above are therefore readable
through the injected provider with no extra setup. Do not re-add a list
here: it will be stale again, and §9 does not depend on one. Note that
Nimiq Pay mediates only wallet requests; other RPC calls go to the host's
configured endpoint. Because that endpoint is chosen by the host rather than the
client, the app MUST cross-check the `Anchored` event against at least one
independent public JSON-RPC endpoint over plain `fetch` and require
agreement, so no single provider can feed a client a false anchor.

Each anchor MUST carry the Nimiq height it corresponds to. Without it the root
is unverifiable, because nobody can know which history to replay.

---

## 10. Economics

### 10.1 Pricing — two bands

| Length | Fee | Rationale |
|---|---|---|
| 1–4 | reserved | Auctioned later under a v2 spec |
| 5–11 | `FEE_STANDARD` — 2,000 NIM (~$1) | The desirable range |
| 12+ | `FEE_LONG` — 400 NIM (~$0.20) | Effectively free to a user; still bounds the log |

**Why not free.** Nobody squats 12-character names, so the usual objection
does not apply. The real risk is state bloat: Nimiq transactions cost almost
nothing, so free registration lets an attacker inflate the log and the Merkle
tree until Tier 1 verification is impractical (§8.2). The fee floor is what
makes the verification artifact bounded. Client-side rate limiting cannot
substitute — an independent indexer could not validate it, so it cannot be a
protocol rule.

**Why $0.20 rather than $0.05.** Price is the lever that actually bounds
bloat: at $0.20, $10,000 of attack buys 50,000 junk names (~7 MB of log)
instead of 200,000 (~28 MB). It remains trivial for a real user.

**Why the threshold stays at 12 rather than moving to 14.** Raising the
threshold does not bound bloat at all — an attacker simply uses longer names.
It only moves 12–13 character names into the premium band, and almost nothing
anyone actually wants lives there; desirable names are short. The change would
add friction for legitimate long-name users while capturing little revenue.
Price is the effective lever; the threshold is not.

Note also that delegated subdomains (§8.6) removed the strongest argument for
an ultra-cheap band: an exchange needs one standard-band name, not thousands
of cheap ones.

Both bands are governable (§10.6), so neither figure is a one-way door.

### 10.2 Where fees go, and the burn share

All fees to `TREASURY_ADDRESS`. **20% is forwarded to `BURN_ADDRESS`.**

Because signalling messages go to `PROTOCOL_ADDRESS` instead (§5.3), the
treasury's balance *is* its revenue — the burn base needs no adjustment and
no dust subtraction, which is what makes burned-versus-owed checkable from
the outside.

`PROTOCOL_ADDRESS` receives only `DUST_VALUE`, so nothing accumulates there
worth sweeping. If §16's signalling fee is ever adopted, that changes and the
inflows burn in full.

The burn base is *all* revenue reaching the treasury — registrations,
renewals, listing fees, and marketplace commission (§6 `M`). One rule, one
number, no carve-outs to explain or to audit around.

A transaction has one recipient, so the split cannot happen inside the
registration. The operator periodically forwards the burn share, tagging each
transfer with `F` so it enters the log.

This makes the commitment **auditable rather than promised**: fees received
and NIM burned are both computable from the log and verifiable on-chain, so
the dashboard can show *burned vs. owed* and any shortfall is publicly and
permanently visible. There are no smart contracts, so it remains a policy —
but a policy whose violation is impossible to hide.

Routing fees to a treasury does not weaken the trust model. The security risk
in NNS is the indexer, which is why §8 exists. The fee destination grants no
additional power over resolution.

Nimiq has no native burn operation; `NQ07 0000 0000 0000 0000 0000 0000 0000
0000` is a valid address whose private key is unknown and unobtainable, used
by the team at mainnet launch. Coins sent there remain in the ledger as an
unspendable balance rather than being subtracted from supply.

### 10.3 Revenue lines beyond registration

- Listing fee on `O`
- **Marketplace commission** — `COMMISSION_RATE` on every settled sale
  (§6 `M`), governable and bounded. Escrow made this trivial to implement:
  the funds already pass through `MARKETPLACE_ADDRESS`, so the cut is a
  subtraction rather than a second transaction anyone has to be persuaded
  to send
- Auctions for withheld 1–4 character names
- **Partner integrations.** Exchanges want `binance`, `kraken`, and the like —
  all on the reserved list. Selling or licensing those, bundled with delegated
  subdomain support, is the clearest enterprise line and the strongest
  distribution channel the project has.
- Hosted resolver API with an SLA. Self-hosting stays free and open — that is
  the trust guarantee — while the managed service is the commercial product.

### 10.4 Term length

**One year, renewable**, with a 30-day `GRACE_PERIOD` after it.

**The term is chosen so the mechanism runs.** Expiry, grace, the fall to
`AVAILABLE` and re-registration are consensus rules that no amount of testing
exercises the way real traffic does, and at a five-year term nothing would
have expired until 2031 — the paths would sit unexercised through the whole
formative period, on a design that is frozen long before that. A one-year term
puts every one of them in front of real owners inside the first year, while the
registry is still small enough to act on what they turn up. `GRACE_PERIOD` is
paired to it: 30 days is a window to notice a missed renewal in, not a second
term.

The indexer cost of expiry is negligible either way: one field per name already
inside the Merkle leaf, the `N` handler, and the `GRACE` check. The expensive
part of renewals is entirely user-facing — reminders, expiry UI, support — and
a one-year term does not defer it. **Renewal has one year of runway, not five:
`N` must be reachable in the client, and the reminder below must fire, before
the first cohort registered at launch comes due.**

**One client requirement is not deferrable at all.** Silent expiry is the most
common failure in naming systems, and a year is long enough to forget in.
Clients MUST surface an approaching expiry in-app, prominently, from
`GRACE_PERIOD` × 2 — 60 days — before the date. It is a client requirement
rather than a protocol rule: no indexer validates it, and nothing in consensus
depends on it.

The reason not to remove expiry outright is that it is a one-way door. Expiry
cannot be added later to names sold as permanent without breaking a promise,
whereas a renewable term can always be made effectively permanent by pricing
renewal near zero. There is also a slow structural cost to permanence: names
behind lost keys never return, so the namespace only degrades.

### 10.5 Payment exactness

A fee-bearing message succeeds iff `value ≥ fee` at that transaction's block
height. There is no credit ledger and no partial payment: the arithmetic is
a comparison, and the whole of it lives in §7.4's two columns.

**Overpayment on a successful message is forfeited.** A correct client sends
the exact fee — the price in effect is published and provable (§10.6) — so
overpaying is client-preventable, and the forfeit column is where
client-preventable losses go. Refunding it instead would mean a settlement
transaction costing more attention than the few luna involved.

### 10.6 Governance

Prices must be changeable after launch — a fee fixed in NIM drifts with the
NIM/USD rate, and a registry priced at $20 or $0.05 is broken either way. The
commission rate travels with them: it is a percentage, so it does not drift
with the NIM price, but it does need to respond to what the market will bear.

**The mechanism is the `P` message, not a config file.** Every parameter that
can change must live on-chain, or independent indexers diverge the moment one
operator edits their deployment. Registrations are validated against the
prices in effect at their own block height, so a change never invalidates
anything in flight.

**Bounds, enforced independently by every indexer:**

| Bound | Value |
|---|---|
| Sender | must be `ADMIN_ADDRESS` |
| Either price | within `PRICE_FLOOR` … `PRICE_CEILING` |
| Ordering | `fee_long` MUST be ≤ `fee_standard` |
| Commission | 0 … `COMMISSION_CEILING` (10%), moving at most `COMMISSION_MAX_STEP` (250 bp) per adjustment |
| Notice | `effective_height` ≥ **the height of the block the `P` lands in** + `GOVERNANCE_DELAY` (§6 `P`) |

**There is no rate limit, and that is deliberate.** Earlier revisions bounded
each `P` to `PRICE_MAX_FACTOR` (2×) per adjustment and one accepted `P` per
`PRICE_MIN_INTERVAL` (~7 d). Both are removed. A rate limit here has to satisfy
two requirements at once and cannot: **loose enough not to obstruct legitimate
repricing** — NIM can move an order of magnitude in a quarter, and a registry
that cannot follow it is priced at $20 or $0.05 for the months the limit takes
to unwind — **and tight enough to stop an attacker**, who simply walks the
price down one permitted step at a time and arrives at the same place a few
weeks later. There is no setting that both protects and permits, so the honest
move is to stop pretending the limit is a defence and delete it.

**What protects is the notice window.** A `P` cannot take effect for
`GOVERNANCE_DELAY` (~24 h, doubled from ~12 h when the rate limits went), and
in that window it is a public on-chain fact that every indexer, resolver and
integrator can see. The response to a hostile `P` is not a bound that softens
it; it is a **fork** — a spec revision, from a stated height, that ignores the
rogue key. That is the same remedy the rest of §10.6 already relies on, and it
is the only one available: `PROTOCOL_ADDRESS` and `ADMIN_ADDRESS` are §3
constants and cannot be rotated in-band, so a compromised admin key is not a
key the protocol can retire — it is a key the network has to route around. The
rate limits bought hours of delay in front of a remedy that takes days to
coordinate either way; the notice window is the part that was doing the work.

**Why ENS does not have this problem.** ENS prices in USD and reads the rate
from an oracle, so its registration fee follows the market without anyone
sending a governance transaction at all, and the powers that *are* governed can
be timelocked and multisig'd on-chain. Neither half is available here: NNS has
**no smart contracts** (§1), so there is no oracle to read, no timelock
contract to enforce a delay, and no multisig to spread the key — a price is
whatever the last valid `P` said, and a `P` is one signature from one address.
The design that removes the need for a rate limit is a design this chain
cannot host, and a weak imitation of it is worse than its absence, because it
is quoted as a protection in threat models.

**`PRICE_FLOOR` and `PRICE_CEILING` stay, as fat-finger rails.** They catch a
misplaced decimal in a legitimate `P` — the failure that is actually likely,
and unretractable once mined (§6 `P`) — and they keep the parameter space
inside the range the rest of this document reasons about. They are not offered
as attack protection: an attacker holding the admin key sets the price to the
floor in one message, and the floor being 1 NIM rather than 0 changes nothing
about the response.

The `U` award (§6) is the other thing a stolen key reaches, and the same
argument covers it. It can hand out reserved names, one at a time, each
announced `GOVERNANCE_DELAY` blocks before it takes effect and each rejected
outright by the same fork; it cannot award to itself, and it cannot touch a
name that has an owner. The reserved list is a finite asset the key can start
spending in public, not a lever on the registry.

**The bounds themselves are spec constants, not governable.** If NIM's price
regime shifts so far that even the floor or ceiling is wrong — a sustained
100× move — the remedy is a spec revision changing the constant from a
stated height, coordinated like any other out-of-scope change. NNS is an
interpretation layer: parameter obsolescence is recoverable by coordination.
Pretending the constants must survive every future would only stretch
governance into something slower and more dangerous than a visible,
versioned edit.

**In scope:** `FEE_STANDARD`, `FEE_LONG`, and `COMMISSION_RATE` (via `P`),
and *releasing* names from `RESERVED_NAMES` — or *awarding* one directly to a
named address, which is the same `U` under a different recipient (§6 `U`),
under the same `GOVERNANCE_DELAY` notice.

**Out of scope — requires a new spec version applying from a stated height:**
name validity rules (§4), `LONG_NAME_LEN`, ordering, expiry semantics,
`TERM_LENGTH`, `BURN_SHARE`, `LISTING_FEE` — no `P` field carries it, which
is why §12 item 3 settled it at 0 rather than inventing one — anything
touching the ownership of a name that *has* an owner, and *adding* to
`RESERVED_NAMES`.

The ownership line is worth stating precisely, because the `U` award crosses
part of it. Governance can give away a name in `RESERVED_NAMES`, which by
construction nobody owns; it can never move, revoke, shorten, or expire a name
somebody holds. An award is the namespace's reserve being spent, not a
registry entry being rewritten, and every one of them is public
`GOVERNANCE_DELAY` blocks before it binds.
Changing validity or the length threshold retroactively would reprice or
invalidate names people already paid for. A commission change binds at the
`B`'s block height, so a seller's open offer can be settled at a rate they
did not see when they listed — bounded by the 250 bp step, and the reason
the step exists.

`TREASURY_ADDRESS` is spent from in normal operation — the burn share (§10.2)
and, since credits were removed, registration refunds via `M` (§6). It is
therefore a working address with a hot key held by the settlement service,
not a cold vault. Keep only an operational balance there and sweep the rest
to cold storage on a schedule; the log makes any shortfall visible either
way (§7.4).

`PROTOCOL_ADDRESS` holds only dust and is never spent from in normal
operation, but its key is **generated and retained in cold storage**, never
imported into a node. Two reasons, neither about the dust: explorers
generally require a signature from an address before attaching a label to it,
so the key is what makes the *NNS Protocol* tag claimable; and over enough
years somebody — a user pasting the wrong address, a misconfigured
integrator — will send real funds there, and returning them requires the key.
Discarding it would buy provable unspendability, except that it is not
provable: "we destroyed the key" is an assertion with exactly the credibility
of "we never spend it".

`ADMIN_ADDRESS` MUST be distinct from `TREASURY_ADDRESS` and held on a cold
key. **OPEN:** admin key rotation — deferred to v2.

---

### 10.7 Ecosystem payouts — deliberately not protocol rules

Two payouts exist, and neither is a consensus rule. Both are computable from
the log, so they are auditable in the same way as the burn share, but an
indexer never validates them and a missed payout can never invalidate a
registration.

**Integrator share.** A percentage of the registration fee attributable to
a `ref` (§6 `G`), paid to the application that drove it. This is the one
place where a usage-based share is the right instrument: it rewards
distribution, which is exactly what an integrating app provides.

The obvious abuse is self-referral — an operator registering junk names
under its own `ref` to buy them at a discount, which erodes the price floor
that bounds the log (§8.2). Mitigations are policy, not protocol: `ref` ids
are issued on application, the share is paid in arrears against reviewed
totals, and the rate is set below the level at which farming beats simply
not registering. **OPEN:** the rate.

**Independent-publisher stipend.** A per-checkpoint payment to operators who
anchor a root matching consensus (§9). The qualifying condition is
self-proving — the root either matches or it does not, and the publication
is on-chain.

Note what this is *not* paying for. Anchoring is an event emission of
roughly 30k gas; on the §9 anchor chain even an hourly cadence would cost a
few dollars a year, and §9's on-change cadence costs less. The cost being
recognised is **operational attention** — running,
monitoring and updating a service — not gas. Cost recovery would be
rounding error, so the stipend should be sized as recognition, alongside
the non-cash incentives in §15 that do most of the work.

The honest weakness: paying for *agreement* invites free-riding, since an
operator can mirror the published root without replaying anything and still
qualify. There is no clean cryptographic fix. The practical mitigation is
that **the stipend is paid to a roster of known parties** — the Nimiq team,
validators, exchanges — whose reputation is the stake, and admission to that
roster is by application and review.

That roster is a **treasury programme, not a contract permission**, and the
distinction is load-bearing. §9's `anchor()` is permissionless: anyone may
publish a root, nobody needs admission to do it, and a client's
`ANCHOR_PUBLISHERS` list decides whose anchors it counts. Being paid is a
third thing again, decided by whoever holds the treasury. Enforcing the
anti-free-riding rule in Solidity would have meant an on-chain allowlist,
which buys nothing here — a mirroring free-rider is a *known party* by
construction, so an allowlist never excluded them anyway — while costing the
property §9 depends on, that no one party controls who is allowed to
disagree. Paying an unwanted publisher nothing is a decision the treasury can
take unilaterally at any time; excluding them from the contract is not, and
should not be. **OPEN:** the stipend amount, and whether it should exist at
all in v1.

---

## 11. Node and operational requirements

### 11.1 What the indexer needs

| Task | Node required |
|---|---|
| Steady-state tailing | Normal (pruning) node — only the latest batch is read |
| Bootstrap replay | History node, **no transaction index needed** |
| Rebuilding lost state | History node |
| Tier 3 verification | History node |

~1TB of history suffices; the ~2TB indexed configuration is not required.

### 11.2 Do not co-locate with a validator

An indexing bootstrap is I/O-heavy, and disk contention on a validator host
risks delayed block production — penalties, deactivation, lost rewards. Run
the history node on separate hardware. It needs no public reachability.

### 11.3 Start the history sync early

Sync time grows with chain length. Begin before writing indexer code.

### 11.4 Public fallback

`rpc.nimiqwatch.com` is a free rate-limited public Nimiq RPC endpoint —
default for Tier 2 spot-checks, for tutorial readers without a node, and a
fallback for the mini app.

### 11.5 Sending addresses MUST be balance-checked and alerted on

An address that cannot cover `value` + `fee` fails by silence, not by error
(§5.3). Two of NNS's own addresses sign transactions and have **no income at
all**:

| Address | Sends | Income |
|---|---|---|
| `MARKETPLACE_ADDRESS` | `M` settlements and refunds (§6 `M`) | Buyer value in, but a `B` it must refund arrives *with* its own value — a run of forfeits does not fund it |
| `ADMIN_ADDRESS` | `P`, `U` (§6) | None. Dust from `S`/`X`/`R` that happen to name it, and nothing else |

For both, an operator MUST:

1. **Precheck the balance before signing.** Read the sender's balance and
   compare it against `value` + `fee`; refuse to broadcast rather than emit a
   transaction that will be dropped.
2. **Alert on a threshold well above zero**, sized so that topping up is
   routine rather than an incident. Alerting at zero alerts after the failure.

`TREASURY_ADDRESS` also spends — the burn share (§10.2) and registration
refunds — but it takes fee income continuously, so it fails differently and
§10.6 already asks that only an operational balance be kept there. It belongs
under the same monitoring regardless.

This is an operational requirement, not a consensus rule: an undelivered `M`
leaves the obligation standing in the log (§6 `M`), which is exactly how a
shortfall is meant to stay visible. The point of the alert is that the log
records the debt whether or not anyone is watching.

---

## 12. Open questions

Resolved by inspecting `@nimiq/mini-app-sdk@0.1.0`:

- `sendBasicTransactionWithData({ recipient, value, fee?, data,
  validityStartHeight? })` exists. The design is implementable as a mini app.
- `data` is typed `string`, confirming text-safe encoding throughout.
- No `sender` parameter — no longer a hazard now that commit–reveal is gone.

**Nothing blocks the format freeze any more.** The two questions that did —
whether `data` is UTF-8 or hex, and whether `value: 0` is accepted — were
answered empirically on mainnet in r13 (§5.1, §5.4). The wire format can be
frozen once `RESERVED_NAMES` and the addresses below are fixed.

Decisions pending:

1. `LAUNCH_HEIGHT`, `TREASURY_ADDRESS`, `PROTOCOL_ADDRESS`, `ADMIN_ADDRESS`,
   `MARKETPLACE_ADDRESS`
2. `RESERVED_NAMES` contents — the highest-value item on this list (§4.1).
   **Partly answered in r19**: the published half exists and is a §3 constant,
   but it is not complete, and completing it blocks launch exactly as the five
   values above do. Additions are free until `LAUNCH_HEIGHT` and out of
   governance scope afterwards (§10.6), so this is the last moment they cost
   nothing
3. ~~Listing fee structure for `O`~~ — **settled in r19**, by taking this
   item's second option: dropped, `LISTING_FEE` = 0. Commission captures
   marketplace value at the point of sale (§10.3), and folding a fourth field
   into `P` would have bought the smallest revenue line a governance
   mechanism, new §10.6 bounds, and a wire change
4. Whether signed delegate responses (format already fixed, §8.6, §16.5)
   should ever become REQUIRED rather than optional
5. Whether the Mopsus "name your address by burning 1 Luna" feature from the
   PoW chain still exists, and whether to acknowledge it as prior art
6. **Two mini-app SDK questions, testable with the SDK probe already
   built:** can a mini app set the transaction **value** (every fee-bearing
   message depends on it), and does a mini-app-supplied **fee** survive to
   signing (decides whether §16.2's fee-gate is viable)? The provider's
   `sendBasicTransaction` takes a `fee` parameter, but the native Nimiq Pay
   UI sets the fee to 0 and does not let a user edit it (Nimiq team,
   2026-08-13) — one send test once consensus returns settles it. Plus, for
   the Nimiq team: can the
   framework pin a build by **content hash** rather than a live URL (§2.2,
   mitigation 3) — the only thing that would narrow the client-delivery
   hole without wallet-native resolution
7. Integrator share rate and `ref` issuance process (§10.7)
8. Whether the publisher stipend exists in v1 at all (§10.7)
9. Whether a Nimiq-side log attestation message (an `L` type carrying the
   CID digest) is worth adding, giving a verification path that never
   touches an EVM chain. It duplicates what the anchor already carries, and
   §1's simplicity principle argues against a message type that buys nothing
   new — but it would make the log addressable to a client with no EVM
   access at all
10. What the client does at launch, when `RESOLVER_QUORUM` independent
    resolvers do not yet exist. Options: ship with quorum 1 and a visible
    *unverified — single resolver* banner until a second operator appears,
    or run a second resolver on separate infrastructure as an interim
    (weaker: same party, but survives a single-host compromise)

(Resolved in r6: the `0`/`1` boundary clause was adopted, and the
recovery-address mechanism became the `R` message — **undone in r20, which
removed both**. Resolved in r7: buyer
races are refunded through `MARKETPLACE_ADDRESS` rather than forfeited, and
`CANCEL_DELAY` was removed along with the problem it patched. Resolved in
r8: the marketplace takes a governable commission, carried on-chain by `P`.
Resolved in r13, by mainnet measurement: `data` is hex over RPC, the 64-byte
cap is real, `value: 0` is rejected. Resolved in r14: credits replaced by
treasury refunds via `M`; anti-spam machinery deferred whole to §16.)

**Pin the SDK version.** `@nimiq/mini-app-sdk` is at 0.1.0 with three
published versions. Signatures may shift during the competition.

---

## 13. Build order

Cycle II runs 10 Aug – 4 Sep 2026, and the rules require something fully
functional on first use, not a prototype.

0. **Encoding test and indexer-node sync — both done** (r13; §5.1, §11)
1. `G` and resolve
2. `S` and `X` with the transfer timelock
3. NNS log, Merkle roots, proofs, non-inclusion; `P` and `F` alongside
4. Mini app UI: register, resolve, send-by-name
5. `D` and delegated resolution, with the verified/delegated UI distinction
6. Run-your-own-indexer tutorial, both paths
7. EVM anchoring
8. Marketplace (`O` + `B` + the `M` settlement service)

Step 5 is small in code and large in pitch — it is the piece that makes the
exchange story real, so it should not be cut before step 7 or 8.

---

## 14. Deliverables

- This spec, versioned in the repo
- `RESERVED_NAMES`, taken seriously (§4.1)
- Indexer — MIT, Dockerised, single command:
  `docker run -e NIMIQ_RPC=... nns/indexer`
- Published NNS log and checkpoint roots, pinned on IPFS and addressed
  from every anchor
- **Conformance test vectors**, shipped with the reference implementation and
  runnable against any independent one. The three areas where implementations
  fork silently rather than loudly: the Merkle leaf byte layout (§8.1),
  canonical ordering across a multi-transaction block (§5.2), and name
  validation including the positional-digit and boundary rules (§4.2). Named
  cases include `failed_G_does_not_register_name` — a `G` with
  `executionResult: false` must leave the name `AVAILABLE` (§7.5)
- Burn and settlement dashboard: burned vs. owed (§10.2) and marketplace
  settled vs. owed (§6 `M`)
- Settlement service — watches `B` and `G` verdicts in the log and issues
  `M` payouts, commission forwards, and refunds past finality, from the
  marketplace and treasury addresses respectively
- Resolver API serving proofs
- Mini app
- Integrator guide: the resolver package, `ref` registration, and the
  §2.2 argument for why an app should ship its own client rather than
  iframe someone else's
- **Delegate resolver reference implementation** — a ~100-line service an
  exchange can deploy to answer `/nns/v1/resolve/<label>`, plus a one-page
  integration guide. This is what turns the exchange story from a claim into
  something a partner can adopt in an afternoon.
- **Run-your-own-indexer tutorial, two paths:**
  - *You already run a node* — point at your RPC, five minutes, full Tier 3 replay
  - *You don't* — download the log, replay, compare to the anchor, spot-check
    entries against the public endpoint
- README threat model (§2 verbatim), naming the operator risk and the accepted
  front-running trade openly
- Resolver npm package — ~50 lines plus the rendering CSS from §4.3,
  shipping the default resolver and anchor-publisher lists and enforcing
  the §8.5 quorum by default
- Anchoring contract (optional)

---

## 15. Positioning

The registry is MIT by competition rule, so it is forkable. The defence is not
secrecy:

- A **free** registry is a broken registry — and now there is a sharper
  version of the argument: free registration destroys the verifiability that
  makes the registry trustworthy at all (§8.2). Cheap is a feature; free is a
  vulnerability.
- Value lives in **resolution, not registration**. A rival namespace nothing
  resolves is an inert database.
- Every mini app that adopts the resolver package raises the switching cost.
  Shipping the package to other Cycle II entrants is the highest-leverage
  defensive move available.
- **Every exchange that delegates a subdomain is a lock-in point.** Once
  `user.exchange` addresses are in circulation, a fork starts from zero.
- Gifting names to ecosystem figures populates the namespace with exactly the
  entries that make a fork look empty.

### Recruiting independent indexers

Capability is solved — validators and the Nimiq team already run history
nodes, so participation costs a container and an RPC URL. Motivation still
needs engineering:

- **A free premium name** for verified operators
- **A public list of independent indexers** with their published roots. The
  list is itself the trust artifact.
- **Something they want anyway** — pool operators can resolve names in their
  own staker dashboards off their local indexer.
- **A publisher slot.** An independent indexer that anchors its own roots
  (§9) is not just verifying the project's claims, it is a party to the
  trust guarantee — and its users get quorum without depending on us.
- **Pinning the log** (§8.2) — cheap, and it keeps Tier 1 verification
  alive independently of this project's infrastructure.

Approaching the Nimiq team early matters less for endorsement than for
intelligence: the one threat that beats distribution is an official name
service. Ask for something small and concrete — *would you run a verifying
indexer?*, or *would you hold a signer on the anchor multisig?* — rather
than a blessing. Both are cheap for them, and either one materially removes
the project from its own trust model.

---

## 16. Deferred to v2

Everything here was designed, argued through, and deliberately left out of
v1. It is recorded so the analysis survives, and so a later revision starts
from conclusions rather than from scratch. The common thread: each is a rule
that every independent implementation must match exactly, and none of them
defends against something that has happened yet.

### 16.1 Name reveal (anti-MEV registration)

§6.2 accepts front-running on the grounds that prizes are thin and Nimiq's
mempool is quiet. Both premises are contingent, and the trigger conditions
are already written there.

The intended mechanism is a soft commitment rather than full commit–reveal:
`G` carries `keccak256(name ‖ salt)`, and a second message reveals the name.
A 32-byte digest is 43 characters in base64url, so the committing message
fits the 64-byte budget comfortably. Cost: two transactions and a wait, on
the operation that most needs to feel instant — which is exactly why it is
not in v1.

### 16.2 Pricing signalling messages

`G`, `N` and `O` are priced by their own fee. `K`, `D`, `S`, `X` and `R` are
not, so a name owner can emit them repeatedly at dust cost. Three mechanisms
were considered:

- **A `SIGNAL_FEE` in `value`**, for messages addressed to
  `PROTOCOL_ADDRESS`. Works for `K`, `D`, `P` and a releasing `U`. Does
  **not** work for `S`, `X`, `R` — or, since r17, an awarding `U`: their
  recipient is the counterparty — usually the user's own other address — so
  the fee would be money moving between one person's pockets, or in the award's
  case a fee paid to the person being given a name.
- **A fee-field gate — the preferred mechanism.** Network fees go to the
  validators: pooled per batch and paid out at the next macro block (Nimiq
  team, 2026-08-13). The money leaves the system entirely, so nothing
  accumulates at `PROTOCOL_ADDRESS`, there is no periodic burn to run and no
  `F` ceremony to audit. An earlier draft called this blocked by
  size-derived fee tiers topping out around 276 luna — that was the **web
  wallet**, not Nimiq Pay. The mini-app provider's `sendBasicTransaction`
  takes a `fee` parameter, while the native Nimiq Pay UI sets the fee to 0
  and does not let a user edit it — so whether a mini-app-supplied fee
  survives to signing is the open question (§12), answerable with one send
  test once consensus returns.
- **A companion message.** `S` keeps the counterparty as recipient, and a
  second message to `PROTOCOL_ADDRESS` carries the fee plus the `S`
  transaction hash; only paired messages are logged. This is the fallback
  that prices `S` without weakening §5.3's trusted-UI property should the
  fee test fail, at the cost of two signatures per retarget and a
  pending-match set in the indexer.

The signalling fee and the companion message would both make
`PROTOCOL_ADDRESS` accumulate value, which §10.2 would then burn in full.
The fee gate is preferred precisely because it does neither: the fee is out
of the system the moment the transaction lands, with no balance anywhere
the operator has to be trusted to sweep.

### 16.3 Rate limiting and backoff

A per-name window (one logged state change per `CHECKPOINT_INTERVAL`) plus
exponential backoff — the window doubling per change within a trailing day,
resetting after a quiet one — caps a spamming name at roughly ten log lines
a day. Rejected for v1 because it adds a committed per-name counter to
consensus state, and because pricing is strictly better than delay: it never
makes an honest user wait.

**The residual v1 carries**, stated plainly: spam capacity scales with names
owned, each costing a registration fee. Roughly $200 of names sustains about
6.5 GB of log growth a year. It is bounded, paid, and obvious in the log —
and §10.6 can raise `FEE_LONG` within a week, multiplying attacker cost while
barely touching real users. No permissionless append-only log closes this;
anyone may pay to write.

### 16.4 Log compaction

§8.8 segments the log without ever deleting from it. If compaction is added,
one rule keeps it safe: a line may be omitted only when its verdict is
terminal *and* any obligation it created is discharged — a `REFUND` line
stays until its `M` exists — and the uncompacted segment keeps its own CID so
the compaction itself remains checkable.

Note that deleting *invalid* messages, the intuitive move, is the wrong one
twice over: the spam that matters is valid, and rejection lines are what let
an independent replay confirm a rejection was correct rather than infer it
from an absence (§7.4).

### 16.5 Signed delegate responses

The format is already fixed in §8.6 so delegates can opt in without a spec
revision. v1 requires neither producing nor verifying it.

### 16.6 Richer records

Avatars, text records, Nostr keys and similar belong at the delegate
resolver (§8.6), not in transaction data. The 64-byte budget is not the
constraint people assume it is: the owner designates a host, and the host
serves whatever it likes. What v2 would add is a *convention* for those
records, so clients agree on their shape — not new on-chain state.
