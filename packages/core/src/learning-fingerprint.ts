import { createHash } from "node:crypto";

/** Normalize claim and proposal text before computing its content fingerprint. */
export function normalizeClaim(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\p{P}\p{S}]/gu, "")
    .trim();
}

/** Return the first 16 hexadecimal characters of the normalized text's SHA-256 digest. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(normalizeClaim(text)).digest("hex").slice(0, 16);
}

/** Fingerprint the stable, normalized fields that identify one learned lesson. */
export function lessonFingerprint(lesson: {
  readonly kind: string;
  readonly lesson: string;
  readonly topic: string;
  readonly procedure: string;
  readonly rule_text: string;
  readonly rule_scope: string;
}): string {
  return fingerprint([
    lesson.kind,
    lesson.lesson,
    lesson.topic,
    lesson.procedure,
    lesson.rule_text,
    lesson.rule_scope,
  ].join("\n"));
}

/** Fingerprint a rule key's source identity, including level and optional role. */
export function ruleKeyFingerprint(text: string, level: string, role?: string | null): string {
  return fingerprint([text, level, role ?? ""].join("\n"));
}
