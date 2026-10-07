import { DEFAULT_OWNER_LANGUAGE, type OwnerLanguage } from "./owner-language.js";

/**
 * The one template for a Work summary. The Advisor is told to write every
 * summary in this shape (see workSummaryInstruction), and the Web UI parses
 * the same labels to show each section on its own. apps/web/lib/work-summary.mjs
 * carries a copy of WORK_SUMMARY_SECTIONS; a test keeps the two identical.
 *
 * The labels follow the Owner language (owner-language.ts): `label` for
 * "ja", `label_en` for "en". Readers accept both, so a summary written before
 * the language changed still parses.
 *
 * Text form, sections in this order, optional sections left out when empty:
 *
 *   依頼: <what to do>
 *
 *   受け入れ条件:
 *   - <condition>
 */
export interface WorkSummarySection {
  readonly key: "request" | "background" | "approach" | "acceptance" | "notes";
  /** The label written in the summary text (`<label>: ...`). */
  readonly label: string;
  /** English label, also accepted when reading a summary. */
  readonly label_en: string;
  /** "list" sections hold one `- ` item per line. */
  readonly kind: "text" | "list";
  readonly required: boolean;
  /** What belongs in the section. */
  readonly guide: string;
}

export const WORK_SUMMARY_SECTIONS: readonly WorkSummarySection[] = [
  { key: "request", label: "依頼", label_en: "Request", kind: "text", required: true, guide: "what should be done, in one to three sentences" },
  { key: "background", label: "背景", label_en: "Background", kind: "text", required: false, guide: "why it is needed and what the conversation established" },
  { key: "approach", label: "方針", label_en: "Approach", kind: "text", required: false, guide: "the agreed way to do it and its constraints" },
  { key: "acceptance", label: "受け入れ条件", label_en: "Acceptance", kind: "list", required: true, guide: "conditions that make the Work done, one per line" },
  { key: "notes", label: "注意", label_en: "Notes", kind: "text", required: false, guide: "what must not be done and known pitfalls" },
];

/** The label a summary is written with in `language`. */
export function workSummaryLabel(section: WorkSummarySection, language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE): string {
  return language === "en" ? section.label_en : section.label;
}

/** The empty template, e.g. `依頼: \n\n受け入れ条件:\n- `. */
export function workSummarySkeleton(language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE): string {
  return WORK_SUMMARY_SECTIONS
    .map((section) => {
      const label = workSummaryLabel(section, language);
      return section.kind === "list" ? `${label}:\n- ` : `${label}: `;
    })
    .join("\n\n");
}

/** Advisor prompt text describing the summary template in the Owner language. */
export function workSummaryInstruction(language: OwnerLanguage = DEFAULT_OWNER_LANGUAGE): string {
  const lines = WORK_SUMMARY_SECTIONS.map((section) =>
    `- "${workSummaryLabel(section, language)}:" (${section.required ? "required" : "optional, leave out when there is nothing to say"}${section.kind === "list" ? ", one \"- \" item per line" : ""}): ${section.guide}.`,
  );
  return [
    "Write summary in this template, with the labels exactly as shown, each section starting on its own line, sections in this order and separated by a blank line. Put the user's full request, relevant conversation context, and concrete acceptance criteria into these sections.",
    ...lines,
  ].join("\n");
}
