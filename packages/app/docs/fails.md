# Refused transactions

Every message the registry refuses is written to the public log with a reason. Whether the money comes back follows one rule:

> **Refund for losses caused by a race. Forfeit for losses the sender could have prevented.**

The app prevents every forfeit on this page before it lets you sign. These tables matter if you build transactions yourself, or want to read the log.

## Refunded

The address that received the value owes it back. The settlement service pays it in a separate transaction, and the debt is visible in the log until then.

| What happened | Log reason | Refunded by |
|---|---|---|
| You registered or renewed and paid less than the price in effect | `INSUFFICIENT_VALUE` | The treasury |
| You registered or renewed and paid **more** than the price in effect (the name is yours, and the surplus comes back) | (accepted, `OK`) | The treasury |
| Someone else's registration of the same name came first in block order | `LOST_REGISTRATION_RACE` | The treasury |
| You bought a name whose sale was gone (sold, cancelled or expired), or bid after an auction closed | `OFFER_NOT_OPEN` | The marketplace |
| You paid the wrong amount for a sale, or bid below the minimum | `WRONG_PRICE` | The marketplace |
| **You were outbid** | (your bid was accepted, `OK`) | The marketplace, the moment the higher bid lands |
| The auction was cancelled by the name entering grace while your bid stood | (your bid was accepted, `OK`) | The marketplace |

An amount below {{nim:REFUND_FLOOR}} that would otherwise be refunded is kept (`BELOW_REFUND_FLOOR`).

## Forfeited

The value stays where it was sent. Every row here is checkable before sending.

**Any message**

| What happened | Log reason |
|---|---|
| Data began `NNS1` but the type letter is not one of the fourteen | `UNKNOWN_TYPE` |
| A known type whose fields do not parse | `MALFORMED_PAYLOAD` |
| Sent to the wrong address for its type | `WRONG_RECIPIENT` |
| Over 64 bytes | `OVER_LENGTH`. Never seen in practice, because the network drops such a transaction before it reaches a block |

**Registering or renewing**

| What happened | Log reason |
|---|---|
| The name breaks a rule in [Rules and reserved names](names) | `INVALID_NAME` |
| The name is reserved | `RESERVED_NAME` |
| Registering a name that is in grace | `NAME_IN_GRACE` |
| Renewing a name that has no record at all | `NAME_NOT_FOUND` |

**Owner actions**: target, EVM address, transfer, subdomain host, sale, auction, cancel

| What happened | Log reason |
|---|---|
| The name is not registered, or is in grace | `NAME_NOT_REGISTERED` |
| Sent by someone other than the owner | `NOT_OWNER` |
| A sale, transfer or second auction while an auction runs | `AUCTION_OPEN` |
| A transfer or auction while the name is for sale. Cancel the sale first | `OFFER_OPEN` |
| A sale or auction while a transfer is pending. Cancel the transfer first | `TRANSFER_PENDING` |
| A sale or auction priced below the base registration price | `BELOW_MIN_PRICE` |
| A subdomain host that is too long, has a scheme, or a bad character | `INVALID_HOST` |
| An auction ending sooner than {{dur:AUCTION_MIN_DURATION}} out | `INSUFFICIENT_NOTICE` |
| An auction ending later than {{dur:AUCTION_MAX_DURATION}} out | `AUCTION_TOO_LONG` |
| An auction ending at or after the name's expiry | `AUCTION_BEYOND_TERM` |
| A cancel with nothing to cancel | `NOTHING_TO_CANCEL` |

**Administrative and service messages**: governance, unreserve, settlement, burn attestation

| What happened | Log reason |
|---|---|
| Not sent by the administrator | `NOT_ADMIN` |
| A settlement or burn attestation from the wrong address | `WRONG_SENDER` |
| A price change outside its bounds | `GOVERNANCE_BOUND_VIOLATED` |
| A price change with less than {{dur:GOVERNANCE_DELAY}} notice | `INSUFFICIENT_NOTICE` |
| Releasing a name that is not reserved | `NAME_NOT_RESERVED` |
| Awarding a name that somebody holds | `NAME_NOT_AVAILABLE` |
| Awarding a name to the burn address | `INVALID_RECIPIENT` |

A message that breaks several rules is logged with the first one, in a fixed order every implementation shares.

## "It never confirmed"

A transaction hash from the wallet means the transaction was accepted for broadcast, not that it will land. Nimiq accepts and then silently drops a transaction when:

- the data is longer than 64 bytes,
- the sender and the recipient are the same address,
- the sender cannot cover the value plus the fee.

The app checks all three before opening the wallet. If a transaction still does not appear, the app asks the chain directly and reports one of the lines in [Buy](buy). It never reports "the network refused it", because it cannot observe that.

## Reading the log yourself

Every line of the public log ends with `OK` or one of the reasons above, beside the block, the transaction hash, the sender, the recipient and the value. `/log/decoded` on any resolver's API renders the data field as text. The vocabulary is exactly 30 words: `OK`, 25 forfeit reasons and 4 refund reasons ([Messages and verdicts](messages)).
