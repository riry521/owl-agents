import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

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

let refreshedCodexCatalog: CodexCatalogModel[] | null = null;

/**
 * The Codex models from the last app-server refresh, followed by any others in
 * the local catalog. Other Codex clients rewrite that file with their own
 * version's list, so it alone can lag behind.
 */
function codexModelCatalog(env: NodeJS.ProcessEnv): CodexCatalogModel[] | null {
  const local = readCodexModelCatalog(env);
  if (!refreshedCodexCatalog) return local;
  const seen = new Set(refreshedCodexCatalog.map(({ slug }) => slug));
  return [...refreshedCodexCatalog, ...(local ?? []).filter(({ slug }) => !seen.has(slug))];
}

/** Every Codex model id Owl accepts: the Codex catalog plus the built-in list. */
export function codexKnownModels(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set([...(codexModelCatalog(env) ?? []).map(({ slug }) => slug), ...CODEX_BUILTIN_MODELS]);
}

export async function mergeOfficialModels(
  stored: Record<string, string[]>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string[]>> {
  const result = Object.fromEntries(Object.entries(stored).map(([id, models]) => [id, [...models]]));
  const codex = codexModelCatalog(env);
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

const CODEX_REFRESH_TIMEOUT_MS = 20_000;

export interface CodexRefreshOptions {
  readonly executable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

function findCodexExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.OWL_CODEX_EXECUTABLE?.trim();
  if (configured) return isAbsolute(configured) ? configured : undefined;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "codex");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep checking the next PATH component.
    }
  }
  return undefined;
}

function codexModelListResult(result: unknown): CodexCatalogModel[] {
  const data = result && typeof result === "object" ? (result as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const models: CodexCatalogModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const { model, id, hidden } = entry as { model?: unknown; id?: unknown; hidden?: unknown };
    const slug = typeof model === "string" && model.trim() ? model.trim() : typeof id === "string" ? id.trim() : "";
    if (slug && !models.some((known) => known.slug === slug)) models.push({ slug, listed: hidden !== true });
  }
  return models;
}

function runCodexModelList(executable: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CodexCatalogModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    let settled = false;
    const finish = (error?: Error, models: CodexCatalogModel[] = []): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Let the app-server finish writing its catalog before it is forced down.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      if (error) reject(error);
      else resolve(models);
    };
    const timer = setTimeout(() => finish(new Error("timed out")), timeoutMs);
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish(new Error("app-server exited")));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.error) finish(new Error(message.error.message ?? "app-server error"));
      else if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "model/list", params: { includeHidden: true } });
      } else if (message.id === 2) {
        const models = codexModelListResult(message.result);
        if (models.length === 0) finish(new Error("model/list returned no models"));
        else finish(undefined, models);
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "owl", title: "Owl", version: "0" } } });
  });
}

let codexRefresh: Promise<boolean> | null = null;

/** Asks the Codex app-server for its current model list and keeps it for the model selectors. */
export function refreshCodexModelCatalog(options: CodexRefreshOptions = {}): Promise<boolean> {
  if (codexRefresh) return codexRefresh;
  const env = options.env ?? process.env;
  codexRefresh = (async () => {
    try {
      const executable = options.executable ?? findCodexExecutable(env);
      if (!executable) throw new Error("codex executable not found");
      refreshedCodexCatalog = await runCodexModelList(executable, env, options.timeoutMs ?? CODEX_REFRESH_TIMEOUT_MS);
      return true;
    } catch (error) {
      console.warn("[owl-server] Could not refresh Codex model catalog", error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      codexRefresh = null;
    }
  })();
  return codexRefresh;
}
