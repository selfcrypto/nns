-- The NC payload no longer carries a subject name (docs/app-chat.md §2,
-- 2026-09-15): it is `NC1<message>`. The column held a sender-written name,
-- which is the only reason a reader ever had to disclaim one — and the app's
-- red "only the sender's claim" line went with it.
--
-- Dropping rather than leaving it empty: a nullable column nothing writes is a
-- question every future reader has to answer, and this database is disposable
-- (every row is rebuildable from the chain).
ALTER TABLE chat_messages DROP COLUMN name;
