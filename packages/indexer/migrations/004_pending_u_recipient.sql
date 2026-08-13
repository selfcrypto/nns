-- 004 · the pending `U` carries its recipient — r17 §6 `U`, §8.1 tag 0x09
--
-- r17 gives `U` a second behaviour, picked by the transaction recipient:
-- `PROTOCOL_ADDRESS` releases the name as before, any other address is
-- **awarded** it outright at `effective_height`. §8.1's pending entry now
-- commits that recipient's 20 bytes, so it is state the reducer needs back
-- after a restart — a column, not something re-derivable from the log.
--
-- NULL is a value here, exactly as it is for `recovery` on a RECOVERY row: it
-- is a release, which §8.1 commits as 20 zero bytes. An address is the
-- awardee — never `BURN_ADDRESS`, which §7.4 rejects (`INVALID_RECIPIENT`)
-- precisely so the zero bytes can only ever mean a release. Existing UNRESERVE
-- rows arrive with NULL and that is their meaning, not a backfill debt:
-- through r16 a release was the only thing a `U` could be.

ALTER TABLE pending ADD COLUMN recipient CHAR(36);

-- The other kinds carry no recipient. One additive check rather than reopening
-- the four per-kind shape constraints from 001; UNRESERVE itself stays
-- unconstrained on this column because NULL is meaningful there (see
-- `pending_recovery_shape`'s deliberate silence about `recovery`).
ALTER TABLE pending
  ADD CONSTRAINT pending_recipient_only_on_unreserve
  CHECK (kind = 'UNRESERVE' OR recipient IS NULL);
