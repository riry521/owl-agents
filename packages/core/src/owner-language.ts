import {
  DEFAULT_OWNER_LANGUAGE,
  OWNER_LANGUAGE_SETTINGS_KEY,
  isOwnerLanguage,
  type OwnerLanguage,
} from "@owl/shared";

import { storedSettingJson } from "./settings-store";
import type { CoreSqlValue } from "./types";

export { DEFAULT_OWNER_LANGUAGE, OWNER_LANGUAGE_SETTINGS_KEY, isOwnerLanguage, type OwnerLanguage };

/** Anything that can read a row: the database or a WriteLane transaction. */
export interface SettingsReader {
  get<T extends object>(sql: string, ...parameters: CoreSqlValue[]): T | undefined;
}

/** The stored Owner language, or null when it was never set. */
export function storedOwnerLanguage(reader: SettingsReader): OwnerLanguage | null {
  const json = storedSettingJson(reader, OWNER_LANGUAGE_SETTINGS_KEY);
  if (json === undefined) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isOwnerLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

/** The Owner language every Owner-facing output is written in. */
export function ownerLanguage(reader: SettingsReader): OwnerLanguage {
  return storedOwnerLanguage(reader) ?? DEFAULT_OWNER_LANGUAGE;
}
