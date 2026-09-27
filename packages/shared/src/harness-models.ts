/** Agent CLIs Owl runs models through. */
export type ModelHarness = "claude" | "codex";

/** Model each harness uses when no role or Executor setting names one. */
export const DEFAULT_HARNESS_MODELS: Readonly<Record<ModelHarness, string>> = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-terra",
};

/**
 * Codex model slugs Owl accepts without reading the Codex CLI's local model
 * catalog. The catalog adds to this list; it never removes from it.
 */
export const CODEX_BUILTIN_MODELS: readonly string[] = [
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-reserve",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "codex-auto-review",
];

/**
 * Harness of a built-in provider id. Custom providers return null: their
 * endpoints serve models Owl cannot enumerate.
 */
export function builtinProviderHarness(providerId: string): ModelHarness | null {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "claude") return "claude";
  if (normalized === "openai" || normalized === "codex" || normalized === "openai/codex") return "codex";
  return null;
}

export interface CodexCatalogModel {
  readonly slug: string;
  /** False for models the Codex CLI hides from its own model picker. */
  readonly listed: boolean;
}

/**
 * Parse the Codex CLI's `models_cache.json` (`{ models: [{ slug, visibility }] }`).
 * Returns the models in catalog order; malformed entries are skipped.
 */
export function parseCodexModelsCache(text: string): CodexCatalogModel[] {
  const parsed = JSON.parse(text) as unknown;
  const models = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { models?: unknown }).models
    : undefined;
  if (!Array.isArray(models)) throw new Error("Codex model catalog has no models list");
  const seen = new Set<string>();
  const result: CodexCatalogModel[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const { slug, visibility } = entry as { slug?: unknown; visibility?: unknown };
    if (typeof slug !== "string" || slug.trim().length === 0 || seen.has(slug.trim())) continue;
    seen.add(slug.trim());
    result.push({ slug: slug.trim(), listed: visibility === undefined || visibility === "list" });
  }
  return result;
}
