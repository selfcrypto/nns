-- 007 · a `U` executes on landing, so nothing about one is ever pending — r22 §6 `U`, §8.1
--
-- r22 took `U` out of `GOVERNANCE_DELAY`. A notice window protects parties who
-- can act on the warning, and a `U` has none: an award has no counterparty at
-- all, and the only party a scheduled release warns is a frontrunner, who gets
-- a publicly timed starting gun out of it. See docs/decisions.md.
--
-- **This is NOT a layout migration.** `COMMITMENT_LAYOUT` stayed 4 here
-- (r26's bump to 5 is migration 008's `evm` leaf field), and every
-- root this database ever wrote is still reproducible under r22 rules. §8.1's
-- pending set concatenates its categories with no separators and no entry
-- count, so a category with no entries contributes zero bytes — removing it
-- changes no preimage for any state that had nothing pending in it, which is
-- every state a checkpoint was ever taken over here and every state r22 admits.
--
-- **A rebuild is still required, for a different reason.** The reducer's rules
-- changed: a `U` in the scanned range now fires in its landing block rather
-- than a day later, an r21-format `U` (which carried `|<effective_height>`) is
-- `MALFORMED_PAYLOAD`, and `INSUFFICIENT_NOTICE` and `UNRESERVE_PENDING` are no
-- longer reachable for it. So the §8.2 log differs on replay wherever a `U`
-- appears, and with it every checkpoint after that point. `configFingerprint`
-- covers configuration, not rules, so nothing refuses the resume for you — this
-- file is the record that it must not happen.
--
-- Dropping the kind and the column rather than leaving them unused follows 006:
-- a row shape that still exists is one a future reader can populate, and a
-- pending `U` is exactly what must not come back without the notice window it
-- was the mechanism for.

BEGIN;

-- UNRESERVE rows first: the kind CHECK below would reject them.
DELETE FROM pending WHERE kind = 'UNRESERVE';

-- Both constraints name `recipient`, so each has to go before the column does.
ALTER TABLE pending DROP CONSTRAINT pending_recipient_only_on_unreserve;
ALTER TABLE pending DROP CONSTRAINT pending_unreserve_shape;

-- Added by 004 for the r17 award recipient, and needed by nothing else: the
-- other three kinds carry no recipient, which is what the constraint above said.
ALTER TABLE pending DROP COLUMN recipient;

ALTER TABLE pending DROP CONSTRAINT pending_kind_check;
ALTER TABLE pending ADD CONSTRAINT pending_kind_check
  CHECK (kind IN ('TRANSFER', 'OFFER', 'GOVERNANCE'));

COMMIT;
