-- The settlement ledger (§6 `M`, task 04 deliverable 3).
--
-- **Its own database, never a schema beside the indexer's.** The indexer's
-- database is a projection of the chain: droppable, rebuildable from
-- `LAUNCH_HEIGHT` by anyone. This one records payments that have left a hot
-- key and cannot be rebuilt from anywhere. Nothing here may ever become an
-- input to `reconcile`, which is the other half of the same rule.
--
-- ## What the keys are for
--
-- `(ref_height, ref_tx_index, kind)` is the whole idempotency story. It is the
-- `(height, tx_index)` an `M` payload names (§6 `M`) plus the leg, and it is
-- unique because a `B` owes either one REFUND or a SALE_PROCEEDS and a
-- COMMISSION, and a `G` owes one REFUND. A restart, a re-read of the log, or a
-- crash mid-broadcast all re-derive the same key from the same log line, so
-- they collide with the row that is already here instead of creating a second
-- obligation to pay.
--
-- The debt is keyed by the transaction that *created* it, never by the `M`
-- that discharges it: an `M` that was signed but never landed has no identity
-- the log can confirm, and keying by it would make every crash look like a new
-- debt.

-- ── Obligations ─────────────────────────────────────────────────────────────
--
-- One row per leg the log has ever said was owed. Rows are inserted from a
-- verified log snapshot and never from anything this service believes.
--
-- `amount`, `owed_by` and `owed_to` are the log's, recorded on first sight and
-- then immutable: a later snapshot reporting a different amount for the same
-- key is a fork, not an update, and the ledger refuses it rather than paying
-- the newer number.

CREATE TABLE obligations (
  ref_height   BIGINT   NOT NULL,
  ref_tx_index INTEGER  NOT NULL,
  kind         TEXT     NOT NULL CHECK (kind IN ('REFUND', 'SALE_PROCEEDS', 'COMMISSION')),

  owed_by      CHAR(36) NOT NULL,
  owed_to      CHAR(36) NOT NULL,
  amount       NUMERIC(40, 0) NOT NULL CHECK (amount > 0),

  -- DUE       — the log says outstanding, and no attempt is live.
  -- CLAIMED   — a transaction plan is pinned; whether it reached the network
  --             is unknown. The ambiguous state, and the only one that is.
  -- BROADCAST — a node accepted the pinned transaction and returned its hash.
  -- CONFIRMED — the log stopped listing the leg at or below a stamped
  --             checkpoint height. Terminal, and the only definition of paid.
  state        TEXT     NOT NULL CHECK (state IN ('DUE', 'CLAIMED', 'BROADCAST', 'CONFIRMED')),

  -- The checkpoint height this leg was first observed at, and the one it was
  -- observed discharged at. Both are stamped API heights (§7.2 step 3), which
  -- is the only finality this service has or needs.
  first_seen_height BIGINT NOT NULL,
  confirmed_height  BIGINT,

  -- How many plans have been pinned for this leg. > 1 means an earlier
  -- transaction was proven dead (past its validity window, still owed) and
  -- replaced — the only path that ever re-pins.
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),

  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (ref_height, ref_tx_index, kind),
  CONSTRAINT confirmed_iff_height CHECK ((state = 'CONFIRMED') = (confirmed_height IS NOT NULL)),
  CONSTRAINT attempted_states_have_attempts CHECK (state NOT IN ('CLAIMED', 'BROADCAST') OR attempt_count > 0)
);

CREATE INDEX obligations_state_idx ON obligations (state);

-- ── Attempts ────────────────────────────────────────────────────────────────
--
-- One row per *pinned transaction plan*: every field of the transaction that
-- will be signed, committed here before anything is signed or sent.
--
-- **Pinning the plan is what makes a crash mid-broadcast free.** Identical
-- re-broadcasts collapse to one transaction hash and land at most once
-- (`docs/rpc-reference.md` §4) — but only if every field is identical,
-- `validity_start_height` included. Recomputing that height from the node's
-- head on restart would produce a *different* transaction with a different
-- hash, and both would be valid: that is the double payment this table exists
-- to make impossible. So the height is stored, not derived, and recovery
-- re-sends these exact bytes.
--
-- `expires_after` is supplied by the issuer, not computed here. The validity
-- window is a chain fact the issuer already reads a node to learn; a second
-- copy of it in this package could only disagree with the first, for the same
-- reason there is no confirmation depth here.

CREATE TABLE attempts (
  ref_height   BIGINT   NOT NULL,
  ref_tx_index INTEGER  NOT NULL,
  kind         TEXT     NOT NULL,
  attempt_no   INTEGER  NOT NULL CHECK (attempt_no >= 1),

  -- PINNED    — committed, not known to have been sent.
  -- SENT      — a node returned this transaction's hash.
  -- CONFIRMED — the leg it pays stopped being outstanding in the log.
  -- EXPIRED   — proven dead: a stamped checkpoint above `expires_after` still
  --             showed the leg outstanding, so this transaction can never land.
  state        TEXT     NOT NULL CHECK (state IN ('PINNED', 'SENT', 'CONFIRMED', 'EXPIRED')),

  -- The transaction, field for field. `data` is hex, like everywhere else.
  sender       CHAR(36) NOT NULL,
  recipient    CHAR(36) NOT NULL,
  value        NUMERIC(40, 0) NOT NULL CHECK (value > 0),
  fee          NUMERIC(40, 0) NOT NULL CHECK (fee >= 0),
  data         TEXT     NOT NULL,
  validity_start_height BIGINT NOT NULL,
  expires_after         BIGINT NOT NULL,

  tx_hash      TEXT,
  -- The checkpoint height at which the leg was seen discharged, for a
  -- CONFIRMED attempt.
  settled_height BIGINT,

  pinned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,

  PRIMARY KEY (ref_height, ref_tx_index, kind, attempt_no),
  FOREIGN KEY (ref_height, ref_tx_index, kind)
    REFERENCES obligations (ref_height, ref_tx_index, kind) ON DELETE RESTRICT,

  CONSTRAINT expiry_not_before_start CHECK (expires_after >= validity_start_height),
  -- Sender and recipient must differ: a self-transaction is accepted by the
  -- RPC and silently dropped by the network, with no error at any layer.
  CONSTRAINT sender_is_not_recipient CHECK (sender <> recipient),
  CONSTRAINT pinned_has_no_hash CHECK (state <> 'PINNED' OR tx_hash IS NULL),
  CONSTRAINT sent_has_hash CHECK (state <> 'SENT' OR tx_hash IS NOT NULL),
  CONSTRAINT confirmed_has_height CHECK ((state = 'CONFIRMED') = (settled_height IS NOT NULL))
);

-- **The double-pay guard, in the schema rather than in application code.**
-- At most one attempt per obligation may be live. Two issuer processes, or one
-- process racing its own restart, both try to pin; exactly one commits and the
-- other takes a unique violation. An application-level "check then insert"
-- would leave the window open between the two statements, which is precisely
-- the window a crash likes.
CREATE UNIQUE INDEX attempts_one_live
  ON attempts (ref_height, ref_tx_index, kind)
  WHERE state IN ('PINNED', 'SENT');

CREATE INDEX attempts_tx_hash_idx ON attempts (tx_hash) WHERE tx_hash IS NOT NULL;

-- ── The source ──────────────────────────────────────────────────────────────
--
-- One row, the ledger's memory of which log it is paying against. The watcher
-- keeps the same two values in process; here they survive a restart, which is
-- the only reason this table exists.
--
-- A checkpoint height going backwards, or a log hash changing at a height
-- already seen, means an `M` already broadcast may have dropped out of the log
-- and its debt reappeared as outstanding — the one way this design can
-- double-pay. In process that refusal covers one run; here it covers every run.
--
-- `config_fingerprint` is the indexer's own function over the §3 values. A
-- ledger reused against a different deployment would key rows by heights from
-- another chain's numbering, and the mismatch would show up as debts that are
-- never confirmed.

CREATE TABLE source (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  api_url            TEXT   NOT NULL,
  config_fingerprint TEXT   NOT NULL,
  checkpoint_height  BIGINT NOT NULL,
  log_hash           TEXT   NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
