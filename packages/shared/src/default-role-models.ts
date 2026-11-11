import { CLAUDE_FABLE_5_2_MODEL, CLAUDE_HAIKU_5_5_MODEL, CLAUDE_OPUS_5_5_MODEL, DEFAULT_HARNESS_MODELS } from "./harness-models.js";

/** Canonical defaults used by Core, workflow dispatch, and the server settings surface. */
export const DEFAULT_ROLE_MODELS = {
  advisor: { provider: "anthropic", model: CLAUDE_OPUS_5_5_MODEL, effort: "high" },
  manager: { provider: "anthropic", model: DEFAULT_HARNESS_MODELS.claude, effort: "high" },
  designer: { provider: "anthropic", model: CLAUDE_FABLE_5_2_MODEL, effort: "high" },
  lead_designer: { provider: "anthropic", model: CLAUDE_FABLE_5_2_MODEL, effort: "high" },
  worker: { provider: "openai", model: DEFAULT_HARNESS_MODELS.codex, effort: "high" },
  // Why not xhigh: the Fixer only runs Tasks the Worker failed twice, so it runs rarely and high costs little more, and Lead Designer also uses high.
  fixer: { provider: "anthropic", model: CLAUDE_OPUS_5_5_MODEL, effort: "high" },
  reviewer: { provider: "anthropic", model: DEFAULT_HARNESS_MODELS.claude, effort: "high" },
  librarian: { provider: "anthropic", model: CLAUDE_OPUS_5_5_MODEL, effort: "high" },
  curator: { provider: "anthropic", model: CLAUDE_HAIKU_5_5_MODEL, effort: "low" },
} as const;

export type ModelSettingRole = keyof typeof DEFAULT_ROLE_MODELS;

/** Every role that has a model setting, in the order the settings list them. */
export const MODEL_SETTING_ROLES = Object.keys(DEFAULT_ROLE_MODELS) as readonly ModelSettingRole[];

export const MODEL_SETTING_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export const MODEL_PRESET_NAME_MAX_LENGTH = 60;
