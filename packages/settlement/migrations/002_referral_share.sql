-- 002 — the §10.7 referral share joins the ledger as a fourth kind.
--
-- `REFERRAL_SHARE` is the one kind `core` does not create: it is policy
-- (`share.ts`, `referral-rates.json`), owed by the treasury to a referring
-- name's target, and discharged by an `M` the reducer accepts and matches
-- nothing against. The idempotency key is unchanged — one share per `G`,
-- keyed `(ref_height, ref_tx_index, 'REFERRAL_SHARE')`. Rows already in the
-- table are untouched; only the check widens.

ALTER TABLE obligations DROP CONSTRAINT obligations_kind_check;
ALTER TABLE obligations
  ADD CONSTRAINT obligations_kind_check
  CHECK (kind IN ('REFUND', 'SALE_PROCEEDS', 'COMMISSION', 'REFERRAL_SHARE'));
