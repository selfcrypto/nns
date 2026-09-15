# Refused transactions

Every message the registry refuses is written to the public log with a reason, so the outcome is never a mystery. The one question that matters is whether the money comes back, and the rule is simple.

> **Refund for losses caused by a race. Forfeit for losses the sender could have prevented.**

The app prevents every forfeit on this page before it lets you sign. These tables matter if you build transactions yourself, or want to read the log.

## Refunded

The value sits at the address that received it, which owes you a refund. The settlement service pays it in a separate transaction, and the debt is visible in the log until it does.

| What happened | Log reason | Refunded by |
|---|---|---|
| You registered or renewed and paid less than the price in effect, including when a price change landed while your transaction was on its way | `INSUFFICIENT_VALUE` | The treasury |
| You registered or renewed and paid **more** than the price in effect (the name is yours, and the surplus comes back) | (accepted, `OK`) | The treasury |
| You registered a name that someone else's registration reached first, in block order | `LOST_REGISTRATION_RACE` | The treasury |
| You bought a name whose sale was gone (sold to someone ahead of you, cancelled, or expired), or bid after an auction closed | `OFFER_NOT_OPEN` | The marketplace |
| You paid the wrong amount for a sale (more *or* less than the exact price), or bid below the minimum | `WRONG_PRICE` | The marketplace |
| **You were outbid** | (your bid was accepted, `OK`) | The marketplace, the moment the higher bid lands |
| An auction was cancelled by the name entering grace while your bid stood | (your bid was accepted, `OK`) | The marketplace |

One exception crosses the line: an amount below {{nim:REFUND_FLOOR}} that would otherwise be refunded is kept (`BELOW_REFUND_FLOOR`). Without that floor, thousands of trivially underfunded messages would become thousands of refund transactions.

## Forfeited

The value stays where it was sent. Every row here is checkable before sending, from the published rules and the current checkpoint.

**Any message**

| What happened | Log reason |
|---|---|
| Data began `NNS1` but the type letter is not one of the fourteen | `UNKNOWN_TYPE` |
| A known type whose fields do not parse | `MALFORMED_PAYLOAD` |
| Sent to the wrong address for its type | `WRONG_RECIPIENT` |
| Over the 64-byte budget | `OVER_LENGTH`. Never seen in practice, because the network drops such a transaction before it reaches a block |

**Registering or renewing**

| What happened | Log reason |
|---|---|
| The name breaks a rule in [Rules and reserved names](names) | `INVALID_NAME` |
| The name is reserved | `RESERVED_NAME` |
| Registered a name that is in grace | `NAME_IN_GRACE` |
| Renewed a name that has no record at all | `NAME_NOT_FOUND` |

**Owner actions**: target, EVM address, transfer, subdomain host, sale, auction, cancel

| What happened | Log reason |
|---|---|
| The name is not registered, or is in grace | `NAME_NOT_REGISTERED` |
| Sent by someone other than the owner | `NOT_OWNER` |
| A sale, transfer or second auction while an auction runs | `AUCTION_OPEN` |
| A sale or auction priced below the base registration price in effect | `BELOW_MIN_PRICE` |
| A subdomain host that is too long, has a scheme, or a bad character | `INVALID_HOST` |
| An auction ending sooner than {{dur:AUCTION_MIN_DURATION}} out | `INSUFFICIENT_NOTICE` |
| An auction ending at or after the name's expiry | `AUCTION_BEYOND_TERM` |
| A cancel with nothing to cancel | `NOTHING_TO_CANCEL` |

**Administrative and service messages**: governance, unreserve, settlement, burn attestation

| What happened | Log reason |
|---|---|
| Not sent by the administrator | `NOT_ADMIN` |
| A settlement or burn attestation from the wrong address | `WRONG_SENDER` |
| A price change outside its bounds | `GOVERNANCE_BOUND_VIOLATED` |
| A price change with less than {{dur:GOVERNANCE_DELAY}} notice | `INSUFFICIENT_NOTICE` |
| Releasing a name that is not reserved, or already released | `NAME_NOT_RESERVED` |
| Awarding a name that somebody already holds, registered or in grace | `NAME_NOT_AVAILABLE` |
| Awarding a name to the burn address | `INVALID_RECIPIENT` |

A message can break several rules at once. The log records the first one in a fixed order that every implementation shares. A message's own contents are judged before the money it carried, so an unusable message is refused for being unusable whatever it paid.

## "It never confirmed"

The wallet returning a transaction hash means the transaction was accepted for broadcast, not that it will land. Three things make Nimiq accept a transaction and then drop it without any error.

- The data is longer than 64 bytes.
- The sender and the recipient are the same address.
- The sender cannot cover the value plus the fee.

The app checks all three before opening the wallet. If a transaction still does not appear, the app asks the chain directly and reports one of the lines in [Buy](buy). The app never reports "the network refused it", because it never observes that. A broken or lagging checker is not a negative result.

## Reading the log yourself

Every line of the public log ends with `OK` or one of the reasons above, beside the block, the transaction hash, the sender, the recipient and the value. `/log/decoded` on any resolver's API renders the data field as text. Two implementations that disagreed about which word to write would produce different logs and therefore different checkpoints, so the vocabulary is fixed, closed, and exactly 28 words: `OK`, 23 forfeit reasons, and 4 refund reasons ([Messages and verdicts](messages)).
