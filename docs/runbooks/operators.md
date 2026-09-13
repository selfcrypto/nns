# Operator roles

Five things can be run, by different kinds of party. Each is a directory under
`deploy/` with its own compose file, its own `.env.example` and its own README,
so nobody reads configuration belonging to a role they do not run.

| Role | Runs | Reachable from outside | Needs |
|---|---|---|---|
| **Resolver** — `deploy/resolver` | Postgres → indexer → API | the API | a Nimiq history node whose retention covers `LAUNCH_HEIGHT` |
| **Delegate** — `deploy/delegate` | the delegate | yes | a labels file, and publicly trusted TLS |
| **The service** — `deploy/service` | the resolver stack + relay + app bundle | app, API, relay | the node's credential, for the relay |
| **Settlement** — `deploy/settlement` | its own Postgres → ledger → issuer | **nothing** | the two §6 `M` hot keys, and a node it reaches privately |
| **Anchor** — `deploy/anchor` | kubo → publisher | **nothing** | a funded EVM key, and §8.2's second CID implementation |

Run one, or two, or all of them: they are separate compose projects and do not
interfere. An exchange that wants `shop.exchange` to work needs only the second
row — no node, no database, no indexer.

The last two rows are ours alone and belong on a **different machine from the
third** — both hold keys, and a box terminating TLS is the wrong home for one.

The first two rows are also the two a third party can run, and
`deploy/collaborator` is both of them in one compose project: one `.env`, one
`up`, the same four containers on the same two ports. It is a convenience, not
a sixth row — the resolver still proves its answers and the delegate still
proves nothing. Use the separate directories when you want the two to fail
separately; do not run both arrangements on one host, where they want the same
ports.

## What each row is for

A **resolver** is the registry itself: an independent replay of the chain into
`name → address`, answering lookups with §8.3 Merkle proofs anyone can check
against the committed root. §8.5 has a client ask *several* of these and
compare, so more of them is the mechanism by which NNS stops depending on us.

A **delegate** is a name owner answering for their own subdomains. It proves
nothing — §8.6's answer carries no proof and clients render it differently for
that reason — and it holds no chain data at all.

**The service** is what we run: a resolver, plus the mini app, plus the RPC
relay the app needs. Only this row exists once.

**Settlement** pays what the protocol owes — marketplace payouts, commission
forwards, and refunds. It is also ours alone, and it holds the system's only
Nimiq hot key.

**The anchor publisher** writes checkpoint commitments to an EVM chain (§9) so
past claims cannot be quietly rewritten. It ships with a **kubo node**, because
§8.2 pins and anchors a log snapshot only when two *independent* CID
implementations mint the same CID — kubo is one, Filebase the other, and
`env.ts` refuses to start with a single one configured. One publisher run by
the operator who also runs the resolver adds timestamping, not independence:
`ANCHOR_QUORUM` is 2 and the contract is permissionless precisely so a second
party can anchor without asking anyone.

## The settlement issuer

It settles **obligations, not message types**: nothing in it looks for a `B`
or a `G`, so which verdicts owe money stays
`core`'s decision. Three kinds — `REFUND`, `SALE_PROCEEDS`, `COMMISSION` — and
two senders, with the key chosen by each obligation's `owedBy`:

- `TREASURY_ADDRESS` refunds a `G` that lost a registration race.
- `MARKETPLACE_ADDRESS` refunds a `B` against a closed offer or at the wrong
  price, and pays a winning `B`'s proceeds and commission.

So **both keys are needed by anyone running the marketplace** — three of the
four obligation paths are the marketplace's, including two of the three refund
reasons. `deploy/settlement`'s compose file therefore declares both as required
rather than optional.

**It must not share a machine with the service.** A box that terminates TLS is
the wrong home for a hot key, and the issuer needs the node's *wallet* methods,
which the relay deliberately does not allowlist. It needs no inbound
reachability at all: it polls the API outbound and broadcasts `M` transactions,
which every indexer then picks up like any other message. The chain is the only
channel between the two halves — no shared database, no open port.

Its ledger is **the one database in NNS worth backing up**. Everything else
derives from the chain and rebuilds from `LAUNCH_HEIGHT`; this records payments
that have already left a hot key.

## Four things that are easy to get wrong

**A delegate is not a resolver.** Different operator, different data, different
trust position — one proves on-chain facts, the other asserts subdomains with
no proof. A delegate needs no indexer and joins no quorum, and calling it a
"delegated resolver" invites exactly that mix-up. One operator running both on
one box (`deploy/collaborator`) does not soften any of it: same machine, same
`.env`, still two different claims about what the answer is worth.

**"Resolver" names two things in this repo.** `packages/api` is the *server*
that answers `/resolve/{name}` — running one is what the table above means.
`packages/resolver` is the *client library* that calls several of them, checks
quorum and verifies proofs; it runs in the app, or in anyone's code, and needs
no database.

**An indexer alone is not a role.** It accumulates state and answers nobody.
It is the base layer of the resolver stack, not a deployment choice.

**The relay belongs to whoever hosts the app.** It exists because a browser
cannot call an authenticated node with no CORS headers: it holds the node's
credential and forwards five allowlisted methods. No partner needs it, and
bundling it would hand them a credential-holding proxy they have no use for.
Nothing a partner can run holds a key of any kind.

## The node

Every resolver needs a Nimiq **history** node with retention covering
`LAUNCH_HEIGHT` (58,842,720). It is external on purpose: bundling one would
make the compose file enormous and the first run days long, and the partners
most likely to run a resolver already have a node.

It is also the one prerequisite that cannot be corrected afterwards, and its
failure is silent — a node that has pruned answers those batches with `[]`,
which is what an empty batch looks like too. The indexer refuses to start
rather than index nothing successfully. `deploy/resolver/README.md` explains
what that refusal means and why raising the start height is the wrong response
to it; read that section before deploying, not after.

A delegate needs no node.

## TLS

Both public roles must be reachable over **publicly trusted HTTPS**: clients are
browsers, and for a delegate §8.6 fixes the scheme outright — a `D` host is
bare, clients hardcode `https://` on 443, and there is no downgrade path.

We ship no web server for this. An exchange already has TLS; a small operator
follows a recipe; bundling one would mean owning failure modes we do not
control, in the role whose whole appeal is that it is tiny. The recipes —
Caddy, nginx + certbot, a tunnel, and the panel note — are in
`deploy/delegate/README.md` and apply to the resolver unchanged, with only the
port differing.

The API sends `access-control-allow-origin: *` itself, so no proxy header
configuration is needed; do not strip it. An endpoint a browser cannot read
answers `curl` perfectly while being invisible to every client.
