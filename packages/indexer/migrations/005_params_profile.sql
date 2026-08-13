-- 005 · the constants profile rides on `params` — mainnet stays NULL
--
-- `NnsState.profile` is optional with **absent meaning `mainnet`** (the
-- profiles decision in docs/decisions.md), and this column mirrors that
-- convention exactly: NULL is mainnet, so every database written before
-- profiles existed reads back unchanged, object shape included. A non-NULL
-- value is the profile the state evolves under ('fast'), stamped by
-- `initialState` and copied verbatim through every reduce — restoring it here
-- is what lets a restarted indexer keep advancing a fast state under fast
-- timings instead of silently under mainnet ones.
--
-- No CHECK on the value: which names are profiles is core's rule
-- (`isProfileName`), and `stateFromRows` rejects anything core does not know.

ALTER TABLE params ADD COLUMN profile TEXT;
