export const MAX_NOTE_TAGS = 5;
export const MIN_KEYWORDS = 3;
export const PRESERVED_ORIGIN_TAGS = ["auto-saved", "work-lessons", "legacy-unknown"] as const;

export type TagProblem = "empty" | "too_long" | "sentence_punctuation" | "particle_edge" | "verb_ending" | "stopword" | "numeric" | "embedded_particle";

const STOPWORDS = new Set([
  "task", "work", "owl", "note", "notes", "lesson", "lessons", "the", "and", "for", "with",
  "対応", "作業", "問題", "確認", "修正", "実装", "場合",
]);
const VERB_ENDINGS = ["する", "した", "して", "しない", "される", "させる", "できる", "ない", "ます", "です", "った", "って", "ている", "こと", "とき", "ため", "ように"];
const HEAD_PARTICLES = ["から", "まで", "より", "は", "が", "を", "に", "で", "と", "の", "へ", "も", "や"];
const TAIL_PARTICLES = "をにでとのへがはもや";
/** A particle between two nouns ("日本語の題名", "起動時に使う設定") marks a phrase, not a keyword. */
const EMBEDDED_PARTICLE = /[\p{Script=Han}\p{Script=Katakana}](?:から|まで|より|[をにでとのへがはもや])[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}]/u;
const PUNCTUATION = /[、。，．,!?！？「」『』()（）:：;；/\s]/u;

export function normalizeKeywordTag(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/^#+/, "").toLocaleLowerCase();
}

export function tagProblem(tag: string): TagProblem | null {
  if (tag.length === 0) return "empty";
  const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(tag);
  if (tag.length > (hasCjk ? 10 : 30)) return "too_long";
  if (PUNCTUATION.test(tag)) return "sentence_punctuation";
  if (/^[\p{N}\p{P}\p{S}]+$/u.test(tag)) return "numeric";
  if (STOPWORDS.has(tag)) return "stopword";
  if (EMBEDDED_PARTICLE.test(tag)) return "embedded_particle";
  for (const particle of HEAD_PARTICLES) {
    if (tag.startsWith(particle) && tag.length > particle.length
      && /[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u.test(tag[particle.length])) return "particle_edge";
  }
  if (tag.length >= 3 && TAIL_PARTICLES.includes(tag[tag.length - 1])) return "particle_edge";
  if (VERB_ENDINGS.some((ending) => tag.endsWith(ending))) return "verb_ending";
  return null;
}

export function isValidTag(tag: string): boolean {
  return tagProblem(tag) === null;
}

export function sanitizeKeywords(raw: readonly unknown[], max = MAX_NOTE_TAGS): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    if (/\s/u.test(value.trim())) continue;
    const tag = normalizeKeywordTag(value);
    if (isValidTag(tag)) seen.add(tag);
  }
  return [...seen].slice(0, max);
}

/** Union of two tag sets that never exceeds `max`; tags present in both survive first. */
export function mergeTagSets(target: readonly string[], incoming: readonly string[], max = MAX_NOTE_TAGS): string[] {
  const left = sanitizeKeywords(target, Infinity);
  const right = sanitizeKeywords(incoming, Infinity);
  const shared = left.filter((tag) => right.includes(tag));
  return [...new Set([...shared, ...left, ...right])]
    .slice(0, max)
    .sort((a, b) => a.localeCompare(b));
}
