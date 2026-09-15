# The HTTP API

Every resolver serves the same read-only API, described by its own `GET /openapi.yaml`. CORS is open to any origin. Until the indexer has written state, every state route answers `503 NOT_SYNCED`.

## Routes

| Route | Answers |
|---|---|
| `/resolve/{name}` | The address, the record, and its inclusion proof against the latest checkpoint |
| `/available/{name}` | Whether the name can be registered, with a proof of absence |
| `/name/{name}` | Everything known: the record or `null`, `reserved`, `unreserved`, and `pending.transfer` / `.offer` / `.auction` (never both of the last two) |
| `/address/{addr}/names` | Names an address owns |
| `/offers`, `/auctions` | Every open sale. Every running auction with its standing bid and the minimum next bid |
| `/params` | The prices in effect, any scheduled change, and what a client needs to build fee-bearing messages, including how deep this resolver's own replay goes. `fees` is the length bands already priced (`upTo`, `times`, `yearly`, `lifetime`, in luna), so a client never multiplies a fee itself |
| `/checkpoints/latest`, `/checkpoints/{height}` | A checkpoint document: the six components and their commitment |
| `/log`, `/log/decoded` | The complete public log through the latest checkpoint. `decoded` renders the data field as text |
| `/settlements` | Outstanding settlement obligations: what the marketplace and treasury owe |
| `/burn` | Burned so far and owed so far, computed from the log |
| `/referrals/{name}` | Every registration that named this name as its referrer: height, transaction, the name registered, the sender, the value, and whether it was a lifetime. Log facts only. No share is computed, because the rate table is the operator's, not the protocol's |

## The proof is the product

Anyone can check the proof in `/resolve` against `/checkpoints/latest` with `@nimiqnames/core` alone. If a proof reaches you by another route (a cached reply, a QR code), verify it with the library's exported `verifyInclusion` and `verifyNonInclusion` rather than your own code. A second implementation of the check is the one place a divergence could enter.

## Try it

```bash
curl -s https://nimiqnames.com/api/params
curl -s https://nimiqnames.com/api/checkpoints/latest
curl -s https://nimiqnames.com/api/resolve/kike
```
