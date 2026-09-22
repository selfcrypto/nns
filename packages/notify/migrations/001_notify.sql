-- The notifier's own state (tasks/26). Nothing here is protocol: every event
-- is re-derivable from the public log, and every row is somebody's contact,
-- which is why this database is the one in the workspace that holds personal
-- data and why the delete paths below are part of the schema's contract.

-- A challenge the app asked for and has not yet signed. Short-lived; swept.
CREATE TABLE challenges (
  nonce       TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  text        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- A signed-in address. The token itself is never stored, only its hash.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  last_used   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_address ON sessions (address);

-- Where an address is reached. `target` is an email address or a Telegram
-- chat id. An email starts unconfirmed and carries its confirmation token
-- (hashed); a Telegram row is born confirmed, since the /start tap is the
-- confirmation. `unsubscribe_token` is the one-click capability every
-- message carries; stored as is, because a link is built from it and all
-- it can do is delete the row it names.
CREATE TABLE contacts (
  id                BIGSERIAL PRIMARY KEY,
  address           TEXT NOT NULL,
  channel           TEXT NOT NULL CHECK (channel IN ('email', 'telegram')),
  target            TEXT NOT NULL,
  confirmed         BOOLEAN NOT NULL DEFAULT FALSE,
  confirm_hash      TEXT,
  confirm_expires   TIMESTAMPTZ,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  failures          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (address, channel, target)
);
CREATE INDEX contacts_address ON contacts (address);
CREATE INDEX contacts_confirm ON contacts (confirm_hash) WHERE confirm_hash IS NOT NULL;
CREATE INDEX contacts_telegram ON contacts (target) WHERE channel = 'telegram';

-- A deep link the app showed and the bot has not yet received. Swept.
CREATE TABLE telegram_links (
  token_hash  TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Which event categories an address wants. No row means all of them.
CREATE TABLE preferences (
  address   TEXT PRIMARY KEY,
  renewal   BOOLEAN NOT NULL DEFAULT TRUE,
  market    BOOLEAN NOT NULL DEFAULT TRUE,
  transfer  BOOLEAN NOT NULL DEFAULT TRUE,
  chat      BOOLEAN NOT NULL DEFAULT TRUE
);

-- Send-once. A restarted service that re-sends a year of milestones is the
-- failure that gets the sending domain blocked, so a delivery is recorded
-- here the moment it succeeds and checked before every send.
CREATE TABLE sent (
  address     TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  contact_id  BIGINT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (address, event_key, contact_id)
);

-- Where the two tails are: the checkpoint the log was last read through, and
-- the chat height the index was last read through.
CREATE TABLE cursor (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  checkpoint_height  BIGINT NOT NULL,
  chat_height        BIGINT,
  network_id         INTEGER NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
