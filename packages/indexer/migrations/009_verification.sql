-- 009 · where this database's state came from
--
-- Until `NNS_START_MODE`, there was one answer and it needed no column: every
-- row above `LAUNCH_HEIGHT` was derived by this process from the chain, and a
-- §8.4 Tier 3 replay is what produced it. `snapshot` and `hybrid` make that
-- untrue for a range, and an indexer that cannot say which range is an
-- indexer whose answers are worth less than it claims.
--
-- One row, like `cursor` and `params`. **Absence means `scratch`** — every
-- database that predates this migration was replayed from `LAUNCH_HEIGHT`,
-- and backfilling a row would mean this file knowing `LAUNCH_HEIGHT`, which
-- is `@nimiqnames/core`'s to state and not a migration's to hard-code.

BEGIN;

CREATE TABLE verification (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),

  -- The lowest height this database derived from the chain itself. For a
  -- bootstrap, the first block the scanner actually read; everything below it
  -- came from a peer's log and is Tier 1 evidence, not Tier 3.
  verified_from      BIGINT NOT NULL,

  -- The height the downloaded log was replayed through, and where it came
  -- from. NULL for a scratch database. `bootstrap_log_hash` is the §8.2 hash
  -- the peer's checkpoint committed — the one value that says *which* log was
  -- trusted, so a later dispute is about a named artefact.
  bootstrap_height   BIGINT,
  bootstrap_source   TEXT,
  bootstrap_log_hash BYTEA,

  -- How far `hybrid`'s background re-derivation has got, or NULL if it has not
  -- run. Progress only: a restart begins the sweep again from `LAUNCH_HEIGHT`,
  -- because resuming it would need the state at this height and that state is
  -- exactly what the sweep exists to derive independently.
  shadow_through     BIGINT,

  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
