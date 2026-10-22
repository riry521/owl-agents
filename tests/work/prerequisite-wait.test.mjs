import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { command as envelope, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";

let counter = 0;
const command = (payload, expectedVersion = 0) => envelope(payload, `prerequisite-wait:${(counter += 1)}`, expectedVersion);

async function setup(t, extra = {}) {
  return createTestCore(t, { version: "prerequisite-wait-test", dispatcher: { tick_interval_ms: 600_000 }, ...extra }, { prefix: "owl-prerequisite-wait-" });
}

async function createProject(core, root, name) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  git(path, "init", "--initial-branch=main");
  await writeFile(join(path, "README.md"), "base\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "initial");
  const response = await core.createProject(command({
    name,
    canonical_path: await realpath(path),
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }));
  return response.data.id;
}

async function createWork(core, projectId, title, prerequisiteIds) {
  const payload = { title, summary: "", size: "small", project_id: projectId };
  if (prerequisiteIds !== undefined) payload.prerequisite_work_ids = prerequisiteIds;
  const response = await core.createWork(command(payload));
  return response.data.work_id;
}

const setState = (db, workId, state) => db.createWriteLane().transact((transaction) => {
  transaction.run("UPDATE works SET state = ? WHERE id = ?", state, workId);
});

const stateOf = (db, workId) => db.get("SELECT state FROM works WHERE id = ?", workId)?.state;
const versionOf = (db, workId) => db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
const count = (db, table, workId) => db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE work_id = ?`, workId).n;
const eventCount = (db, type, workId) => db.get("SELECT COUNT(*) AS n FROM events WHERE type = ? AND work_id = ?", type, workId).n;
const openDecision = (db, workId) => db.get("SELECT * FROM decisions WHERE work_id = ? AND status = 'open'", workId);

/** Two prerequisites in their own Projects and a waiting Work in a third, started and therefore `ready`. */
async function waitingSetup(t) {
  const { root, db, core } = await setup(t);
  const projects = [];
  for (const name of ["Alpha", "Beta", "Gamma"]) projects.push(await createProject(core, root, name));
  const first = await createWork(core, projects[0], "first");
  const second = await createWork(core, projects[1], "second");
  const waiting = await createWork(core, projects[2], "waiting", [first, second]);
  await core.startWork(waiting, command({ mode: "auto" }, versionOf(db, waiting)));
  return { root, db, core, first, second, waiting };
}

/** Answer the open prerequisite Decision with the option of `key`; the answer text must be that option's label. */
async function answerWith(core, db, workId, key) {
  const decision = openDecision(db, workId);
  const option = JSON.parse(decision.options_json).find((candidate) => candidate.key === key);
  assert.ok(option, `option ${key}`);
  await core.answerDecision(decision.id, command({ answer: option.label, option_key: key, source_message_id: null }));
}

async function expectRefusal(promise, code) {
  const error = await promise.then(() => null, (caught) => caught);
  assert.ok(error, `expected ${code}`);
  assert.equal(error.code ?? error.error?.code, code);
  return error;
}

test("a Work waits as ready with no plan, then starts when its last prerequisite completes", async (t) => {
  const { db, core, first, second, waiting } = await waitingSetup(t);
  assert.equal(stateOf(db, waiting), "ready");
  assert.equal(count(db, "tasks", waiting), 0);
  assert.equal(count(db, "agent_runs", waiting), 0);

  await setState(db, first, "completed");
  await core.checkWorkPrerequisites();
  assert.equal(stateOf(db, waiting), "ready");

  await setState(db, second, "completed");
  await core.checkWorkPrerequisites();
  assert.equal(stateOf(db, waiting), "running");
  assert.equal(eventCount(db, "work.prerequisites_satisfied", waiting), 1);
});

test("a cancelled prerequisite opens a Decision; dropping it keeps waiting or starts, cancel cancels", async (t) => {
  const { db, core, first, second, waiting } = await waitingSetup(t);
  const cancelled = await core.cancelWork(first, command({ reason: "no longer needed" }, versionOf(db, first)));
  assert.equal(cancelled.data.state, "cancelled");
  assert.equal(stateOf(db, waiting), "judgement_waiting");
  assert.equal(count(db, "tasks", waiting), 0);
  const decision = openDecision(db, waiting);
  const number = db.get("SELECT display_number FROM works WHERE id = ?", first).display_number;
  assert.match(decision.reason, new RegExp(`Alpha Work #${number}`));
  assert.match(decision.reason, /中止|cancel/iu);
  assert.ok(JSON.parse(decision.options_json).some((option) => option.key === "drop_missing_prerequisites"));

  await answerWith(core, db, waiting, "drop_missing_prerequisites");
  assert.equal(stateOf(db, waiting), "ready");

  // Same again with the other prerequisite already done: dropping leaves nothing to wait for.
  const done = await waitingSetup(t);
  await setState(done.db, done.second, "completed");
  await done.core.cancelWork(done.first, command({ reason: "x" }, versionOf(done.db, done.first)));
  await answerWith(done.core, done.db, done.waiting, "drop_missing_prerequisites");
  assert.equal(stateOf(done.db, done.waiting), "running");

  const stopped = await waitingSetup(t);
  await stopped.core.cancelWork(stopped.first, command({ reason: "x" }, versionOf(stopped.db, stopped.first)));
  const cancelKey = JSON.parse(openDecision(stopped.db, stopped.waiting).options_json).find((option) => option.key !== "drop_missing_prerequisites").key;
  await answerWith(stopped.core, stopped.db, stopped.waiting, cancelKey);
  assert.equal(stateOf(stopped.db, stopped.waiting), "cancelled");
  void second;
});

test("a deleted prerequisite opens a Decision, but one deleted after completing counts as satisfied", async (t) => {
  const { db, core, first, second, waiting } = await waitingSetup(t);
  const deleted = await core.deleteWork(first, command({}, versionOf(db, first)));
  assert.equal(deleted.data.deleted, true);
  assert.equal(stateOf(db, waiting), "judgement_waiting");
  assert.match(openDecision(db, waiting).reason, /削除|delet/iu);
  void second;

  const satisfied = await waitingSetup(t);
  await setState(satisfied.db, satisfied.first, "completed");
  await setState(satisfied.db, satisfied.second, "completed");
  await satisfied.db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE works SET state = 'ready' WHERE id = ?", satisfied.waiting);
  });
  await satisfied.core.deleteWork(satisfied.first, command({}, versionOf(satisfied.db, satisfied.first)));
  await satisfied.core.checkWorkPrerequisites();
  assert.equal(stateOf(satisfied.db, satisfied.waiting), "running");
});

test("release starts the wait at once, is refused for a memo Work, and a second start keeps waiting", async (t) => {
  const { db, core, waiting } = await waitingSetup(t);
  await core.startWork(waiting, command({ mode: "auto" }, versionOf(db, waiting)));
  assert.equal(stateOf(db, waiting), "ready");

  const memo = await createWork(core, null, "memo");
  await expectRefusal(core.releaseWorkPrerequisiteWait(memo, command({}, versionOf(db, memo))), "invalid_state_transition");

  await core.releaseWorkPrerequisiteWait(waiting, command({}, versionOf(db, waiting)));
  assert.equal(stateOf(db, waiting), "running");
  assert.equal(eventCount(db, "work.prerequisite_wait_released", waiting), 1);
});

test("updateWork while the prerequisite Decision is open queues no replan", async (t) => {
  const { db, core, first, waiting } = await waitingSetup(t);
  await core.cancelWork(first, command({ reason: "x" }, versionOf(db, first)));
  assert.equal(stateOf(db, waiting), "judgement_waiting");
  const response = await core.updateWork(waiting, command({ title: "renamed" }, versionOf(db, waiting)));
  assert.equal(response.data.replan_queued, false);
});

test("a waiting Work with prerequisite rows can be deleted", async (t) => {
  const { db, core, waiting } = await waitingSetup(t);
  await core.deleteWork(waiting, command({}, versionOf(db, waiting)));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM work_prerequisites WHERE work_id = ?", waiting).n, 0);
  assert.equal(stateOf(db, waiting), undefined);
});

test("the startup sweep starts a Work whose prerequisite completed while Core was stopped", async (t) => {
  const first = await waitingSetup(t);
  await first.core.stop({ force: true });
  await setState(first.db, first.first, "completed");
  await setState(first.db, first.second, "completed");
  assert.equal(stateOf(first.db, first.waiting), "ready");
  const second = await createTestCore(t, { version: "prerequisite-wait-test", dispatcher: { tick_interval_ms: 600_000 }, db: first.db, owlRoot: first.root }, { start: true });
  try {
    assert.equal(stateOf(second.db, first.waiting), "running");
  } finally {
    await second.core.stop({ force: true });
  }
});

test("replaceWorkPrerequisites and createWork refuse missing Works, self references and cycles", async (t) => {
  const { db, core, first, second, waiting } = await waitingSetup(t);
  await expectRefusal(core.replaceWorkPrerequisites(waiting, command({ prerequisite_work_ids: [createUlid()] }, versionOf(db, waiting))), "prerequisite_work_not_found");
  await expectRefusal(core.replaceWorkPrerequisites(waiting, command({ prerequisite_work_ids: [waiting] }, versionOf(db, waiting))), "validation_error");
  await expectRefusal(core.createWork(command({ title: "x", summary: "", size: "small", project_id: null, prerequisite_work_ids: [createUlid()] })), "prerequisite_work_not_found");

  // first -> waiting would close first -> waiting -> first through the stored edge waiting -> first.
  const error = await expectRefusal(core.replaceWorkPrerequisites(first, command({ prerequisite_work_ids: [waiting] }, versionOf(db, first))), "prerequisite_cycle");
  const cycle = error.details?.cycle ?? error.error?.details?.cycle;
  assert.deepEqual(cycle.slice(0, 2), [first, waiting]);
  assert.equal(cycle.at(-1), first);

  // A transitive cycle: second -> first is fine, then first -> second is refused.
  await core.replaceWorkPrerequisites(second, command({ prerequisite_work_ids: [first] }, versionOf(db, second)));
  const transitive = await expectRefusal(core.replaceWorkPrerequisites(first, command({ prerequisite_work_ids: [second] }, versionOf(db, first))), "prerequisite_cycle");
  assert.ok((transitive.details?.cycle ?? transitive.error?.details?.cycle).includes(second));
});
