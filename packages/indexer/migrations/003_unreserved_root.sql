-- 003 · the unreserved set's own digest on the checkpoint row
--
-- r16 §8.1 binds a sixth component, the unreserved set under tag `0x0A`
-- (migration `002` records why the layout column exists and what it means).
-- The commitment covering it is not enough on its own.
--
-- The per-component columns are what turn "these two indexers disagree" into
-- "they disagree about the pending set". Without a column for the unreserved
-- set, the one disagreement `0x0A` was added to catch — two indexers differing
-- only about which reserved names have been released — presents as four
-- matching digests and a different `commitment`: you know something diverged
-- and have nothing that says what. That is the exact shape of failure this
-- component exists to make visible, so it gets a column like the rest.
--
-- **Nullable, on purpose.** A layout `1` row was produced by a function that
-- had no such digest. Its value there is not unknown, it does not exist, and
-- writing 32 zero bytes would invent one — worse, it would collide with the
-- empty *name tree*, whose empty form really is 32 zeros, while the unreserved
-- set's empty form is `keccak256(0x0A)`. So the column is NULL exactly for r15
-- rows, and the CHECK pins that in both directions rather than leaving it a
-- convention the writer has to remember.

ALTER TABLE checkpoints ADD COLUMN unreserved_root BYTEA;

ALTER TABLE checkpoints
  ADD CONSTRAINT checkpoints_unreserved_root_matches_layout
  CHECK ((layout >= 2) = (unreserved_root IS NOT NULL));
