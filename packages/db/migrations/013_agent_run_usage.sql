-- Token usage of the finished run as reported by the provider CLI
-- (Claude `usage`, Codex `turn.completed.usage`), in the shared TokenUsage
-- shape {input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}.
-- NULL when the provider did not report it or the run did not finish. Hybrid
-- Worker rows hold the sum of their plan (+repair) and verdict processes;
-- Executor rows hold their own.
ALTER TABLE agent_runs ADD COLUMN usage_json TEXT NULL CHECK (usage_json IS NULL OR json_valid(usage_json));
