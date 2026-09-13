-- 012 · one governed price — the 2026-09-11 fold of r29 (§3, §10.1, §8.1)
--
-- The fold replaced the two governed fees with one: `FEE_BASE` is the 12+
-- fee, and every shorter band is a frozen multiple of it (`core`'s
-- `FEE_MULTIPLIERS`, read through `feeMultiplier`). `P` carries one price,
-- so the prices singleton and the pending-`P` row carry one price. The
-- column kept is `fee_long`, renamed — it *was* the 12+ fee, and the era
-- profile on the tempo branch reads the same way (`FEE_LONG` 4 NIM became
-- `FEE_BASE` 4 NIM). `fee_standard` is dropped: nothing derives it any more,
-- and a column that still exists is a column a reader can populate.
--
-- **This is a layout migration, and the resync rule of 006 and 008
-- applies — but for a different reason than theirs.** §8.1's prices digest
-- lost a field (tag 0x03 over `fee_base ‖ commission_bp`), so every
-- commitment this database ever wrote is a layout-5 commitment and none is
-- reproducible under the fold's rules. `COMMITMENT_LAYOUT` goes to 6. The
-- log moves too: a name shorter than 12 characters paying the old flat fee
-- is refunded under the bands, and a `U` that awards an unreserved name is
-- `OK` where it forfeited `NAME_NOT_RESERVED`. Nothing in this database
-- survives the fold, so every layout-5 database is dropped and resynced,
-- as every layout-4 database was at r26.
--
-- The columns are altered rather than the tables rebuilt only so a throwaway
-- test database migrates forward from empty. A database holding layout-5
-- checkpoints is refused at startup by `Store.assertLayout` — the first
-- layout bump since the column was added, and the first time the column
-- refuses anything rather than only labelling it. `configFingerprint` covers
-- configuration, not rules, and would resume this database silently wrong.
--
-- The four shape checks each name both fee columns, so each is rebuilt, as
-- 006 and 010 did: each is the complete statement of its row, and a check
-- naming only the surviving column would accept a row it should not.

BEGIN;

-- The constraints go first: Postgres drops a CHECK that names a dropped
-- column on its own, and a DROP CONSTRAINT after the column would find
-- nothing to drop.
ALTER TABLE pending DROP CONSTRAINT pending_transfer_shape;
ALTER TABLE pending DROP CONSTRAINT pending_offer_shape;
ALTER TABLE pending DROP CONSTRAINT pending_auction_shape;
ALTER TABLE pending DROP CONSTRAINT pending_governance_shape;

ALTER TABLE params  RENAME COLUMN fee_long TO fee_base;
ALTER TABLE params  DROP   COLUMN fee_standard;
ALTER TABLE pending RENAME COLUMN fee_long TO fee_base;
ALTER TABLE pending DROP   COLUMN fee_standard;

ALTER TABLE pending ADD CONSTRAINT pending_transfer_shape CHECK (
  kind <> 'TRANSFER' OR (
    effective_height IS NOT NULL AND new_owner IS NOT NULL
    AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    AND fee_base IS NULL AND commission_bp IS NULL
    AND starting_price IS NULL AND end_height IS NULL AND bidder IS NULL AND bid IS NULL
    AND bid_ref_height IS NULL AND bid_ref_tx_index IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_offer_shape CHECK (
  kind <> 'OFFER' OR (
    effective_height IS NULL AND seller IS NOT NULL AND price IS NOT NULL
    AND opened_height IS NOT NULL AND expiry_height IS NOT NULL
    AND new_owner IS NULL
    AND fee_base IS NULL AND commission_bp IS NULL
    AND starting_price IS NULL AND end_height IS NULL AND bidder IS NULL AND bid IS NULL
    AND bid_ref_height IS NULL AND bid_ref_tx_index IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_auction_shape CHECK (
  kind <> 'AUCTION' OR (
    seller IS NOT NULL AND starting_price IS NOT NULL AND end_height IS NOT NULL AND bid IS NOT NULL
    AND (
      (bidder IS NULL AND bid = 0 AND bid_ref_height IS NULL AND bid_ref_tx_index IS NULL)
      OR (bidder IS NOT NULL AND bid_ref_height IS NOT NULL AND bid_ref_tx_index IS NOT NULL)
    )
    AND effective_height IS NULL AND new_owner IS NULL
    AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    AND fee_base IS NULL AND commission_bp IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_governance_shape CHECK (
  kind <> 'GOVERNANCE' OR (
    name = '' AND effective_height IS NOT NULL
    AND fee_base IS NOT NULL AND commission_bp IS NOT NULL
    AND new_owner IS NULL
    AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    AND starting_price IS NULL AND end_height IS NULL AND bidder IS NULL AND bid IS NULL
    AND bid_ref_height IS NULL AND bid_ref_tx_index IS NULL
  )
);

COMMIT;
