-- 008 · the name leaf gains an EVM address — r26 §6 `E`, §8.1
--
-- r26 added the `E` message: the owner binds one 20-byte EVM address to the
-- name, and the address entered the §8.1 leaf between `target` and `expiry`
-- (20 zero bytes when unset). Stored as text in the display form the rest of
-- the stack uses — lowercase `0x`-hex, `''` when unset — exactly as `host`
-- stores the §6 `D` record.
--
-- **This is a layout migration, and the resync rule of 006 applies.** Every
-- root this database ever wrote is a layout-4 root and none of them can be
-- reproduced under r26 rules, so `COMMITMENT_LAYOUT` goes to 5 and every
-- layout-4 database is dropped and resynced, as every layout-3 database was
-- at r20. The columns are added rather than the tables rebuilt only so a
-- throwaway test database migrates forward; a database holding layout-4
-- checkpoints is a pre-r26 database and resyncs from scratch.

BEGIN;

-- The name leaf's field. Present in `names` (live state) and in
-- `checkpoint_names` (the §8.3 proof-serving snapshot, migration 005).
ALTER TABLE names            ADD COLUMN evm TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoint_names ADD COLUMN evm TEXT NOT NULL DEFAULT '';

COMMIT;
