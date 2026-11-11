import { createHash } from "node:crypto";

/** A plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hex sha256 of a string (utf8) or a buffer. */
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Escapes a string for use as a literal inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** The `code` of a Node error as a string, or undefined when the value has none. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** `value` when it is a safe integer above zero, else `fallback`. */
export function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** At most `max` characters, the last one an ellipsis when cut. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** The first line of the trimmed text, trimmed. */
export function firstLine(value: string): string {
  return value.trim().split(/\r?\n/u, 1)[0].trim();
}
