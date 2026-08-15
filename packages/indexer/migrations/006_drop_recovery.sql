-- 006 · the recovery address is gone — r20 §6, §8.1
--
-- r20 removed the `R` message and the recovery address with it. The mechanism
-- never defended against the key it existed to defend against: a holder of the
-- owner key deleted a pending recovery-initiated `X` with a bare `K` at
-- `DUST_VALUE`, indefinitely, and `O` + `B` moved a name in two blocks while
-- clearing the recovery field outright. See docs/decisions.md.
--
-- **This is a layout migration, and it is destructive by design.** The §8.1
-- name leaf lost its `recovery:20B` field and the pending-transfer entry lost
-- its trailing `via_recovery:u8`, so every root this database ever wrote is an
-- r19 root and none of them can be reproduced under r20 rules. Migrating the
-- rows forward would leave `checkpoints` full of values that no replay
-- reproduces — the exact silent divergence the checkpoint layout exists to
-- catch. So `COMMITMENT_LAYOUT` goes to 4 and every layout-3 database is
-- dropped and resynced, as every layout-1 database was at r16.
--
-- Dropping the columns rather than leaving them nullable is deliberate: a
-- column that still exists is a column a future reader can populate, and the
-- one thing that must never come back is a second authorised sender.

BEGIN;

-- The name leaf's field. Present in `names` (live state) and in
-- `checkpoint_names` (the §8.3 proof-serving snapshot, migration 005).
ALTER TABLE names            DROP COLUMN recovery;
ALTER TABLE checkpoint_names DROP COLUMN recovery;

-- Every shape constraint below names `via_recovery` or `recovery`, so each is
-- rebuilt rather than edited. Dropping the columns alone would leave the
-- CHECKs referring to columns that no longer exist.
ALTER TABLE pending DROP CONSTRAINT pending_transfer_shape;
ALTER TABLE pending DROP CONSTRAINT pending_recovery_shape;
ALTER TABLE pending DROP CONSTRAINT pending_offer_shape;
ALTER TABLE pending DROP CONSTRAINT pending_governance_shape;
ALTER TABLE pending DROP CONSTRAINT pending_unreserve_shape;

-- RECOVERY rows first: the kind CHECK below would reject them.
DELETE FROM pending WHERE kind = 'RECOVERY';

ALTER TABLE pending DROP COLUMN via_recovery;
ALTER TABLE pending DROP COLUMN recovery;

ALTER TABLE pending DROP CONSTRAINT pending_kind_check;
ALTER TABLE pending ADD CONSTRAINT pending_kind_check
  CHECK (kind IN ('TRANSFER', 'OFFER', 'GOVERNANCE', 'UNRESERVE'));

ALTER TABLE pending ADD CONSTRAINT pending_transfer_shape CHECK (
  kind <> 'TRANSFER' OR (
    effective_height IS NOT NULL AND new_owner IS NOT NULL
    AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_offer_shape CHECK (
  kind <> 'OFFER' OR (
    effective_height IS NULL AND seller IS NOT NULL AND price IS NOT NULL
    AND opened_height IS NOT NULL AND expiry_height IS NOT NULL
    AND new_owner IS NULL
    AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_governance_shape CHECK (
  kind <> 'GOVERNANCE' OR (
    name = '' AND effective_height IS NOT NULL
    AND fee_standard IS NOT NULL AND fee_long IS NOT NULL AND commission_bp IS NOT NULL
    AND new_owner IS NULL
    AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
  )
);
ALTER TABLE pending ADD CONSTRAINT pending_unreserve_shape CHECK (
  kind <> 'UNRESERVE' OR (
    effective_height IS NOT NULL
    AND new_owner IS NULL
    AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
  )
);

COMMIT;
