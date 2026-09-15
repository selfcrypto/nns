# The wire format

Every NNS message is an ordinary Nimiq basic transaction whose data field is:

```
NNS1  <one type letter>  <payload>
```

For example, `NNS1Gkike` registers `kike`, and `NNS1Dkike|nns.example.com` sets its subdomain host.

- **At most 64 bytes.** Sixty-five bytes is accepted by the RPC, returns a hash, and never lands in a block.
- **Hex over RPC**, both directions.
- **Routed by recipient.** Fee-bearing messages go to the treasury. Signalling messages go to the protocol address with a value of 1 luna, because the network rejects a value of zero. A target change and a transfer put the counterparty in the recipient, so the wallet's own sheet shows it. Purchases and bids go to the marketplace address.
- **Sender and recipient must differ.** Nimiq silently drops a self-transaction, so "point my name back at myself" is sent to the protocol address instead.
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

Build payloads with `@nimiqnames/core`: `encodeRegister`, `encodeSetTarget`, `encodeSetEvm`, `encodeTransfer`, `encodeDelegate`, `encodeCancel`, `encodeRenew`, `encodeOffer`, `encodeBuy`, `encodeAuction`. They refuse anything the registry would refuse, including an over-length payload.

The `ref` on a registration is a registered name of up to {{n:MAX_REF_LEN}} characters whose owner drove the registration. It has no effect on validity, price or ownership ([Referrals](referrals)).

Same-block order is by transaction hash, ascending. A refused message still occupies its position.

## Names on EVM chains

The owner can bind one 20-byte EVM address to a name. It sits inside the Merkle leaf, and the tree is keccak256, so **an EVM contract can verify an NNS proof directly and bind a name to `msg.sender`** with no oracle. One record covers every EVM chain.

The record is self-declared: NNS verifies that the owner said it, not that the owner controls the EVM key. It clears on transfer and when the name falls back to available, and survives grace.

## Messaging (not protocol)

The app's Inbox is a client convention: a dust transaction to a name's **owner** whose data begins `NC1` and carries a short text. Because the prefix is not `NNS1`, no indexer parses, logs or commits it. Details are in the repository under `docs/app-chat.md`.

## Links (not protocol)

Two URL conventions, both read entirely on the client. Any site may emit them.

| Link | Shape | What it does |
|---|---|---|
| **Payment link** | `https://<host>/pay/<name>?amount=<n>&message=<text>[&asset=usdt]` | Opens Pay with the recipient, amount and message filled in. Nothing is sent until the payer presses Pay |
| **Referral link** | `https://<host>/?ref=<name>` | Records who introduced a visitor, until their next registration carries it as `G`'s `ref` |

A payment link needs no integration beyond building the URL. The `message` becomes the transaction's data field, so it is bound by the same two rules: 64 bytes, and never the prefix `NNS1`. A USDT payment carries no message.
