export interface MarkdownToSlackResult {
  /** Visible message text in Slack mrkdwn format. */
  readonly text: string;
  /** Raw payloads from any `owl-actions` fences, in source order. */
  readonly owlActions: readonly string[];
}

export interface OwlActionsExtraction {
  readonly body: string;
  readonly owlActions: readonly string[];
}

/**
 * Convert supported GitHub Markdown to Slack mrkdwn and return internal action
 * payloads separately so callers can continue processing them without posting
 * them as visible Slack text.
 */
export function markdownToSlackMrkdwn(markdown: string): MarkdownToSlackResult {
  const { body, owlActions } = extractOwlActionsBlocks(markdown);
  return { text: markdownToMrkdwn(body), owlActions };
}

/** Convert Markdown to Slack mrkdwn for outbound messages. */
export function markdownToMrkdwn(text: string): string {
  const source = typeof text === "string" ? text : "";
  try {
    return convertOutsideCode(source);
  } catch {
    // Keep malformed or unusual input safe for notification callers.
    return source;
  }
}

/** Remove all `owl-actions` fences while preserving their raw contents. */
export function extractOwlActionsBlocks(markdown: string): OwlActionsExtraction {
  const lines = getLines(markdown);
  const removedRanges: Array<{ start: number; end: number }> = [];
  const owlActions: string[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const opening = parseFenceOpening(lines[lineIndex].text);
    if (!opening) continue;

    let closingLine = lineIndex + 1;
    while (
      closingLine < lines.length
      && !isFenceClosing(lines[closingLine].text, opening.marker, opening.length)
    ) {
      closingLine += 1;
    }

    const hasClosingFence = closingLine < lines.length;
    if (opening.infoTag !== "owl-actions") {
      // An owl-actions-looking line inside another fenced block is code, not
      // an independent metadata block. Skip the whole outer fence.
      if (!hasClosingFence) break;
      lineIndex = closingLine;
      continue;
    }

    const contentStart = lines[lineIndex].end;
    const contentEnd = hasClosingFence ? lines[closingLine].start : markdown.length;
    owlActions.push(stripFenceSeparator(markdown.slice(contentStart, contentEnd)));

    const blockEnd = hasClosingFence ? lines[closingLine].end : markdown.length;
    removedRanges.push({ start: lines[lineIndex].start, end: blockEnd });
    lineIndex = hasClosingFence ? closingLine : lines.length;
  }

  let body = "";
  let cursor = 0;
  for (const range of removedRanges) {
    body += markdown.slice(cursor, range.start);
    cursor = range.end;
  }
  body += markdown.slice(cursor);
  return { body, owlActions };
}

/** Compatibility helper for callers that expect a single aggregated payload. */
export function extractOwlActionsBlock(markdown: string): { body: string; actionsBlock: string | null } {
  const { body, owlActions } = extractOwlActionsBlocks(markdown);
  return { body, actionsBlock: owlActions.length === 0 ? null : owlActions.join("\n") };
}

function convertOutsideCode(markdown: string): string {
  const maskedParts: string[] = [];
  let plainStart = 0;
  let index = 0;
  const protectedCode: Array<{ placeholder: string; source: string }> = [];
  let markerPrefix = "\uE000SLACKCODE";
  while (markdown.includes(markerPrefix)) markerPrefix += "\uE000";

  const protect = (start: number, end: number): void => {
    const source = markdown.slice(start, end);
    const lineBreaks = source.match(/\r\n|\r|\n/gu)?.join("") ?? "";
    const id = protectedCode.length;
    const placeholder = `${markerPrefix}${id}\uE001${lineBreaks}${markerPrefix}${id}\uE002`;
    maskedParts.push(markdown.slice(plainStart, start), placeholder);
    protectedCode.push({ placeholder, source });
    plainStart = end;
  };

  while (index < markdown.length) {
    const marker = markdown[index];
    if (marker !== "`" && marker !== "~") {
      index += 1;
      continue;
    }

    const runEnd = findMarkerRunEnd(markdown, index);
    const runLength = runEnd - index;
    if (runLength >= 3 && isFenceOpener(markdown, index)) {
      const fenceEnd = findFenceEnd(markdown, index, marker, runLength);
      if (fenceEnd !== -1) {
        protect(index, fenceEnd);
        index = fenceEnd;
        continue;
      }
      // An unclosed fenced block protects the rest of the message as code.
      protect(index, markdown.length);
      index = markdown.length;
      break;
    }

    if (marker === "~") {
      index = runEnd;
      continue;
    }

    const closingRun = findClosingBacktickRun(markdown, runEnd, runLength);
    if (closingRun !== -1) {
      const end = findMarkerRunEnd(markdown, closingRun);
      protect(index, end);
      index = end;
      continue;
    }

    index = runEnd;
  }

  maskedParts.push(markdown.slice(plainStart));
  let converted = convertMarkdown(maskedParts.join(""));
  for (const { placeholder, source } of protectedCode) {
    converted = converted.split(placeholder).join(source);
  }
  return converted;
}

function convertMarkdown(text: string): string {
  return serializeInlineNodes(parseInlineMarkdown(convertBlockMarkdown(text)));
}

function convertBlockMarkdown(text: string): string {
  const parts = text.split(/(\r\n|\r|\n)/gu);
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const heading = /^( {0,3})#{1,6}[ \t]+(.*)$/u.exec(line);
    if (heading) {
      const content = heading[2].replace(/[ \t]+#+[ \t]*$/u, "").replace(/[ \t]+$/u, "");
      parts[index] = `${heading[1]}**${content}**`;
      continue;
    }

    parts[index] = line.replace(/^([ \t]*)[-*+][ \t]+/u, "$1• ");
  }
  return parts.join("");
}

type InlineNode = TextNode | TrustedNode | FormatNode;

interface TextNode {
  readonly kind: "text";
  readonly text: string;
}

interface TrustedNode {
  readonly kind: "trusted";
  readonly text: string;
}

interface FormatNode {
  readonly kind: "format";
  readonly delimiter: string;
  readonly slackMarker: string;
  readonly children: InlineNode[];
  closed: boolean;
}

interface OpenDelimiter {
  readonly character: string;
  readonly width: number;
  readonly node: FormatNode;
}

interface MarkdownLink {
  readonly end: number;
  readonly label: string;
  readonly url: string;
}

function parseInlineMarkdown(text: string, preserveSlackBold = true): InlineNode[] {
  const root: InlineNode[] = [];
  const stack: OpenDelimiter[] = [];
  let current = root;
  let plainStart = 0;
  let index = 0;

  const appendText = (value: string): void => {
    if (value) current.push({ kind: "text", text: value });
  };
  const appendTrusted = (value: string): void => {
    current.push({ kind: "trusted", text: value });
  };
  const flushPlain = (end: number): void => {
    appendText(text.slice(plainStart, end));
  };
  const openFormat = (character: string, width: number): void => {
    const delimiter = character.repeat(width);
    const keepSingleAsterisk = preserveSlackBold
      && character === "*"
      && width === 1
      && stack.length === 0
      && isSimpleAsteriskSpan(text, index + width);
    const node: FormatNode = {
      kind: "format",
      delimiter,
      // A simple single-asterisk span is already valid Slack bold mrkdwn.
      // Keep it intact so a second conversion does not turn it into italics.
      // In nested Markdown and link labels, single asterisks remain italics.
      slackMarker: character === "~" ? "~" : width === 2 || keepSingleAsterisk ? "*" : "_",
      children: [],
      closed: false,
    };
    current.push(node);
    stack.push({ character, width, node });
    current = node.children;
  };
  const closeFormat = (): void => {
    const open = stack.pop();
    if (!open) return;
    open.node.closed = true;
    current = stack.length === 0 ? root : stack[stack.length - 1].node.children;
  };

  while (index < text.length) {
    if (text[index] === "<" && !isEscaped(text, index)) {
      const slackToken = findExistingSlackToken(text, index);
      if (slackToken) {
        flushPlain(index);
        appendTrusted(slackToken);
        index += slackToken.length;
        plainStart = index;
        continue;
      }
    }

    if (text[index] === "[" && !isEscaped(text, index)) {
      const link = findMarkdownLink(text, index);
      if (link) {
        flushPlain(index);
        appendTrusted(`<${formatLinkTarget(link.url)}|${serializeInlineNodes(parseInlineMarkdown(link.label, false))}>`);
        index = link.end;
        plainStart = index;
        continue;
      }
    }

    if (/^[hw]/iu.test(text[index] ?? "")) {
      const bareUrl = findBareUrl(text, index);
      if (bareUrl) {
        flushPlain(index);
        appendTrusted(bareUrl);
        index += bareUrl.length;
        plainStart = index;
        continue;
      }
    }

    const character = text[index];
    if ((character === "*" || character === "_" || character === "~") && !isEscaped(text, index)) {
      let runEnd = index + 1;
      while (text[runEnd] === character) runEnd += 1;
      const runLength = runEnd - index;
      if (character !== "~" || runLength >= 2) {
        const previous = index === 0 ? undefined : text[index - 1];
        const next = runEnd === text.length ? undefined : text[runEnd];
        const canOpen = canOpenDelimiter(character, previous, next);
        const canClose = canCloseDelimiter(character, previous, next);

        if (canOpen || canClose) {
          flushPlain(index);
          let remaining = character === "~" ? runLength - (runLength % 2) : runLength;
          if (canClose) {
            while (remaining > 0) {
              const open = stack[stack.length - 1];
              if (!open || open.character !== character || open.width > remaining) break;
              closeFormat();
              remaining -= open.width;
            }
          }

          if (canOpen) {
            while (remaining >= 2) {
              openFormat(character, 2);
              remaining -= 2;
            }
            if (remaining === 1 && character !== "~") {
              openFormat(character, 1);
              remaining = 0;
            }
          }

          if (remaining > 0) appendText(character.repeat(remaining));
          if (character === "~" && runLength % 2 === 1) appendText("~");
          index = runEnd;
          plainStart = index;
          continue;
        }
      }
      index = runEnd;
      continue;
    }

    index += 1;
  }

  flushPlain(text.length);
  return root;
}

function serializeInlineNodes(nodes: readonly InlineNode[], insideBold = false): string {
  let result = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      result += escapeSlackText(node.text);
    } else if (node.kind === "trusted") {
      result += node.text;
    } else {
      const isBold = node.delimiter === "**" || node.delimiter === "__";
      if (node.closed && insideBold && isBold) {
        // Bold inside a heading (or another bold span) is redundant. Flatten it
        // so repeated asterisks do not create invalid Slack formatting.
        result += serializeInlineNodes(node.children, true);
        continue;
      }

      const inner = serializeInlineNodes(node.children, insideBold || (node.closed && isBold));
      result += node.closed ? `${node.slackMarker}${inner}${node.slackMarker}` : `${node.delimiter}${inner}`;
    }
  }
  return result;
}

function formatLinkTarget(url: string): string {
  return url
    .replace(/\\([\\|<>])/gu, "$1")
    .replace(/[|<>\s]/gu, (character) => encodeURIComponent(character));
}

function findExistingSlackToken(text: string, start: number): string | null {
  const match = /^<(?:@[A-Z][A-Z0-9]*(?:\|[^<>]*)?|#[A-Z][A-Z0-9]*(?:\|[^<>]*)?|!(?:here|everyone|channel|subteam\^[A-Z0-9]+)(?:\|[^<>]*)?|(?:https?:\/\/|mailto:)[^<>\s|]+(?:\|[^<>]*)?|[^<>\s|]+\|[^<>]*)>/iu.exec(text.slice(start));
  return match?.[0] ?? null;
}

function findBareUrl(text: string, start: number): string | null {
  const previous = start === 0 ? undefined : text[start - 1];
  if (previous !== undefined && /[\p{L}\p{N}_@]/u.test(previous)) return null;
  const match = /^(?:https?:\/\/|www\.)[^\s<>`]+/iu.exec(text.slice(start));
  return match?.[0] ?? null;
}

function escapeSlackText(text: string): string {
  return text.replace(/&(?!amp;|lt;|gt;)|[<>]/gu, (character) => {
    if (character === "&") return "&amp;";
    return character === "<" ? "&lt;" : "&gt;";
  });
}

function findMarkdownLink(text: string, start: number): MarkdownLink | null {
  let bracketDepth = 1;
  let labelEnd = -1;
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\r" || text[index] === "\n") return null;
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === "[") bracketDepth += 1;
    if (text[index] === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        labelEnd = index;
        break;
      }
    }
    index += 1;
  }
  if (labelEnd === -1 || text[labelEnd + 1] !== "(") return null;

  let parenDepth = 1;
  index = labelEnd + 2;
  const urlStart = index;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === "(") parenDepth += 1;
    if (text[index] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        return {
          end: index + 1,
          label: text.slice(start + 1, labelEnd),
          url: text.slice(urlStart, index),
        };
      }
    }
    index += 1;
  }
  return null;
}

function canOpenDelimiter(character: string, previous: string | undefined, next: string | undefined): boolean {
  if (isWhitespace(next)) return false;
  if (character === "_" && isWord(previous) && isWord(next)) return false;
  return true;
}

function canCloseDelimiter(character: string, previous: string | undefined, next: string | undefined): boolean {
  if (isWhitespace(previous)) return false;
  if (character === "_" && isWord(previous) && isWord(next)) return false;
  return true;
}

function isWhitespace(character: string | undefined): boolean {
  return character === undefined || /\s/u.test(character);
}

function isWord(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isSimpleAsteriskSpan(text: string, contentStart: number): boolean {
  for (let index = contentStart; index < text.length; index += 1) {
    if (text[index] === "\r" || text[index] === "\n") return false;
    if (text[index] !== "*" || isEscaped(text, index)) continue;

    let runEnd = index + 1;
    while (text[runEnd] === "*") runEnd += 1;
    if (runEnd - index !== 1) return false;

    const content = text.slice(contentStart, index);
    return content.length > 0
      && !/^\s|\s$/u.test(content)
      && !/\*\*/u.test(content)
      && !/[\[\]]/u.test(content);
  }
  return false;
}

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface FenceOpening {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly infoTag: string;
}

function getLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    const contentEnd = newline === -1 ? end : newline;
    lines.push({ start, end, text: text.slice(start, contentEnd) });
    start = end;
  }
  if (text.length === 0 || text.endsWith("\n")) {
    lines.push({ start: text.length, end: text.length, text: "" });
  }
  return lines;
}

function parseFenceOpening(line: string): FenceOpening | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(line);
  if (!match) return null;
  const marker = match[1][0] as "`" | "~";
  if (marker === "`" && match[2].includes("`")) return null;
  const info = match[2].trim();
  return {
    marker,
    length: match[1].length,
    infoTag: info.split(/[ \t]+/u, 1)[0] ?? "",
  };
}

function isFenceOpener(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (!/^ {0,3}$/.test(text.slice(lineStart, start))) return false;
  const newline = text.indexOf("\n", start);
  const lineEnd = newline === -1 ? text.length : newline;
  return parseFenceOpening(text.slice(lineStart, lineEnd)) !== null;
}

function findFenceEnd(
  text: string,
  openingStart: number,
  marker: "`" | "~",
  openingLength: number,
): number {
  const openingNewline = text.indexOf("\n", openingStart);
  if (openingNewline === -1) return -1;

  let lineStart = openingNewline + 1;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (isFenceClosing(text.slice(lineStart, lineEnd), marker, openingLength)) {
      return newline === -1 ? lineEnd : lineEnd + 1;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return -1;
}

function isFenceClosing(line: string, marker: "`" | "~", openingLength: number): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  return Boolean(match && match[1][0] === marker && match[1].length >= openingLength);
}

function stripFenceSeparator(content: string): string {
  if (content.endsWith("\r\n")) return content.slice(0, -2);
  if (content.endsWith("\n") || content.endsWith("\r")) return content.slice(0, -1);
  return content;
}

function findMarkerRunEnd(text: string, start: number): number {
  let end = start;
  while (text[end] === text[start]) end += 1;
  return end;
}

function findClosingBacktickRun(text: string, start: number, openingLength: number): number {
  let index = start;
  while (index < text.length) {
    const next = text.indexOf("`", index);
    if (next === -1) return -1;
    const runEnd = findMarkerRunEnd(text, next);
    if (runEnd - next === openingLength) return next;
    index = runEnd;
  }
  return -1;
}
