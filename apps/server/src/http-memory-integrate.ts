import { ApiError } from "./errors.js";
import { MemoryMessages } from "./messages/memory.js";

export function validateMemoryPagesIntegratePayload(body: unknown): { paths?: string[] } {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "validation_error", MemoryMessages.integrateBodyNotObject(), { field: "body" });
  const { paths } = body as Record<string, unknown>;
  if (paths === undefined) return {};
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || p === "")) throw new ApiError(400, "validation_error", MemoryMessages.integratePathsInvalid(), { field: "paths" });
  return { paths: paths as string[] };
}
