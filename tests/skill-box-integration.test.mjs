import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../packages/db/dist/index.js";
import { Core } from "../packages/core/dist/core.js";

const migrations = join(process.cwd(), "packages/db/migrations");
const proposal = {
  kind: "new",
  target: null,
  summary: "Capture release steps",
  steps_or_diff: "Review the source, run the required checks, and record the verified result for the next release.",
  evidence: "The same release sequence was used in multiple tasks.",
};

async function fixture(t, withTypeSafe) {
  const root = await mkdtemp(join(tmpdir(), "owl-skill-box-integration-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('work-1', 'owner:default', 'Release work', '', 'normal', 'running', '[]', '[]', ?, ?)", now, now);
  });
  const calls = [];
  const agentRunner = {
    runCurator: async (request) => {
      calls.push(request);
      return {
        ok: true,
        results: request.proposals.map((item) => ({
          proposal_id: item.id,
          decision: "create",
          judgement: { reusable: 1.5, work_specific: 0.1, relation: "different", confidence: 0.8 },
          skill: {
            name: "release-procedure",
            description: "Repeatable release steps.",
            tags: ["release"],
            files: [{ path: "SKILL.md", content: "# Release procedure\n\nCheck the version, run the checks, then publish." }],
          },
          archive: [],
          reason: "The sequence is reusable.",
        })),
      };
    },
  };
  const core = new Core({
    db,
    agentRunner,
    version: "skill-box-integration-test",
    owlRoot: root,
    skillCuratorDebounceMs: 1,
    ...(withTypeSafe ? {
      getTypesafeApiKey: () => "stub-key",
      skillCuratorTypeSafeJudge: async () => ({ reusable: 1.5, work_specific: 0.1, relation: "different", confidence: 0.8 }),
    } : {}),
  });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, core, calls, now };
}

async function seedRun(db, id, now) {
  await db.createWriteLane().transact((tx) => tx.run(
    `INSERT INTO agent_runs (id, work_id, role, provider, model, status, created_at, updated_at)
     VALUES (?, 'work-1', 'worker', 'test', 'test', 'completed', ?, ?)`, id, now, now,
  ));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Curator integration did not reach the expected state.");
}

for (const withTypeSafe of [false, true]) {
  test(`feedback is curated, indexed, and graduates from trial (TypeSafe ${withTypeSafe ? "enabled" : "disabled"})`, async (t) => {
    const { db, core, calls, now } = await fixture(t, withTypeSafe);
    await seedRun(db, "proposal-run", now);
    await core.skillBox.recordFeedback("proposal-run", { skills_used: [], skill_proposals: [proposal] });
    await waitFor(() => db.get("SELECT name FROM skills WHERE name = 'release-procedure'"));
    assert.equal(db.get("SELECT status FROM skill_proposals").status, "applied");
    assert.equal(db.get("SELECT trial FROM skills WHERE name = 'release-procedure'").trial, 1);
    assert.match(core.workflowEngine().composeSkillsForWork("work-1"), /release-procedure/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].with_judgement, !withTypeSafe);

    for (let index = 1; index <= 3; index += 1) {
      const runId = `verdict-run-${index}`;
      await seedRun(db, runId, now);
      await core.skillBox.recordFeedback(runId, {
        skills_used: [{ name: "release-procedure", verdict: "helpful", note: `The procedure helped ${index}.` }],
        skill_proposals: [],
      });
    }
    assert.equal(db.get("SELECT trial FROM skills WHERE name = 'release-procedure'").trial, 0);
  });
}
