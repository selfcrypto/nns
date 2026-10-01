-- 014 · the cursor records which rules produced the state it points into
--
-- A reducer change resumed from the stored cursor leaves a state computed
-- under the old rules below the cursor and the new ones above it. That mix
-- matches neither, a fresh replay would derive another root, and until now
-- nothing refused it: `config_fingerprint` covers configuration, and the
-- layout column covers only §8.1's shape. `rules_version` is `core`'s
-- `RULES_VERSION` at the time the state was derived, and `Store.loadCursor`
-- refuses a resume under another, beside the two refusals already there.
--
-- **Bookkeeping, like the fingerprint.** It is in no commitment and no log
-- line, so this migration moves no root and is not a layout migration.
--
-- NULL means "written before this column existed". The first start after
-- this migration adopts the running build's version for such a database and
-- says so in the log: the migration ships with no rule change, so the claim
-- "these rules produced this state" is exactly as true as it was the day
-- before. No backfill is written here, because a migration cannot know which
-- build will start next.
--
-- `rules_accepted_from` and `rules_accepted_at` record the override
-- (`NNS_ACCEPT_RULES_VERSION`): the version the state was built under when
-- an operator declared that the change did not move this database's history.
-- A rebuild clears them, since after one the state is the new rules' own.

BEGIN;

ALTER TABLE "cursor"
  ADD COLUMN rules_version       INTEGER,
  ADD COLUMN rules_accepted_from INTEGER,
  ADD COLUMN rules_accepted_at   TIMESTAMPTZ;

COMMIT;
