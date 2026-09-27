CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  original_draft_id TEXT NOT NULL,
  history_cursor TEXT NOT NULL,
  thread_id TEXT,
  due_at INTEGER,
  pending_draft_id TEXT,
  pending_step INTEGER,
  reminder_at INTEGER,
  reminder_sent_at INTEGER,
  replied_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS followups_due_idx
  ON followups (state, due_at);

CREATE TABLE IF NOT EXISTS gmail_sync (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  history_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
