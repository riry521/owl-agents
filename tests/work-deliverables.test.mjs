import assert from "node:assert/strict";
import { test } from "node:test";

import { workDeliverables } from "../apps/web/lib/work-deliverables.mjs";

const report = (id, runId, createdAt, changes) => ({ id, agent_run_id: runId, created_at: createdAt, payload: { changes } });

test("deliverables list each file completed Tasks changed, using the Worker report file/action fields", () => {
  const tasks = [
    { id: "T2", status: "completed" },
    { id: "T3", status: "cancelled" },
    { id: "T5", status: "completed" },
    { id: "T4", status: "running" },
  ];
  const runs = [
    { id: "R2", task_id: "T2" },
    { id: "R3", task_id: "T3" },
    { id: "R5", task_id: "T5" },
    { id: "R4", task_id: "T4" },
  ];
  const reports = [
    report("P5", "R5", "2026-09-24T08:56:00Z", [
      { file: "apps/web/BoardView.tsx", action: "Added archive buttons" },
      { file: "packages/core/src/core.ts", action: "Exposed archive filter" },
    ]),
    report("P2", "R2", "2026-09-24T08:02:00Z", [
      { file: "packages/core/src/core.ts", action: "Added archive commands" },
      { file: "packages/db/migrations/007_work_archiving.sql", action: "Added archived_at" },
      { action: "no file" },
      null,
    ]),
    // A superseded Task's changes never reached the Work branch.
    report("P3", "R3", "2026-09-24T08:38:00Z", [{ file: "apps/web/BoardView.tsx", action: "conflicting version" }]),
    report("P4", "R4", "2026-09-24T09:00:00Z", [{ file: "tests/archive.test.mjs", action: "in progress" }]),
  ];

  assert.deepEqual(workDeliverables(reports, runs, tasks), [
    { file: "packages/db/migrations/007_work_archiving.sql", action: "Added archived_at", task_id: "T2", agent_run_id: "R2" },
    { file: "apps/web/BoardView.tsx", action: "Added archive buttons", task_id: "T5", agent_run_id: "R5" },
    { file: "packages/core/src/core.ts", action: "Exposed archive filter", task_id: "T5", agent_run_id: "R5" },
  ]);
});
