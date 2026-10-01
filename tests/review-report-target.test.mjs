import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { registerReviewBacklogInTransaction } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";
import { buildReviewerPrompt, parseReviewResult } from "../packages/agent-runtime/dist/reviewer.js";

const migrations = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "packages/db/migrations");

const minor = (file, problem, extras = {}) => ({ severity: "minor", pre_existing: false, file, problem, ...extras });

const parse = (findings) => parseReviewResult({
  adapter: "claude",
  format: "json",
  stdout: JSON.stringify({
    verdict: "pass",
    summary: "ok",
    findings,
    tests: { ran: false, command: "none", passed: 0, failed: 0 },
  }),
});

test("backlog skips minor findings that target the report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-review-target-"));
  const db = openDatabase(join(root, "owl.db"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  db.migrate(migrations);
  const now = "2026-09-27T00:00:00.000Z";
  const workId = createUlid();
  const taskId = createUlid();
  const findings = [
    minor("a.ts", "report omits the command", { target: "report" }),
    minor("b.ts", "unused import", { target: "deliverable" }),
    minor("c.ts", "legacy finding"),
  ];
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', NULL, 'w', '', 'small', 'running', '[]', '[]', ?, ?)`,
      workId, now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, created_at, updated_at)
       VALUES (?, ?, 't', 'code', 'completed', 'normal', '', '', '/repo', ?, ?)`,
      taskId, workId, now, now,
    );
    tx.run(
      `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
       VALUES (?, ?, 1, 'pass', ?, '{}', ?)`,
      createUlid(), taskId, JSON.stringify(findings), now,
    );
  });
  await db.createWriteLane().transact((tx) => registerReviewBacklogInTransaction(tx, taskId, now));
  const files = db.all("SELECT file FROM backlog_items ORDER BY file").map((row) => row.file);
  assert.deepEqual(files, ["b.ts", "c.ts"]);
});

test("parseReviewResult fills target for legacy findings and rejects a major report finding", () => {
  const legacy = { severity: "minor", pre_existing: false, file: "a.ts", line: 0, problem: "p", reason: "r", fix: "f" };
  assert.equal(parse([legacy]).findings[0].target, "deliverable");
  assert.equal(parse([{ ...legacy, target: "report" }]).findings[0].target, "report");
  assert.throws(
    () => parse([{ ...legacy, severity: "major", target: "report" }]),
    (error) => error?.code === "review_invalid" && error.reason === "report_major",
  );
});

test("reviewer prompt does not flag report format but still flags false reports", () => {
  const prompt = buildReviewerPrompt({
    task: { id: "t", title: "t", type: "code", review_round: 1 },
    report: { changes: [] },
    review_round: 1,
  }, "en");
  assert.doesNotMatch(prompt, /report misdescribes it/u);
  assert.match(prompt, /Do not report the format, omissions, or wording of the Worker report as findings, not even as minor/u);
  assert.match(prompt, /Exception: when the report states something that is not true[^.]*set target to deliverable/u);
});
