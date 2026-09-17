-- 013 · a rules rebuild replayed this database's own §8.2 log
--
-- Every reducer revision is a rebuild (root CLAUDE.md), and until now a
-- rebuild meant dropping the database and replaying the chain from
-- `LAUNCH_HEIGHT` with the registry down for the whole of it. The `log` table
-- is the same input in a shorter form: every NNS-bearing transaction since
-- `LAUNCH_HEIGHT`, in canonical order, with the fields the reducer consumes.
-- Replaying it re-derives every verdict and every root without a peer, a
-- commitment to match, or a node.
--
-- What that costs is one thing, and it is recorded here rather than inferred:
-- over the rebuilt range the *membership* of the log was derived from the
-- chain under the **previous** revision's rules. A revision that leaves
-- membership and the stored fields alone (the declaration `--log-preserving`
-- makes, and which the rebuild re-checks line by line) makes that a
-- distinction without a difference — but only a chain replay proves it, and
-- that replay is `hybrid`'s sweep, which clears these columns when it agrees.
--
-- They are deliberately **not** `verified_from`. That column means "the lowest
-- height this database derived from the chain itself", and after a log rebuild
-- every height still was — under the rules of the revision before this one.
-- Moving it would under-claim; leaving it alone with nothing else written
-- would over-claim.

BEGIN;

ALTER TABLE verification
  -- The `CONSTANTS.SPEC_REVISION` the rebuild ran under. NULL once the sweep
  -- has re-derived the range from the chain, or for a database never rebuilt.
  ADD COLUMN rebuilt_revision INTEGER,
  -- The highest height the rebuild replayed through — `cursor.scanned_through`
  -- at the time, since the rebuild leaves the cursor exactly where it was.
  ADD COLUMN rebuilt_through  BIGINT,
  ADD COLUMN rebuilt_at       TIMESTAMPTZ;

COMMIT;
