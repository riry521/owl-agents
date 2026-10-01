import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { GitWorktreeGateway } from "../packages/core/dist/git-gateway.js";
import { mergeConflictPaths } from "../packages/core/dist/workflow-engine.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function projectRepo(parent) {
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "README.md"), "base\n");
  await writeFile(join(project, "untouched.txt"), "never changed by a Task\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  return project;
}

async function addRejectingSigner(projectPath) {
  // A repository-local signing program that always fails makes every commit fail.
  const program = join(projectPath, ".git", "reject-signing.sh");
  await writeFile(program, "#!/bin/sh\nprintf '%s\\n' 'blocked by test signer' >&2\nexit 1\n");
  await chmod(program, 0o755);
  execFileSync("git", ["-C", projectPath, "config", "gpg.program", program]);
  execFileSync("git", ["-C", projectPath, "config", "commit.gpgsign", "true"]);
}

function fakeDatabase(parent, project) {
  return {
    get(sql) {
      if (sql.includes("SELECT project_id FROM works")) return { project_id: "project-1" };
      if (sql.includes("FROM projects")) return { canonical_path: project, base_branch: "main", allowed_roots_json: JSON.stringify([parent]) };
      return undefined;
    },
  };
}

test("a new Task starts from the Work branch and reports only its own changed files", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-task-base-")));
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));

  const first = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(first.ok, true, first.message);
  await writeFile(join(first.worktree_path, "backend.txt"), "from T1\n");
  assert.deepEqual(await gateway.changedPaths({ work_id: "W", task_id: "T1" }), ["backend.txt"]);
  const integrated = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: first.worktree_path });
  assert.equal(integrated.merged, true, integrated.message);
  assert.equal(integrated.worktree_removed, true, integrated.removal_message);

  // The next Task sees what T1 merged, and T1's file is not its change.
  const second = await gateway.prepareWorktree({ work_id: "W", task_id: "T2" });
  assert.equal(second.ok, true, second.message);
  assert.equal(await readFile(join(second.worktree_path, "backend.txt"), "utf8"), "from T1\n");
  assert.deepEqual(await gateway.changedPaths({ work_id: "W", task_id: "T2" }), []);
  await writeFile(join(second.worktree_path, "README.md"), "edited by T2\n");
  await mkdir(join(second.worktree_path, "web"));
  await writeFile(join(second.worktree_path, "web", "new file.txt"), "untracked\n");
  git(second.worktree_path, "add", "README.md");
  git(second.worktree_path, "commit", "-m", "T2 commits part of its work");
  assert.deepEqual(await gateway.changedPaths({ work_id: "W", task_id: "T2" }), ["README.md", "web/new file.txt"]);
});

test("a design Task branch is reset to its fork point and removed even when it carries commits", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-task-design-reset-")));
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));
  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(prepared.ok, true, prepared.message);
  const forkPoint = git(prepared.worktree_path, "rev-parse", "HEAD");
  await writeFile(join(prepared.worktree_path, "committed.txt"), "committed\n");
  git(prepared.worktree_path, "add", "committed.txt");
  git(prepared.worktree_path, "commit", "-m", "commit on the Task branch");
  await writeFile(join(prepared.worktree_path, "README.md"), "edited\n");
  await writeFile(join(prepared.worktree_path, "loose.txt"), "untracked\n");

  const discarded = await gateway.discardTaskWorktreeChanges({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });
  assert.equal(discarded.ok, true, discarded.message);
  assert.deepEqual([...discarded.changed_paths].sort(), ["README.md", "committed.txt", "loose.txt"]);
  assert.equal(git(prepared.worktree_path, "rev-parse", "HEAD"), forkPoint);
  assert.equal(git(prepared.worktree_path, "status", "--porcelain"), "");

  // A commit that is not part of the Work branch does not block the removal.
  git(prepared.worktree_path, "commit", "--allow-empty", "-m", "late commit");
  const removed = await gateway.removeTaskWorktreeAndBranch({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });
  assert.equal(removed.ok, true, removed.message);
  assert.equal(git(project, "branch", "--list", "owl/task/W/T1"), "");
  await assert.rejects(access(prepared.worktree_path));
});

test("a merge conflict names the conflicting files", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-task-conflict-")));
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));
  const a = await gateway.prepareWorktree({ work_id: "W", task_id: "A" });
  const b = await gateway.prepareWorktree({ work_id: "W", task_id: "B" });
  await writeFile(join(a.worktree_path, "README.md"), "A\n");
  await writeFile(join(b.worktree_path, "README.md"), "B\n");
  assert.equal((await gateway.integrateTask({ work_id: "W", task_id: "A", worktree_path: a.worktree_path })).merged, true);
  const merge = await gateway.integrateTask({ work_id: "W", task_id: "B", worktree_path: b.worktree_path });
  assert.equal(merge.merged, false);
  assert.deepEqual(mergeConflictPaths(merge.message), ["README.md"]);
  assert.equal(merge.aborted, true, merge.abort_message);

  assert.deepEqual(mergeConflictPaths([
    "Auto-merging src/a.ts",
    "CONFLICT (content): Merge conflict in src/a.ts",
    "CONFLICT (modify/delete): src/b.ts deleted in HEAD and modified in owl/task/W/B.  Version owl/task/W/B of src/b.ts left in tree.",
    "Automatic merge failed; fix conflicts and then commit the result.",
  ].join("\n")), ["src/a.ts", "src/b.ts"]);
});

test("Task integration reports a rejected commit as a commit failure with stderr", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-task-commit-failure-")));
  const project = await projectRepo(parent);
  const gateway = new GitWorktreeGateway(fakeDatabase(parent, project), join(parent, "owl"));
  const prepared = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  await mkdir(join(prepared.worktree_path, "docs", "designs"), { recursive: true });
  await writeFile(join(prepared.worktree_path, "docs", "designs", "x.md"), "rejected content\n");
  await addRejectingSigner(project);

  const result = await gateway.integrateTask({ work_id: "W", task_id: "T1", worktree_path: prepared.worktree_path });

  assert.equal(result.merged, false);
  assert.equal(result.failure_kind, "commit_failure");
  assert.match(result.message, /could not commit the Task's changes:[\s\S]*blocked by test signer/);
  assert.match(result.stderr_tail, /blocked by test signer/);
  assert.equal(result.aborted, true);
  await access(prepared.worktree_path);
});

async function waitFor(read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function workerReport(invocationId, changes) {
  return {
    kind: "report", schema_version: "1.0.0", invocation_id: invocationId, result: "success",
    work_done: "Done.", changes, verification: { passed: true, method: "Checked the result." }, remaining_issues: [], next_action: "none",
    needs_replanning: false, question_for_manager: null,
  };
}

test("Tasks with and without review are merged, and dependents build on them", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-task-integration-")));
  const project = await projectRepo(root);
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    transaction.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, '[]', '[]', ?, ?)`,
      "project:integration", "owner:default", "Integration", project, JSON.stringify([root]), now, now,
    );
  });

  const seenByCode = {};
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Write the design note", type: "doc", acceptance: "Note exists.", depends_on: [], replaces: [] },
          { id: "T2", title: "Implement", type: "code", acceptance: "Code exists.", depends_on: ["T1"], replaces: [] },
        ] } }
      : { outcome: "success", report_valid: true, report: { event: "work.completed", summary: "Done." } },
    runWorker: async (request) => {
      const worktree = request.context.worktree;
      if (request.context.task.type === "doc") {
        await writeFile(join(worktree, "design.md"), "# Design\n");
        return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: "design.md", action: "added" }]) };
      }
      seenByCode.design = await readFile(join(worktree, "design.md"), "utf8").catch(() => null);
      await writeFile(join(worktree, "code.ts"), "export {};\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: "code.ts", action: "added" }]) };
    },
    runReviewer: async (request) => ({
      outcome: "success",
      report_valid: true,
      report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();
  const created = await core.createWork({
    request_id: createUlid(),
    idempotency_key: "test:integration-create",
    expected_version: 0,
    payload: { title: "Integration", summary: "x", size: "normal", project_id: "project:integration" },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, { request_id: createUlid(), idempotency_key: "test:integration-start", expected_version: created.version, payload: { mode: "normal" } });

  const done = await waitFor(() => {
    const rows = db.all("SELECT manager_task_id, status, worktree_state FROM tasks WHERE work_id = ? ORDER BY manager_task_id", workId);
    return rows.length === 2 && rows.every((row) => row.status === "completed") ? rows : null;
  });
  assert.deepEqual(done?.map((row) => ({ ...row })), [
    { manager_task_id: "T1", status: "completed", worktree_state: "merged" },
    { manager_task_id: "T2", status: "completed", worktree_state: "merged" },
  ]);
  // T2 started from the Work branch, so it saw the note T1 merged.
  assert.equal(seenByCode.design, "# Design\n");
  const workBranch = `owl/work/${workId}/work`;
  assert.equal(git(project, "show", `${workBranch}:design.md`), "# Design");
  assert.equal(git(project, "show", `${workBranch}:code.ts`), "export {};");
  const docsTaskId = db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId).id;
  await assert.rejects(access(join(root, ".owl-workspaces", workId, docsTaskId)), "the merged Task worktree is removed");

  // Artifacts are the files each Task changed, not the whole checkout.
  const artifacts = db.all(
    "SELECT tasks.manager_task_id AS task, artifacts.path FROM artifacts JOIN tasks ON tasks.id = artifacts.task_id WHERE artifacts.work_id = ? ORDER BY 1, 2",
    workId,
  );
  assert.deepEqual(artifacts.map((row) => [row.task, row.path]), [["T1", "design.md"], ["T2", "code.ts"]]);
});

test("design Tasks stay outside Git and hand their document to dependent implementation Tasks", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-task-integration-")));
  const project = await projectRepo(root);
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const now = new Date().toISOString();
  const verificationLog = join(root, "verification.log");
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    transaction.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, ?, '[]', ?, ?)`,
      "project:integration", "owner:default", "Integration", project, JSON.stringify([root]), JSON.stringify([{
        command_id: "record-verification",
        argv: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'run\\n')", verificationLog],
        cwd: ".", env_allowlist: [], timeout_seconds: 10, stdout_limit: 1024, stderr_limit: 1024, expected_exit_codes: [0], executor: "core",
      }]), now, now,
    );
  });

  const seenByCode = {};
  const reviewed = [];
  const managerCalls = [];
  let designerAttempts = 0;
  const agentRunner = {
    runManagerPlan: async (request) => {
      managerCalls.push(request.context);
      return request.context?.mode === "plan"
        ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Design the implementation", type: "design", acceptance: "External design document exists.", depends_on: [], replaces: [] },
          { id: "T2", title: "Implement", type: "code", acceptance: "Code exists.", depends_on: ["T1"], replaces: [] },
        ] } }
        : request.context?.mode === "finalize"
          ? { outcome: "success", report_valid: true, report: { verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
          : { outcome: "success", report_valid: true, report: { event: "work.completed", summary: "Done." } };
    },
    runDesigner: async (request) => {
      const worktree = request.context.worktree;
      const documentPath = request.context.design_document_path;
      await mkdir(dirname(documentPath), { recursive: true });
      designerAttempts += 1;
      if (designerAttempts === 1) {
        // A commit on the Task branch must not survive into integration.
        await writeFile(documentPath, "# Draft\n");
        await writeFile(join(worktree, "committed.txt"), "must be discarded\n");
        git(worktree, "add", "committed.txt");
        git(worktree, "commit", "-m", "designer commit");
        const report = workerReport(request.invocation_id, [{ file: documentPath, action: "created" }]);
        return { outcome: "success", report_valid: true, report: { ...report, verification: { passed: false, method: "The draft misses the acceptance criteria." } } };
      }
      if (designerAttempts === 2) {
        // The document left by the previous attempt does not count.
        return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: documentPath, action: "created" }]) };
      }
      await writeFile(documentPath, "# Design\n\nUse a focused implementation.\n");
      await writeFile(join(worktree, "stray.txt"), "must be discarded\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: documentPath, action: "created" }]) };
    },
    runWorker: async (request) => {
      const worktree = request.context.worktree;
      seenByCode.design = request.context.dependency_reports?.[0]?.design_document_path ?? null;
      seenByCode.contents = seenByCode.design ? await readFile(seenByCode.design, "utf8") : null;
      await writeFile(join(worktree, "code.ts"), "export {};\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: "code.ts", action: "added" }]) };
    },
    runReviewer: async (request) => {
      reviewed.push(request.context.task.type);
      return {
        outcome: "success",
        report_valid: true,
        report: { kind: "review", invocation_id: request.invocation_id },
        review: { verdict: "pass", findings: [], tests: {} },
      };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();
  const created = await core.createWork({
    request_id: createUlid(),
    idempotency_key: "test:integration-create",
    expected_version: 0,
    payload: { title: "Integration", summary: "x", size: "normal", project_id: "project:integration" },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, { request_id: createUlid(), idempotency_key: "test:integration-start", expected_version: created.version, payload: { mode: "normal" } });

  const done = await waitFor(() => {
    const rows = db.all("SELECT manager_task_id, status, worktree_state FROM tasks WHERE work_id = ? ORDER BY manager_task_id", workId);
    return rows.length === 2 && rows.every((row) => row.status === "completed") && designerAttempts >= 3 ? rows : null;
  });
  assert.deepEqual(done?.map((row) => ({ ...row })), [
    { manager_task_id: "T1", status: "completed", worktree_state: "merged" },
    { manager_task_id: "T2", status: "completed", worktree_state: "merged" },
  ]);
  const designTaskId = db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId).id;
  const externalDesignPath = join(root, "data", "designs", workId, `${designTaskId}.md`);
  assert.equal(seenByCode.design, externalDesignPath);
  assert.equal(seenByCode.contents, "# Design\n\nUse a focused implementation.\n");
  const workBranch = `owl/work/${workId}/work`;
  assert.equal(git(project, "show", `${workBranch}:code.ts`), "export {};");
  assert.equal(Number(git(project, "rev-list", "--count", workBranch)), 3, "the design Task adds no commit or merge commit");
  assert.equal(git(project, "branch", "--list", `owl/task/${workId}/${designTaskId}`), "", "the completed design Task branch is removed");
  assert.equal(await readFile(externalDesignPath, "utf8"), "# Design\n\nUse a focused implementation.\n");
  assert.deepEqual(reviewed, ["code"]);
  assert.equal(designerAttempts, 3, "a failed self-check and a stale document retry through the normal Task failure path");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'task.failure.classified' AND json_extract(payload_json, '$.error_key') = 'design_document_missing'")?.count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'verification.completed' AND task_id = ? AND json_extract(payload_json, '$.outcome') = 'fail'", designTaskId)?.count, 1);
  const alerts = db.all("SELECT payload_json FROM events WHERE type = 'system.alert' AND task_id = ? ORDER BY sequence", designTaskId)
    .map((row) => JSON.parse(row.payload_json))
    .filter((payload) => payload.kind === "design_changes_discarded");
  assert.deepEqual(alerts.map((payload) => payload.discarded_paths), [["committed.txt"], ["stray.txt"]]);
  assert.deepEqual(git(project, "ls-tree", "--name-only", workBranch).split("\n").sort(), ["README.md", "code.ts", "untouched.txt"]);
  assert.equal((await readFile(verificationLog, "utf8")).trim(), "run", "only the code Task runs Project verification");
  assert.equal(db.get("SELECT role FROM agent_runs WHERE task_id = ? ORDER BY created_at LIMIT 1", designTaskId).role, "designer");
  const replanRequest = core.buildReplanRequest(workId, [db.get("SELECT id FROM tasks WHERE work_id = ? AND manager_task_id = 'T2'", workId).id], "retry", undefined, 1, null);
  assert.deepEqual(replanRequest.context.design_documents, [{ task_id: designTaskId, title: "Design the implementation", path: externalDesignPath }]);
  const finalizeContext = await waitFor(() => managerCalls.find((context) => context?.mode === "finalize") ?? null);
  assert.deepEqual(finalizeContext?.design_documents, [{ task_id: designTaskId, title: "Design the implementation", path: externalDesignPath }]);
  await assert.rejects(access(join(root, ".owl-workspaces", workId, designTaskId)), "the completed design worktree is removed");

  // Artifacts are the files each Task changed, not the whole checkout.
  const artifacts = db.all(
    "SELECT tasks.manager_task_id AS task, artifacts.path FROM artifacts JOIN tasks ON tasks.id = artifacts.task_id WHERE artifacts.work_id = ? ORDER BY 1, 2",
    workId,
  );
  assert.deepEqual(artifacts.map((row) => [row.task, row.path]), [["T2", "code.ts"]]);
});

test("Hybrid Mode still runs a design Task once through the Designer", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-task-design-hybrid-")));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  let workerCalls = 0;
  let designerHybridMode;
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Design the approach", type: "design", acceptance: "Document exists.", depends_on: [], replaces: [] },
        ] } }
      : { outcome: "success", report_valid: true, report: { verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } },
    runDesigner: async (request) => {
      designerHybridMode = request.context.hybrid_mode;
      await mkdir(dirname(request.context.design_document_path), { recursive: true });
      await writeFile(request.context.design_document_path, "# Design\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: request.context.design_document_path, action: "created" }]) };
    },
    runWorker: async () => { workerCalls += 1; throw new Error("design Task must not run as Worker"); },
    runReviewer: async () => { throw new Error("design review is disabled by default"); },
    runAdvisor: async () => ({ reply: "" }),
  };
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => { await core.stop({ force: true }); db.close(); });
  await core.setHybridMode(true);
  await core.start();
  const created = await core.createWork({
    request_id: createUlid(), idempotency_key: "test:design-hybrid-create", expected_version: 0,
    payload: { title: "Design hybrid Work", summary: "x", size: "normal", project_id: null },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, { request_id: createUlid(), idempotency_key: "test:design-hybrid-start", expected_version: created.version, payload: { mode: "normal" } });
  const completed = await waitFor(() => db.get("SELECT status FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId)?.status === "completed");
  assert.equal(completed, true, JSON.stringify({
    work: db.get("SELECT state FROM works WHERE id = ?", workId),
    tasks: db.all("SELECT manager_task_id, status, last_error_key FROM tasks WHERE work_id = ?", workId),
    runs: db.all("SELECT role, status FROM agent_runs WHERE work_id = ?", workId),
    workerCalls,
    designerHybridMode,
  }));
  assert.equal(designerHybridMode, false);
  assert.equal(workerCalls, 0);
  assert.equal(db.get("SELECT role FROM agent_runs WHERE task_id = (SELECT id FROM tasks WHERE work_id = ?)", workId)?.role, "designer");
});

async function startProjectlessWork(t, root, agentRunner, key) {
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  t.after(async () => { await core.stop({ force: true }); db.close(); });
  await core.start();
  const created = await core.createWork({
    request_id: createUlid(), idempotency_key: `test:${key}-create`, expected_version: 0,
    payload: { title: "Design Work", summary: "x", size: "normal", project_id: null },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, { request_id: createUlid(), idempotency_key: `test:${key}-start`, expected_version: created.version, payload: { mode: "normal" } });
  return { db, workId };
}

test("a reviewed design Task goes back to the Designer when its document is blank, and the Reviewer reads it", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-task-design-review-")));
  let designerAttempts = 0;
  const reviewerDocuments = [];
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Design the approach", type: "design", acceptance: "Document exists.", depends_on: [], replaces: [], review: true },
        ] } }
      : { outcome: "success", report_valid: true, report: { verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } },
    runDesigner: async (request) => {
      designerAttempts += 1;
      const documentPath = request.context.design_document_path;
      await mkdir(dirname(documentPath), { recursive: true });
      await writeFile(documentPath, designerAttempts === 1 ? "\n\n" : "# Design\n\nReviewed approach.\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: documentPath, action: "created" }]) };
    },
    runWorker: async () => { throw new Error("design Task must not run as Worker"); },
    runReviewer: async (request) => {
      reviewerDocuments.push(request.context.design_document);
      return {
        outcome: "success",
        report_valid: true,
        report: { kind: "review", invocation_id: request.invocation_id },
        review: { verdict: "pass", findings: [], tests: {} },
      };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, workId } = await startProjectlessWork(t, root, agentRunner, "design-review");
  const completed = await waitFor(() => db.get("SELECT status FROM tasks WHERE work_id = ? AND manager_task_id = 'T1'", workId)?.status === "completed");
  assert.equal(completed, true, JSON.stringify(db.all("SELECT manager_task_id, status, last_error_key FROM tasks WHERE work_id = ?", workId)));
  const taskId = db.get("SELECT id FROM tasks WHERE work_id = ?", workId).id;
  const documentPath = join(root, "data", "designs", workId, `${taskId}.md`);
  assert.equal(designerAttempts, 2);
  assert.deepEqual(reviewerDocuments, [{ path: documentPath, markdown: "# Design\n\nReviewed approach.\n" }]);
  const failedChecks = db.all("SELECT payload_json FROM events WHERE type = 'verification.completed' AND task_id = ? AND json_extract(payload_json, '$.outcome') = 'fail'", taskId)
    .map((row) => JSON.parse(row.payload_json).verification.error_key);
  assert.deepEqual(failedChecks, ["design_document_missing"]);
  assert.deepEqual(db.all("SELECT role, status FROM agent_runs WHERE task_id = ? ORDER BY created_at", taskId).map((row) => [row.role, row.status]), [
    ["designer", "completed"], ["designer", "completed"], ["reviewer", "completed"],
  ]);
  assert.equal(db.get("SELECT reviewer_failure_count FROM tasks WHERE id = ?", taskId).reviewer_failure_count, 0);
  // A Project-less Work has no repository worktree to clean up.
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE type = 'system.alert' AND task_id = ?", taskId).count, 0);
});

test("a design report that asks for replanning reaches the Manager without a document check", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-task-design-replan-")));
  const agentRunner = {
    runManagerPlan: async (request) => request.context?.mode === "plan"
      ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
          { id: "T1", title: "Design the approach", type: "design", acceptance: "Document exists.", depends_on: [], replaces: [] },
        ] } }
      : { outcome: "failed", report_valid: false, error: "stop here" },
    runDesigner: async (request) => ({
      outcome: "success",
      report_valid: true,
      report: { ...workerReport(request.invocation_id, []), needs_replanning: true, question_for_manager: "Which storage layer should the design target?" },
    }),
    runWorker: async () => { throw new Error("design Task must not run as Worker"); },
    runReviewer: async () => { throw new Error("design review is disabled by default"); },
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, workId } = await startProjectlessWork(t, root, agentRunner, "design-replan");
  const requested = await waitFor(() => db.get("SELECT payload_json FROM events WHERE type = 'task.replan_requested' AND work_id = ?", workId) ?? null);
  assert.equal(JSON.parse(requested.payload_json).question, "Which storage layer should the design target?");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM events WHERE work_id = ? AND json_extract(payload_json, '$.error_key') = 'design_document_missing'", workId).count, 0);
});

test("a rejected commit reaches the Manager as a commit failure, not a merge conflict", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-task-commit-replan-")));
  const project = await projectRepo(root);
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    transaction.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, '[]', '[]', ?, ?)`,
      "project:commit-failure", "owner:default", "Commit failure", project, JSON.stringify([root]), now, now,
    );
  });
  await addRejectingSigner(project);

  let replanReason = null;
  const core = new Core({
    db,
    git: new GitWorktreeGateway(db, root),
    agentRunner: {
      runManagerPlan: async (request) => {
        if (request.context?.mode === "plan") {
          return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [
            { id: "T1", title: "Write the design", type: "doc", acceptance: "The note exists.", depends_on: [], replaces: [] },
          ] } };
        }
        if (request.context?.mode === "replan") {
          replanReason = request.context.reason;
          return { outcome: "failed", message: "Stop after capturing the replan reason." };
        }
        return { outcome: "success", report_valid: true, report: {
          tasks: request.tasks ?? [], event: null,
          verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] },
        } };
      },
      runWorker: async (request) => {
        const path = join(request.context.worktree, "docs", "designs", "x.md");
        await mkdir(join(request.context.worktree, "docs", "designs"), { recursive: true });
        await writeFile(path, "The signer rejects the commit of this file.\n");
        return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, [{ file: "docs/designs/x.md", action: "added" }]) };
      },
      runReviewer: async () => ({ outcome: "failed", message: "The document Task does not need review." }),
      runAdvisor: async () => ({ reply: "" }),
    },
    version: "test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });

  await core.start();
  const created = await core.createWork({
    request_id: createUlid(),
    idempotency_key: "test:commit-failure-create",
    expected_version: 0,
    payload: { title: "Commit failure", summary: "x", size: "normal", project_id: "project:commit-failure" },
  });
  const workId = created.data.work_id;
  await core.startWork(workId, {
    request_id: createUlid(),
    idempotency_key: "test:commit-failure-start",
    expected_version: created.version,
    payload: { mode: "normal" },
  });

  await waitFor(() => replanReason);

  assert.match(replanReason, /could not commit the Task's changes:[\s\S]*blocked by test signer/);
  assert.doesNotMatch(replanReason, /Git merge conflict/);
  const failure = JSON.parse(db.get(
    "SELECT payload_json FROM events WHERE work_id = ? AND type = 'verification.completed' ORDER BY sequence DESC LIMIT 1",
    workId,
  ).payload_json);
  assert.equal(failure.failure_kind, "commit_failure");
  assert.match(failure.failure_message, /could not commit the Task's changes:[\s\S]*blocked by test signer/);
  assert.match(failure.stderr_tail, /blocked by test signer/);
  const task = db.get("SELECT status, worktree_state, worktree_path FROM tasks WHERE work_id = ?", workId);
  assert.ok(["failed", "judgement_waiting"].includes(task.status));
  assert.equal(task.worktree_state, "active");
  await access(task.worktree_path);
});
