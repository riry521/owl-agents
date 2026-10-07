import { DEFAULT_HARNESS_MODELS } from "./harness-models.js";

/** Canonical defaults used by Core, workflow dispatch, and the server settings surface. */
export const DEFAULT_ROLE_MODELS = {
  advisor: { provider: "anthropic", model: "claude-opus-5", effort: "high" },
  manager: { provider: "anthropic", model: DEFAULT_HARNESS_MODELS.claude, effort: "high" },
  designer: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" },
  lead_designer: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" },
  worker: { provider: "openai", model: DEFAULT_HARNESS_MODELS.codex, effort: "high" },
  reviewer: { provider: "anthropic", model: DEFAULT_HARNESS_MODELS.claude, effort: "high" },
  librarian: { provider: "anthropic", model: "claude-opus-5", effort: "high" },
  curator: { provider: "anthropic", model: "claude-haiku-4-5-20251001", effort: "low" },
} as const;
