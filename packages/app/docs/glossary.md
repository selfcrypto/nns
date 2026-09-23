# Glossary

- **Name.** A registered identifier, {{n:MIN_NAME_LEN}} to {{n:MAX_NAME_LEN}} characters, held by an owner for a term.
- **Owner.** The key that registered the name, or that it was transferred to.
- **Target.** The Nimiq address a name pays. The owner's own address at registration.
- **Label** and **parent.** The two halves of `label.parent`. The parent is a name. The label is answered by the parent's host.
- **Host.** A server a name's owner runs to answer for its labels. Proves nothing.
- **Resolver.** The server that replays the chain and answers lookups with proofs. Also the client library that asks several of them and verifies the proofs.
- **Checkpoint.** A commitment to the whole registry, cut at every finalised macro block (every ~{{dur:CHECKPOINT_INTERVAL}}), so a name is provable the moment it is final.
- **Proof.** The path from a name's leaf to the checkpoint's root, which the client rebuilds and compares.
- **Quorum.** How many independent resolvers must agree before a client accepts an answer.
- **Anchor.** A checkpoint commitment posted to a contract on an EVM chain, by a publisher.
- **Log.** Every NNS transaction, accepted or refused, one line each. Its hash is inside every checkpoint.
- **Pin.** The address a device remembers for a name from first use.
- **Term.** The {{dur:TERM_LENGTH}} a registration lasts. **Grace.** The {{dur:GRACE_PERIOD}} after expiry when a name is renewable but not resolving or registrable.
- **Sale.** A name put up at a fixed price by its owner. The protocol calls the message an offer.
- **Luna.** The smallest unit of NIM: 100,000 luna per NIM. **Dust.** One luna, the value on every message that carries no fee.
- **Canonical order.** Block number, then transaction hash. What "first" means when two messages race.
- **Forfeit** and **refund.** The two things that can happen to the value of a refused message.
