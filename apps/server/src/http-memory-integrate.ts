import { ApiError } from "./errors.js";

export interface MemoryPagesIntegrateApiPort {
  integrateMemoryPages(input: { mode: "manual"; paths?: readonly string[]; trigger: "manual_api"; actor: "owner" }): Promise<unknown>;
}

export interface MemoryPagesPendingApiPort {
  memoryPendingStats(): Promise<unknown>;
}

const isPendingPort = (value: unknown): value is MemoryPagesPendingApiPort =>
  typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).memoryPendingStats === "function";

/** Resolves Core's `memoryPendingStats` the same way; 503 when absent. */
export function requireMemoryPagesPendingApi(core: unknown): MemoryPagesPendingApiPort {
  const candidate = [core, (core as { core?: unknown } | null)?.core].find(isPendingPort);
  if (!candidate) throw new ApiError(503, "core_not_ready", "The loaded Core does not report the librarian backlog.");
  return candidate;
}

const isIntegratePort = (value: unknown): value is MemoryPagesIntegrateApiPort =>
  typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).integrateMemoryPages === "function";

/** Resolves Core's `integrateMemoryPages`, falling back to the ExternalCoreAdapter's wrapped `.core`; 503 when absent. */
export function requireMemoryPagesIntegrateApi(core: unknown): MemoryPagesIntegrateApiPort {
  const candidate = [core, (core as { core?: unknown } | null)?.core].find(isIntegratePort);
  if (!candidate) throw new ApiError(503, "core_not_ready", "The loaded Core does not support page integration.");
  return candidate;
}

export function validateMemoryPagesIntegratePayload(body: unknown): { paths?: string[] } {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "validation_error", "The body must be a JSON object.", { field: "body" });
  const { paths } = body as Record<string, unknown>;
  if (paths === undefined) return {};
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || p === "")) throw new ApiError(400, "validation_error", "paths must be an array of non-empty strings.", { field: "paths" });
  return { paths: paths as string[] };
}
