import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { necessityFor, criteriaFor } from "../helpers/necessity.mjs";
import { git } from "../helpers/git.mjs";
import { waitFor as pollFor } from "../helpers/wait.mjs";

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
}

function workerReport(invocationId) {
  return {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Done.",
    changes: [],
    verification: { passed: true, method: "Checked the result." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
}

function managerComplete(request) {
  return {
    outcome: "success",
    report_valid: true,
    report: {
      tasks: request.tasks ?? [],
      event: null,
      verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] },
    },
  };
}

const waitForValue = (read) => pollFor(read, { timeoutMs: 15_000, intervalMs: 25 });

function markerPlan() {
  const mark = join(mkdtempSync(join(tmpdir(), "owl-merge-mark-")), "runs");
  const plan = [{
    command_id: "mark-check",
    argv: ["node", "-e", `require("node:fs").appendFileSync(process.argv[1], "x")`, mark],
    cwd: ".",
    env_allowlist: [],
    timeout_seconds: 15,
    stdout_limit: 1_024,
    stderr_limit: 1_024,
    expected_exit_codes: [0],
    executor: "core",
  }];
  return { plan, runs: () => (existsSync(mark) ? readFileSync(mark, "utf8").length : 0) };
}

async function openFixture(t, { verificationPlan = [], autoPush = false, beforeFinalize = async () => {}, onWorker = async () => {}, onReplan = null } = {}) {
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? (await beforeFinalize(request), managerComplete(request))
      : request.mode === "replan" && onReplan !== null
        ? onReplan(request)
        : { outcome: "failed", message: `Unexpected Manager mode: ${request.mode}` },
    runWorker: async (request) => {
      await onWorker(request);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async (request) => ({
      outcome: "success",
      report_valid: true,
      report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { root, db, core } = await createTestCore(
    t,
    { agentRunner, dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 } },
    { prefix: "owl-work-auto-merge-", start: true },
  );

  const project = join(root, "project");
  await mkdir(project);
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Test");
  git(project, "config", "user.email", "test@example.invalid");
  await writeFile(join(project, "README.md"), "base version\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "initial");
  const remote = join(root, "remote.git");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(project, "remote", "add", "origin", remote);
  git(project, "push", "--porcelain", "-u", "origin", "main");

  const registered = await core.createProject(commandEnvelope({
    name: "Auto merge integration project",
    canonical_path: project,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: verificationPlan,
  }, "project"));
  if (autoPush) {
    await db.createWriteLane().transact((tx) => {
      tx.run("UPDATE projects SET auto_push = 1 WHERE id = ?", registered.data.id);
      return null;
    });
  }
  const mergeCalls = [];
  const gateway = core.gitGateway();
  const mergeWorkIntoBase = gateway.mergeWorkIntoBase.bind(gateway);
  gateway.mergeWorkIntoBase = async (request) => {
    mergeCalls.push(request.work_id);
    return mergeWorkIntoBase(request);
  };
  return { root, project, remote, db, core, projectId: registered.data.id, mergeCalls };
}

async function startSmallWork(core, projectId, suffix) {
  const created = await core.createWork(commandEnvelope({
    title: `Auto merge ${suffix}`,
    summary: "Write the requested output file.",
    size: "small",
    project_id: projectId,
  }, `${suffix}-create`));
  await core.startWork(created.data.work_id, commandEnvelope({ mode: "small" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

async function waitForTerminalDecision(db, workId) {
  const state = await waitForValue(() => {
    const value = db.get("SELECT state FROM works WHERE id = ?", workId)?.state;
    return value === "completed" || value === "judgement_waiting" ? value : null;
  });
  assert.ok(state, `Work reached completion or judgement_waiting (state=${db.get("SELECT state FROM works WHERE id = ?", workId)?.state})`);
  return state;
}

test("Core auto-merges a completed Project Work into main and cleans its integration worktree and branch", async (t) => {
  const { project, db, core, projectId, mergeCalls } = await openFixture(t, {
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
  });
  const oldMain = git(project, "rev-parse", "refs/heads/main");
  const workId = await startSmallWork(core, projectId, "success");
  const integrationPath = join(dirname(project), ".owl-workspaces", workId, "__work__");

  const workState = await waitForTerminalDecision(db, workId);
  assert.equal(workState, "completed", JSON.stringify({
    alert: db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' ORDER BY sequence DESC LIMIT 1", workId),
    decision: db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId),
    task: db.get("SELECT status, worktree_path, last_error_key FROM tasks WHERE work_id = ?", workId),
  }));
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  assert.deepEqual(mergeCalls, [workId]);
  assert.notEqual(git(project, "rev-parse", "refs/heads/main"), oldMain);
  assert.equal(git(project, "show", "main:feature.mjs"), "export {};");
  const mergeCommit = git(project, "rev-parse", "refs/heads/main");
  assert.equal(git(project, "rev-list", "--parents", "-n", "1", "main"), `${mergeCommit} ${oldMain}`);
  assert.equal(git(project, "log", "-1", "--format=%s", "main"), db.get("SELECT title FROM works WHERE id = ?", workId).title);
  assert.doesNotMatch(git(project, "log", "main", "--format=%an %ae %B"), /owl|Owl Agent/u);

  const cleanupComplete = await waitForValue(() =>
    !existsSync(integrationPath) && git(project, "branch", "--list", `owl/work/${workId}/work`) === "",
  );
  assert.equal(cleanupComplete, true, "Core removes the integration worktree and Work branch after completion");
  assert.equal(git(project, "worktree", "list", "--porcelain").includes(integrationPath), false);
  assert.equal(git(project, "branch", "--list", `owl/work/${workId}/work`), "");
  assert.equal(await waitForValue(() => git(project, "branch", "--list", "owl/*") === ""), true);
  assert.ok(await waitForValue(() => db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", workId)));
  assert.equal(existsSync(join(dirname(project), ".owl-workspaces", workId)), false);
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE work_id = ?", workId).worktree_state, "merged");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'task.worktree.discarded'", workId).n, 0);
});

test("Core completion discards a merged Work's leftover worktree past a rejected commit and deletes its branches", async (t) => {
  let workId;
  let leftoverPath;
  const { project, db, core, projectId } = await openFixture(t, {
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
    beforeFinalize: async () => {
      const leftover = await core.gitGateway().prepareWorktree({ work_id: workId, task_id: "cancelled-leftover" });
      assert.equal(leftover.ok, true, leftover.message);
      leftoverPath = leftover.worktree_path;
      await mkdir(join(leftoverPath, "docs", "designs"), { recursive: true });
      await writeFile(join(leftoverPath, "docs", "designs", "x.md"), "staged content the signer rejects\n");
      git(leftoverPath, "add", "docs/designs/x.md");
      const signer = join(project, ".git", "reject-signing.sh");
      await writeFile(signer, "#!/bin/sh\nprintf '%s\\n' 'blocked by test signer' >&2\nexit 1\n");
      await chmod(signer, 0o755);
      git(project, "config", "extensions.worktreeConfig", "true");
      git(leftoverPath, "config", "--worktree", "gpg.program", signer);
      git(leftoverPath, "config", "--worktree", "commit.gpgsign", "true");
      const now = new Date().toISOString();
      await db.createWriteLane().transact((tx) => {
        tx.run(
          `INSERT INTO tasks
             (id, work_id, title, type, status, priority, context, acceptance,
              worker_generation, worktree_path, worktree_state, created_at, updated_at)
           VALUES (?, ?, 'Leftover', 'code', 'cancelled', 'normal', '', 'Done.', 0, ?, 'conflict_retained', ?, ?)`,
          "cancelled-leftover", workId, leftoverPath, now, now,
        );
        return null;
      });
    },
  });
  workId = await startSmallWork(core, projectId, "signer-leftover");

  assert.equal(await waitForTerminalDecision(db, workId), "completed");
  assert.ok(await waitForValue(() => db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", workId)));
  assert.equal(git(project, "branch", "--list", "owl/*"), "");
  assert.equal(existsSync(leftoverPath), false);
  assert.equal(existsSync(join(dirname(project), ".owl-workspaces", workId)), false);
  assert.equal(db.get("SELECT worktree_state FROM tasks WHERE id = ?", "cancelled-leftover").worktree_state, "discarded");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'system.alert'", workId).n, 0);
});

test("Core records the automatic conflict resolution, leaves the Work waiting once it cannot continue, preserves main, and aborts the integration merge", async (t) => {
  let mainBeforeMerge;
  const { project, db, core, projectId, mergeCalls } = await openFixture(t, {
    onWorker: async (request) => {
      await writeFile(join(request.context.worktree, "README.md"), "Work version\n");
      await writeFile(join(request.context.worktree, "check.mjs"), "export {};\n");
    },
    beforeFinalize: async () => {
      await writeFile(join(project, "README.md"), "conflicting main version\n");
      git(project, "add", "README.md");
      git(project, "commit", "-m", "conflicting main edit");
      mainBeforeMerge = git(project, "rev-parse", "refs/heads/main");
    },
  });
  const workId = await startSmallWork(core, projectId, "conflict");

  assert.equal(await waitForTerminalDecision(db, workId), "judgement_waiting");
  assert.deepEqual(mergeCalls, [workId]);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), mainBeforeMerge);
  assert.equal(git(project, "show", "main:README.md"), "conflicting main version");
  assert.notEqual(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");

  const decision = db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId);
  assert.ok(decision);
  assert.match(decision.reason, /README\.md/u);
  const alert = db.get(
    "SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_merge_conflict_auto_resolve' ORDER BY sequence DESC LIMIT 1",
    workId,
  );
  const payload = JSON.parse(alert.payload_json);
  assert.equal(payload.merge_kind, "conflict");
  assert.deepEqual(payload.conflicting_files, ["README.md"]);

  const integrationPath = join(dirname(project), ".owl-workspaces", workId, "__work__");
  assert.ok(git(project, "worktree", "list", "--porcelain").includes(integrationPath));
  for (const worktree of [project, integrationPath]) {
    const gitDir = git(worktree, "rev-parse", "--git-dir");
    const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(worktree, gitDir);
    assert.equal(existsSync(join(absoluteGitDir, "MERGE_HEAD")), false, `no MERGE_HEAD in ${absoluteGitDir}`);
  }
});

test("Core hands a real merge conflict to a conflict-resolution Task, opens no Decision, and merges after the retry", async (t) => {
  let conflictCommitted = false;
  let replanned = false;
  const { project, db, core, projectId, mergeCalls } = await openFixture(t, {
    onWorker: async (request) => {
      const cwd = request.context.worktree;
      if (!replanned) {
        await writeFile(join(cwd, "README.md"), "Work version\n");
        await writeFile(join(cwd, "check.mjs"), "export {};\n");
        return;
      }
      // The resolution Task brings the latest main into the Work and settles the conflict.
      try { git(cwd, "merge", "--no-commit", "main"); } catch { /* the conflict is expected */ }
      await writeFile(join(cwd, "README.md"), "resolved version\n");
      git(cwd, "add", "README.md");
      git(cwd, "commit", "-m", "resolve conflict with main");
    },
    beforeFinalize: async () => {
      if (conflictCommitted) return;
      conflictCommitted = true;
      await writeFile(join(project, "README.md"), "conflicting main version\n");
      git(project, "add", "README.md");
      git(project, "commit", "-m", "conflicting main edit");
    },
    onReplan: (request) => {
      replanned = true;
      const resolveTask = {
        id: "resolve-conflict", title: "Resolve the base merge conflict", type: "doc", necessity: necessityFor(),
        acceptance_criteria: criteriaFor("README.md is resolved against main."), depends_on: [], context: "", notes: "", review: false,
        required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [],
      };
      return { outcome: "success", report_valid: true, report: { tasks: [...(request.tasks ?? []), resolveTask], event: "task.replanned" } };
    },
  });
  const workId = await startSmallWork(core, projectId, "conflict-resolve");

  const finalState = await waitForTerminalDecision(db, workId);
  assert.equal(finalState, "completed");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0);
  assert.equal(mergeCalls.length, 2, "the integration was retried after the resolution Task");
  assert.equal(git(project, "show", "main:README.md"), "resolved version");
});

test("Core keeps main unchanged and opens a Decision when Project verification fails", async (t) => {
  const verificationPlan = [{
    command_id: "fail-check",
    argv: ["node", "-e", "const failed = process.cwd().endsWith('__work__'); if (failed) console.error('verification failed'); process.exit(failed ? 7 : 0)"],
    cwd: ".",
    env_allowlist: [],
    timeout_seconds: 15,
    stdout_limit: 1_024,
    stderr_limit: 1_024,
    expected_exit_codes: [0],
    executor: "core",
  }];
  const { project, db, core, projectId, mergeCalls } = await openFixture(t, {
    verificationPlan,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
  });
  const oldMain = git(project, "rev-parse", "refs/heads/main");
  const workId = await startSmallWork(core, projectId, "verification-failed");

  assert.equal(await waitForTerminalDecision(db, workId), "judgement_waiting");
  // The Work-branch verification fails before the merge, so the merge is never attempted.
  assert.deepEqual(mergeCalls, []);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldMain);
  assert.notEqual(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  const verification = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.integration_verification_completed'", workId).payload_json);
  assert.equal(verification.status, "failed");
  assert.equal(verification.failed_command_id, "fail-check");
  assert.match(verification.commands[0].stderr_tail, /verification failed/u);
  assert.ok(db.get("SELECT reason FROM decisions WHERE work_id = ? AND status = 'open'", workId));
});

test("Core skips Project merge for a Project-less Work while saving outputs and removing its workspace", async (t) => {
  const { root, project, db, core, mergeCalls } = await openFixture(t, {
    onWorker: async (request) => {
      await mkdir(join(request.context.worktree, "out"), { recursive: true });
      await writeFile(join(request.context.worktree, "out", "result.mjs"), "export {};\n");
    },
  });
  const oldMain = git(project, "rev-parse", "refs/heads/main");
  const worktreesBefore = git(project, "worktree", "list", "--porcelain");
  const branchesBefore = git(project, "branch", "--list");
  const workId = await startSmallWork(core, null, "projectless");

  assert.equal(await waitForTerminalDecision(db, workId), "completed");
  assert.deepEqual(mergeCalls, []);
  assert.equal(git(project, "rev-parse", "refs/heads/main"), oldMain);
  assert.equal(git(project, "worktree", "list", "--porcelain"), worktreesBefore);
  assert.equal(git(project, "branch", "--list"), branchesBefore);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type LIKE '%merge%'", workId).n, 0);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND payload_json LIKE '%work_merge_%'", workId).n, 0);
  // Outputs are saved by the worktree reconciler after the Work completes.
  const outputPath = join(root, "data", "outputs", workId, "out", "result.mjs");
  assert.ok(await waitForValue(() => existsSync(outputPath) && !existsSync(join(root, ".owl-workspaces", workId))), "outputs saved and workspace removed");
  assert.equal(await readFile(outputPath, "utf8"), "export {};\n");
});

test("Core auto-pushes the merged base only when the Project option is enabled", async (t) => {
  const enabled = await openFixture(t, {
    autoPush: true,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
  });
  const workId = await startSmallWork(enabled.core, enabled.projectId, "auto-push-enabled");
  assert.equal(await waitForTerminalDecision(enabled.db, workId), "completed");
  const pushed = await waitForValue(() => enabled.db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.pushed'", workId));
  assert.ok(pushed);
  const payload = JSON.parse(pushed.payload_json);
  assert.equal(git(enabled.remote, "rev-parse", "refs/heads/main"), git(enabled.project, "rev-parse", "refs/heads/main"));
  assert.equal(payload.new_remote_commit, git(enabled.remote, "rev-parse", "refs/heads/main"));

  const disabled = await openFixture(t, {
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
  });
  const originalRemote = git(disabled.remote, "rev-parse", "refs/heads/main");
  const disabledWork = await startSmallWork(disabled.core, disabled.projectId, "auto-push-disabled");
  assert.equal(await waitForTerminalDecision(disabled.db, disabledWork), "completed");
  assert.ok(await waitForValue(() => disabled.db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", disabledWork)));
  assert.equal(git(disabled.remote, "rev-parse", "refs/heads/main"), originalRemote);
  assert.equal(disabled.db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'work.pushed'", disabledWork).n, 0);
});

test("Core keeps completion and alerts when remote advances or the base has no upstream", async (t) => {
  const advanced = await openFixture(t, {
    autoPush: true,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
  });
  const other = join(advanced.root, "other");
  git(advanced.root, "clone", advanced.remote, other);
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.invalid");
  await writeFile(join(other, "remote.txt"), "remote advance\n");
  git(other, "add", "remote.txt");
  git(other, "commit", "-m", "remote advance");
  git(other, "push", "origin", "main");
  const remoteBefore = git(advanced.remote, "rev-parse", "refs/heads/main");
  const workId = await startSmallWork(advanced.core, advanced.projectId, "push-rejected");
  assert.equal(await waitForTerminalDecision(advanced.db, workId), "completed");
  assert.equal(git(advanced.remote, "rev-parse", "refs/heads/main"), remoteBefore);
  const failed = await waitForValue(() => advanced.db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_push_failed'", workId));
  assert.ok(failed);
  assert.equal(JSON.parse(failed.payload_json).push_failure, "non_fast_forward");
  assert.equal(advanced.db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");

  const noUpstream = await openFixture(t, {
    autoPush: true,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
  });
  git(noUpstream.project, "branch", "--unset-upstream");
  const noUpstreamWork = await startSmallWork(noUpstream.core, noUpstream.projectId, "push-no-upstream");
  assert.equal(await waitForTerminalDecision(noUpstream.db, noUpstreamWork), "completed");
  const skipped = await waitForValue(() => noUpstream.db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_push_skipped_no_upstream'", noUpstreamWork));
  assert.ok(skipped);
});

test("Core includes the local pre-push hook's rejection reason in its alert", async (t) => {
  const { project, db, core, projectId } = await openFixture(t, {
    autoPush: true,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
    beforeFinalize: async () => {},
  });
  const hook = join(project, ".git", "hooks", "pre-push");
  await writeFile(hook, "#!/bin/sh\nprintf '%s\\n' 'owl-pre-push: blocked: policy review required' >&2\nexit 1\n");
  await chmod(hook, 0o755);
  const workId = await startSmallWork(core, projectId, "push-hook-blocked");
  assert.equal(await waitForTerminalDecision(db, workId), "completed");
  const blocked = await waitForValue(() => db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_push_blocked_by_hook'", workId));
  assert.ok(blocked);
  const alert = JSON.parse(blocked.payload_json);
  assert.match(alert.message, /owl-pre-push: blocked: policy review required/);
  assert.match(alert.stderr_tail, /owl-pre-push: blocked: policy review required/);
});

test("Core skips the pre-merge verification when the squash tree equals the integration-verified tree", async (t) => {
  const { plan, runs } = markerPlan();
  let runsBeforeMerge = -1;
  const { project, db, core, projectId } = await openFixture(t, {
    verificationPlan: plan,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
    beforeFinalize: async () => { runsBeforeMerge = runs(); },
  });
  const oldMain = git(project, "rev-parse", "refs/heads/main");
  const workId = await startSmallWork(core, projectId, "skip-reverify");

  assert.equal(await waitForTerminalDecision(db, workId), "completed");
  assert.equal(runs(), runsBeforeMerge, "the merge did not run the plan again");
  const skipped = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.merge_verification_skipped'", workId).payload_json);
  const verified = JSON.parse(db.get("SELECT payload_json FROM events WHERE work_id = ? AND type = 'work.integration_verification_completed'", workId).payload_json);
  const mergeCommit = git(project, "rev-parse", "refs/heads/main");
  assert.notEqual(mergeCommit, oldMain);
  assert.equal(skipped.work_id, workId);
  assert.equal(skipped.verified_commit, verified.work_commit);
  assert.equal(skipped.merge_commit, mergeCommit);
  assert.equal(skipped.tree, git(project, "rev-parse", "main^{tree}"));
});

test("Core re-verifies before merging when the base moved after the integration verification", async (t) => {
  const { plan, runs } = markerPlan();
  let project;
  let runsBeforeMerge = -1;
  const fixture = await openFixture(t, {
    verificationPlan: plan,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
    beforeFinalize: async () => {
      runsBeforeMerge = runs();
      await writeFile(join(project, "other.md"), "moved base\n");
      git(project, "add", "other.md");
      git(project, "commit", "-m", "base moved");
    },
  });
  project = fixture.project;
  const workId = await startSmallWork(fixture.core, fixture.projectId, "base-moved");

  assert.equal(await waitForTerminalDecision(fixture.db, workId), "completed");
  assert.equal(runs(), runsBeforeMerge + 1, "the plan ran again on the merge commit");
  assert.equal(fixture.db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'work.merge_verification_skipped'", workId).n, 0);
});

test("Core re-verifies on the newest base and merges, without a Decision, when main moves during the merge verification", async (t) => {
  const { plan, runs } = markerPlan();
  let project;
  const fixture = await openFixture(t, {
    verificationPlan: plan,
    onWorker: async (request) => writeFile(join(request.context.worktree, "feature.mjs"), "export {};\n"),
    // Moving main here makes the squash tree differ from the verified tree, so the merge verification runs.
    beforeFinalize: async () => {
      await writeFile(join(project, "first.md"), "first\n");
      git(project, "add", "first.md");
      git(project, "commit", "-m", "first");
    },
  });
  project = fixture.project;
  const gateway = fixture.core.gitGateway();
  const verify = gateway.runWorkVerification.bind(gateway);
  const seen = [];
  let moved = null;
  gateway.runWorkVerification = async (workId, planArg, context, ...rest) => {
    if (moved === null) {
      await writeFile(join(project, "second.md"), "second\n");
      git(project, "add", "second.md");
      git(project, "commit", "-m", "second");
      moved = git(project, "rev-parse", "refs/heads/main");
    } else {
      git(context.worktree_path, "merge-base", "--is-ancestor", moved, "HEAD");
    }
    seen.push(moved);
    return verify(workId, planArg, context, ...rest);
  };
  const workId = await startSmallWork(fixture.core, fixture.projectId, "moved-during-merge");

  assert.equal(await waitForTerminalDecision(fixture.db, workId), "completed");
  assert.equal(seen.length, 2, "the merge verification ran again after the base moved");
  assert.equal(fixture.db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ?", workId).n, 0);
  for (const file of ["first.md", "second.md", "feature.mjs"]) assert.ok(git(project, "show", `main:${file}`).length > 0, file);
});
