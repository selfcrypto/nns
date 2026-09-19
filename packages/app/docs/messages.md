# Messages and verdicts

The fourteen messages, and the 30 words that can end a log line. Payloads and routing are on [The wire format](wire-format).

## Messages

| Letter | Message | Who sends it | Effect |
|---|---|---|---|
| `G` | Register | anyone | First valid one in block order takes the name for a term, or for a lifetime |
| `N` | Renew | anyone | Extends the expiry by a term, or by a lifetime |
| `S` | Set target | owner | Changes where the name pays |
| `E` | Set EVM address | owner | Binds one EVM address. Empty clears |
| `X` | Transfer | owner | New owner after the timelock. Cancellable meanwhile, and a second one replaces it |
| `D` | Set subdomain host | owner | Enables `label.name` via that host. Empty clears |
| `K` | Cancel | owner | Cancels the pending transfer or sale, at any time |
| `O` | Offer | owner | Puts the name up for sale at a fixed price. A second one changes the price |
| `B` | Buy, or bid | anyone | Buys an open sale, or bids in an open auction |
| `A` | Auction | owner, or admin for a reserved name | Opens a timed auction |
| `M` | Settlement | marketplace or treasury | Pays a seller's proceeds, a refund or a referral payout |
| `P` | Governance | admin | Schedules a new base price and commission |
| `U` | Unreserve | admin | Releases a reserved name, or awards any name nobody holds |
| `F` | Burn attestation | treasury | Records a burn-share transfer in the log |

There is no recovery message. A lost owner key is a lost name.

**One pending thing per name.** A name holds at most one transfer, sale or auction at a time. A message of the same kind replaces the pending one, except a second auction. A message of another kind is refused with the token naming what is pending. To switch, cancel first. An auction cannot be cancelled.

## Verdicts

**Accepted:** `OK`. The message took effect.

**Refunded.** The value is owed back.

| Token | Meaning |
|---|---|
| `LOST_REGISTRATION_RACE` | An earlier registration in block order took the name |
| `OFFER_NOT_OPEN` | No open sale or auction to buy or bid on |
| `WRONG_PRICE` | Not exactly the sale price, or a bid below the minimum |
| `INSUFFICIENT_VALUE` | Less than the fee a registration or renewal owes |

**Forfeited.** The value stays where it was sent.

| Token | Meaning |
|---|---|
| `UNKNOWN_TYPE` | `NNS1` prefix, unknown type letter |
| `OVER_LENGTH` | Over 64 bytes (unreachable on mainnet, the network drops it first) |
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
| `NAME_NOT_RESERVED` | Releasing a name that is not reserved |
| `NAME_NOT_AVAILABLE` | Awarding a name somebody holds |
| `GOVERNANCE_BOUND_VIOLATED` | A price or commission outside its bounds |
| `NOTHING_TO_CANCEL` | A cancel with nothing cancellable |
| `BELOW_MIN_PRICE` | A sale or starting price below the base price |
| `AUCTION_OPEN` | A sale, transfer or auction while an auction runs |
| `OFFER_OPEN` | A transfer or auction while the name is for sale |
| `TRANSFER_PENDING` | A sale or auction while a transfer is pending |
| `AUCTION_BEYOND_TERM` | An owner's auction ending at or past the name's expiry |
| `BELOW_REFUND_FLOOR` | Would have been refunded, but the amount is below the floor |

What each one means for your money: [Refused transactions](fails).
