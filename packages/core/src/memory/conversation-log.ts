import { CONVERSATION_LOG_SECTIONS, SOURCE_LABEL, type PageSection } from "./page-format.js";
import type { RouteResult } from "./page-router.js";

/** The shape of summary the advisor is asked to write when a provider can be told how (T10 design §4.3). */
export const CONVERSATION_COMPACT_INSTRUCTIONS =
  "会話の要約を日本語で、次の 4 つの見出しだけを使って書く: ## 話したこと / ## 決まったこと / ## 学んだこと / ## 反映先。見出しの文字は変えない。"
  + "各見出しの下は「- 」で始まる 1 行 1 件の箇条書きにする。決まったこと には Owner と合意した決定だけを書く。"
  + "学んだこと には次から気をつける落とし穴を「- [落とし穴] 」、確かめた事実を「- [事実] 」で始めて書く。該当がなければ「- なし」と書く。"
  + "進行中の作業・次にやること・まだ答えていない質問は 話したこと の最後に「- 継続中: 」で始めて書く。反映先 には「- なし」とだけ書く。";

export type ConversationItemKind = "decision" | "pitfall" | "fact";
export interface ConversationItem { readonly kind: ConversationItemKind; readonly text: string }
export interface ParsedConversation {
  /** The raw lines of 話したこと / 決まったこと / 学んだこと, kept as written. */
  readonly talked: readonly string[];
  readonly decided: readonly string[];
  readonly learned: readonly string[];
  /** Items to send to the theme pages. */
  readonly items: readonly ConversationItem[];
  /** Notes for 反映先 about lines that were not sent. */
  readonly skipped: readonly string[];
}

const FIELDS = CONVERSATION_LOG_SECTIONS.slice(0, 4);
const EMPTY_ITEMS = new Set(["なし", "（なし）", "特になし", "該当なし"]);
const TRAILING_SOURCE = new RegExp(`\\s*（${SOURCE_LABEL}(?:\\s*,\\s*${SOURCE_LABEL})*）\\s*$`, "u");
const norm = (text: string): string => text.normalize("NFKC").trim();

/** Takes the 4 fields out of a summary by fixed rules (design §5.4); null when it is not in that shape. */
export function parseConversationSummary(text: string): ParsedConversation | null {
  const fields = new Map<string, string[]>();
  const order: string[] = [];
  let current: string[] | null = null;
  let fenced = false;
  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced || line.startsWith("```") ? null : /^## (.+?)\s*$/u.exec(line);
    if (heading) {
      const name = norm(heading[1]);
      if (!FIELDS.includes(name as typeof FIELDS[number]) || order.includes(name)) return null;
      order.push(name);
      current = [];
      fields.set(name, current);
    } else current?.push(line);
  }
  const required = order.filter((name) => name !== FIELDS[3]);
  if (required.join() !== FIELDS.slice(0, 3).join() || (order.length === 4 && order[3] !== FIELDS[3])) return null;
  const body = (name: string): string[] => trimBlank(fields.get(name) ?? []);
  const decided = body(FIELDS[1]);
  const learned = body(FIELDS[2]);
  const items: ConversationItem[] = [];
  const skipped: string[] = [];
  for (const [lines, field] of [[decided, "decision"], [learned, "learned"]] as const) {
    let fenced = false;
    for (const line of lines) {
      if (line.startsWith("```")) { fenced = !fenced; continue; }
      if (fenced) continue;
      if (!line.startsWith("- ")) continue;
      let content = line.slice(2).trim();
      if (EMPTY_ITEMS.has(norm(content))) continue;
      let kind: ConversationItemKind = "decision";
      if (field === "learned") {
        const mark = /^\[([^\]]*)\]\s*/u.exec(content);
        if (mark && mark[1] !== "落とし穴" && mark[1] !== "事実") {
          skipped.push(`反映なし: ${mark[1]}は司書へ`);
          continue;
        }
        kind = mark?.[1] === "落とし穴" ? "pitfall" : "fact";
        if (mark) content = content.slice(mark[0].length);
      }
      content = content.replace(TRAILING_SOURCE, "").trim();
      if (content) items.push({ kind, text: content });
    }
  }
  return { talked: body(FIELDS[0]), decided, learned, items, skipped };
}

function trimBlank(lines: readonly string[]): string[] {
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from].trim() === "") from += 1;
  while (to > from && lines[to - 1].trim() === "") to -= 1;
  return lines.slice(from, to);
}

/** One line of 反映先 for a PageRouter result (design §5.5). */
export function routeResultLine(result: RouteResult): string {
  const page = (result.page ?? "").replace(/^.*\//u, "").replace(/\.md$/u, "");
  switch (result.status) {
    case "appended": return `- [[${page}]] の ${result.section ?? ""} に 1 件`;
    case "duplicate": return `- 反映なし: 重複（[[${page}]] の ${result.section ?? ""} に既にあった）`;
    case "skill_proposal": return "- 反映なし: 手順は skill 提案へ";
    default: return `- 反映なし: ${result.reason ?? result.status}`;
  }
}

/** The sections of a conversation log: the 4 fields in order, plus 原文 (the whole summary) when it was not in the 4-field shape. */
export function conversationLogSections(input: {
  readonly parsed: ParsedConversation | null; readonly raw: string; readonly reflected: readonly string[];
}): PageSection[] {
  const { parsed } = input;
  const fields: Array<[string, readonly string[]]> = parsed
    ? [[FIELDS[0], parsed.talked], [FIELDS[1], parsed.decided], [FIELDS[2], parsed.learned], [FIELDS[3], [...input.reflected, ...parsed.skipped]]]
    : FIELDS.map((name) => [name, ["- （司書待ち）"]] as [string, readonly string[]]);
  const sections = fields.map(([heading, lines]) => ({ heading, lines: lines.length > 0 ? lines : ["- なし"] }));
  if (!parsed) sections.push({ heading: "原文", lines: input.raw.trim().split("\n").map((line) => (line.startsWith("#") ? `\\${line}` : line)) });
  return sections;
}
