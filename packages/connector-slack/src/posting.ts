import type { WebClient } from "@slack/web-api";
import { extractOwlActionsBlocks, markdownToMrkdwn } from "./markdown.js";

type SlackPostMessageArgs = Parameters<WebClient["chat"]["postMessage"]>[0];

const MAX_SLACK_TEXT_LENGTH = 40_000;
const MAX_SLACK_SECTION_TEXT_LENGTH = 3_000;

export async function postSlackMessage(
  client: Pick<WebClient, "chat">,
  message: SlackPostMessageArgs,
): Promise<unknown> {
  // Core parses and dispatches Advisor action fences before emitting its
  // response event. Strip any fence that reaches this transport boundary as
  // a final guard, convert the full visible Markdown, and then split it.
  const outbound = convertSlackMessage(message);
  if (typeof outbound.text !== "string") {
    return client.chat.postMessage(outbound as unknown as SlackPostMessageArgs);
  }

  const chunks = splitSlackText(outbound.text);
  if (chunks.length === 1 && chunks[0]!.length === 0 && !hasBlocks(outbound)) return undefined;

  let result: unknown;
  for (const [index, text] of chunks.entries()) {
    const chunkMessage: Record<string, unknown> = { ...outbound, text };
    // Blocks describe the first post's rendered content. Repeating them for
    // every continuation would duplicate the same notification or reply.
    if (index > 0) {
      delete chunkMessage.blocks;
      delete chunkMessage.attachments;
    }
    result = await client.chat.postMessage(chunkMessage as unknown as SlackPostMessageArgs);
  }
  return result;
}

function convertSlackMessage(message: SlackPostMessageArgs): Record<string, unknown> {
  // Slack's generated arguments are a union across every chat.postMessage
  // overload. Preserve the caller's shape while converting visible mrkdwn.
  const outbound: Record<string, unknown> = { ...message };
  if (typeof outbound.text === "string") {
    const visibleMarkdown = stripOwlActions(outbound.text);
    outbound.text = markdownToMrkdwn(visibleMarkdown);
    // Converted markers must be parsed even when a caller explicitly disabled
    // mrkdwn. Leave the field absent otherwise; Slack's default is mrkdwn.
    if (outbound.mrkdwn === false) outbound.mrkdwn = true;
  }
  if (Array.isArray(outbound.blocks)) {
    outbound.blocks = outbound.blocks.map(convertMrkdwnTextFields);
  }
  if (Array.isArray(outbound.attachments)) {
    outbound.attachments = outbound.attachments.map(convertMrkdwnTextFields);
  }
  return outbound;
}

/** Apply the same outbound conversion as a post without splitting chat.update messages. */
export function prepareSlackMessage(message: Record<string, unknown>): Record<string, unknown> {
  return convertSlackMessage(message as unknown as SlackPostMessageArgs);
}

function convertMrkdwnTextFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(convertMrkdwnTextFields);
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  const converted = Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, convertMrkdwnTextFields(item)]),
  );
  if (record.type === "mrkdwn" && typeof record.text === "string") {
    converted.text = truncateSectionText(markdownToMrkdwn(stripOwlActions(record.text)));
  }
  return converted;
}

function truncateSectionText(text: string): string {
  if (text.length <= MAX_SLACK_SECTION_TEXT_LENGTH) return text;
  let end = MAX_SLACK_SECTION_TEXT_LENGTH - 1;
  const lastIncludedCodeUnit = text.charCodeAt(end - 1);
  if (lastIncludedCodeUnit >= 0xd800 && lastIncludedCodeUnit <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function stripOwlActions(text: string): string {
  return extractOwlActionsBlocks(text).body;
}

function hasBlocks(message: Record<string, unknown>): boolean {
  const blocks = message.blocks;
  if (Array.isArray(blocks) && blocks.length > 0) return true;
  const attachments = message.attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

interface CodeFenceRange extends TextRange {
  readonly marker: string;
  readonly openingLine: string;
  readonly closingLine: string | null;
}

function splitSlackText(text: string, limit = MAX_SLACK_TEXT_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const fences = findCodeFenceRanges(text);
  let cursor = 0;
  for (const fence of fences) {
    chunks.push(...splitPlainText(text.slice(cursor, fence.start), limit));
    chunks.push(...splitCodeFence(text.slice(fence.start, fence.end), fence, limit));
    cursor = fence.end;
  }
  chunks.push(...splitPlainText(text.slice(cursor), limit));
  return chunks.filter((chunk) => chunk.length > 0);
}

interface SourceLine {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function findCodeFenceRanges(text: string): CodeFenceRange[] {
  const lines = getLines(text);
  const ranges: CodeFenceRange[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,})(.*)$/u.exec(lines[index]!.content);
    if (!opening) continue;

    let closingIndex = index + 1;
    while (closingIndex < lines.length && !isCodeFenceClosing(lines[closingIndex]!.content, opening[1]!.length)) {
      closingIndex += 1;
    }
    const hasClosing = closingIndex < lines.length;
    ranges.push({
      start: lines[index]!.start,
      end: hasClosing ? lines[closingIndex]!.end : text.length,
      marker: opening[1]!,
      openingLine: text.slice(lines[index]!.start, lines[index]!.end),
      closingLine: hasClosing ? text.slice(lines[closingIndex]!.start, lines[closingIndex]!.end) : null,
    });
    index = hasClosing ? closingIndex : lines.length;
  }
  return ranges;
}

function getLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    let content = text.slice(start, newline < 0 ? end : newline);
    if (content.endsWith("\r")) content = content.slice(0, -1);
    lines.push({ start, end, content });
    start = end;
  }
  return lines;
}

function isCodeFenceClosing(line: string, minimumLength: number): boolean {
  const match = /^ {0,3}(`+)[ \t]*$/u.exec(line);
  return match !== null && match[1]!.length >= minimumLength;
}

function splitCodeFence(source: string, fence: CodeFenceRange, limit: number): string[] {
  if (source.length <= limit) return [source];

  const openingLine = fence.openingLine;
  const closingLine = fence.closingLine ?? `${fence.marker}\n`;
  const contentStart = openingLine.length;
  const contentEnd = fence.closingLine === null ? source.length : source.length - closingLine.length;
  const content = source.slice(contentStart, Math.max(contentStart, contentEnd));
  const contentLimit = limit - openingLine.length - closingLine.length;
  if (contentLimit <= 0) return [source];

  const contentParts = splitTextAtPreferredBreaks(content, contentLimit);
  return contentParts.map((part, index) => {
    const close = index === contentParts.length - 1 && fence.closingLine !== null
      ? closingLine
      : fence.closingLine?.endsWith("\n") || fence.closingLine?.endsWith("\r")
        ? fence.closingLine
        : `${fence.marker}\n`;
    const lineBreak = part.length > 0 && !part.endsWith("\n") ? "\n" : "";
    return `${openingLine}${part}${lineBreak}${close}`;
  });
}

function splitPlainText(text: string, limit: number): string[] {
  if (text.length <= limit) return text.length === 0 ? [] : [text];
  const links = findSlackLinkRanges(text);
  const chunks: string[] = [];
  let cursor = 0;

  while (text.length - cursor > limit) {
    const startingLink = links.find((link) => link.start === cursor && link.end - link.start > limit);
    if (startingLink) {
      const splitToken = splitOversizedSlackLink(text.slice(startingLink.start, startingLink.end), limit);
      chunks.push(...(splitToken ?? [text.slice(startingLink.start, startingLink.end)]));
      cursor = startingLink.end;
      continue;
    }

    const target = Math.min(cursor + limit, text.length);
    let cut = preferredPlainCut(text, cursor, target);
    const link = links.find((candidate) => candidate.start < cut && cut < candidate.end);
    if (link) cut = link.start > cursor ? link.start : link.end;
    if (cut <= cursor) cut = target;

    chunks.push(text.slice(cursor, cut));
    cursor = cut;
  }
  if (cursor < text.length) chunks.push(text.slice(cursor));
  return chunks;
}

function preferredPlainCut(text: string, start: number, target: number): number {
  const threshold = start + Math.floor((target - start) * 0.65);
  const newline = text.lastIndexOf("\n", target - 1);
  if (newline >= threshold) return newline + 1;
  const whitespace = Math.max(text.lastIndexOf(" ", target - 1), text.lastIndexOf("\t", target - 1));
  if (whitespace >= threshold) return whitespace + 1;
  return target;
}

function findSlackLinkRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start < 0) break;
    const end = text.indexOf(">", start + 1);
    if (end < 0) break;
    const body = text.slice(start + 1, end);
    const isSlackLink = !/[\r\n]/u.test(body) && (
      /^(?:https?:\/\/|mailto:)[^<>]+\|[^<>]*$/iu.test(body) ||
      /^(?:https?:\/\/|mailto:)[^<>]+$/iu.test(body) ||
      /^(?:[@#][A-Za-z0-9._-]+(?:\|[^<>]*)?|![A-Za-z][^<>]*|[^<>\s|]+\|[^<>]*)$/u.test(body)
    );
    if (isSlackLink) {
      ranges.push({ start, end: end + 1 });
      cursor = end + 1;
    } else {
      cursor = start + 1;
    }
  }
  return ranges;
}

function splitOversizedSlackLink(token: string, limit: number): string[] | null {
  const separator = token.indexOf("|");
  if (separator < 0) return null;
  const url = token.slice(1, separator);
  const label = token.slice(separator + 1, -1);
  const labelLimit = limit - url.length - 3;
  if (labelLimit < 1) return null;
  return splitTextAtPreferredBreaks(label, labelLimit).map((part) => `<${url}|${part}>`);
}

function splitTextAtPreferredBreaks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (text.length - cursor > limit) {
    const target = Math.min(cursor + limit, text.length);
    let cut = preferredPlainCut(text, cursor, target);
    if (cut <= cursor) cut = target;
    chunks.push(text.slice(cursor, cut));
    cursor = cut;
  }
  if (cursor < text.length) chunks.push(text.slice(cursor));
  return chunks;
}
