# Constants

Every honest implementation on the same network agrees on these. None is configuration. Every figure here is read from the reference implementation at build time.

## Names

| Constant | Value | Meaning |
|---|---|---|
| `MIN_NAME_LEN` | {{n:MIN_NAME_LEN}} | Shorter names are reserved |
| `MAX_NAME_LEN` | {{n:MAX_NAME_LEN}} | Longest registrable name |
| `MAX_LABEL_LEN` | {{n:MAX_LABEL_LEN}} | Longest subdomain label |
| `MAX_HOST_LEN` | {{n:MAX_HOST_LEN}} | Longest subdomain host (name and host together ≤ 52) |
| `MAX_REF_LEN` | {{n:MAX_REF_LEN}} | Longest referrer on a registration |

## Prices and money

| Constant | Value | Meaning | Governable |
|---|---|---|---|
| `FEE_BASE` | {{nim:FEE_BASE}} | A year for {{n:LONG_BAND_FROM}}+ characters. Shorter names pay a multiple. Also the floor for sales and auctions | yes |
| `FEE_MULTIPLIERS` | Below | The multiple of `FEE_BASE` each length pays | no |
| `LIFETIME_MULTIPLIER` | {{n:LIFETIME_MULTIPLIER}} | A lifetime costs this many yearly fees | no |
| `LIFETIME_TERMS` | {{n:LIFETIME_TERMS}} | The years a lifetime buys | no |
| `PRICE_FLOOR` | {{nim:PRICE_FLOOR}} | Lowest the base can be set to | bound |
| `PRICE_CEILING` | {{nim:PRICE_CEILING}} | Highest the base can be set to | bound |
| `COMMISSION_RATE` | {{pct:COMMISSION_RATE}} | Deducted from a marketplace seller's proceeds | yes |
| `COMMISSION_CEILING` | {{pct:COMMISSION_CEILING}} | Highest the commission can be set to | bound |
| `COMMISSION_MAX_STEP` | {{pct:COMMISSION_MAX_STEP}} | Largest change per adjustment | bound |
| `BURN_SHARE_BP` | {{pct:BURN_SHARE_BP}} | Share of registry revenue burned | no |
| `LISTING_FEE` | {{nim:LISTING_FEE}} | Cost of putting a name up for sale | no |
| `DUST_VALUE` | 1 luna | Value on every message that carries no fee | no |
| `REFUND_FLOOR` | {{nim:REFUND_FLOOR}} | Below this, a refundable amount is kept | no |

`FEE_MULTIPLIERS` in full, at today's base:

{{fees:table}}

## Time

Blocks, at roughly one per second.

| Constant | Blocks | About | Meaning |
|---|---|---|---|
| `TERM_LENGTH` | {{blocks:TERM_LENGTH}} | {{dur:TERM_LENGTH}} | A registration term |
| `GRACE_PERIOD` | {{blocks:GRACE_PERIOD}} | {{dur:GRACE_PERIOD}} | After expiry: renewable, not resolving, not registrable |
| `XFER_TIMELOCK` | {{blocks:XFER_TIMELOCK}} | {{dur:XFER_TIMELOCK}} | A transfer waits this long and can be cancelled meanwhile |
| `OFFER_MAX_LIFETIME` | {{blocks:OFFER_MAX_LIFETIME}} | {{dur:OFFER_MAX_LIFETIME}} | Then the sale expires by itself |
| `AUCTION_MIN_DURATION` | {{blocks:AUCTION_MIN_DURATION}} | {{dur:AUCTION_MIN_DURATION}} | Shortest auction |
| `AUCTION_EXTENSION` | {{blocks:AUCTION_EXTENSION}} | {{dur:AUCTION_EXTENSION}} | A late bid moves the end to at least this far out |
| `AUCTION_MIN_INCREMENT_BP` | n/a | {{pct:AUCTION_MIN_INCREMENT_BP}} | Minimum raise over the standing bid |
| `GOVERNANCE_DELAY` | {{blocks:GOVERNANCE_DELAY}} | {{dur:GOVERNANCE_DELAY}} | Notice before a price change takes effect |
| `CHECKPOINT_INTERVAL` | {{blocks:CHECKPOINT_INTERVAL}} | {{dur:CHECKPOINT_INTERVAL}} | A checkpoint and its proofs are cut this often |
| `SEGMENT_LENGTH` | {{blocks:SEGMENT_LENGTH}} | {{dur:SEGMENT_LENGTH}} | Log segment boundary (specified, not yet in use) |
| `ANCHOR_STALENESS_LIMIT_SEC` | n/a | {{sec:ANCHOR_STALENESS_LIMIT_SEC}} | An older anchor makes the client say "couldn't confirm a recent anchor" |

## Verification

| Constant | Value | Meaning |
|---|---|---|
| `RESOLVER_QUORUM` | {{n:RESOLVER_QUORUM}} | Independent resolvers a client asks to agree |
| `ANCHOR_QUORUM` | {{n:ANCHOR_QUORUM}} | Independent publishers whose anchors must match |
| `LAUNCH_HEIGHT` | {{height:LAUNCH_HEIGHT}} | The block indexers start from |

## Addresses

| Constant | Address | Receives |
|---|---|---|
| `TREASURY_ADDRESS` | {{addr:TREASURY_ADDRESS}} | Registration and renewal fees, sale listings, marketplace commission |
| `PROTOCOL_ADDRESS` | {{addr:PROTOCOL_ADDRESS}} | Dust-only signalling: cancel, host, EVM address, auction, governance, release |
| `MARKETPLACE_ADDRESS` | {{addr:MARKETPLACE_ADDRESS}} | Purchases and bids. Pays proceeds and refunds |
| `ADMIN_ADDRESS` | {{addr:ADMIN_ADDRESS}} | Nothing. Sends governance and unreserve messages |
| `BURN_ADDRESS` | {{addr:BURN_ADDRESS}} | The burn share. Its key is unobtainable |

The 64-byte data limit is a Nimiq property, not an NNS constant.
