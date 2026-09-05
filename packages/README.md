# Packages

Twelve packages in one pnpm workspace. They divide along one line: **`core` decides
what the protocol means, and nothing else is allowed to.**

Every rule — what a valid name is, which verdict a message earns, what bytes go
into a Merkle leaf — lives in `core` and is called from everywhere else. Two
implementations of a rule is two chances to diverge, and divergence here is
silent: different roots, no error, and the first symptom is a mismatch in
somebody's client. That is the failure mode the whole design exists to prevent.

## The twelve

| Package | Does | Holds a key | Talks to |
|---|---|---|---|
| **`core`** | The rules: encode/decode, validation, the reducer, the Merkle tree, the canonical log | no | **nothing** — pure |
| **`indexer`** | Tails the node, replays messages through `core`, writes state and checkpoints to Postgres | no | node (read), Postgres |
| **`api`** | Read-only REST over the indexer's database: twelve endpoints, §8.3 proofs | no | Postgres |
| **`resolver`** | Client library: asks several APIs, checks quorum, verifies proofs, follows §8.6 delegation | no | any NNS API |
| **`app`** | The Nimiq Pay mini app — search, register, manage. Static Vite bundle | no | `resolver`, relay |
| **`relay`** | RPC proxy for the app: five allowlisted node methods, rate limits, CORS | **node credential** | node |
| **`delegate`** | Reference §8.6 host: answers `shop.alice` for one name's owner | no | nothing |
| **`settlement`** | Watches obligations and issues `M` — payouts, commission, refunds; since r28 the auction's outbid refunds and its close's two legs, which no log line announces | **two hot keys** | any NNS API, node (wallet) |
| **`anchor`** | The §9 EVM contract, its publisher, and a browser-safe reader | funded EVM key | an EVM chain, IPFS |
| **`admin`** | Cold-key CLI for `P` (governance), `U` (unreserve), `F` (burn attestation), `A` (the admin's auction of a reserved name, r28) | **cold key** (in the node's wallet) | node, an NNS API |
| **`chat`** | The NC message convention (`docs/app-chat.md`): wire format, inbox derivation. **Not protocol** | no | **nothing** — pure |
| **`chat-index`** | Optional: indexes NC messages and serves them by address, so the Inbox is a lookup rather than a full-history pull | no | node (read), its own Postgres |

Only three packages can spend anything, and they are deliberately the three you
would never deploy on a public box: `settlement`, `anchor`, `admin`.

**The last two are not part of the protocol and must never become part of it.**
NC chat is a client convention: a dust transaction whose data starts `NC1`,
which every NNS indexer ignores because §7.5 makes `NNS1` the ignore boundary.
`chat-index` imports nothing from `indexer`, `api` or `core`, edits nothing in
them, and keeps its own disposable database — stop it, delete it, or never
deploy it, and the registry is unchanged.

## How they stack

```
                          core
             (rules — pure, no I/O, no clock)
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
     indexer            resolver            settlement
   chain → Postgres    client-side          watches what is
        │              quorum + proofs      owed, issues M
        │                   │                (the only hot keys)
        ▼                   ▼
       api ──────────────► app ◄──────── relay ──► node
   read-only REST      mini app       5 methods, the
                                      node credential

   delegate    answers one owner's subdomains. No node, no database,
               no key, no dependency on any of the above.

   anchor      publishes checkpoint roots to an EVM chain, so past
               claims cannot be quietly rewritten.

   admin       sends P / U / F / A from the cold key.
```

`relay` is the odd one: it has **no workspace dependencies at all**, because it
proxies node methods and never touches a protocol rule.

## Two names that get confused

**"Resolver" means two different things in this repo.**

- **`packages/api`** is the *server* that answers `/resolve/{name}`. Running one
  is what `docs/runbooks/operators.md` calls "a resolver", and §8.5's quorum is
  made of these.
- **`packages/resolver`** is the *client library* that calls several of them,
  compares answers and verifies proofs. It runs in the app, or in anyone's code,
  and needs no database.

**A delegate is not a resolver.** Different operator, different data, different
trust position: a resolver proves on-chain facts with a Merkle proof, a delegate
asserts subdomains with none, and clients render the two differently for exactly
that reason.

## Which of these you would actually run

Most people run one or two. `deploy/` has a directory per role — compose file,
`.env.example`, README — and `docs/runbooks/operators.md` is the map.

| To… | Run | Packages involved |
|---|---|---|
| Serve the registry, independently verifiable | `deploy/resolver` | `indexer`, `api` |
| Make `shop.yourname` resolve | `deploy/delegate` | `delegate` |
| Both of those, on one box | `deploy/collaborator` | `indexer`, `api`, `delegate` |
| Host the app and its RPC proxy | `deploy/service` | + `relay`, `app` |
| Pay what the protocol owes | `deploy/settlement` | `settlement` |
| Anchor checkpoint roots to an EVM chain | `deploy/anchor` | `anchor` |

Embedding NNS in your own app needs none of them — `npm i @nns/resolver` and
point it at other people's endpoints.

## Conventions every package inherits

- **TypeScript strict**, `NodeNext`, `noUncheckedIndexedAccess`,
  `erasableSyntaxOnly` — set once in `tsconfig.base.json`. Extend it; don't
  restate its options.
- **`NodeNext` means relative imports carry a `.js` extension.** `app` overrides
  `moduleResolution` to `Bundler` in its own tsconfig.
- **Amounts are integer luna and are `bigint`** (1 NIM = 100,000 luna). Never
  floats, never `number`. **Heights are `number`** — the chain is nowhere near
  2^53.
- Dependency versions live once in the `catalog:` of `pnpm-workspace.yaml`.
- `pnpm test` runs one Vitest over every package. A package joins by having its
  own `vitest.config.ts` — deliberate, so "no test files found" stays a real
  failure rather than the normal state of an empty package.
- **Verification is `pnpm typecheck && pnpm build && pnpm test`, all three.**
  The build config is narrow (`src/` only) and typecheck is wide, so a build can
  be broken while typecheck is green.
- **No secrets in the repo.** Keys come from the environment.

## Finding your way in

Each package has its own `CLAUDE.md` with the spec sections it implements and
the invariants that are easy to break. Six — `core`, `indexer`, `api`,
`resolver`, `relay` and `delegate` — also have a `MAP.md` listing every
exported symbol with its file: check there before grepping `src/`.

Start from the spec, though: `docs/nns-spec-v1.md` is authoritative, and if code
and spec disagree the spec wins. It is ~180 KB, so navigate it rather than
reading it:

```bash
grep -n "^#\{2,3\} " docs/nns-spec-v1.md     # every heading with its line number
sed -n '1245,1290p' docs/nns-spec-v1.md      # then read only the range you need
```
