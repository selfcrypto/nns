# Running the anchor publisher

Publishes checkpoint commitments to an EVM chain (§9), so past claims cannot be
quietly rewritten. Two containers: the publisher, and the **kubo node §8.2
requires beside it**.

This is a funded-key role, and it belongs nowhere near a box that terminates
TLS — `deploy/README.md`, "Keys, and where they may not be". It needs **no
inbound reachability at all**: it reads an NNS API outbound, pins outbound, and
sends outbound.

## Why there is a kubo in this directory

§8.2 does not accept one CID derivation. The log snapshot is pinned and the
anchor broadcast **only when two independent implementations mint the same
CID**:

| | Implementation | Here |
|---|---|---|
| **A** | a kubo node you run | the `kubo` service, `http://kubo:5001` |
| **B** | a different importer | Filebase by default, or a second non-kubo endpoint |

`env.ts` refuses to start with one configured, and refuses two URLs that are the
same endpoint. It cannot check the harder half: **two kubos of the same version
are one implementation run twice**, and would agree on a bug. That is the whole
reason B defaults to Filebase — a different importer, written by different
people, reporting its own minted CID in `x-amz-meta-cid`.

The kubo API is unauthenticated and grants full control of the node, so it is
**never published to a host port**. It exists on the compose network and
nowhere else.

## Deploy the contract first

The contract is `packages/anchor/contracts/NnsAnchor.sol` — one function, one
event, no access control, no owner, no upgrade path. Its compilation is
committed at `packages/anchor/src/artifact.ts` (bytecode, `initCodeHash`,
`sourceHash`, solc version and optimizer settings), which is what lets anyone
check that a deployed address really holds it.

**Rehearse on Sepolia.** It exercises this exact path — same bytecode, same
script, same variables — and what it rehearses is the *configuration*, which is
where the mistakes are.

```bash
cp packages/anchor/.env.example packages/anchor/.env
$EDITOR packages/anchor/.env
pnpm --filter @nimiqnames/anchor deploy            # dry run: reads a nonce and a
                                            # balance, predicts the CREATE
                                            # address, sends nothing
pnpm --filter @nimiqnames/anchor deploy --send
pnpm --filter @nimiqnames/anchor verify 0x…        # does that address hold this contract?
```

`verify` is worth running against someone else's deployment too — it is the
check that makes "the contract at this address is the audited one" a fact rather
than a claim.

## Then run the publisher

```bash
cd deploy/anchor
cp .env.example .env
$EDITOR .env                                  # everything, key included

chmod 600 .env
docker compose up -d --build
docker compose logs -f publisher
```

**Do not source a secret store into the shell before `up`.** Compose gives the
shell environment precedence over the project `.env`, so a store that happens
to define `NNS_ANCHOR_*` silently overrides this deployment — and nothing
warns. That cost a real debugging session on 2026-08-17: `~/.nns/evm-keys.env`
carries `NNS_ANCHOR_LOOKBACK_BLOCKS=5000`, sourcing it overrode the `45000` in
`.env`, and the publisher could then not see its own prior anchors. Put the
values in `.env` and start with a bare `docker compose up -d`.

**The cadence is the publisher's decision, not the schedule's.** §9 anchors on
change with a daily floor: it publishes when the commitment moved since this
key's last anchor, unconditionally when that anchor is a day old, and otherwise
exits clean saying "unchanged". `NNS_ANCHOR_INTERVAL_SECONDS` is only how often
it *looks* — every few hours is right, and looking more often buys requests
rather than anchors.

The loop deliberately does not stop on a failed run. **Exit 1 is an alert** —
watch for `anchor.run exit=1` — but a publisher that stopped on one bad run
would stop anchoring altogether, which is the failure §9 exists to prevent.

## One publisher is not the point

§8.5 #1 counts anchors from *independent* parties against the client's own
`ANCHOR_PUBLISHERS` list, and `ANCHOR_QUORUM` is 2. The contract is
permissionless precisely so that a second party can anchor without asking
anyone: there is no registry, no allowlist and no owner, because a contract-level
allowlist would let whoever holds it silence a dissenting publisher — exactly
the disagreement anchoring exists to expose.

So a single publisher run by the same operator who runs the resolver adds
**timestamping**, not independence. It is worth having, and it is not the claim
§2.1 wants to make. Getting a second, genuinely separate party to run this
directory is the deliverable.

## Verifying an anchor by hand

Everything needed is public. Given a root from `/checkpoints/{height}`:

```bash
# anchors for this root — `root` and `publisher` are the indexed topics
curl -s -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,
  "method":"eth_getLogs","params":[{"address":"<contract>",
  "topics":["0x05d81b8d9808f1fa1f651e2e7dc51bf6900cfd074532e3a0eccacf57055b668d",
            "<root>"]}]}' "$NNS_ANCHOR_RPC_URL"
```

The event carries `nimiqHeight`, `timestamp` and `logDigest`. **Check
`nimiqHeight` against the height you asked about** — it is deliberately not an
indexed topic, because the client already knows the height and MUST compare it.
`logDigest` is the sha2-256 multihash digest of the snapshot's root CID;
`core`'s `cidFromDigest` turns it back into the CID string, and fetching those
bytes and keccak256-ing them must reproduce the log hash committed inside the
root.

## Operating it

```bash
docker compose logs -f publisher
docker compose exec kubo ipfs repo stat
docker compose up -d --build            # after a git pull
```

- **Nothing here is worth backing up.** Anchors already on chain stand on their
  own; kubo's repo re-derives the same CIDs from the same bytes, and Filebase
  holds the pinned copy regardless.
- **Do not run this against a load-balanced public RPC if you can avoid it.**
  Measured 2026-08-17 on `ethereum-sepolia-rpc.publicnode.com`: the same
  45,000-block `eth_getLogs` returned the publisher's prior anchor on one run
  and nothing on the next, because the pool routes to backends that answer
  wide ranges differently. The consequence is worse than a spurious warning —
  when that lookup comes back empty, the **divergence check does not run**.
  That check is what catches an API serving a different root at a height this
  key already anchored, which is the single most important thing the publisher
  can notice. A dedicated endpoint makes it deterministic; short of that, keep
  `NNS_ANCHOR_LOOKBACK_BLOCKS` well under the endpoint's cap (50,000 is the
  common one) and treat "no prior anchor" as a signal to check by hand.
- Fund the publisher address. `NNS_ANCHOR_MIN_BALANCE_WEI` refuses to sign below
  one anchor's cost and warns above it; an anchor is roughly 30k gas, an event
  emission and nothing else.
