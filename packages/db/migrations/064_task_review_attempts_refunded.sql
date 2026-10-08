-- Review attempts handed back to the Task by Manager replans (review_focus.replan_refund, capped by review_focus.refund_limit).
ALTER TABLE tasks ADD COLUMN review_attempts_refunded INTEGER NOT NULL DEFAULT 0;
