# The wire format

Every NNS message is an ordinary Nimiq basic transaction whose data field is:

```
NNS1  <one type letter>  <payload>
```

- **At most 64 bytes**, the network's data limit. Sixty-five bytes is accepted by the RPC, returns a hash, and never lands in a block.
- **Hex over RPC**, both directions.
- **Routed by recipient.** Fee-bearing messages go to the treasury. Signalling messages go to the protocol address with a value of 1 luna, because the network rejects a value of zero. A target change and a transfer put the counterparty in the recipient, so the wallet's own sheet shows it. Purchases go to the marketplace address.
- **Sender and recipient must differ.** Nimiq silently drops a self-transaction. That is why "point my name back at myself" is sent to the protocol address as a sentinel.
- **Failed transactions are still in blocks.** The indexer ignores anything whose `executionResult` is false.

## The fourteen messages

| Letter | Message | Payload | Sent by | To | Value |
|---|---|---|---|---|---|
| `G` | Register | `<name>`, `<name>\|<ref>`, or `<name>\|<ref or empty>\|L` | anyone | treasury | the band price, yearly or lifetime |
| `N` | Renew | `<name>` or `<name>\|L` | anyone | treasury | the band price, yearly or lifetime |
| `S` | Set target | `<name>` | owner | the new target | 1 luna |
| `E` | Set EVM address | `<name>\|<base64url 27 chars>` (empty clears) | owner | protocol | 1 luna |
| `X` | Transfer | `<name>` | owner | the new owner | 1 luna |
| `D` | Set subdomain host | `<name>\|<host>` (empty clears) | owner | protocol | 1 luna |
| `K` | Cancel | `<name>` | owner | protocol | 1 luna |
| `O` | Offer | `<name>\|<price in luna>` | owner | treasury | 1 luna |
| `B` | Buy, or bid | `<name>` | anyone | marketplace | the price exactly, or the bid |
| `A` | Auction | `<name>\|<starting price>\|<end height>` | owner, or admin for a reserved name | protocol | 1 luna |
| `M` | Settlement | `<height>\|<tx index>` | marketplace or treasury | the party paid | the amount owed |
| `P` | Governance | `<fee base>\|<commission bp>\|<effective height>` | admin | protocol | 1 luna |
| `U` | Unreserve | `<name>` or `<name>\|L` | admin | protocol (release) or the awardee (award) | 1 luna |
| `F` | Burn attestation | none | treasury | burn address | the amount burned |

Build payloads with `@nimiqnames/core`: `encodeRegister`, `encodeSetTarget`, `encodeSetEvm`, `encodeTransfer`, `encodeDelegate`, `encodeCancel`, `encodeRenew`, `encodeOffer`, `encodeBuy`, `encodeAuction`. They validate inputs and refuse anything the reducer would refuse. Every encoder checks the byte ceiling, because an over-length message fails silently.

**The `ref` field on a registration** is a registered name of up to {{n:MAX_REF_LEN}} characters (`a-z 0-9 -`) whose owner drove the registration, so the referral share can be paid to it. It has no effect on validity, price or ownership. A malformed or unknown `ref` is ignored and the registration proceeds. The share is an operator policy, not a protocol rule ([Referrals](referrals)).

Same-block order is by transaction hash, ascending. A message that is refused still occupies its position.

## Names on EVM chains

The owner can bind one 20-byte EVM address to a name. It sits inside the Merkle leaf, and the tree is keccak256, so **an EVM contract can verify an NNS proof directly and bind a name to `msg.sender`** with no oracle. One record covers every EVM chain, because multicoin wallets derive the same address on all of them. Anything further (per-chain records, other chains) composes on the EVM side, authorised through this one record. The protocol deliberately holds nothing else.

The record is self-declared. NNS verifies that the owner said it, not that the owner controls the EVM key. Control is demonstrated on the EVM side by transacting. The record clears on transfer and on the fall to available, and survives grace.

## Messaging (not protocol)

The app's Inbox is a client convention, not part of NNS: a dust transaction to a name's **owner** whose data begins `NC1` and carries a short text. The one rule that keeps it harmless is that the prefix is **not** `NNS1`, so no indexer parses, logs or commits it. Messages go to the owner, not to the address the name pays, because the owner is who can act on the name. A message about a subdomain goes to the address the host answered with, since a subdomain has no owner of record. Details are in the repository under `docs/app-chat.md`.

## The links the app understands (not protocol)

Two URL conventions, both read entirely on the client, both inert to the registry. Nothing on a chain depends on either, so any site may emit them.

| Link | Shape | What it does |
|---|---|---|
| **Payment link** | `https://<host>/pay/<name>?amount=<n>&message=<text>[&asset=usdt]` | Opens the Pay screen with the recipient, amount and reference filled in. Every field stays editable and nothing is sent until the payer presses Pay. Pasted into a chat, it previews as a card naming the payee and the amount. `https://<host>/#/pay/<name>?…` is the same link without the card |
| **Referral link** | `https://<host>/?ref=<name>` | Records who introduced a visitor, until their next registration carries it as `G`'s `ref` field |

A payment link is the useful one to emit from an invoice or a checkout. It needs no integration beyond building the URL. The `message` becomes the transaction's data field, so it is bound by the two rules that fail silently on chain: **64 bytes**, and never the prefix `NNS1` (exact case). That is why the app refuses such a reference before it sends. `asset=usdt` asks for the name's linked EVM address instead, and a USDT payment carries no message, because an ERC-20 transfer has nowhere to put one.

A payment link is a request, not an obligation. It commits nobody, proves nothing, and the payer's app resolves and verifies the name exactly as if they had typed it.
