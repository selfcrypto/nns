-- 010 · an open auction is pending state — r28 §6 `A`, §8.1 tag 0x0B
--
-- r28 made `A` a v1 rule (docs/decisions.md, "r28: `A` activates before
-- launch…"). An open auction sits in the §8.1 pending set between offers and
-- governance, so the state the indexer reloads on restart has to carry it:
-- `pending` gains the kind `AUCTION`, reusing `seller`, with the entry's own
-- fields — `reserve`, `end_height`, and the standing bid as `bidder`/`bid`
-- plus the bid's ref. The ref is settlement identity, not committed (§8.1),
-- but it is what the close keys its two legs by, so a restart that lost it
-- would owe the winning bid's proceeds to a ref nobody can pay. NULL `bidder`
-- means no bid yet, and then `bid` is 0 and the ref is NULL — the shape check
-- refuses a half-present bid, which is the row a crashed writer could leave.
--
-- **This is NOT a layout migration.** `COMMITMENT_LAYOUT` stays 5 (r26's,
-- migration 008). §8.1's pending set concatenates its categories with no
-- separators and no entry count, so a category with no entries contributes
-- zero bytes — adding one changes no preimage for any state that has nothing
-- in it, which is every state a pre-r28 checkpoint was taken over. r22's
-- argument for 007, unchanged.
--
-- **A rebuild is still required, for the reason 007 gives.** The reducer's
-- rules changed: an `A` in the scanned range is `OK` where r27 forfeited it
-- `AUCTION_NOT_IN_V1`, a `B` on an auctioned name is a bid, and the close is a
-- height effect that moves a name and creates two legs. The §8.2 log differs
-- on replay wherever an `A` appears, and every checkpoint after it with it.
-- `configFingerprint` covers configuration, not rules, so nothing refuses the
-- resume for you — every database rebuilds at r28, on both boxes
-- (docs/runbooks/deploy.md).
--
-- The three existing shape checks are rebuilt rather than left alone, as 006
-- did: each one is the complete statement of its row, and a TRANSFER row with
-- a `reserve` in it is a malformed row that a check naming only the old
-- columns would accept.

BEGIN;

ALTER TABLE pending
  ADD COLUMN reserve          NUMERIC(40, 0), -- AUCTION
  ADD COLUMN end_height       BIGINT,         -- AUCTION
  ADD COLUMN bidder           CHAR(36),       -- AUCTION: NULL until the first bid
  ADD COLUMN bid              NUMERIC(40, 0), -- AUCTION: 0 until the first bid
  ADD COLUMN bid_ref_height   BIGINT,         -- AUCTION: the standing bid's `B`
  ADD COLUMN bid_ref_tx_index INTEGER;        -- AUCTION: its §5.2 rank

ALTER TABLE pending DROP CONSTRAINT pending_kind_check;
ALTER TABLE pending ADD CONSTRAINT pending_kind_check
  CHECK (kind IN ('TRANSFER', 'OFFER', 'AUCTION', 'GOVERNANCE'));

ALTER TABLE pending DROP CONSTRAINT pending_transfer_shape;
ALTER TABLE pending DROP CONSTRAINT pending_offer_shape;
ALTER TABLE pending DROP CONSTRAINT pending_governance_shape;

ALTER TABLE pending ADD CONSTRAINT pending_transfer_shape CHECK (
  kind <> 'TRANSFER' OR (
    effective_height IS NOT NULL AND new_owner IS NOT NULL
    AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
    AND reserve IS NULL AND end_height IS NULL AND bidder IS NULL AND bid IS NULL
    AND bid_ref_height IS NULL AND bid_ref_tx_index IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_offer_shape CHECK (
  kind <> 'OFFER' OR (
    effective_height IS NULL AND seller IS NOT NULL AND price IS NOT NULL
    AND opened_height IS NOT NULL AND expiry_height IS NOT NULL
    AND new_owner IS NULL
    AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
    AND reserve IS NULL AND end_height IS NULL AND bidder IS NULL AND bid IS NULL
    AND bid_ref_height IS NULL AND bid_ref_tx_index IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_auction_shape CHECK (
  kind <> 'AUCTION' OR (
    seller IS NOT NULL AND reserve IS NOT NULL AND end_height IS NOT NULL AND bid IS NOT NULL
    AND (
      (bidder IS NULL AND bid = 0 AND bid_ref_height IS NULL AND bid_ref_tx_index IS NULL)
      OR (bidder IS NOT NULL AND bid_ref_height IS NOT NULL AND bid_ref_tx_index IS NOT NULL)
    )
    AND effective_height IS NULL AND new_owner IS NULL
    AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_governance_shape CHECK (
  kind <> 'GOVERNANCE' OR (
    name = '' AND effective_height IS NOT NULL
    AND fee_standard IS NOT NULL AND fee_long IS NOT NULL AND commission_bp IS NOT NULL
    AND new_owner IS NULL
    AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    AND reserve IS NULL AND end_height IS NULL AND bidder IS NULL AND bid IS NULL
    AND bid_ref_height IS NULL AND bid_ref_tx_index IS NULL
  )
);

COMMIT;
