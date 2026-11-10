import assert from "node:assert/strict";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid, openDatabase } from "../../packages/db/dist/index.js";
import { migrationsDir as migrations } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const now = "2026-01-01T00:00:00.000Z";
const SUFFIX = "_move_owner_replans_out_of_idempotency_keys.sql";

test("the Owner replan migration moves only well-formed owner-replan rows and keeps every other row", async (t) => {
  const root = await tempDir(t, "owl-owner-replan-migration-");
  const db = openDatabase(join(root, "owl.db")); // helpers-exempt: the test applies only the early migrations first
  t.after(() => db.close());
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  const target = files.find((name) => name.endsWith(SUFFIX));
  assert.ok(target, "the migration is found by its name suffix");
  const early = join(root, "early");
  await mkdir(early);
  for (const name of files.filter((name) => name < target)) await copyFile(join(migrations, name), join(early, name));
  db.migrate(early);

  const ownerId = createUlid();
  const w = Object.fromEntries(["processing", "old", "noKind", "unknownKind", "attempted", "badAnswer", "noStatus", "badStatus"].map((k) => [k, createUlid()]));
  const orphanId = createUlid();
  const put = (tx, key, body) => tx.run(
    `INSERT INTO idempotency_keys (key, request_hash, response_json, status_code, created_at, expires_at)
     VALUES (?, ?, ?, 202, ?, '9999-12-31T23:59:59.999Z')`,
    key, "0".repeat(64), JSON.stringify(body), now,
  );
  const requests = [{ kind: "instruction", text: "b", message_ids: ["m2"] }];
  const processingRequests = [{ kind: "instruction", text: "a", message_ids: ["m1"] }];
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'o', ?, ?)", ownerId, now, now);
    for (const id of Object.values(w)) {
      tx.run(
        `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
         VALUES (?, ?, NULL, 'Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
        id, ownerId, now, now,
      );
    }
    put(tx, `owner-replan:${w.processing}`, {
      work_id: w.processing, status: "queued", kind: "instruction", answer: "b", requests, message_ids: ["m2"],
      processing_kind: "instruction", processing_answer: "a", processing_requests: processingRequests, processing_message_ids: ["m1"],
    });
    put(tx, `owner-replan:${w.old}`, { status: "queued", kind: "reopen", answer: "old" });
    put(tx, `owner-replan:${w.noKind}`, { status: "queued", answer: "no kind", message_ids: ["m3"] });
    put(tx, `owner-replan:${w.unknownKind}`, { status: "queued", kind: "future_kind", answer: "x" });
    put(tx, `owner-replan:${w.attempted}`, { status: "attempted", kind: "decision", answer: "y", message_ids: [] });
    put(tx, `owner-replan:${w.badAnswer}`, { status: "queued", kind: "reopen", answer: 5 });
    put(tx, `owner-replan:${w.noStatus}`, { kind: "reopen", answer: "z" });
    put(tx, `owner-replan:${w.badStatus}`, { status: "done", kind: "reopen", answer: "z" });
    put(tx, `owner-replan:${orphanId}`, { status: "queued", kind: "reopen", answer: "orphan" });
    put(tx, `manager-trigger:${orphanId}`, { status: "queued" });
    put(tx, `design-completed:${orphanId}`, { task_id: orphanId });
    put(tx, `paused-reviewer-wait:${orphanId}`, { task_id: orphanId, provider: "openai" });
    put(tx, `work.resume_or_retry:${w.old}`, { ok: true });
    put(tx, "http-idempotency:POST:/works", { ok: true });
    return null;
  });

  await copyFile(join(migrations, target), join(early, target));
  db.migrate(early);

  const row = (id) => ({ ...db.get("SELECT * FROM owner_replan_requests WHERE work_id = ?", id) });
  assert.deepEqual(row(w.processing), {
    work_id: w.processing, status: "queued", kind: "instruction", answer: "b",
    requests_json: JSON.stringify(requests), message_ids_json: '["m2"]',
    processing_kind: "instruction", processing_answer: "a",
    processing_requests_json: JSON.stringify(processingRequests), processing_message_ids_json: '["m1"]',
    created_at: now, updated_at: now,
  }, "a queued request being processed moves with every processing_* field");
  assert.equal(row(w.old).requests_json, null, "the old shape without requests keeps requests_json NULL");
  assert.equal(row(w.old).message_ids_json, "[]", "a row without message_ids gets an empty array");
  assert.equal(row(w.old).processing_answer, null);
  assert.equal(row(w.noKind).kind, "decision", "a row without kind reads as decision");
  assert.equal(row(w.noKind).message_ids_json, '["m3"]');
  assert.equal(row(w.unknownKind).kind, "future_kind", "an unknown kind stays as it is");
  assert.equal(row(w.attempted).status, "attempted", "attempted moves as attempted");
  assert.deepEqual(
    db.all("SELECT work_id FROM owner_replan_requests ORDER BY work_id").map((r) => r.work_id),
    [w.processing, w.old, w.noKind, w.unknownKind, w.attempted].sort(),
    "rows with a non-text answer, no status, a wrong status or no owner do not move",
  );
  assert.equal(db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key LIKE 'owner-replan:%'").n, 0, "every moved or rejected row leaves idempotency_keys");
  assert.deepEqual(
    db.all("SELECT key FROM idempotency_keys ORDER BY key").map((r) => r.key.split(":")[0]),
    ["design-completed", "http-idempotency", "manager-trigger", "paused-reviewer-wait", "work.resume_or_retry"],
    "other markers and command records stay",
  );

  await db.createWriteLane().transact((tx) => {
    tx.run("DELETE FROM works WHERE id = ?", w.processing);
    return null;
  });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM owner_replan_requests WHERE work_id = ?", w.processing).n, 0, "deleting the Work removes its row");
});
