-- 003 — the §10.7 buyer rebate joins the ledger as a fifth kind.
--
-- A referral now pays twice: `REFERRAL_SHARE` to the referring name's target
-- and `REFERRAL_REBATE` back to the buyer, the `G`'s effective sender (§7.2).
-- Both are policy (`share.ts`, `referral-rates.json`), owed by the treasury
-- and discharged by an `M` the reducer accepts and matches nothing against.
-- The idempotency key is unchanged in shape and still unique — one payout per
-- `(ref, kind)`, so one `G` owes at most one of each. Rows already in the
-- table are untouched; only the check widens.
--
-- The rebate exists because §6 `G` checks `value` against the band's fee: a
-- referred buyer paying less would be `INSUFFICIENT_VALUE` and refunded, so a
-- discount at the price is impossible without making referrals consensus.

ALTER TABLE obligations DROP CONSTRAINT obligations_kind_check;
ALTER TABLE obligations
  ADD CONSTRAINT obligations_kind_check
  CHECK (kind IN ('REFUND', 'SALE_PROCEEDS', 'COMMISSION', 'REFERRAL_SHARE', 'REFERRAL_REBATE'));
