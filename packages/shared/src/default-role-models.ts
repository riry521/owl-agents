import { CLAUDE_HAIKU_5_5_MODEL, CLAUDE_OPUS_5_5_MODEL, DEFAULT_HARNESS_MODELS } from "./harness-models.js";

/** Canonical defaults used by Core, workflow dispatch, and the server settings surface. */
export const DEFAULT_ROLE_MODELS = {
  advisor: { provider: "anthropic", model: CLAUDE_OPUS_5_5_MODEL, effort: "high" },
  manager: { provider: "anthropic", model: DEFAULT_HARNESS_MODELS.claude, effort: "high" },
  designer: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" },
  lead_designer: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" },
  worker: { provider: "openai", model: DEFAULT_HARNESS_MODELS.codex, effort: "high" },
  reviewer: { provider: "anthropic", model: DEFAULT_HARNESS_MODELS.claude, effort: "high" },
  librarian: { provider: "anthropic", model: CLAUDE_OPUS_5_5_MODEL, effort: "high" },
  curator: { provider: "anthropic", model: CLAUDE_HAIKU_5_5_MODEL, effort: "low" },
} as const;
