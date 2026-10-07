/**
 * The Owner language: what connectors write in. It is the one Owl-wide
 * setting Core keeps (GET /settings/language); a decision.opened payload also
 * carries it as `language`. Anything but "en" reads as "ja", Owl's default.
 */
export type OwlLanguage = "ja" | "en";

export function asOwlLanguage(value: unknown): OwlLanguage {
  return value === "en" ? "en" : "ja";
}
