import assert from "node:assert/strict";
import { test } from "node:test";
import { createUlid } from "../../packages/db/dist/index.js";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestCore, command } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { PostMergeCommandQueue } from "../../packages/core/dist/post-merge-command.js";

function commandEnvelope(payload, suffix) {
  return command(payload, `test:${suffix}:${createUlid()}`, 0);
}

function fakeGit(commits = { old: "a".repeat(40), new: "b".repeat(40) }) {
  return {
    async abortIntegrationMerge() { return { ok: true, message: "none" }; },
    async mergeWorkIntoBase(request) {
      return {
        kind: "merged", ok: true, exit_code: 0, recorded: false, message: "merged", worktree_path: "/tmp/integration",
        base_branch: "main", work_branch: `owl/work/${request.work_id}/work`, old_base_commit: commits.old,
        new_base_commit: commits.new, merge_commit: commits.new, verification_commands_run: [],
      };
    },
    async deleteMergedWorkBranches() { return { ok: true, message: "removed", deleted_branches: {} }; },
    async removeWorktree() { return { ok: true, message: "removed" }; },
    async removeIntegrationWorktree() { return { ok: true, message: "removed" }; },
    async removeMergedIntegrationWorktree() { return { ok: true, message: "removed" }; },
    async removeTaskWorktreeAndBranch() { return { ok: true, message: "removed" }; },
    async discardTaskWorktree() { return { ok: true, message: "discarded" }; },
    async discardMergedWorktree() { return { ok: true, message: "discarded" }; },
    async verifyWorkBranch() { return { status: "not_applicable", reason: "empty_plan", work_commit: null, commands: [], failed_command_id: null, message: null }; },
    async listWorkspaces() { return []; },
  };
}

async function openMergeCore(t, postMergeCommand, commits) {
  const agentRunner = {
    runManagerPlan: async (request) => ({
      outcome: "success", report_valid: true,
      report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "done", missing: [], lessons: [] } },
    }),
    runWorker: async () => ({ outcome: "failed", message: "unexpected worker call" }),
    runReviewer: async () => ({ outcome: "failed", message: "unexpected reviewer call" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, core, root } = await createTestCore(t, { git: fakeGit(commits), agentRunner, postMergeCommand: { installDefault: [], ...postMergeCommand }, dispatcher: { tick_interval_ms: 60_000, manager_retry_delay_ms: 1 } }, { prefix: "owl-post-merge-core-", start: true });
  return { db, core, root };
}

/** A finished Work in a new Project. `path` is the project's canonical_path; `argv` its stored command (null = unset). */
async function seedFinishedWork(core, db, path, argv) {
  await core.createProject(commandEnvelope({
    name: `Project ${createUlid()}`, canonical_path: path, base_branch: "main", allowed_roots: [tmpdir()], verification_plan: [],
  }, "project"));
  const projectId = db.get("SELECT id FROM projects ORDER BY created_at DESC, id DESC LIMIT 1").id;
  const created = await core.createWork(commandEnvelope({ title: "Post merge", summary: "Check.", size: "normal", project_id: projectId }, "work"));
  const workId = created.data.work_id;
  const taskId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, state_version, failure_count, same_error_count, review_round, worker_generation, created_at, updated_at, retry_no, manager_task_id)
       VALUES (?, ?, 'Done', 'code', 'completed', 'normal', '', 'Done.', 0, 0, 0, 0, 0, ?, ?, 0, 'T1')`,
      taskId, workId, now, now,
    );
    const runId = createUlid();
    tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, 'worker', 'test', 'test', 'completed', ?, ?)", runId, workId, taskId, now, now);
    tx.run("INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at) VALUES (?, ?, '1', 'success', ?, ?, 0, ?)", createUlid(), runId, JSON.stringify({ kind: "report", result: "success", work_done: "Done." }), "0".repeat(64), now);
    tx.run("UPDATE works SET state = 'running' WHERE id = ?", workId);
    if (argv !== null) tx.run("UPDATE projects SET post_merge_argv_json = ? WHERE id = ?", JSON.stringify(argv), projectId);
    return null;
  });
  return { workId, projectId };
}

/** A git repo whose second commit adds `changed` (paths relative to the repo). Returns both commit ids. */
async function repoWithChange(t, changed) {
  const dir = await tempDir(t, "owl-post-merge-git-");
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "a");
  git("add", "."); git("commit", "-q", "-m", "one");
  const old = git("rev-parse", "HEAD");
  for (const file of changed) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), "{}");
  }
  git("add", "."); git("commit", "-q", "--allow-empty", "-m", "two");
  return { dir, commits: { old, new: git("rev-parse", "HEAD") } };
}

/** argv for a node one-liner that appends `label` to the log file, then exits with `exit`. */
const logging = (log, label, exit = 0, extra = "") =>
  [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(label + "\n")}); ${extra} process.exit(${exit});`];

const resultEvent = (db, workId) => db.get("SELECT type, payload_json FROM events WHERE work_id = ? AND type IN ('work.post_merge_command_succeeded', 'system.alert')", workId);

test("owl root project runs its default command after merge; other unset projects run nothing", async (t) => {
  const scriptDir = await tempDir(t, "owl-post-merge-script-");
  const script = join(scriptDir, "mark.mjs");
  await writeFile(script, "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', process.cwd());");
  const { db, core, root } = await openMergeCore(t, { owlRootDefault: [process.execPath, script] });
  const other = await tempDir(t, "owl-post-merge-other-");

  const unset = await seedFinishedWork(core, db, other, null);
  await core.tick(unset.workId);
  const owl = await seedFinishedWork(core, db, root, null);
  await core.tick(owl.workId);

  const event = await waitFor(() => resultEvent(db, owl.workId), { message: "post-merge result" });
  assert.equal(event.type, "work.post_merge_command_succeeded");
  const payload = JSON.parse(event.payload_json);
  assert.equal(payload.default_command, true);
  assert.equal(payload.exit_code, 0);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", owl.workId).state, "completed");
  assert.equal(await readFile(join(root, "ran.txt"), "utf8"), await realpath(root));
  assert.ok(db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.post_merge_command_queued'", owl.workId));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type LIKE '%post_merge%'", unset.workId).n, 0);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", unset.workId).state, "completed");
});

test("a failing command records a system.alert with the redacted output tail and leaves the Work completed", async (t) => {
  const { db, core } = await openMergeCore(t, undefined);
  const dir = await tempDir(t, "owl-post-merge-fail-");
  const code = "console.error('build exploded https://user:tok@example.com/x'); process.exit(3);";
  const { workId, projectId } = await seedFinishedWork(core, db, dir, [process.execPath, "-e", code]);
  await core.tick(workId);

  const event = await waitFor(() => resultEvent(db, workId), { message: "post-merge alert" });
  assert.equal(event.type, "system.alert");
  const alert = JSON.parse(event.payload_json);
  assert.equal(alert.kind, "work_post_merge_command_failed");
  assert.equal(alert.exit_code, 3);
  assert.equal(alert.timed_out, false);
  assert.match(alert.stderr_tail, /build exploded/);
  assert.doesNotMatch(alert.stderr_tail, /tok@/);
  assert.match(alert.message, /build exploded/);
  assert.equal(alert.argv[0], process.execPath);
  assert.equal(db.get("SELECT idempotency_key FROM events WHERE work_id = ? AND type = 'system.alert'", workId).idempotency_key, `work-post-merge-failed:${projectId}:${"b".repeat(40)}`);
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
});

test("commands from two merges never overlap", async (t) => {
  const { db, core } = await openMergeCore(t, undefined);
  const dir = await tempDir(t, "owl-post-merge-serial-");
  const log = join(dir, "log.txt");
  const code = `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, 'start\\n'); setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, 'end\\n'); }, 400);`;
  const argv = [process.execPath, "-e", code];
  const dirB = await tempDir(t, "owl-post-merge-serial-b-");
  const first = await seedFinishedWork(core, db, dir, argv);
  const second = await seedFinishedWork(core, db, dirB, argv);
  await Promise.all([core.tick(first.workId), core.tick(second.workId)]);

  await waitFor(() => resultEvent(db, first.workId) && resultEvent(db, second.workId), { message: "both results" });
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["start", "end", "start", "end"]);
});

test("createProject stores a valid post_merge_command and rejects invalid ones", async (t) => {
  const { db, core } = await openMergeCore(t, undefined);
  const base = { name: "P", base_branch: "main", allowed_roots: [tmpdir()], verification_plan: [] };
  const created = await core.createProject(commandEnvelope({ ...base, canonical_path: join(tmpdir(), `pm-a-${createUlid()}`), post_merge_command: ["node", "x.js"] }, "ok"));
  assert.deepEqual(created.data.post_merge_command, ["node", "x.js"]);
  assert.equal(db.get("SELECT post_merge_argv_json AS j FROM projects WHERE id = ?", created.data.id).j, JSON.stringify(["node", "x.js"]));
  for (const bad of ["node", ["node", ""], [""], [1]]) {
    await assert.rejects(core.createProject(commandEnvelope({ ...base, canonical_path: join(tmpdir(), `pm-b-${createUlid()}`), post_merge_command: bad }, "bad")), (e) => e.code === "validation_error" || /validation/i.test(String(e.message)));
  }
  await assert.rejects(core.updateProject(commandEnvelope({ project_id: created.data.id, post_merge_command: ["node", ""] }, "upd")));
});

test("Core defaults to pnpm build for its own unset project", async (t) => {
  const { db, core, root } = await openMergeCore(t, undefined);
  const owl = await seedFinishedWork(core, db, root, null);
  assert.deepEqual(core.resolvePostMergeCommand(owl.projectId).argv, ["pnpm", "build"]);
});

async function runMergeWith(t, changed, { install, build, projectInstall }) {
  const { dir, commits } = await repoWithChange(t, changed);
  const log = join(await tempDir(t, "owl-post-merge-log-"), "log.txt");
  const { db, core } = await openMergeCore(t, { installDefault: install(log) }, commits);
  const { workId, projectId } = await seedFinishedWork(core, db, dir, build(log));
  if (projectInstall) db.createWriteLane().transact((tx) => { tx.run("UPDATE projects SET post_merge_install_argv_json = ? WHERE id = ?", JSON.stringify(projectInstall(log)), projectId); return null; });
  await core.tick(workId);
  const event = await waitFor(() => resultEvent(db, workId), { message: "post-merge result" });
  const lines = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { event, payload: JSON.parse(event.payload_json), lines };
}

test("install runs before the build when a package.json or lockfile changed", async (t) => {
  for (const changed of [["packages/x/package.json"], ["pnpm-lock.yaml"], ["日本語/package.json"]]) {
    const run = await runMergeWith(t, changed, { install: (log) => logging(log, "install"), build: (log) => logging(log, "build") });
    assert.equal(run.event.type, "work.post_merge_command_succeeded");
    assert.deepEqual(await run.lines(), ["install", "build"]);
  }
});

test("install is skipped when no dependency file changed", async (t) => {
  const run = await runMergeWith(t, ["src/index.js"], { install: (log) => logging(log, "install"), build: (log) => logging(log, "build") });
  assert.deepEqual(await run.lines(), ["build"]);
});

test("a failing install records a system.alert with the stage, skips the build and logs the redacted tail", async (t) => {
  const lines = [];
  const original = console.info;
  console.info = (...args) => { lines.push(args.join(" ")); };
  t.after(() => { console.info = original; });
  const run = await runMergeWith(t, ["package.json"], {
    install: (log) => logging(log, "install", 4, "console.error('install exploded https://user:tok@example.com/x'); console.log('stdout detail');"),
    build: (log) => logging(log, "build"),
  });
  assert.equal(run.event.type, "system.alert");
  assert.equal(run.payload.kind, "work_post_merge_command_failed");
  assert.equal(run.payload.stage, "install");
  assert.equal(run.payload.exit_code, 4);
  assert.match(run.payload.message, /install/);
  assert.deepEqual(await run.lines(), ["install"]);
  const failed = lines.find((line) => /Post-merge command for Work .* failed/.test(line));
  assert.ok(failed, "failure log line");
  assert.match(failed, /stage=install/);
  assert.match(failed, /exit_code=4/);
  assert.match(failed, /install exploded/);
  assert.match(failed, /stdout detail/);
  assert.doesNotMatch(failed, /tok@/);
});

test("a failing build after a successful install reports the build stage", async (t) => {
  const run = await runMergeWith(t, ["package.json"], { install: (log) => logging(log, "install"), build: (log) => logging(log, "build", 2) });
  assert.equal(run.payload.stage, "build");
  assert.equal(run.payload.exit_code, 2);
  assert.deepEqual(await run.lines(), ["install", "build"]);
});

test("the Project's install command wins over the Core default", async (t) => {
  const run = await runMergeWith(t, ["package.json"], {
    install: (log) => logging(log, "core-default"), build: (log) => logging(log, "build"), projectInstall: (log) => logging(log, "project"),
  });
  assert.deepEqual(await run.lines(), ["project", "build"]);
});

test("createProject and updateProject store post_merge_install_command and reject invalid values", async (t) => {
  const { db, core } = await openMergeCore(t, undefined);
  const base = { name: "P", base_branch: "main", allowed_roots: [tmpdir()], verification_plan: [] };
  const created = await core.createProject(commandEnvelope({ ...base, canonical_path: join(tmpdir(), `pm-i-${createUlid()}`), post_merge_install_command: ["npm", "ci"] }, "ok"));
  assert.deepEqual(created.data.post_merge_install_command, ["npm", "ci"]);
  const updated = await core.updateProject(created.data.id, commandEnvelope({ post_merge_install_command: [] }, "off"));
  assert.deepEqual(updated.data.post_merge_install_command, []);
  assert.equal(db.get("SELECT post_merge_install_argv_json AS j FROM projects WHERE id = ?", created.data.id).j, "[]");
  await assert.rejects(core.updateProject(created.data.id, commandEnvelope({ post_merge_install_command: ["npm", ""] }, "bad")));
});

test("coalesced merges diff from the earliest old base", async (t) => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ok = { exit_code: 0, stdout: "", stderr: "", timed_out: false };
  const queue = new PostMergeCommandQueue({
    timeoutMs: 1000,
    run: async (cmd, args) => { calls.push([cmd, ...args]); if (cmd === "build-first") await gate; return cmd === "git" ? { ...ok, stdout: "package.json\0" } : ok; },
    resolve: (id) => ({ argv: [id === "p1" && calls.length === 0 ? "build-first" : "build"], cwd: "/tmp", default_command: false, install_argv: ["install"], dependency_files: ["package.json"] }),
    record: async () => {},
    log: () => {},
  });
  const job = (work, from, to) => ({ project_id: "p1", work_id: work, merge: { base_branch: "main", old_base_commit: from, new_base_commit: to, merge_commit: to } });
  queue.enqueue({ ...job("w1", "c0", "c1"), project_id: "p1" });
  queue.enqueue(job("w2", "c1", "c2"));
  queue.enqueue(job("w3", "c2", "c3"));
  release();
  await queue.idle();
  const diffs = calls.filter((call) => call[0] === "git");
  assert.deepEqual(diffs.at(-1), ["git", "diff", "--name-only", "-z", "c1", "c3"]);
});
