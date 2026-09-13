-- 011 · `reserve` is a starting price — the column says so (2026-09-04)
--
-- The first bid on an auction must meet this amount and a bid below it is
-- refunded on arrival and never stands (§6 `A`), which is a starting price:
-- public, and the least a first bid can be. "Reserve" is the eBay word for
-- something else — a hidden threshold that bids below still stand under —
-- and Kike read it that way from the app's own status line. The spec, the
-- wire field, the API field (`startingPrice`) and this column were renamed
-- together on 2026-09-04: it is a starting price, not a reserve. Bytes on
-- the wire and in the §8.1 entry are unchanged: nothing
-- here is a layout or a rules change, and no database rebuilds.
--
-- A rename carries the three shape checks with it — Postgres binds a CHECK
-- to the column, not to its name — so 010's constraints need no restating.

BEGIN;

ALTER TABLE pending RENAME COLUMN reserve TO starting_price;

COMMIT;
