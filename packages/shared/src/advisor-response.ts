export interface AdvisorSuggestedAction {
  readonly type: string;
  readonly description: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface ParsedAdvisorResponse {
  readonly reply: string;
  readonly suggested_actions: readonly AdvisorSuggestedAction[];
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
  onMalformedActions?: (reason: string) => void,
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

  return parseNaturalAdvisorReply(trimmed, onMalformedActions).response;
}

/** Parse a Slack reply while preserving plain visible text exactly as received. */
export function parseSlackAdvisorResponse(
  rawText: string,
  onMalformedActions?: (reason: string) => void,
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
      } catch {
        onMalformedActions?.("invalid_suggested_actions");
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
  onMalformedActions?: (reason: string) => void,
  options: NaturalAdvisorParseOptions = {},
): NaturalAdvisorParse {
  const lines = splitSourceLines(response);
  const replyParts: string[] = [];
  const parsedActions: AdvisorSuggestedAction[][] = [];
  let malformedReason: string | null = null;
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
      try {
        parsedActions.push(parseSuggestedActions(parseJson(body.trim())));
      } catch {
        malformedReason ??= "invalid_fence_json";
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
    onMalformedActions?.(malformedReason);
    return {
      response: {
        reply: replyParts.join("").trim(),
        // Slack may return several independent action blocks. Hide malformed
        // ones while retaining any other block that parsed successfully.
        suggested_actions: options.allowMultipleActionFences ? mergeSuggestedActions(...parsedActions) : [],
      },
      foundActionFence: true,
    };
  }

  const reply = replyParts.join("").trim();
  const suggestedActions = options.allowMultipleActionFences
    ? mergeSuggestedActions(...parsedActions)
    : parsedActions[0] ?? [];
  if (reply.length === 0 && suggestedActions.length === 0 && !options.allowEmptyActionSet) {
    throw new Error("Advisor response has neither visible text nor actions.");
  }
  return {
    response: { reply, suggested_actions: suggestedActions },
    foundActionFence: true,
  };
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

function isActionFence(fence: MarkdownFence): boolean {
  // Recognize malformed variants too, so the block is still hidden from the
  // user. Validation below decides whether its payload may be executed.
  return /^[ \t]*owl-actions(?:[ \t].*)?$/iu.test(fence.info);
}

function isWellFormedActionFence(fence: MarkdownFence): boolean {
  return /^[ \t]*owl-actions(?:[ \t]+json)?[ \t]*$/iu.test(fence.info);
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

function parseSuggestedActions(value: unknown): AdvisorSuggestedAction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Advisor suggested_actions must be an array.");
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.type !== "string" || item.type.length === 0 || typeof item.description !== "string") {
      throw new Error(`Advisor suggested action ${index} is invalid.`);
    }
    if (item.payload !== undefined && !isRecord(item.payload)) {
      throw new Error(`Advisor suggested action ${index} payload is invalid.`);
    }
    return {
      type: item.type,
      description: item.description,
      ...(isRecord(item.payload) ? { payload: item.payload } : {}),
    };
  });
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
