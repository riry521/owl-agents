import { createUlid, utcNow, type WriteLane } from "../../db/dist/index.js";
import { SettingsValidationError } from "../../shared/dist/settings-validation.js";
import { validationError } from "./errors";
import type { SettingsReader } from "./owner-language";
import type { CoreWriteLaneTransaction, JsonObject } from "./types";

// Why only these runtime imports: state-reducer.ts imports most settings modules, so importing it here would form a cycle.

export const DEFAULT_OWNER_ID = "owner:default";

export function ensureOwner(transaction: CoreWriteLaneTransaction, ownerId: string, now: string): void {
  transaction.run(
    `INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    ownerId,
    ownerId,
    now,
    now,
  );
}

/** The stored JSON text of a setting, or undefined when it has no row. A failed read is thrown. */
export function storedSettingJson(reader: SettingsReader, key: string): string | undefined {
  return reader.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key)?.value_json;
}

/** The stored row of a setting including updated_at (only hybrid mode needs it). */
export function storedSettingRow(reader: SettingsReader, key: string): { value_json: string; updated_at: string } | undefined {
  return reader.get<{ value_json: string; updated_at: string }>("SELECT value_json, updated_at FROM settings WHERE key = ?", key);
}

/** Writes a setting row after making sure the default owner exists. An existing row keeps its schema_version. */
export function upsertSetting(
  transaction: CoreWriteLaneTransaction,
  input: { readonly key: string; readonly valueJson: string; readonly now?: string; readonly schemaVersion?: string },
): void {
  const now = input.now ?? utcNow();
  ensureOwner(transaction, DEFAULT_OWNER_ID, now);
  transaction.run(
    `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    input.key,
    DEFAULT_OWNER_ID,
    input.schemaVersion ?? "1.0.0",
    input.valueJson,
    now,
  );
}

export interface SettingReadSpec<T> {
  readonly key: string;
  readonly defaults: T;
  readonly read: (value: unknown, warn: (message: string) => void) => T;
  readonly warnPrefix?: string;
  readonly readFailure: string;
}

/** Missing row gives defaults; a failed read or unparsable JSON warns and gives defaults. */
export function readSetting<T>(reader: SettingsReader, spec: SettingReadSpec<T>): T {
  try {
    const json = storedSettingJson(reader, spec.key);
    if (json === undefined) return spec.defaults;
    return spec.read(JSON.parse(json) as unknown, (message) => {
      console.warn(`[owl-core] ${spec.warnPrefix ?? ""}${message}`);
    });
  } catch (error) {
    console.warn(`[owl-core] ${spec.readFailure}`, error);
    return spec.defaults;
  }
}

/** Runs validate; a SettingsValidationError becomes a validation_error with its field, anything else is rethrown. */
export function validatedSetting<T, I>(validate: (input: I) => T, input: I): T {
  try {
    return validate(input);
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      throw validationError(error.message, { field: error.field });
    }
    throw error;
  }
}

export interface SettingSaveSpec<T, I = unknown> {
  readonly key: string;
  readonly validate: (input: I) => T;
  readonly event: {
    readonly type: string;
    readonly idempotencyPrefix: string | ((value: T) => string);
    /** Defaults to the value itself. */
    readonly payload?: (value: T) => unknown;
  };
}

export type SettingSpec<T, I = unknown> = SettingReadSpec<T> & SettingSaveSpec<T, I>;

/** Validates, then saves the setting and its event in one write-lane write. Returns the validated value. */
export async function saveSetting<T, I>(writeLane: Pick<WriteLane, "write">, spec: SettingSaveSpec<T, I>, input: I): Promise<T> {
  const value = validatedSetting(spec.validate, input);
  const prefix = typeof spec.event.idempotencyPrefix === "function" ? spec.event.idempotencyPrefix(value) : spec.event.idempotencyPrefix;
  await writeLane.write({
    mutateState: (transaction) => {
      upsertSetting(transaction, { key: spec.key, valueJson: JSON.stringify(value) });
      return value;
    },
    event: {
      idempotencyKey: `${prefix}:${createUlid()}`,
      type: spec.event.type,
      payload: (spec.event.payload ? spec.event.payload(value) : value) as JsonObject,
    },
    outbox: [{ provider: "websocket" }],
  });
  return value;
}
