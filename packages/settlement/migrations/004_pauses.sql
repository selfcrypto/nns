-- 004 — the issuer's pauses (`guards.ts`).
--
-- A guard that does not hold stops the issuer until a person acts, and that
-- has to survive a restart: a process that forgot why it stopped would start
-- paying again. So the pause is a row here, beside the debts it protects, and
-- the issuer reads it before every pass.
--
-- Append-only. A release closes the row and never deletes it, so the table is
-- also the record of every time a guard fired and who let the issuer go on.
--
-- Nothing about a debt changes while the issuer is paused: `obligations` and
-- `attempts` keep moving with the log exactly as before. A pinned plan stays
-- pinned, and one that outlives its window is expired by the rule that
-- already exists. That is what makes a release a continuation rather than a
-- restart.

CREATE TABLE pauses (
  id           BIGSERIAL   PRIMARY KEY,
  reason       TEXT        NOT NULL CHECK (reason IN ('UNBACKED', 'DEPOSIT_MISMATCH', 'INSOLVENT', 'DAILY_CAP')),
  -- `<height>:<txIndex>:<KIND>` of the leg the guard stopped on, where one did.
  leg_key      TEXT,
  detail       TEXT        NOT NULL,
  paused_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  released_at  TIMESTAMPTZ,
  release_note TEXT,
  -- The operator looked at `leg_key` and said to pay it anyway. That leg, and
  -- only that leg, is exempt from the deposit guards from then on.
  approved     BOOLEAN     NOT NULL DEFAULT FALSE,

  CONSTRAINT released_with_note CHECK ((released_at IS NULL) = (release_note IS NULL)),
  CONSTRAINT approved_names_a_leg CHECK (NOT approved OR (leg_key IS NOT NULL AND released_at IS NOT NULL))
);

-- One open pause at a time: the issuer is paused or it is not.
CREATE UNIQUE INDEX pauses_one_open ON pauses ((TRUE)) WHERE released_at IS NULL;
