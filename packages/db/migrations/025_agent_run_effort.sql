-- Records the reasoning effort each AgentRun was launched with, for display.
ALTER TABLE agent_runs ADD COLUMN effort TEXT NULL;
