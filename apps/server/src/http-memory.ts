import { ApiError } from "./errors.js";
import type { GuardTokenAgent } from "../../../packages/shared/dist/guard-token.js";
import type { MemoryNoteType, MemoryRequestContext } from "../../../packages/core/dist/memory/memory-types.js";
import type { MemoryHealth, MemoryExpandOutput, MemoryRecallOutput, MemoryReindexOutput, MemorySearchOutput, PageReadOutput, PageSearchOutput } from "../../../packages/core/dist/memory/memory-service.js";
import type { MemorySearchInput } from "../../../packages/core/dist/memory/memory-search.js";

export const MEMORY_OPERATIONS: ReadonlySet<string> = new Set(["search", "expand", "recall", "health", "reindex", "index", "page", "pages/search", "mode"]);
/** Operations answered to GET; the rest are POST. */
export const MEMORY_GET_OPERATIONS: ReadonlySet<string> = new Set(["health", "mode"]);

/** The Core memory window (`core.memory`). */
interface MemoryApiPort {
  search(input: MemorySearchInput, ctx: MemoryRequestContext): Promise<MemorySearchOutput>;
  expand(input: { note: string; include_body?: boolean; max_bytes?: number }, ctx: MemoryRequestContext): Promise<MemoryExpandOutput>;
  recall(input: { topic?: string; types?: MemoryNoteType[]; limit?: number; explain?: boolean }, ctx: MemoryRequestContext): Promise<MemoryRecallOutput>;
  health(): Promise<MemoryHealth>;
  reindex(input: { mode: "diff" | "full" }): Promise<MemoryReindexOutput>;
  // Theme-page tools; an older Core lacks them (503), and its mode is legacy.
  mode?(): "pages";
  readIndex?(input: { project_id?: string | null }, ctx: MemoryRequestContext): Promise<PageReadOutput>;
  page?(input: { page: string; sections?: readonly string[] }, ctx: MemoryRequestContext): Promise<PageReadOutput>;
  searchPages?(input: { query: string; include_work_log?: boolean }, ctx: MemoryRequestContext): Promise<PageSearchOutput>;
}

const METHODS = ["search", "expand", "recall", "health", "reindex"] as const;
const isMemoryApi = (value: unknown): value is MemoryApiPort =>
  typeof value === "object" && value !== null && METHODS.every((m) => typeof (value as Record<string, unknown>)[m] === "function");

/** Resolves `core.memory`, falling back to the ExternalCoreAdapter's wrapped `.core`; 503 when absent. */
export function requireMemoryApi(core: unknown): MemoryApiPort {
  const memoryOf = (c: unknown): unknown => (typeof c === "object" && c !== null ? (c as { memory?: unknown }).memory : undefined);
  const candidate = [memoryOf(core), memoryOf((core as { core?: unknown } | null)?.core)].find(isMemoryApi);
  if (!candidate) throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support the memory API.");
  return candidate;
}

const TYPES = new Set(["preference", "decision", "lesson", "procedure", "reference", "overview", "north-star", "reflection", "log", "raw"]);
const SCOPES = new Set(["global", "project", "all"]);
const bad = (message: string): ApiError => new ApiError(400, "validation_error", message);

function field<T>(body: Record<string, unknown>, key: string, ok: (v: unknown) => v is T): T | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!ok(value)) throw bad(`${key}が不正です。`);
  return value;
}
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2000;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isInt = (max: number) => (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
const isTypes = (v: unknown): v is MemoryNoteType[] => Array.isArray(v) && v.length <= 10 && v.every((t) => typeof t === "string" && TYPES.has(t));
const isMode = (v: unknown): v is "diff" | "full" => v === "diff" || v === "full";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 20 && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 200);
const isScope = (v: unknown): v is "global" | "project" | "all" => typeof v === "string" && SCOPES.has(v);

/** Design §7/§11 injection limits per role. Core does not report injection yet, so this stands in until it does. */
const INJECTION_DEFAULT = {
  enabled: false,
  last_injection_at: null,
  limits_by_role: {
    advisor_session_start: { bytes: 8000, items: 25 }, advisor_turn: { bytes: 2000, items: 6 }, manager: { bytes: 6000, items: 20 },
    designer: { bytes: 6000, items: 20 }, worker: { bytes: 4000, items: 12 }, reviewer: { bytes: 3000, items: 8 }, curator: { bytes: 2000, items: 8 },
  },
};

/** Identity comes from the verified guard token; work/task/project ids are hints from the request headers. */
export function memoryContext(agent: GuardTokenAgent | null, hint: (name: string) => string | undefined): MemoryRequestContext {
  return {
    // The Librarian only reads knowledge, so it is served like the Curator.
    caller: agent ? (agent.role === "librarian" ? "curator" : agent.role) : "owner",
    agent_run_id: agent?.agent_run_id ?? null,
    work_id: hint("x-owl-work-id") ?? null,
    task_id: hint("x-owl-task-id") ?? null,
    project_id: hint("x-owl-project-id") ?? null,
  };
}

export async function runMemoryOperation(core: unknown, op: string, rawBody: unknown, ctx: MemoryRequestContext): Promise<unknown> {
  const api = requireMemoryApi(core);
  if (op === "health") {
    const health = (await api.health()) as unknown as Record<string, unknown>;
    return { ...health, injection: health.injection ?? INJECTION_DEFAULT };
  }
  if (op === "mode") return { mode: api.mode?.() ?? "pages" };
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) throw bad("本文はJSON objectで指定してください。");
  const body = rawBody as Record<string, unknown>;
  if (op === "reindex") return api.reindex({ mode: field(body, "mode", isMode) ?? "diff" });
  if (op === "index" || op === "page" || op === "pages/search") {
    const unsupported = (): never => { throw new ApiError(503, "dependency_unavailable", "The loaded Core does not support the page tools."); };
    if (op === "index") {
      if (!api.readIndex) return unsupported();
      return api.readIndex({ project_id: field(body, "project_id", isString) }, ctx);
    }
    if (op === "page") {
      const page = field(body, "page", isString);
      if (!page) throw bad("pageを指定してください。");
      if (!api.page) return unsupported();
      return api.page({ page, sections: field(body, "sections", isStrings) }, ctx);
    }
    const pageQuery = field(body, "query", isString);
    if (!pageQuery) throw bad("queryを指定してください。");
    if (!api.searchPages) return unsupported();
    return api.searchPages({ query: pageQuery, include_work_log: field(body, "include_work_log", isBool) }, ctx);
  }
  if (op === "expand") {
    const note = field(body, "note", isString);
    if (!note) throw bad("noteを指定してください。");
    return api.expand({ note, include_body: field(body, "include_body", isBool), max_bytes: field(body, "max_bytes", isInt(200_000)) }, ctx);
  }
  if (op === "recall") {
    return api.recall({ topic: field(body, "topic", isString), types: field(body, "types", isTypes), limit: field(body, "limit", isInt(50)), explain: field(body, "explain", isBool) }, ctx);
  }
  const query = field(body, "query", isString);
  if (!query) throw bad("queryを指定してください。");
  return api.search({
    query, limit: Math.min(field(body, "limit", isInt(1000)) ?? 8, 30), types: field(body, "types", isTypes),
    scope: field(body, "scope", isScope), include_superseded: field(body, "include_superseded", isBool),
    include_raw: field(body, "include_raw", isBool), project_id: ctx.project_id,
  }, ctx);
}
