CREATE TABLE IF NOT EXISTS conversations (
  telegram_user_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_expires_at_idx
  ON conversations (expires_at);
