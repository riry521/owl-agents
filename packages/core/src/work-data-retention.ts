import type { WriteLane } from "../../db/dist/index.js";
import {
  DEFAULT_WORK_DATA_RETENTION_SETTINGS,
  readWorkDataRetentionSettings,
  WORK_DATA_RETENTION_SETTINGS_KEY,
  type WorkDataRetentionSettings,
} from "../../shared/dist/work-data-retention-settings.js";
import type { SettingsReader } from "./owner-language";
import { readSetting, type SettingReadSpec } from "./settings-store";

const SETTING: SettingReadSpec<WorkDataRetentionSettings> = {
  key: WORK_DATA_RETENTION_SETTINGS_KEY,
  defaults: DEFAULT_WORK_DATA_RETENTION_SETTINGS,
  read: readWorkDataRetentionSettings,
  warnPrefix: "work_data_retention: ",
  readFailure: "Could not read work_data_retention; using defaults",
};

const FINISHED = `SELECT id FROM works WHERE state IN ('completed','cancelled')`;

/**
 * Clears what nothing reads after a Work ends: delivered outbox rows, clone-use rows of completed Tasks,
 * review verification reports, event payloads nothing reads, and every report but each Task's latest. Other Works' rows stay.
 * Why one entry point: later cleanups join this call so Work end and startup stay in step.
 * Why not pending/failed outbox rows: the dispatcher still resends them.
 * workId null clears every finished Work (startup).
 */
export async function pruneFinishedWorkData(reader: SettingsReader, lane: WriteLane, workId: string | null): Promise<void> {
  if (!readSetting(reader, SETTING).enabled) return;
  const works = workId === null ? FINISHED : `${FINISHED} AND id = ?`;
  const args = workId === null ? [] : [workId];
  await lane.transact((tx) => {
    tx.run(
      `DELETE FROM outbox_deliveries WHERE status = 'delivered' AND event_id IN (SELECT id FROM events WHERE work_id IN (${works}))`,
      ...args,
    );
    tx.run(
      `DELETE FROM task_clone_uses WHERE task_id IN (SELECT id FROM tasks WHERE status = 'completed' AND work_id IN (${works}))`,
      ...args,
    );
    tx.run(
      `UPDATE reviews SET verification_report_json = '{}' WHERE verification_report_json <> '{}'
       AND task_id IN (SELECT id FROM tasks WHERE work_id IN (${works}))`,
      ...args,
    );
    // agent_runs.report_id is RESTRICT; only runs whose report is not their Task's latest lose the link.
    const stale = `SELECT r.id FROM reports r JOIN agent_runs a ON a.id = r.agent_run_id
         WHERE a.task_id IS NOT NULL AND a.work_id IN (${works})
           AND EXISTS (SELECT 1 FROM reports r2 JOIN agent_runs a2 ON a2.id = r2.agent_run_id
                       WHERE a2.task_id = a.task_id AND (r2.created_at > r.created_at OR (r2.created_at = r.created_at AND r2.id > r.id)))`;
    tx.run(`UPDATE agent_runs SET report_id = NULL WHERE report_id IN (${stale})`, ...args);
    tx.run(`DELETE FROM reports WHERE id IN (${stale})`, ...args);
    // Event rows stay (metrics, command-event: marks, foreign keys); only payloads nothing reads after the Work ends go.
    // Why not task.failure.classified etc.: task-lineage counts rows by their report keys, and reopen reads them.
    tx.run(
      `UPDATE events SET payload_json = '{}' WHERE type IN ('test_run.completed','agent.started') AND payload_json <> '{}' AND work_id IN (${works})`,
      ...args,
    );
    tx.run(
      `UPDATE events SET payload_json = json_remove(payload_json, '$.report', '$.usage') WHERE type = 'agent.exited'
       AND (json_type(payload_json, '$.report') IS NOT NULL OR json_type(payload_json, '$.usage') IS NOT NULL) AND work_id IN (${works})`,
      ...args,
    );
  });
}
