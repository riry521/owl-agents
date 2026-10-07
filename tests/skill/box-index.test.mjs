import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { SkillBox } from "../../packages/core/dist/skill-box.js";
import { renderSkillMd } from "../../packages/core/dist/skill-files.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { waitFor } from "../helpers/wait.mjs";

async function seedSkillBox(db, root) {
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)",
    now,
    now,
  ));
  return new SkillBox({ db, owlRoot: root, logger: { warn() {}, error() {} } });
}

async function fixture(t) {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-skill-index-" });
  return { db, root, skillBox: await seedSkillBox(db, root) };
}

async function coreFixture(t, agentRunner) {
  const { root, db, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-skill-index-" });
  const skillBox = await seedSkillBox(db, root);
  core.ruleStore.startWatching = async () => {};
  return { db, root, skillBox, core };
}

async function addSkill(skillBox, name, { scope = "global", trial = false, description = `${name} procedure.`, action = "create" } = {}) {
  const meta = { description, scope, tags: ["test"] };
  const files = { "SKILL.md": renderSkillMd({ name, ...meta }, `# ${name}`) };
  return skillBox.applyRevision({ name, files, meta, actor: "user", action, reason: "test setup", trial });
}

async function addUsage(db, name, count, { createdAt = new Date().toISOString() } = {}) {
  const lane = db.createWriteLane();
  await lane.transact((tx) => {
    for (let index = 0; index < count; index += 1) {
      tx.run(
        `INSERT INTO skill_usages (agent_run_id, skill_name, revision, read_detected, created_at, updated_at)
         VALUES (?, ?, 1, 1, ?, ?)`,
        `${name}-run-${createdAt}-${index}`,
        name,
        createdAt,
        createdAt,
      );
    }
  });
}

test("skill index filters project scope and broken or archived skills, then applies the specified priority", async (t) => {
  const { db, skillBox } = await fixture(t);
  await addSkill(skillBox, "project-hot", { scope: "project:project-1", trial: true });
  await addSkill(skillBox, "project-cold", { scope: "project:project-1" });
  await addSkill(skillBox, "project-stale", { scope: "project:project-1" });
  await addSkill(skillBox, "global-active");
  await addSkill(skillBox, "global-stale");
  await addSkill(skillBox, "other-project", { scope: "project:project-2" });
  await addSkill(skillBox, "archived-skill");
  await addSkill(skillBox, "broken-skill");

  await skillBox.setState("project-stale", "stale", "user", "inactive");
  await skillBox.setState("global-stale", "stale", "user", "inactive");
  await skillBox.setState("archived-skill", "archived", "user", "removed");
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE skills SET broken_reason = 'bad frontmatter' WHERE name = 'broken-skill'");
    tx.run("UPDATE skills SET updated_at = '2026-09-20T00:00:00.000Z' WHERE name = 'project-hot'");
    tx.run("UPDATE skills SET updated_at = '2026-09-25T00:00:00.000Z' WHERE name = 'project-cold'");
    tx.run("UPDATE skills SET updated_at = '2026-09-24T00:00:00.000Z' WHERE name = 'global-active'");
  });
  await addUsage(db, "project-hot", 4);
  await addUsage(db, "project-cold", 1);
  await addUsage(db, "global-active", 99);
  await addUsage(db, "project-stale", 100);
  await addUsage(db, "project-hot", 2, { createdAt: "2026-01-01T00:00:00.000Z" });

  const index = skillBox.renderIndex("project-1");
  assert.ok(index);
  const names = index.split("\n").map((line) => line.match(/^- ([^:]+):/u)?.[1]);
  // Rendered by name; the priority decides which skills are selected.
  assert.deepEqual(names, ["global-active", "global-stale", "project-cold", "project-hot", "project-stale"]);
  const top = skillBox.renderIndex("project-1", { max_items: 2 })?.split("\n").map((line) => line.match(/^- ([^:]+):/u)?.[1]);
  assert.deepEqual(top, ["project-cold", "project-hot"]);
  assert.match(index, /project-hot: .*\[trial\]/u);
  assert.equal(index.includes("other-project"), false);
  assert.equal(index.includes("archived-skill"), false);
  assert.equal(index.includes("broken-skill"), false);
  assert.equal(skillBox.renderIndex(null)?.includes("project-hot"), false);
});

test("skill index obeys the settings limits and applies the default item and character limits when unset", async (t) => {
  const { db, skillBox } = await fixture(t);
  for (let index = 0; index < 31; index += 1) {
    const description = `s${index}`;
    await addSkill(skillBox, `limit-${String(index).padStart(2, "0")}`, { description });
  }
  await db.createWriteLane().transact((tx) => tx.run("UPDATE skills SET updated_at = '2026-09-01T00:00:00.000Z'"));
  const defaultIndex = skillBox.renderIndex(null);
  assert.equal(defaultIndex?.split("\n").length, 30);
  assert.equal(defaultIndex?.includes("limit-30"), false);

  const wideIndex = await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE skills SET description = ?", "x".repeat(300));
    tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('skills', 'owner:default', '1.0.0', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at", JSON.stringify({ index_max_items: 50, index_max_chars: 6000 }), new Date().toISOString());
    return true;
  }).then(() => skillBox.renderIndex(null));
  assert.ok(wideIndex);
  assert.ok(wideIndex.length <= 6000);
  assert.ok(wideIndex.split("\n").length < 31);

  await db.createWriteLane().transact((tx) => tx.run(
    "UPDATE settings SET value_json = ? WHERE key = 'skills'",
    JSON.stringify({ index_max_items: 2, index_max_chars: 10000 }),
  ));
  assert.equal(skillBox.renderIndex(null)?.split("\n").length, 2);
});

test("Core adds the skill index to Manager, Worker, and Reviewer requests for a Work", async (t) => {
  const requests = { manager: [], worker: [], reviewer: [] };
  const workerReport = (invocationId) => ({
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
  });
  const agentRunner = {
    runManagerPlan: async (request) => {
      requests.manager.push(request);
      const mode = request.context?.mode ?? request.mode;
      return mode === "plan"
        ? { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Use skill", type: "code", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: true }] } }
        : { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } };
    },
    runWorker: async (request) => {
      requests.worker.push(request);
      await writeFile(join(request.context.worktree, "out.mjs"), "export {};\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async (request) => {
      requests.reviewer.push(request);
      const review = { verdict: "pass", summary: "Looks good.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
      return { outcome: "success", report_valid: true, report: review, review };
    },
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, skillBox, core } = await coreFixture(t, agentRunner);
  await addSkill(skillBox, "context-procedure");
  {
    await core.start();
    await disablePlanQuality(db);
    const created = await core.createWork(command({ title: "Use a stored skill", summary: "Complete the work.", size: "normal", project_id: null }, "skill-index:create"));
    await core.startWork(created.data.work_id, command({ mode: "normal" }, "skill-index:start", created.version));
    const complete = await waitFor(() => db.get("SELECT state FROM works WHERE id = ? AND state = 'completed'", created.data.work_id), { timeoutMs: 8000, message: "the Work to complete" });
    assert.ok(complete, `work did not complete (state=${db.get("SELECT state FROM works WHERE id = ?", created.data.work_id)?.state})`);

    assert.match(requests.manager.find((request) => request.context?.mode === "plan").context.skills, /context-procedure/u);
    assert.match(requests.worker[0].context.skills, /context-procedure/u);
    assert.match(requests.reviewer[0].context.skills, /context-procedure/u);
  }
});

test("Core starts a Manager with null skills if rendering the index throws", async (t) => {
  const managerRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      managerRequests.push(request);
      return { outcome: "failed", message: "stop after checking the request" };
    },
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { db, skillBox, core } = await coreFixture(t, agentRunner);
  await addSkill(skillBox, "context-procedure");
  core.skillBox.renderIndex = () => { throw new Error("index unavailable"); };
  {
    await core.start();
    await disablePlanQuality(db);
    const created = await core.createWork(command({ title: "Continue without skills", summary: "Continue.", size: "normal", project_id: null }, "skill-index:fallback-create"));
    await core.startWork(created.data.work_id, command({ mode: "normal" }, "skill-index:fallback-start", created.version));
    const seen = await waitFor(() => managerRequests[0], { timeoutMs: 8000, message: "the Manager request" });
    assert.ok(seen);
    assert.equal(seen.context.skills, null);
  }
});
