import { ApiError } from "./errors.js";

export function validateMemoryPagesIntegratePayload(body: unknown): { paths?: string[] } {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "validation_error", "The body must be a JSON object.", { field: "body" });
  const { paths } = body as Record<string, unknown>;
  if (paths === undefined) return {};
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string" || p === "")) throw new ApiError(400, "validation_error", "paths must be an array of non-empty strings.", { field: "paths" });
  return { paths: paths as string[] };
}
