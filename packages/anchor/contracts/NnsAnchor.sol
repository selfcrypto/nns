// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title NnsAnchor — NNS checkpoint anchoring (spec §9)
/// @notice Append-only attestation that a party published a given NNS
///         checkpoint commitment for a given Nimiq height, together with the
///         address of the log snapshot that is the evidence for it.
///
/// This contract has one function and one event, and that is the whole design.
/// Read §9 before changing anything here; the three properties below are load
/// bearing and every one of them is the kind a later reader "fixes" by reflex.
///
/// 1. PERMISSIONLESS. There is no access control, no publisher registry, no
///    owner, no admin function and no upgrade path. Anyone may anchor
///    anything. Who counts is decided entirely on the client, against its
///    own `ANCHOR_PUBLISHERS` list (§8.5 #1) — anchors from unknown addresses
///    are ignored, never counted toward the quorum and never a mismatch.
///
///    Do not add a modifier. §2.1's trust signal is that *independent*
///    parties agree; a contract-level allowlist would hand whoever holds it
///    the power to exclude a dissenting publisher, silencing exactly the
///    disagreement anchoring exists to expose. It buys nothing in exchange,
///    because the same operator ships the client that holds the list either
///    way (§2.2). §10.7's publisher stipend is treasury policy, decided
///    off-chain — it is not this contract's business and must not become a
///    modifier here.
///
/// 2. NO VALIDATION. `anchor` does not check that `root` is non-zero, that
///    `nimiqHeight` is plausible, or that the caller has anchored before. A
///    `require` here would be a protocol rule living outside the spec and
///    outside the `core` package, enforced by a contract that cannot see
///    Nimiq state and so cannot enforce it correctly. Junk anchors are a
///    client-side non-problem by construction — see (3) — and cost the
///    spammer gas and everyone else nothing.
///
/// 3. `root` AND `publisher` ARE INDEXED; `nimiqHeight` IS NOT. A client's
///    primary query is "anchors for *this* root", which is a topic filter a
///    junk root never appears in, and its secondary filter is by publisher
///    address, also a topic. That is what makes (2) safe. The third topic is
///    deliberately not spent on `nimiqHeight`: the client already knows the
///    height it is asking about and MUST check the field against it, so
///    indexing it would serve a query nobody makes.
///
/// The contract holds no state and no value: there is no storage, no
/// constructor, and no `receive` or `fallback`, so it cannot be paid and has
/// nothing to drain. Deployed with CREATE2 under a fixed salt it takes the
/// same address on every EVM chain — the anchor chain is a deployment choice
/// and not a protocol rule (§9), and this contract is what makes that true.
contract NnsAnchor {
    /// @param root        The §8.1 checkpoint commitment at `nimiqHeight` —
    ///                    the six-component digest, taken verbatim from the
    ///                    checkpoint and never recomputed by the publisher.
    ///                    Not the name root: an inclusion proof verifies
    ///                    against `nameRoot`, which is one component of this
    ///                    value, and §8.5 #3 specifies both steps.
    /// @param publisher   `msg.sender`. The only thing this contract does
    ///                    about identity; it does not decide who counts.
    /// @param nimiqHeight The Nimiq block height the commitment is for.
    ///                    Without it the root is unverifiable, because nobody
    ///                    could know which history to replay (§9).
    /// @param timestamp   Anchor-chain block time. Evidence of *when* the
    ///                    claim was made, which is the whole point of a
    ///                    third-party attestation; clients use it for the
    ///                    `ANCHOR_STALENESS_LIMIT` check (§8.5 #8).
    /// @param logDigest   The 32-byte sha2-256 multihash digest of the log
    ///                    snapshot's root CID (§8.2). An address, not a hash
    ///                    of the file, and not the keccak256 log hash — that
    ///                    one is already committed inside `root`.
    event Anchored(
        bytes32 indexed root,
        address indexed publisher,
        uint64 nimiqHeight,
        uint64 timestamp,
        bytes32 logDigest
    );

    /// @notice Publish an anchor. Permissionless: any address may call this.
    /// @dev Roughly 30k gas — an event emission and nothing else. Events
    ///      rather than storage because logs live in the receipt trie, are
    ///      independently verifiable, and cost a fraction of an SSTORE (§9).
    function anchor(bytes32 root, uint64 nimiqHeight, bytes32 logDigest) external {
        emit Anchored(root, msg.sender, nimiqHeight, uint64(block.timestamp), logDigest);
    }
}
