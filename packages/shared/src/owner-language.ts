/**
 * The language of everything Owl writes for the Owner: the human-readable
 * values in every agent output (reports, review findings, final verdicts,
 * plans), the text Owl itself writes (Decisions), and notifications.
 * Deliverables (code, comments, commit messages, documents) are not covered:
 * they follow the conventions of their repository.
 *
 * One setting per Owl, stored in the `settings` table under
 * OWNER_LANGUAGE_SETTINGS_KEY as a JSON string. Changing it affects output
 * produced afterwards; nothing already written is translated.
 */
export type OwnerLanguage = "ja" | "en";

export const OWNER_LANGUAGES: readonly OwnerLanguage[] = ["ja", "en"];

/** Used when the setting was never stored. */
export const DEFAULT_OWNER_LANGUAGE: OwnerLanguage = "ja";

export const OWNER_LANGUAGE_SETTINGS_KEY = "language";

export function isOwnerLanguage(value: unknown): value is OwnerLanguage {
  return value === "ja" || value === "en";
}

/** The language an OS locale such as "ja-JP" or "en_US.UTF-8" implies. */
export function ownerLanguageFromLocale(locale: string | null | undefined): OwnerLanguage {
  return typeof locale === "string" && locale.toLowerCase().startsWith("ja") ? "ja" : "en";
}

const LANGUAGE_NAMES: Readonly<Record<OwnerLanguage, string>> = { ja: "Japanese (日本語)", en: "English" };

/**
 * The output-language rule every role prompt carries. Machine-read values
 * stay unchanged so validation and tooling keep working.
 */
export function outputLanguageInstruction(language: OwnerLanguage): string {
  return [
    `Write every human-readable value in ${LANGUAGE_NAMES[language]}: summaries, descriptions, titles, instructions, issues, findings and lessons.`,
    "Keep enum values, ids, file paths, commands, code identifiers and quoted error messages exactly as they are.",
    "This rule covers only the JSON you return. Files you create or change follow the conventions of their repository.",
  ].join(" ");
}
