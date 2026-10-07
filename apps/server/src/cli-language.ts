import { isOwnerLanguage, ownerLanguageFromLocale, type OwnerLanguage } from "../../../packages/shared/dist/owner-language.js";

export function cliLanguage(env: NodeJS.ProcessEnv = process.env): OwnerLanguage {
  if (isOwnerLanguage(env.OWL_LANG)) return env.OWL_LANG;
  return ownerLanguageFromLocale(env.LC_ALL || env.LC_MESSAGES || env.LANG);
}

export function cliText(ja: string, en: string, env: NodeJS.ProcessEnv = process.env): string {
  return cliLanguage(env) === "ja" ? ja : en;
}
