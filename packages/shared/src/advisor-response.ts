import { validateRoleOutput, type RoleSchema } from "./role-schema.js";

export interface AdvisorSuggestedAction {
  readonly type: string;
  readonly description: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface ParsedAdvisorResponse {
  readonly reply: string;
  readonly suggested_actions: readonly AdvisorSuggestedAction[];
}

export type AdvisorWorkOperationType =
  | "send_work_instruction"
  | "update_work"
  | "pause_work"
  | "resume_work"
  | "cancel_work"
  | "delete_work";

/** Work-operation action types from owl-actions. Use `.has` for untrusted action types. */
export const ADVISOR_WORK_OPERATION_ACTION_TYPES: ReadonlySet<string> = new Set<AdvisorWorkOperationType>([
  "send_work_instruction",
  "update_work",
  "pause_work",
  "resume_work",
  "cancel_work",
  "delete_work",
]);

export function isAdvisorWorkOperationType(type: string): type is AdvisorWorkOperationType {
  return ADVISOR_WORK_OPERATION_ACTION_TYPES.has(type);
}

/** Diagnostics for a dropped owl-actions block. Excerpts are escaped and masked; never the full response. */
export interface AdvisorMalformedDetail {
  readonly error?: string;
  readonly position?: number;
  readonly line?: number;
  readonly column?: number;
  readonly before?: string;
  readonly after?: string;
  readonly action_index?: number;
}

export type AdvisorMalformedHandler = (reason: string, detail?: AdvisorMalformedDetail) => void;

/** Mask credentials the same way Core masks user-visible error text. */
export function redactProviderOutput(text: string): string {
  return text
    .replace(/(bearer\s+|authorization\s*[:=]\s*|api[-_ ]?key\s*[:=]\s*|access[_ -]?token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;"]+/giu, "$1[redacted]")
    .replace(/\b(?:sk|xoxb|xoxp|xapp|ghp|gho|github_pat)[-_][A-Za-z0-9_-]+\b/gu, "[redacted]");
}

/** One-line log text for a reason plus its detail. */
export function formatAdvisorMalformed(reason: string, detail?: AdvisorMalformedDetail): string {
  if (!detail) return reason;
  return `${reason}; ${Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`).join(" ")}`;
}

const EXCERPT_CHARS = 40;

const SECRET_PATTERNS = [
  /(?:bearer\s+|authorization\s*[:=]\s*|api[-_ ]?key\s*[:=]\s*|access[_ -]?token\s*[:=]\s*|secret\s*[:=]\s*)[^\s,;"]+/giu,
  /\b(?:sk|xoxb|xoxp|xapp|ghp|gho|github_pat)[-_][A-Za-z0-9_-]+\b/gu,
];

/** Escaped excerpt of text[from, to). Secrets are located on the full text first, so a token cut by the window is still masked. */
function excerpt(text: string, from: number, to: number): string {
  const ranges = SECRET_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((m) => [m.index!, m.index! + m[0].length] as const));
  let out = "";
  for (let i = from; i < Math.min(to, text.length); i += 1) {
    const range = ranges.find(([start, end]) => i >= start && i < end);
    if (!range) out += text[i];
    else if (i === from || i === range[0]) out += "[redacted]";
  }
  return JSON.stringify(out);
}

function jsonErrorDetail(body: string, cause: unknown): AdvisorMalformedDetail {
  const message = cause instanceof Error ? cause.message : String(cause);
  const name = cause instanceof Error ? cause.name : "Error";
  const reported = /position (\d+)/u.exec(message)?.[1];
  // Without a position the parser stopped at the end (incomplete JSON) or at the first token.
  const at = Math.min(body.length, reported !== undefined ? Number(reported) : /end of JSON/u.test(message) ? body.length : 0);
  const lines = body.slice(0, at).split("\n");
  return {
    // The offending token and the input snippet may echo the input; keep only the fixed description.
    error: `${name}: ${message.replace(/^(Unexpected (?:token|identifier|string|number))[\s\S]*/u, "$1").replace(/"[\s\S]*/u, "").trim()}`,
    position: at,
    line: lines.length,
    column: lines[lines.length - 1]!.length + 1,
    before: excerpt(body, Math.max(0, at - EXCERPT_CHARS), at),
    after: excerpt(body, at, at + EXCERPT_CHARS),
  };
}

class SuggestedActionError extends Error {
  public constructor(message: string, public readonly index?: number) {
    super(message);
  }
}

function actionsErrorDetail(error: unknown): AdvisorMalformedDetail {
  return {
    error: error instanceof Error ? redactProviderOutput(error.message) : "invalid actions",
    ...(error instanceof SuggestedActionError && error.index !== undefined ? { action_index: error.index } : {}),
  };
}

interface SourceLine {
  readonly content: string;
  readonly start: number;
  readonly end: number;
}

interface MarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly info: string;
}

interface NaturalAdvisorParse {
  readonly response: ParsedAdvisorResponse;
  readonly foundActionFence: boolean;
}

interface NaturalAdvisorParseOptions {
  readonly allowMultipleActionFences?: boolean;
  readonly allowEmptyActionSet?: boolean;
}

/** Parse a legacy JSON response or natural language with an optional owl-actions fence. */
export function parseAdvisorResponse(
  rawText: string,
  onMalformedActions?: AdvisorMalformedHandler,
): ParsedAdvisorResponse {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) throw new Error("Advisor response is empty.");

  if (trimmed.startsWith("{")) {
    const payload = parseJson(trimmed);
    if (!isRecord(payload) || typeof payload.reply !== "string") {
      throw new Error("Advisor JSON response must contain a string reply.");
    }
    const suggestedActions = parseSuggestedActions(payload.suggested_actions);
    // Legacy providers may wrap natural-language output, including its action
    // fence, inside the JSON reply field. Parse that nested text before Core
    // dispatches the structured actions.
    const nestedReply = parseNaturalAdvisorReply(payload.reply, onMalformedActions);
    if (nestedReply.foundActionFence) {
      return {
        reply: nestedReply.response.reply,
        suggested_actions: mergeSuggestedActions(suggestedActions, nestedReply.response.suggested_actions),
      };
    }
    return {
      reply: payload.reply,
      suggested_actions: suggestedActions,
    };
  }

  return parseNaturalAdvisorReply(rawText, onMalformedActions).response;
}

/** Parse a Slack reply while preserving plain visible text exactly as received. */
export function parseSlackAdvisorResponse(
  rawText: string,
  onMalformedActions?: AdvisorMalformedHandler,
): ParsedAdvisorResponse {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return { reply: rawText, suggested_actions: [] };

  if (trimmed.startsWith("{")) {
    // Treat JSON as the legacy envelope only when it is valid and has the
    // expected shape. Slack replies that merely begin with JSON (or contain
    // a malformed wrapper around a valid action fence) still need fence
    // extraction and must not fail open with the internal block displayed.
    let payload: unknown;
    try {
      payload = parseJson(trimmed);
    } catch {
      payload = undefined;
    }
    if (isRecord(payload) && typeof payload.reply === "string") {
      let suggestedActions: AdvisorSuggestedAction[] = [];
      try {
        suggestedActions = parseSuggestedActions(payload.suggested_actions);
      } catch (error) {
        onMalformedActions?.("invalid_suggested_actions", actionsErrorDetail(error));
      }
      const nestedReply = parseNaturalAdvisorReply(payload.reply, onMalformedActions, {
        allowMultipleActionFences: true,
        allowEmptyActionSet: true,
      });
      if (nestedReply.foundActionFence) {
        return {
          reply: nestedReply.response.reply,
          suggested_actions: mergeSuggestedActions(suggestedActions, nestedReply.response.suggested_actions),
        };
      }
      return { reply: payload.reply, suggested_actions: suggestedActions };
    }
  }

  const naturalReply = parseNaturalAdvisorReply(rawText, onMalformedActions, {
    allowMultipleActionFences: true,
    allowEmptyActionSet: true,
  });
  return naturalReply.foundActionFence
    ? naturalReply.response
    : { reply: rawText, suggested_actions: [] };
}

function parseNaturalAdvisorReply(
  response: string,
  onMalformedActions?: AdvisorMalformedHandler,
  options: NaturalAdvisorParseOptions = {},
): NaturalAdvisorParse {
  const lines = splitSourceLines(response);
  const replyParts: string[] = [];
  const parsedActions: AdvisorSuggestedAction[][] = [];
  let malformedReason: string | null = null;
  let malformedDetail: AdvisorMalformedDetail | undefined;
  let actionFenceCount = 0;
  let foundActionFence = false;
  let activeFence: MarkdownFence | null = null;

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (activeFence) {
      replyParts.push(response.slice(line.start, line.end));
      if (isClosingFence(line.content, activeFence)) activeFence = null;
      index += 1;
      continue;
    }

    const opening = parseFenceOpening(line.content);
    if (!opening) {
      replyParts.push(response.slice(line.start, line.end));
      index += 1;
      continue;
    }

    if (!isActionFence(opening)) {
      replyParts.push(response.slice(line.start, line.end));
      activeFence = opening;
      index += 1;
      continue;
    }

    foundActionFence = true;
    actionFenceCount += 1;
    let closingIndex = index + 1;
    while (closingIndex < lines.length && !isClosingFence(lines[closingIndex]!.content, opening)) {
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      malformedReason ??= "unclosed_fence";
      // Do not expose an incomplete action block or its payload to the user.
      break;
    }

    const openingLine = response.slice(line.start, line.end);
    const hasOpeningNewline = openingLine.endsWith("\n");
    const body = response.slice(line.end, lines[closingIndex]!.start);
    if (!isWellFormedActionFence(opening) || !hasOpeningNewline || body.trim().length === 0) {
      malformedReason ??= "invalid_fence_header";
    } else {
      const trimmedBody = body.trim();
      let value: unknown;
      let jsonOk = false;
      try {
        value = JSON.parse(trimmedBody) as unknown;
        jsonOk = true;
      } catch (error) {
        if (malformedReason === null) {
          malformedReason = "invalid_fence_json";
          malformedDetail = jsonErrorDetail(trimmedBody, error);
        }
      }
      if (jsonOk) {
        try {
          parsedActions.push(parseSuggestedActions(value));
        } catch (error) {
          if (malformedReason === null) {
            malformedReason = "invalid_fence_actions";
            malformedDetail = actionsErrorDetail(error);
          }
        }
      }
    }
    const closingLine = lines[closingIndex]!;
    const closingLineEnding = response.slice(closingLine.start + closingLine.content.length, closingLine.end);
    if (closingLineEnding.length > 0) replyParts.push(closingLineEnding);
    index = closingIndex + 1;
  }

  if (!foundActionFence) {
    return { response: { reply: response, suggested_actions: [] }, foundActionFence: false };
  }
  if (actionFenceCount > 1 && !options.allowMultipleActionFences) malformedReason ??= "multiple_fences";
  if (malformedReason) {
    onMalformedActions?.(malformedReason, malformedDetail);
    return {
      response: {
        reply: withoutFenceBreaks(replyParts.join("")),
        // Slack may return several independent action blocks. Hide malformed
        // ones while retaining any other block that parsed successfully.
        suggested_actions: options.allowMultipleActionFences ? mergeSuggestedActions(...parsedActions) : [],
      },
      foundActionFence: true,
    };
  }

  const reply = withoutFenceBreaks(replyParts.join(""));
  const suggestedActions = options.allowMultipleActionFences
    ? mergeSuggestedActions(...parsedActions)
    : parsedActions[0] ?? [];
  if (reply.trim().length === 0 && suggestedActions.length === 0 && !options.allowEmptyActionSet) {
    throw new Error("Advisor response has neither visible text nor actions.");
  }
  return {
    response: { reply, suggested_actions: suggestedActions },
    foundActionFence: true,
  };
}

/** Only the line breaks left around the removed fence go; spaces and text of the body are kept as written. */
function withoutFenceBreaks(value: string): string {
  return value.replace(/^(?:\r?\n)+/u, "").replace(/(?:\r?\n)+$/u, "");
}

function splitSourceLines(value: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < value.length) {
    const newline = value.indexOf("\n", start);
    const end = newline < 0 ? value.length : newline + 1;
    let content = value.slice(start, newline < 0 ? end : newline);
    if (content.endsWith("\r")) content = content.slice(0, -1);
    lines.push({ content, start, end });
    start = end;
  }
  return lines;
}

function parseFenceOpening(line: string): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) return null;
  return {
    marker: match[1]![0] as "`" | "~",
    length: match[1]!.length,
    info: match[2]!,
  };
}

/** The fence name that opens the structured actions block of a reply. */
const ADVISOR_ACTIONS_FENCE = "owl-actions";

/** Info strings that open a well-formed actions block. Compared exactly, not by pattern. */
const ADVISOR_ACTIONS_INFO: ReadonlySet<string> = new Set([ADVISOR_ACTIONS_FENCE, `${ADVISOR_ACTIONS_FENCE} json`]);

function isActionFence(fence: MarkdownFence): boolean {
  // A fence whose first word is the name is an actions block even when malformed, so it stays hidden
  // from the user. Validation below decides whether its payload may be executed.
  return fence.info.trim().split(/[ \t]/u, 1)[0] === ADVISOR_ACTIONS_FENCE;
}

function isWellFormedActionFence(fence: MarkdownFence): boolean {
  return ADVISOR_ACTIONS_INFO.has(fence.info.trim());
}

function isClosingFence(line: string, opening: MarkdownFence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
  return match !== null && match[1]![0] === opening.marker && match[1]!.length >= opening.length;
}

function mergeSuggestedActions(
  ...groups: readonly (readonly AdvisorSuggestedAction[])[]
): AdvisorSuggestedAction[] {
  const seen = new Set<string>();
  const actions: AdvisorSuggestedAction[] = [];
  for (const action of groups.flat()) {
    const fingerprint = JSON.stringify(action);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    actions.push(action);
  }
  return actions;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Advisor response contains invalid JSON.", { cause: error });
  }
}

/** The shape of an owl-actions block: an array of actions. Extra keys on an action are ignored. */
export const ADVISOR_ACTIONS_SCHEMA: RoleSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["type", "description"],
    properties: {
      type: { type: "string", minLength: 1 },
      description: { type: "string" },
      payload: { type: "object" },
    },
  },
};

function parseSuggestedActions(value: unknown): AdvisorSuggestedAction[] {
  if (value === undefined) return [];
  const problem = validateRoleOutput(ADVISOR_ACTIONS_SCHEMA, value);
  if (problem) {
    const index = /^\[(\d+)\]/u.exec(problem)?.[1];
    throw new SuggestedActionError(`Advisor suggested actions are invalid: ${problem}`, index === undefined ? undefined : Number(index));
  }
  return (value as Record<string, unknown>[]).map((item) => ({
    type: item.type as string,
    description: item.description as string,
    ...(item.payload !== undefined ? { payload: item.payload as Record<string, unknown> } : {}),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type AdvisorCurationKind = "librarian" | "skill_curation" | "rule_curation";

/**
 * Every owl-actions type that runs a curation, with the curation kind it maps
 * to, in the order an Advisor reply is expected to mention them.
 */
const ADVISOR_CURATION_ACTION_ENTRIES: readonly (readonly [string, AdvisorCurationKind])[] = Object.freeze([
  ["run_librarian", "librarian"],
  ["run_skill_curation", "skill_curation"],
  ["run_rule_curation", "rule_curation"],
]);

/**
 * owl-actions type → curation kind. The null prototype and Object.hasOwn in
 * `advisorCurationKind` keep Object.prototype members ("toString",
 * "constructor", …) from ever being returned as a curation kind, no matter
 * what an Advisor reply or an API caller sends as `type`.
 */
export const ADVISOR_CURATION_ACTIONS: Readonly<Record<string, AdvisorCurationKind>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, AdvisorCurationKind>, Object.fromEntries(ADVISOR_CURATION_ACTION_ENTRIES)),
);

/** The same list as a Set, so a caller can test an untrusted `type` without indexing an object. */
export const ADVISOR_CURATION_ACTION_TYPES: ReadonlySet<string> = new Set(
  ADVISOR_CURATION_ACTION_ENTRIES.map(([type]) => type),
);

/** The curation kind an owl-actions type runs, or null when the type is not a curation action. */
export function advisorCurationKind(type: string): AdvisorCurationKind | null {
  return Object.hasOwn(ADVISOR_CURATION_ACTIONS, type) ? ADVISOR_CURATION_ACTIONS[type]! : null;
}
