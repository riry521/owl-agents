import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { NoopGitGateway } from "../../packages/core/dist/index.js";
import { FakeClock } from "../helpers/clock.mjs";
import { createTestCore } from "../helpers/core.mjs";

const T0 = new Date(2026, 5, 1, 10, 0, 0);
// The overview is read from page files (real I/O), so microtask flushing is not enough.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
const at = (day, hour, minute = 0) => new Date(2026, 5, day, hour, minute, 0);

const worth = {
  ok: true,
  judgment: { worth_fixing: true, reason: "直す価値がある", duplicate_of_work_id: null, duplicate_reason: null, work: { title: "夜間テストを直す", summary: "失敗を直す", size: "normal" } },
};

async function setup(t) {
  const calls = [];
  const clock = new FakeClock(T0);
  const { root, db, core } = await createTestCore(t, {
    git: new NoopGitGateway(),
    version: "auto-work-scheduled-check",
    agentRunner: { runAutoWorkJudgment: async (request) => { calls.push(request); return worth; } },
    autoWork: { clock },
  }, { prefix: "owl-auto-work-scheduled-check-" });
  const directory = join(root, "rules", "auto-work");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "defaults.json"), await readFile(new URL("../../rules/auto-work/defaults.json", import.meta.url), "utf8"));
  const now = T0.toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'owner:default', ?, ?)", now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
         verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES ('proj1', 'owner:default', 'Project 1', ?, 'main', '[]', '[]', '[]', ?, ?)`,
      join(root, "proj1"), now, now,
    );
    tx.run(
      `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('auto_work', 'owner:default', '1.0.0', ?, ?)`,
      JSON.stringify({ schema_version: "1.0.0", version: 1, enabled: true, projects: { proj1: { enabled: true } } }), now,
    );
  });
  await core.start();

  /** A nightly run that failed with these test names, and the open backlog item it made. */
  const seedFailedRun = async (id, names, finishedAt) => {
    const itemId = `item-${id}`;
    await db.createWriteLane().transact((tx) => {
      tx.run(
        `INSERT INTO backlog_items (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion,
           status, issued_work_id, dedupe_key, created_at, updated_at, source)
         VALUES (?, NULL, NULL, 'proj1', NULL, 0, 'tests/a.test.mjs', 0, ?, '', '', 'open', NULL, ?, ?, ?, 'nightly_test')`,
        itemId, `problem ${id}`, `key-${id}`, finishedAt.toISOString(), finishedAt.toISOString(),
      );
      tx.run(
        `INSERT INTO nightly_test_runs (id, project_id, status, started_at, finished_at, failures_json, new_failure_count, backlog_item_ids_json)
         VALUES (?, 'proj1', 'failed', ?, ?, ?, ?, ?)`,
        id, finishedAt.toISOString(), finishedAt.toISOString(),
        JSON.stringify(names.map((name) => ({ file: "tests/a.test.mjs", name, line: null, message: "" }))), names.length, JSON.stringify([itemId]),
      );
    });
    return itemId;
  };
  const events = () => db.all("SELECT * FROM auto_work_events ORDER BY created_at, id");
  const item = (id) => db.get("SELECT status, issued_work_id FROM backlog_items WHERE id = ?", id);
  return { root, db, core, clock, calls, events, item, seedFailedRun, directory };
}

test("the scheduled check runs once a day at its time, makes a Work and links the backlog item", async (t) => {
  const { core, clock, calls, events, item, seedFailedRun, directory } = await setup(t);
  const first = await seedFailedRun("run1", ["a"], at(1, 4));

  await clock.advanceTo(at(2, 9));
  await settle();
  const [event, ...others] = events();
  assert.equal(others.length, 0);
  assert.equal(event.verdict, "created");
  assert.equal(event.kind, "nightly_test_failed");
  assert.equal(event.source, "scheduled_check");
  assert.equal(calls.length, 1);
  const work = core.db.get("SELECT id, state, project_id FROM works WHERE id = ?", event.work_id);
  assert.equal(work.state, "memo");
  assert.deepEqual(item(first), { status: "in_progress", issued_work_id: work.id });

  // A time changed to later the same day does not check a second time.
  await writeFile(join(directory, "local.json"), JSON.stringify({ scheduled_check: { times: ["09:30"] } }));
  await core.autoWorkConfig.reload();
  core.autoWork.reconfigure();
  const second = await seedFailedRun("run2", ["b"], at(2, 9, 1));
  await clock.advanceTo(at(2, 9, 31));
  await settle();
  assert.equal(events().length, 1);
  assert.equal(item(second).status, "open");

  // A manual check runs on the same day.
  await core.autoWork.runAutoWorkNow("scheduled_check", "proj1");
  const afterManual = events();
  assert.equal(afterManual.length, 2);
  assert.equal(afterManual[1].verdict, "created");
  assert.equal(item(second).status, "in_progress");
});

test("a different set of failures gets a different dedupe key and the same set gets the same one", async (t) => {
  const { core, events, seedFailedRun } = await setup(t);
  const check = async () => {
    await core.autoWork.runAutoWorkNow("scheduled_check", "proj1");
    return events().at(-1).dedupe_key;
  };
  await seedFailedRun("run1", ["a", "b"], at(1, 4));
  const keyAB = await check();
  await seedFailedRun("run2", ["a"], at(1, 5));
  const keyA = await check();
  await seedFailedRun("run3", ["b", "a"], at(1, 6));
  const keyBA = await check();
  assert.notEqual(keyAB, keyA);
  assert.equal(keyBA, keyAB);
});

test("an unknown item name in the settings is skipped", async (t) => {
  const { core, events, seedFailedRun, directory } = await setup(t);
  await writeFile(join(directory, "local.json"), JSON.stringify({ scheduled_check: { items: ["toString", "nightly_test_failed"] } }));
  await core.autoWorkConfig.reload();
  core.autoWork.reconfigure();
  await seedFailedRun("run1", ["a"], at(1, 4));
  await core.autoWork.runAutoWorkNow("scheduled_check", "proj1");
  assert.equal(events().length, 1);
});
