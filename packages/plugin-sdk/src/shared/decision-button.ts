import type { PendingDecision } from "./router";

/** Discord custom IDs are limited to 100 characters; Slack action IDs are also
 * kept compact here. The option key is deliberately not embedded because it
 * may contain underscores, punctuation, or exceed a platform's ID limit. */
const PREFIX = "owl.d1.";
const MAX_PLATFORM_ID_LENGTH = 100;

export interface DecisionButtonTarget {
  readonly decisionId: string;
  readonly optionIndex: number;
}

export interface ResolvedDecisionButton {
  readonly decisionId: string;
  readonly optionKey: string;
  readonly label: string;
  readonly stateVersion: number;
}

export function createDecisionButtonId(decisionId: string, optionIndex: number): string | null {
  if (decisionId.length === 0 || decisionId.length > 128 || !Number.isSafeInteger(optionIndex) || optionIndex < 0) {
    return null;
  }
  const encodedDecisionId = Buffer.from(decisionId, "utf8").toString("base64url");
  const value = `${PREFIX}${encodedDecisionId}.${optionIndex.toString(36)}`;
  return value.length <= MAX_PLATFORM_ID_LENGTH ? value : null;
}

export function parseDecisionButtonId(value: string): DecisionButtonTarget | null {
  if (typeof value !== "string" || value.length > MAX_PLATFORM_ID_LENGTH) return null;
  const match = value.match(/^owl\.d1\.([A-Za-z0-9_-]+)\.([0-9a-z]+)$/u);
  if (!match) return null;
  let decisionId: string;
  try {
    decisionId = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
  // Buffer's base64 decoder is intentionally forgiving. Require the exact
  // canonical encoding emitted by createDecisionButtonId so malformed or
  // tampered action IDs cannot turn into a different decision identifier.
  if (Buffer.from(decisionId, "utf8").toString("base64url") !== match[1]) return null;
  if (decisionId.length === 0 || decisionId.length > 128) return null;
  const optionIndex = Number.parseInt(match[2], 36);
  if (!Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex.toString(36) !== match[2]) return null;
  return { decisionId, optionIndex };
}

/** Resolve the compact button target against the current stored Decision. */
export function resolveDecisionButtonTarget(
  decisions: readonly PendingDecision[],
  target: DecisionButtonTarget,
): ResolvedDecisionButton | null {
  const decision = decisions.find((candidate) => candidate.id === target.decisionId);
  const option = decision?.options[target.optionIndex];
  if (!option || typeof option.key !== "string" || typeof option.label !== "string") return null;
  const stateVersion = typeof decision?.state_version === "number" ? decision.state_version : 0;
  return { decisionId: target.decisionId, optionKey: option.key, label: option.label, stateVersion };
}
