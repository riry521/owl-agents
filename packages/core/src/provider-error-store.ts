import type { ProviderErrorRecord } from "@owl/shared";
import { createUlid, utcNow } from "../../db/dist/index.js";
import type { CoreDatabase, CoreWriteLaneTransaction, StoredProviderError } from "./types.js";

interface Row { readonly invocation_id: string; readonly role: string; readonly record_json: string; readonly created_at: string }

export function insertProviderError(tx: Pick<CoreWriteLaneTransaction, "run">, invocationId: string, role: string, record: ProviderErrorRecord): void {
  tx.run(
    `INSERT INTO provider_error_records (id, invocation_id, role, record_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    createUlid(), invocationId, role, JSON.stringify(record), utcNow(),
  );
}

export function listProviderErrors(
  db: Pick<CoreDatabase, "all">,
  query: { readonly invocation_id: string } | { readonly since: string; readonly role?: string },
): StoredProviderError[] {
  const rows = "invocation_id" in query
    ? db.all<Row>(`SELECT invocation_id, role, record_json, created_at FROM provider_error_records WHERE invocation_id = ? ORDER BY created_at, id`, query.invocation_id)
    : db.all<Row>(
      `SELECT invocation_id, role, record_json, created_at FROM provider_error_records WHERE created_at >= ?${query.role === undefined ? "" : " AND role = ?"} ORDER BY created_at, id`,
      ...(query.role === undefined ? [query.since] : [query.since, query.role]),
    );
  return rows.flatMap((row) => {
    try {
      return [{ invocation_id: row.invocation_id, role: row.role, record: JSON.parse(row.record_json) as ProviderErrorRecord, created_at: row.created_at }];
    } catch {
      return [];
    }
  });
}
