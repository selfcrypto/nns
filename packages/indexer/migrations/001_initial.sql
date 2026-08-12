-- 001 · initial schema
--
-- Everything here is a projection of what `@nns/core` holds in `NnsState`,
-- plus the §8.2 log. Nothing is derived that a replay could not reproduce:
-- drop the database, replay from LAUNCH_HEIGHT, and every row comes back.
--
-- Heights are BIGINT and read back as JS `number` — the chain is nowhere near
-- 2^53. Luna amounts are NUMERIC and read back as `bigint`, never as `number`.
-- Addresses are the compact 36-character NQ form, which is what `core`'s
-- `Address` already is, so no conversion happens on the way in or out.

-- ── State: names (§8.1 leaves) ──────────────────────────────────────────────

CREATE TABLE names (
  name     TEXT     PRIMARY KEY,
  owner    CHAR(36) NOT NULL,
  target   CHAR(36) NOT NULL,
  expiry   BIGINT   NOT NULL,
  status   TEXT     NOT NULL CHECK (status IN ('REGISTERED', 'GRACE')),
  -- NULL is "unset", which §8.1 commits as 20 zero bytes.
  recovery CHAR(36),
  -- '' when no delegate resolver (§6 D). Never NULL: §8.1 length-prefixes it.
  host     TEXT     NOT NULL DEFAULT ''
);

CREATE INDEX names_owner_idx ON names (owner);
CREATE INDEX names_expiry_idx ON names (expiry);

-- ── State: the pending set (§8.1) ───────────────────────────────────────────
--
-- One table, discriminated on `kind`, because §8.1 commits these as a single
-- pending set. The CHECK constraints below are what keeps the nullable columns
-- honest: each kind must carry exactly its own fields and no others, so a
-- mis-typed insert fails at the database rather than at the next Merkle root.

CREATE TABLE pending (
  kind             TEXT NOT NULL
    CHECK (kind IN ('TRANSFER', 'RECOVERY', 'OFFER', 'GOVERNANCE', 'UNRESERVE')),
  -- '' for GOVERNANCE, which is a singleton and has no name.
  name             TEXT NOT NULL,

  effective_height BIGINT,        -- all but OFFER
  new_owner        CHAR(36),      -- TRANSFER
  via_recovery     BOOLEAN,       -- TRANSFER: waits RECOVERY_TIMELOCK, not XFER_TIMELOCK
  -- RECOVERY. NULL is meaningful here: it is a clearing operation (§6 R).
  recovery         CHAR(36),
  seller           CHAR(36),      -- OFFER
  price            NUMERIC(40, 0),-- OFFER
  opened_height    BIGINT,        -- OFFER
  expiry_height    BIGINT,        -- OFFER
  fee_standard     NUMERIC(40, 0),-- GOVERNANCE
  fee_long         NUMERIC(40, 0),-- GOVERNANCE
  commission_bp    NUMERIC(40, 0),-- GOVERNANCE

  PRIMARY KEY (kind, name),

  CONSTRAINT pending_transfer_shape CHECK (
    kind <> 'TRANSFER' OR (
      effective_height IS NOT NULL AND new_owner IS NOT NULL AND via_recovery IS NOT NULL
      AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
      AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
    )
  ),
  -- `recovery` is deliberately absent from this shape check: NULL is a value.
  CONSTRAINT pending_recovery_shape CHECK (
    kind <> 'RECOVERY' OR (
      effective_height IS NOT NULL AND new_owner IS NULL AND via_recovery IS NULL
      AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
      AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
    )
  ),
  CONSTRAINT pending_offer_shape CHECK (
    kind <> 'OFFER' OR (
      effective_height IS NULL AND seller IS NOT NULL AND price IS NOT NULL
      AND opened_height IS NOT NULL AND expiry_height IS NOT NULL
      AND new_owner IS NULL AND via_recovery IS NULL AND recovery IS NULL
      AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
    )
  ),
  CONSTRAINT pending_governance_shape CHECK (
    kind <> 'GOVERNANCE' OR (
      name = '' AND effective_height IS NOT NULL
      AND fee_standard IS NOT NULL AND fee_long IS NOT NULL AND commission_bp IS NOT NULL
      AND new_owner IS NULL AND via_recovery IS NULL AND recovery IS NULL
      AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
    )
  ),
  CONSTRAINT pending_unreserve_shape CHECK (
    kind <> 'UNRESERVE' OR (
      effective_height IS NOT NULL
      AND new_owner IS NULL AND via_recovery IS NULL AND recovery IS NULL
      AND seller IS NULL AND price IS NULL AND opened_height IS NULL AND expiry_height IS NULL
      AND fee_standard IS NULL AND fee_long IS NULL AND commission_bp IS NULL
    )
  )
);

-- Names released from RESERVED_NAMES by a `U` that has taken effect (§6 U).
-- Not part of the `pending` set — these have already fired.
CREATE TABLE unreserved (
  name TEXT PRIMARY KEY
);

-- ── State: the singleton row ────────────────────────────────────────────────
--
-- Active prices and commission (§8.1 commits them), plus the two scalars
-- `NnsState` carries. `id` is a one-value primary key so a second row is a
-- constraint violation rather than an ambiguity.

CREATE TABLE params (
  id                     BOOLEAN       PRIMARY KEY DEFAULT TRUE CHECK (id),
  fee_standard           NUMERIC(40, 0) NOT NULL,
  fee_long               NUMERIC(40, 0) NOT NULL,
  commission_bp          NUMERIC(40, 0) NOT NULL,
  -- NULL until the first accepted P (PRICE_MIN_INTERVAL, §10.6).
  last_governance_height BIGINT,
  -- The height whose scheduled effects have all been applied.
  state_height           BIGINT        NOT NULL,
  -- NULL is Infinity: nothing scheduled. A lower bound, as `core` documents.
  next_due_height        BIGINT
);

-- ── State: outstanding obligations ──────────────────────────────────────────
--
-- What a settlement `M` discharges (§6 M, §7.4). Deliberately NOT part of the
-- §8.1 commitment — settled-versus-owed is computable from the log — so the
-- checkpoint builder must never read this table.

CREATE TABLE settlements (
  ref_height   BIGINT  NOT NULL,
  ref_tx_index INTEGER NOT NULL,
  -- Position within the obligations of one transaction. Their order is
  -- significant and a set would lose it.
  ordinal      INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('REFUND', 'SALE_PROCEEDS', 'COMMISSION')),
  owed_by      CHAR(36) NOT NULL,
  owed_to      CHAR(36) NOT NULL,
  amount       NUMERIC(40, 0) NOT NULL,
  PRIMARY KEY (ref_height, ref_tx_index, ordinal)
);

CREATE INDEX settlements_owed_to_idx ON settlements (owed_to);

-- ── The NNS log (§8.2) ──────────────────────────────────────────────────────
--
-- One row per message surviving §7.5, with its verdict — including rejections,
-- so an independent replay can confirm a rejection was correct. The primary
-- key IS the canonical order: ascending block height, then ascending
-- zero-based position in the block body array (§5.2).

CREATE TABLE log (
  block_height BIGINT  NOT NULL,
  tx_index     INTEGER NOT NULL,
  tx_hash      TEXT    NOT NULL,
  sender       CHAR(36) NOT NULL,
  recipient    CHAR(36) NOT NULL,
  value        NUMERIC(40, 0) NOT NULL,
  -- Lowercase hex, never raw text (§8.2): a malformed but NNS1-prefixed
  -- payload still earns a line, and raw text could forge a line break.
  data         TEXT    NOT NULL,
  verdict      TEXT    NOT NULL,
  PRIMARY KEY (block_height, tx_index)
);

-- ── Checkpoints (§8.1) ──────────────────────────────────────────────────────
--
-- Created here so the schema is one unit. **Nothing writes it yet** — the
-- checkpoint builder is the next task.

CREATE TABLE checkpoints (
  height       BIGINT PRIMARY KEY,
  name_root    BYTEA  NOT NULL,
  prices_root  BYTEA  NOT NULL,
  pending_root BYTEA  NOT NULL,
  log_hash     BYTEA  NOT NULL,
  commitment   BYTEA  NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexer position ────────────────────────────────────────────────────────
--
-- Committed in the same transaction as the state it produced, so a crash can
-- only lose work, never half-apply a batch.

-- Quoted: `cursor` is close enough to a keyword that leaving it bare is a
-- needless bet on the parser.
CREATE TABLE "cursor" (
  id              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  -- Next batch to scan. Batch numbers are genesis-relative; see chain.ts.
  next_batch      BIGINT  NOT NULL,
  -- Macro block of the last batch fully applied. Informational.
  scanned_through BIGINT  NOT NULL,
  -- Rejects a restart against a database built under different §3 values.
  -- LAUNCH_HEIGHT or a reserved name changing under an existing database
  -- silently invalidates every row above it.
  config_fingerprint TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
