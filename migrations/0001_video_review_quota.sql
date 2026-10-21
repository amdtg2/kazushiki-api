-- Persistent video review usage (UTC calendar months). D1 uniqueness makes reservations atomic.
CREATE TABLE IF NOT EXISTS video_review_quota (
  account_id TEXT NOT NULL,
  month_key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY(account_id, month_key)
);
