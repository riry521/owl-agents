import assert from "node:assert/strict";
import { test } from "node:test";

import { recoverOrphanedState } from "../../packages/core/dist/startup-recovery.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { openTestDatabase } from "../helpers/db.mjs";

async function fixture(t) {
  const { db } = await openTestDatabase(t, { prefix: "owl-startup-merge-abort-" });

  const now = new Date().toISOString();
  const projectId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", "owner:default", "Owner", now, now);
    tx.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Project', ?, 'main', '[]', '[]', '[]', ?, ?)`,
      projectId, `/tmp/owl-startup-merge-abort-${projectId}`, now, now,
    );
  });

  return { db, projectId };
}

async function insertWork(db, id, projectId, state) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO works
         (id, owner_id, project_id, title, summary, size, state, rules_json,
          related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', ?, ?, 'x', 'normal', ?, '[]', '[]', ?, ?)`,
      id, projectId, id, state, now, now,
    );
  });
}

function fakeGit(abortIntegrationMerge) {
  return { abortIntegrationMerge };
}

test("startup recovery aborts integration merges for every non-terminal Project Work only", async (t) => {
  const { db, projectId } = await fixture(t);
  const calls = [];
  const git = fakeGit(async (request) => {
    calls.push(request.work_id);
    return { ok: true, exit_code: 0, recorded: true, message: "No merge in progress." };
  });
  const nonterminalStates = ["memo", "ready", "running", "judgement_waiting", "paused"];
  for (const state of nonterminalStates) await insertWork(db, `project-${state}`, projectId, state);
  await insertWork(db, "project-completed", projectId, "completed");
  await insertWork(db, "project-cancelled", projectId, "cancelled");
  await insertWork(db, "projectless-running", null, "running");

  await recoverOrphanedState(db, git);

  assert.deepEqual(calls.sort(), nonterminalStates.map((state) => `project-${state}`).sort());
});

test("a failed or throwing abort warns and does not stop other startup recovery", async (t) => {
  const { db, projectId } = await fixture(t);
  const failedWork = "project-abort-failed";
  const throwingWork = "project-abort-threw";
  const calls = [];
  const warnings = [];
  const git = fakeGit(async ({ work_id }) => {
    calls.push(work_id);
    if (work_id === failedWork) return { ok: false, exit_code: 1, recorded: true, message: "merge abort failed" };
    throw new Error("git unavailable");
  });
  await insertWork(db, failedWork, projectId, "running");
  await insertWork(db, throwingWork, projectId, "running");

  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let recovery;
  try {
    recovery = await recoverOrphanedState(db, git);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls, [failedWork, throwingWork]);
  assert.equal(warnings.length, 2);
  assert.ok(recovery.staleWorks.includes(failedWork));
  assert.ok(recovery.staleWorks.includes(throwingWork));
});

test("startup recovery skips merge abort when no Git gateway is configured", async (t) => {
  const { db, projectId } = await fixture(t);
  await insertWork(db, "project-running", projectId, "running");

  await assert.doesNotReject(recoverOrphanedState(db));
});
