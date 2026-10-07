-- Latest plan usage (subscription rate-limit windows) per harness and origin.
-- snapshot_json keeps the last successful PlanUsageSnapshot and survives
-- failed checks; status/detail/checked_at describe the latest check. Never
-- holds credentials. Written without events (polled every few minutes).
CREATE TABLE IF NOT EXISTS plan_usage_snapshots (
  harness TEXT NOT NULL CHECK (harness IN ('claude','codex')),
  origin TEXT NOT NULL CHECK (origin IN ('claude_usage_api','claude_rate_limit_event','codex_live','codex_session_log')),
  status TEXT NOT NULL CHECK (status IN ('ok','disabled','not_configured','not_logged_in','expired','unauthorized','rate_limited','unavailable','unrecognized','error','not_installed','no_data')),
  detail TEXT NULL CHECK (detail IS NULL OR length(detail) <= 64),
  snapshot_json TEXT NULL CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
  observed_at TEXT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (harness, origin)
);
