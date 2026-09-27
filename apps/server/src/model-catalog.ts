import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CODEX_BUILTIN_MODELS,
  parseCodexModelsCache,
  type CodexCatalogModel,
} from "../../../packages/shared/dist/index.js";

/** Public model catalogs used by the built-in provider selectors. */
const SOURCES = {
  anthropic: "https://platform.claude.com/docs/en/models/overview.md",
} as const;

const CACHE_MS = 6 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 4_000;

type BuiltinProvider = keyof typeof SOURCES;

const cache = new Map<BuiltinProvider, { models: string[]; expiresAt: number }>();
const pending = new Map<BuiltinProvider, Promise<string[]>>();

export function parseAnthropicModels(markdown: string): string[] {
  const row = markdown.split("\n").find((line) => /^\|\s*Claude API ID\s*\|/u.test(line));
  if (!row) return [];
  return [...new Set([...row.matchAll(/`(claude-[a-z0-9-]+)`/gu)].map((match) => match[1]))];
}

export async function getOfficialModels(provider: BuiltinProvider): Promise<string[]> {
  const cached = cache.get(provider);
  if (cached && cached.expiresAt > Date.now()) return [...cached.models];
  const inFlight = pending.get(provider);
  if (inFlight) return [...await inFlight];

  const request = (async () => {
    const response = await fetch(SOURCES[provider], { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Model catalog returned ${response.status}`);
    const markdown = await response.text();
    const models = parseAnthropicModels(markdown);
    if (models.length === 0) throw new Error("Model catalog contained no supported models");
    cache.set(provider, { models, expiresAt: Date.now() + CACHE_MS });
    return models;
  })();
  pending.set(provider, request);
  try {
    return [...await request];
  } catch (error) {
    cache.set(provider, { models: cached?.models ?? [], expiresAt: Date.now() + 10 * 60_000 });
    if (cached?.models.length) return [...cached.models];
    throw error;
  } finally {
    pending.delete(provider);
  }
}

/** Location of the model catalog the Codex CLI keeps under its home directory. */
export function codexModelsCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "models_cache.json");
}

/** Models the local Codex CLI accepts, or null when its catalog cannot be read. */
export function readCodexModelCatalog(env: NodeJS.ProcessEnv = process.env): CodexCatalogModel[] | null {
  try {
    const models = parseCodexModelsCache(readFileSync(codexModelsCachePath(env), "utf8"));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/** Every Codex model id Owl accepts: the local catalog plus the built-in list. */
export function codexKnownModels(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set([...(readCodexModelCatalog(env) ?? []).map(({ slug }) => slug), ...CODEX_BUILTIN_MODELS]);
}

export async function mergeOfficialModels(
  stored: Record<string, string[]>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string[]>> {
  const result = Object.fromEntries(Object.entries(stored).map(([id, models]) => [id, [...models]]));
  const codex = readCodexModelCatalog(env);
  if (codex) {
    const listed = codex.filter((model) => model.listed).map(({ slug }) => slug);
    result.openai = [...new Set([...listed, ...(result.openai ?? [])])];
  }
  await Promise.all((Object.keys(SOURCES) as BuiltinProvider[]).map(async (provider) => {
    try {
      const official = await getOfficialModels(provider);
      result[provider] = [...new Set([...official, ...(result[provider] ?? [])])];
    } catch (error) {
      // Keep the saved list available when the documentation site is offline.
      console.warn(`[owl-server] Could not refresh ${provider} model catalog`, error instanceof Error ? error.message : String(error));
    }
  }));
  return result;
}
