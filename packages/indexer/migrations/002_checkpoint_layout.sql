-- 002 · which §8.1 commitment function produced a checkpoint row
--
-- §8.1 as of r15 commits the name tree, the prices, the pending set, the log
-- hash and the height. It does **not** commit the unreserved set — names whose
-- `U` has already fired — which is a known gap being fixed separately (see
-- `src/checkpoint.ts`). Closing it changes the value of every checkpoint ever
-- computed, and a 32-byte column gives no hint that the function behind it
-- moved.
--
-- So the function gets a version. `1` is r15's layout; the commit that closes
-- the gap bumps `COMMITMENT_LAYOUT` and every row below the bump stays
-- knowably a different derivation rather than a mismatch nobody can explain.

ALTER TABLE checkpoints ADD COLUMN layout SMALLINT NOT NULL DEFAULT 1;

-- The default exists only for this ALTER; the builder always writes the column
-- explicitly, and a row that arrived without one would be claiming a layout it
-- never asserted.
ALTER TABLE checkpoints ALTER COLUMN layout DROP DEFAULT;
