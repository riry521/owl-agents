-- Records the SHA-256 of the system prompt an Advisor session was started or
-- resumed with, so a suspended session is only resumed under the same prompt.
ALTER TABLE advisor_sessions ADD COLUMN system_prompt_sha256 TEXT NULL;
