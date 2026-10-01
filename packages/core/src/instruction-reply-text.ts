import type { OwnerLanguage } from "@owl/shared";

/** Titles of the Tasks a replan touched, for the Manager's reply to an Owner instruction. */
export interface ReplanSummary {
  readonly planRevision: number;
  readonly added: readonly string[];
  readonly redone: readonly string[];
  readonly replaced: readonly string[];
}

/** The Manager's reply to an Owner instruction. It follows the Owner language (owner-language.ts). */
export interface InstructionReplyText {
  readonly tasksChanged: (summary: ReplanSummary) => string;
  readonly noChange: string;
  readonly decisionOpened: (detail: string) => string;
}

const MAX_LISTED = 10;

function list(label: string, items: readonly string[], more: (count: number) => string): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, MAX_LISTED).map((item) => `- ${label}: ${item}`);
  return items.length > MAX_LISTED ? [...shown, more(items.length - MAX_LISTED)] : shown;
}

export const INSTRUCTION_REPLY_TEXT: Record<OwnerLanguage, InstructionReplyText> = {
  ja: {
    tasksChanged: (s) => [
      `指示を受けて計画を更新しました（計画 rev.${s.planRevision}）。`,
      ...list("追加", s.added, (k) => `- 追加: ほか${k}件`),
      ...list("やり直し", s.redone, (k) => `- やり直し: ほか${k}件`),
      ...list("置き換え", s.replaced, (k) => `- 置き換え: ほか${k}件`),
    ].join("\n"),
    noChange: "指示を確認しました。今の計画のまま対応できるため、Taskの変更はありません。",
    decisionOpened: (detail) => `指示を計画に反映できませんでした（${detail}）。判断待ちに回答してください。`,
  },
  en: {
    tasksChanged: (s) => [
      `I updated the plan based on your instruction (plan rev.${s.planRevision}).`,
      ...list("Added", s.added, (k) => `- Added: ${k} more`),
      ...list("Redo", s.redone, (k) => `- Redo: ${k} more`),
      ...list("Replaced", s.replaced, (k) => `- Replaced: ${k} more`),
    ].join("\n"),
    noChange: "I reviewed your instruction. The current plan already covers it, so no Tasks changed.",
    decisionOpened: (detail) => `I could not apply your instruction to the plan (${detail}). Please answer the open Decision.`,
  },
};
