import { createUlid } from "../../db/dist/index.js";
import { DEFAULT_TEST_RUN_SETTINGS } from "../../shared/dist/test-run-settings.js";
import type { TestFailure } from "./nightly-tests";
import { QUARANTINE_FIX_TASK_PREFIX } from "./state-reducer";
import type { CoreDatabase, CoreWriteLaneTransaction } from "./types";

// Core no longer adds quarantine fix Tasks; the prefix stays so a Work that still has one from before is not failed by it.
export { QUARANTINE_FIX_TASK_PREFIX };

export interface QuarantineRow {
  readonly project_id: string;
  readonly file: string;
  readonly classified_by: "baseline" | "nightly";
  readonly failures_json: string;
  readonly quarantined_at: string;
}

export interface QuarantineEntry {
  readonly file: string;
  readonly classified_by: "baseline" | "nightly";
  readonly failures: readonly TestFailure[];
}

/** Files that fail on the base too. An existing row keeps its quarantined_at. */
export function quarantineFilesInTransaction(tx: CoreWriteLaneTransaction, projectId: string, entries: readonly QuarantineEntry[], now: string): void {
  const { brief_max_failures: max, brief_message_chars: chars } = DEFAULT_TEST_RUN_SETTINGS;
  for (const entry of entries) {
    const brief = entry.failures.slice(0, max).map((f) => ({ name: f.name, line: f.line, message: f.message.slice(0, chars) }));
    tx.run(
      "INSERT OR IGNORE INTO test_quarantine (project_id, file, classified_by, failures_json, quarantined_at) VALUES (?, ?, ?, ?, ?)",
      projectId, entry.file, entry.classified_by, JSON.stringify(brief), now,
    );
  }
}

export function releaseQuarantinedFilesInTransaction(tx: CoreWriteLaneTransaction, projectId: string, files: readonly string[]): void {
  for (const file of files) tx.run("DELETE FROM test_quarantine WHERE project_id = ? AND file = ?", projectId, file);
}

/** Drops rows of files that no longer exist in the repository. */
export function pruneMissingQuarantineInTransaction(tx: CoreWriteLaneTransaction, projectId: string, existingFiles: readonly string[]): void {
  const existing = new Set(existingFiles);
  for (const row of tx.all<{ file: string }>("SELECT file FROM test_quarantine WHERE project_id = ?", projectId)) {
    if (!existing.has(row.file)) tx.run("DELETE FROM test_quarantine WHERE project_id = ? AND file = ?", projectId, row.file);
  }
}

export function quarantinedFiles(db: Pick<CoreDatabase, "all">, projectId: string): string[] {
  return db.all<{ file: string }>("SELECT file FROM test_quarantine WHERE project_id = ? ORDER BY file", projectId).map((row) => row.file);
}

/**
 * Keeps one open/in_progress backlog item per Project that names the quarantined files, so the Owner can start a fix Work from it.
 * Runs inside the write transaction that quarantines, so concurrent runs cannot make a second item.
 */
export function registerQuarantineBacklogInTransaction(tx: CoreWriteLaneTransaction, projectId: string, language: string, now: string): void {
  const rows = tx.all<QuarantineRow>("SELECT * FROM test_quarantine WHERE project_id = ? ORDER BY file", projectId);
  if (rows.length === 0) return;
  const ja = language === "ja";
  const lines = rows.map((row) => `- ${row.file}: ${row.failures_json}`).join("\n");
  const problem = ja ? `base でも落ちていて隔離されているテストがあります:\n${lines}` : `Tests that also fail on the base are quarantined:\n${lines}`;
  const suggestion = ja
    ? "コード側の不具合ならコードを、テスト側が古いならテストを直す。テストを消すのは仕様自体がなくなったときだけ。"
    : "If the code is defective, fix the code; if the test is outdated, fix the test. Delete a test only when the specification itself is gone.";
  const open = tx.get<{ id: string }>("SELECT id FROM backlog_items WHERE project_id = ? AND source = 'test_quarantine' AND status IN ('open', 'in_progress') LIMIT 1", projectId);
  if (open) {
    tx.run("UPDATE backlog_items SET problem = ?, updated_at = ? WHERE id = ?", problem, now, open.id);
    return;
  }
  tx.run(
    `INSERT INTO backlog_items
       (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion,
        status, issued_work_id, dedupe_key, created_at, updated_at, source)
     VALUES (?, NULL, NULL, ?, NULL, 0, 'test_quarantine', 0, ?, '', ?, 'open', NULL, ?, ?, ?, 'test_quarantine')`,
    createUlid(), projectId, problem, suggestion, `test_quarantine:${projectId}`, now, now,
  );
}
