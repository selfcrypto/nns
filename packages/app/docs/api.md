# The HTTP API

Every resolver serves the same read-only API, described by its own `GET /openapi.yaml`. CORS is open to any origin. Until the indexer has written state, every state route answers `503 NOT_SYNCED`.

## Routes

| Route | Answers |
|---|---|
| `/resolve/{name}` | The address, the record, and its inclusion proof against the latest checkpoint |
| `/available/{name}` | Whether the name can be registered, with a proof of absence |
| `/name/{name}` | Everything known: the record or `null`, `reserved`, `unreserved`, and `pending.transfer` / `.offer` / `.auction` |
| `/address/{addr}/names` | Names an address owns |
| `/offers`, `/auctions` | Every open sale. Every running auction with its standing bid and the minimum next bid |
| `/params` | The prices in effect, any scheduled change, and `fees`: every length band already priced (`upTo`, `times`, `yearly`, `lifetime`, in luna) |
| `/checkpoints/latest`, `/checkpoints/{height}` | A checkpoint document: the six components and their commitment |
| `/log`, `/log/decoded` | The complete public log through the latest checkpoint. `decoded` renders the data field as text |
| `/settlements` | Outstanding settlement obligations: what the marketplace and treasury owe |
| `/burn` | Burned so far and owed so far |
| `/referrals/{name}` | Every registration that named this name as its referrer. Log facts only, no share computed |

## Try it

```bash
curl -s https://nimiqnames.com/api/params
curl -s https://nimiqnames.com/api/checkpoints/latest
curl -s https://nimiqnames.com/api/resolve/rico
```

The proof in `/resolve` is the product. Anyone can check it against `/checkpoints/latest` with `@nimiqnames/core` alone. If a proof reaches you by another route (a cached reply, a QR code), verify it with the library's `verifyInclusion` and `verifyNonInclusion` rather than your own code.
