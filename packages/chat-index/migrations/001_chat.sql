-- NC chat messages, and the scan cursor. Nothing here is protocol state:
-- every row is rebuildable from the chain, so this database is disposable.

CREATE TABLE chat_messages (
  tx_hash        TEXT PRIMARY KEY,
  block_number   BIGINT NOT NULL,
  -- Milliseconds, as the node reports it (rpc-reference §3).
  timestamp      BIGINT NOT NULL,
  sender         TEXT   NOT NULL,
  recipient      TEXT   NOT NULL,
  -- The message's subject: which name it is about. Sender-asserted, stored as
  -- sent — whether it is really the recipient's name is the reader's check,
  -- and this service deliberately holds no registry state to answer it.
  name           TEXT   NOT NULL,
  message        TEXT   NOT NULL,
  -- The payload as it appeared on chain. Kept so a reader can re-parse with
  -- the same @nns/chat parser instead of trusting this service's parse.
  recipient_data TEXT   NOT NULL
);

-- Both directions of "messages involving this address", which is the only
-- query the endpoint makes.
CREATE INDEX chat_messages_recipient ON chat_messages (recipient, block_number DESC);
CREATE INDEX chat_messages_sender ON chat_messages (sender, block_number DESC);

CREATE TABLE chat_cursor (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  next_batch    BIGINT NOT NULL,
  -- The window this index can honestly claim: the height the operator started
  -- it from, and the last batch it has actually scanned.
  start_height  BIGINT NOT NULL,
  network_id    INTEGER NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
