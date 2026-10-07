import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { createUlid } from "../../packages/db/dist/index.js";
import { postMergeResultEvent, redactArgv, redactSecrets } from "../../packages/core/dist/post-merge-command.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

test("redactSecrets masks headers, assignments, flags and URL credentials", () => {
  const out = redactSecrets([
    "Authorization: Bearer abc123def", "Authorization: Basic dXNlcjpwdw==", "curl -H 'Bearer zzzzzzzz1'",
    "API_KEY=s3cret1", "db_password: s3cret2", "--token=s3cret3", "run --password s3cret4",
    "git clone https://user:s3cret5@example.com/r.git",
  ].join("\n"));
  for (const n of [1, 2, 3, 4, 5]) assert.ok(!out.includes(`s3cret${n}`), `s3cret${n} leaked: ${out}`);
  for (const v of ["abc123def", "dXNlcjpwdw", "zzzzzzzz1"]) assert.ok(!out.includes(v), v);
  assert.ok(out.includes("[REDACTED]"));
});

test("redactArgv masks the value element after a secret flag", () => {
  assert.deepEqual(redactArgv(["tool", "--token", "s3cret", "--name", "ok", "--api-key=k1"]),
    ["tool", "--token", "[REDACTED]", "--name", "ok", "--api-key=[REDACTED]"]);
});

test("postMergeResultEvent redacts argv, output tails and alert message", () => {
  const event = postMergeResultEvent({
    job: { project_id: "p", work_id: "w", covered_work_ids: ["w"], merge: { base_branch: "main", new_base_commit: "b", merge_commit: "b" } },
    command: { argv: ["node", "x.mjs", "--password", "pw-SECRET", "TOKEN=tk-SECRET"], cwd: "/tmp", default_command: false },
    result: { exit_code: 1, timed_out: false, stdout: "", stderr: "Authorization: Bearer bt-SECRET\nAPI_KEY=ak-SECRET" },
    duration_ms: 1, timeout_ms: 60_000,
  }, "en");
  assert.equal(event.type, "system.alert");
  assert.ok(!/SECRET/.test(JSON.stringify(event.payload)), JSON.stringify(event.payload));
});

test("a secret argv value never reaches events, outbox or logs from queueing to result", async (t) => {
  const logs = [];
  const orig = { info: console.info, warn: console.warn, log: console.log, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(" ")); };
  t.after(() => { Object.assign(console, orig); });
  const git = new Proxy({ async verifyWorkBranch() {
    return { status: "not_applicable", reason: "empty_plan", work_commit: null, commands: [], failed_command_id: null, message: null };
  }, async mergeWorkIntoBase(r) {
    return { kind: "merged", ok: true, exit_code: 0, recorded: false, message: "merged", worktree_path: "/tmp/integration", base_branch: "main",
      work_branch: `owl/work/${r.work_id}/work`, old_base_commit: "a".repeat(40), new_base_commit: "b".repeat(40), merge_commit: "b".repeat(40), verification_commands_run: [] };
  } }, { get: (o, k) => (k === "withWorkCheckout" || k === "diffPaths") ? undefined : o[k] ?? (async () => ({ ok: true, message: "ok", deleted_branches: {} })) });
  const agentRunner = { runManagerPlan: async (r) => ({ outcome: "success", report_valid: true,
    report: { tasks: r.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] } } }) };
  const { db, core } = await createTestCore(t, { git, agentRunner, dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 } }, { prefix: "owl-pm-redact-", start: true });
  const env = (payload) => ({ request_id: createUlid(), idempotency_key: `t:${createUlid()}`, expected_version: 0, payload });
  const dir = await tempDir(t, "owl-pm-redact-proj-");
  await core.createProject(env({ name: "P", canonical_path: dir, base_branch: "main", allowed_roots: [tmpdir()], verification_plan: [] }));
  const projectId = db.get("SELECT id FROM projects ORDER BY created_at DESC, id DESC LIMIT 1").id;
  const workId = (await core.createWork(env({ title: "W", summary: "s", size: "normal", project_id: projectId }))).data.work_id;
  const taskId = createUlid(), runId = createUlid(), now = new Date().toISOString();
  const argv = [process.execPath, "-e", "process.exit(2)", "--token", "CANARY_SECRET"];
  await db.createWriteLane().transact((tx) => {
    tx.run(`INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'Done', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`, taskId, workId, now, now);
    tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)", runId, workId, taskId, now, now);
    tx.run("INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1', 'success', ?, ?, 0, ?)", createUlid(), runId, JSON.stringify({ kind: "report", result: "success", work_done: "Done." }), "0".repeat(64), now);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    tx.run("UPDATE projects SET post_merge_argv_json = ? WHERE id = ?", JSON.stringify(argv), projectId);
    return null;
  });
  await core.tick(workId);
  await waitFor(() => db.get("SELECT id FROM events WHERE work_id = ? AND type = 'system.alert'", workId), { message: "the post-merge alert" });
  const types = db.all("SELECT type FROM events WHERE work_id = ?", workId).map((e) => e.type);
  assert.ok(types.includes("work.post_merge_command_queued") && types.includes("system.alert"), types.join());
  const dump = JSON.stringify([db.all("SELECT * FROM events"), db.all("SELECT * FROM outbox_deliveries")]);
  assert.ok(!dump.includes("CANARY_SECRET"), "secret leaked into events/outbox");
  assert.ok(!logs.join("\n").includes("CANARY_SECRET"), "secret leaked into logs");
  assert.ok(logs.some((l) => l.includes("queued")), "queue log not captured");
});
