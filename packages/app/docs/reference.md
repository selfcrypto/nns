# Constants, messages and glossary

The lookup page. Every figure here is read from the reference implementation at build time.

## Constants

Every honest implementation on the same network agrees on these byte for byte. None is configuration.

**Names**

| Constant | Value | Meaning |
|---|---|---|
| `MIN_NAME_LEN` | {{n:MIN_NAME_LEN}} | Shorter names are reserved by rule |
| `MAX_NAME_LEN` | {{n:MAX_NAME_LEN}} | Longest registrable name |
| `MAX_LABEL_LEN` | {{n:MAX_LABEL_LEN}} | Longest subdomain label |
| `MAX_HOST_LEN` | {{n:MAX_HOST_LEN}} | Longest subdomain host (name and host together ≤ 52) |
| `MAX_REF_LEN` | {{n:MAX_REF_LEN}} | Longest referrer on a registration: a name, so it equals `MAX_NAME_LEN` |

**Prices and money.** Governable means changeable by an on-chain governance message, within the bounds shown.

| Constant | Value | Meaning | Governable |
|---|---|---|---|
| `FEE_BASE` | {{nim:FEE_BASE}} | Registration and renewal for a year, {{n:LONG_BAND_FROM}}+ characters; shorter names pay a multiple of it; also the floor for offers and auctions | yes |
| `FEE_MULTIPLIERS` | Below | The multiple of `FEE_BASE` each length pays | **no** |
| `LIFETIME_MULTIPLIER` | {{n:LIFETIME_MULTIPLIER}} | A lifetime costs this many yearly fees | **no** |
| `LIFETIME_TERMS` | {{n:LIFETIME_TERMS}} | The terms a lifetime buys | **no** |
| `PRICE_FLOOR` | {{nim:PRICE_FLOOR}} | Lowest the base can be set to | bound |
| `PRICE_CEILING` | {{nim:PRICE_CEILING}} | Highest the base can be set to | bound |
| `COMMISSION_RATE` | {{pct:COMMISSION_RATE}} | Deducted from a marketplace seller's proceeds | yes |
| `COMMISSION_CEILING` | {{pct:COMMISSION_CEILING}} | Highest the commission can be set to | bound |
| `COMMISSION_MAX_STEP` | {{pct:COMMISSION_MAX_STEP}} | Largest change per adjustment | bound |
| `BURN_SHARE_BP` | {{pct:BURN_SHARE_BP}} | Share of registry revenue committed to be burned | **no** |
| `LISTING_FEE` | {{nim:LISTING_FEE}} | Cost of listing a name for sale | no |
| `DUST_VALUE` | 1 luna | Value on every message that carries no fee (zero is rejected by the network) | no |
| `REFUND_FLOOR` | {{nim:REFUND_FLOOR}} | Below this, a refundable amount is kept | no |

`FEE_MULTIPLIERS` in full, and the fees it makes at today's base:

{{fees:table}}

**Time.** Blocks, at roughly one per second.

| Constant | Blocks | About | Meaning |
|---|---|---|---|
| `TERM_LENGTH` | {{blocks:TERM_LENGTH}} | {{dur:TERM_LENGTH}} | A registration term |
| `GRACE_PERIOD` | {{blocks:GRACE_PERIOD}} | {{dur:GRACE_PERIOD}} | After expiry: renewable, not resolving, not registrable |
| `XFER_TIMELOCK` | {{blocks:XFER_TIMELOCK}} | {{dur:XFER_TIMELOCK}} | A transfer waits this long and can be cancelled meanwhile |
| `OFFER_IRREVOCABLE` | {{blocks:OFFER_IRREVOCABLE}} | {{dur:OFFER_IRREVOCABLE}} | A seller cannot cancel a new offer before this |
| `OFFER_MAX_LIFETIME` | {{blocks:OFFER_MAX_LIFETIME}} | {{dur:OFFER_MAX_LIFETIME}} | Then the offer expires by itself |
| `AUCTION_MIN_DURATION` | {{blocks:AUCTION_MIN_DURATION}} | {{dur:AUCTION_MIN_DURATION}} | Shortest auction |
| `AUCTION_EXTENSION` | {{blocks:AUCTION_EXTENSION}} | {{dur:AUCTION_EXTENSION}} | A late bid moves the end to at least this far out |
| `AUCTION_MIN_INCREMENT_BP` | n/a | {{pct:AUCTION_MIN_INCREMENT_BP}} | Minimum raise over the standing bid |
| `GOVERNANCE_DELAY` | {{blocks:GOVERNANCE_DELAY}} | {{dur:GOVERNANCE_DELAY}} | Notice before a price change takes effect |
| `CHECKPOINT_INTERVAL` | {{blocks:CHECKPOINT_INTERVAL}} | {{dur:CHECKPOINT_INTERVAL}} | A checkpoint and its proofs are cut this often |
| `SEGMENT_LENGTH` | {{blocks:SEGMENT_LENGTH}} | {{dur:SEGMENT_LENGTH}} | Log segment boundary (specified, not yet in use) |
| `ANCHOR_STALENESS_LIMIT_SEC` | n/a | {{sec:ANCHOR_STALENESS_LIMIT_SEC}} | An older anchor makes the client say "couldn't confirm a recent anchor" |

**Verification**

| Constant | Value | Meaning |
|---|---|---|
| `RESOLVER_QUORUM` | {{n:RESOLVER_QUORUM}} | Independent resolvers a client asks to agree (the launch app overrides to 1) |
| `ANCHOR_QUORUM` | {{n:ANCHOR_QUORUM}} | Independent publishers whose anchors must match |
| `LAUNCH_HEIGHT` | {{height:LAUNCH_HEIGHT}} | The block indexers start from; nothing before it is protocol material |

**Addresses.** The four roles, plus Nimiq's burn address.

| Constant | Address | Receives |
|---|---|---|
| `TREASURY_ADDRESS` | {{addr:TREASURY_ADDRESS}} | Registration and renewal fees, offers, marketplace commission |
| `PROTOCOL_ADDRESS` | {{addr:PROTOCOL_ADDRESS}} | Dust-only signalling: cancel, host, EVM address, auction, governance, release |
| `MARKETPLACE_ADDRESS` | {{addr:MARKETPLACE_ADDRESS}} | Purchases and bids; pays proceeds and refunds |
| `ADMIN_ADDRESS` | {{addr:ADMIN_ADDRESS}} | Nothing; sends governance and unreserve messages |
| `BURN_ADDRESS` | {{addr:BURN_ADDRESS}} | The burn share; its key is unobtainable |

The wire budget is 64 bytes, a measured Nimiq property rather than a constant of NNS.

## Messages

| Letter | Message | Who sends it | Effect |
|---|---|---|---|
| `G` | Register | anyone | First valid one in block order takes the name for a term, or for a lifetime |
| `N` | Renew | anyone | Extends the expiry by a term, or by a lifetime |
| `S` | Set target | owner | Changes where the name pays |
| `E` | Set EVM address | owner | Binds one EVM address; empty clears |
| `X` | Transfer | owner | New owner after the timelock; cancellable meanwhile |
| `D` | Set subdomain host | owner | Enables `label.name` via that host; empty clears |
| `K` | Cancel | owner | Cancels a pending transfer and a cancellable offer |
| `O` | Offer | owner | Lists the name at a fixed price |
| `B` | Buy, or bid | anyone | Buys an open offer, or bids in an open auction; the state decides which |
| `A` | Auction | owner, or admin for a reserved name | Opens a timed auction |
| `M` | Settlement | marketplace or treasury | Pays a proceeds, commission or refund obligation |
| `P` | Governance | admin | Schedules a new base price and commission |
| `U` | Unreserve | admin | Releases a reserved name, or awards any name nobody holds to an address |
| `F` | Burn attestation | treasury | Records a burn-share transfer in the log |

There is no recovery message. It was removed because every version the owner key could cancel was theatre, and every version it could not outranked the owner.

## Verdicts

The 28 words that can end a log line. Two implementations that disagreed by one character would derive different checkpoints, so the vocabulary is closed.

**Accepted:** `OK`. The message took effect, whatever it did.

**Refunded.** The value is owed back:

| Token | Meaning |
|---|---|
| `LOST_REGISTRATION_RACE` | An earlier registration in block order took the name |
| `OFFER_NOT_OPEN` | No open offer or auction to buy or bid on |
| `WRONG_PRICE` | Not exactly the offer price, or a bid below the minimum |
| `INSUFFICIENT_VALUE` | Less than the fee a registration or renewal owes |

**Forfeited.** The value stays where it was sent:

| Token | Meaning |
|---|---|
| `UNKNOWN_TYPE` | `NNS1` prefix, unknown type letter |
| `OVER_LENGTH` | Over 64 bytes (unreachable on mainnet; the network drops it first) |
| `MALFORMED_PAYLOAD` | Known type, payload does not parse |
| `WRONG_RECIPIENT` | Not the address this type is routed to |
| `INVALID_RECIPIENT` | An award to the burn address |
| `WRONG_SENDER` | A settlement or burn attestation from the wrong address |
| `INVALID_NAME` | Fails a name rule |
| `RESERVED_NAME` | Currently reserved |
| `NAME_IN_GRACE` | Registration of a name in grace |
| `NAME_NOT_REGISTERED` | An owner action on a name that is absent, expired or in grace |
| `NAME_NOT_FOUND` | A cancel, renewal or auction on a name with no record |
| `NOT_OWNER` | Sender is not the owner |
| `INVALID_HOST` | A subdomain host that breaks a host rule |
| `NOT_ADMIN` | Sender is not the administrator |
| `INSUFFICIENT_NOTICE` | A governance change or auction end too soon |
| `NAME_NOT_RESERVED` | Releasing a name that is not reserved, or already released |
| `NAME_NOT_AVAILABLE` | Awarding a name somebody holds, registered or in grace |
| `GOVERNANCE_BOUND_VIOLATED` | A price or commission outside its bounds |
| `NOTHING_TO_CANCEL` | A cancel with nothing cancellable |
| `BELOW_MIN_PRICE` | An offer or starting price below the base price in effect |
| `AUCTION_OPEN` | An offer, transfer or auction while an auction runs |
| `AUCTION_BEYOND_TERM` | An owner's auction ending at or past the name's expiry |
| `BELOW_REFUND_FLOOR` | Would have been refunded, but the amount is below the floor |

## Glossary

- **Name.** A registered identifier, {{n:MIN_NAME_LEN}}–{{n:MAX_NAME_LEN}} characters, held by an owner for a term.
- **Owner.** The key that registered the name, or that it was transferred to. Can sell, renew, repoint, delegate.
- **Target.** The Nimiq address a name pays. Set by the owner; the owner's own address at registration.
- **Label** and **parent.** The two halves of `label.parent`. The parent is a name; the label is answered by the parent's host.
- **Delegate**, or **subdomain host.** A server a name's owner runs to answer for its labels. Proves nothing.
- **Resolver.** Two things, easily confused. The *server* that replays the chain and answers lookups with proofs; and the *client library* that asks several servers, checks quorum and verifies proofs.
- **Checkpoint.** A commitment to the whole registry, cut every ~{{dur:CHECKPOINT_INTERVAL}}: six components (names, prices, pending items, released reservations, the log hash, the height) under one hash.
- **Proof.** The path from a name's leaf to the checkpoint's name root, plus the leaf's fields, which the client rebuilds and recombines.
- **Quorum.** How many independent resolvers must agree before a client accepts an answer.
- **Anchor.** A checkpoint commitment posted to a contract on an EVM chain, by a publisher.
- **Log.** Every NNS transaction, accepted or refused, one line each; its hash is inside every checkpoint.
- **Pin.** The address a device remembers for a name from first use; a change stops the app before it pays.
- **Term.** The ~{{dur:TERM_LENGTH}} a registration lasts. **Grace.** The {{dur:GRACE_PERIOD}} after expiry when a name is renewable but not resolving or registrable.
- **Luna.** The smallest unit of NIM: 100,000 luna per NIM. **Dust.** One luna, the value on every message that carries no fee.
- **Canonical order.** Block number, then transaction hash. What "first" means when two messages race.
- **Forfeit** and **refund.** The two things that can happen to the value of a refused message.
