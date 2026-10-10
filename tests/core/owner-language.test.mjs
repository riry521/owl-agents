import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";
import { ownerLanguageFromLocale } from "../../packages/shared/dist/owner-language.js";

// One Owl-wide language setting decides what the Owner reads: the
// human-readable values agents return, Owl's own Decision text, and the
// headings of notifications. These tests hold that it is stored once, only
// seeded from the OS locale on first start, and reaches every role request.

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `language:${suffix}`, expectedVersion);
}

function openCore(t, agentRunner, coreOptions = {}) {
  return createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 }, ...coreOptions }, { prefix: "owl-language-" });
}

const idleRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unexpected" }),
  runWorker: async () => ({ outcome: "failed", message: "unexpected" }),
  runReviewer: async () => ({ outcome: "failed", message: "unexpected" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("the OS locale only seeds the language; a stored choice is kept", async (t) => {
  assert.equal(ownerLanguageFromLocale("ja-JP"), "ja");
  assert.equal(ownerLanguageFromLocale("ja_JP.UTF-8"), "ja");
  assert.equal(ownerLanguageFromLocale("en-US"), "en");
  assert.equal(ownerLanguageFromLocale("de-DE"), "en");
  assert.equal(ownerLanguageFromLocale(undefined), "en");

  const { core, db } = await openCore(t, idleRunner);
  await core.start();
  await disablePlanQuality(db);
  assert.equal(await core.getLanguage(), "ja", "nothing stored yet reads as the default");
  assert.equal(await core.initializeLanguage("en"), "en", "first start stores the locale's language");
  assert.equal(await core.initializeLanguage("ja"), "en", "a later start never overwrites it");
  assert.equal(await core.setLanguage("ja"), "ja");
  assert.equal(await core.getLanguage(), "ja");
  assert.equal(db.get("SELECT value_json FROM settings WHERE key = 'language'").value_json, '"ja"');
});

test("the language reaches every role request and lessons enter the learning pipeline", async (t) => {
  const managerRequests = [];
  const workerRequests = [];
  const agentRunner = {
    runManagerPlan: async (request) => {
      managerRequests.push(request);
      if (request.context?.mode === "plan") {
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Research", type: "research", acceptance: "Done.", depends_on: [], required_sections: [], required_tests: [], replaces: [], review: false }] } };
      }
      if (request.mode === "finalize") {
        return {
          outcome: "success",
          report_valid: true,
          report: {
            tasks: request.tasks ?? [],
            event: null,
            verdict: {
              verdict: "complete",
              summary: "Done.",
              missing: [],
              lessons: [{ lesson: "Pin the migration number early.", basis: "Two Works clashed.", applies_to: "Schema changes.", proposes_rule: true }],
            },
          },
        };
      }
      return { outcome: "failed", message: "unexpected" };
    },
    runWorker: async (request) => {
      workerRequests.push(request);
      return {
        outcome: "success",
        report_valid: true,
        report: {
          kind: "report",
          schema_version: "1.0.0",
          invocation_id: request.invocation_id,
          result: "success",
          work_done: "Done.",
          changes: [],
          verification: { passed: true, method: "Read the result." },
          remaining_issues: [],
          next_action: "none",
          needs_replanning: false,
          question_for_manager: null,
        },
      };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { core, db } = await openCore(t, agentRunner);
  await core.start();
  await disablePlanQuality(db);
  await core.setLanguage("en");
  const created = await core.createWork(commandEnvelope({ title: "Language", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "start", created.version));

  const job = await waitFor(() => db.get("SELECT * FROM learning_jobs WHERE work_id = ? AND status = 'done'", workId), { timeoutMs: 15_000, message: "the learning job to finish" }).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify({ work: db.get("SELECT state FROM works WHERE id = ?", workId), jobs: db.all("SELECT status, attempts, last_error, result_json FROM learning_jobs WHERE work_id = ?", workId), requests: managerRequests.map((request) => request.mode ?? request.context?.mode), workerCalls: workerRequests.length })}`);
  });
  assert.ok(managerRequests.length >= 2, "plan and finalize both ran");
  for (const request of managerRequests) assert.equal(request.language, "en", JSON.stringify(request.mode ?? request.context?.mode));
  assert.ok(workerRequests.length > 0);
  for (const request of workerRequests) assert.equal(request.language, "en");
  const result = JSON.parse(job.result_json);
  const proposal = db.get("SELECT * FROM rule_proposals WHERE id = ?", result.rule_proposal_ids[0]);
  assert.equal(proposal.status, "pending", "a single source stays pending");
  assert.equal(proposal.text, "Pin the migration number early.");
  assert.equal(proposal.rationale, "Two Works clashed.");
  assert.equal((await core.knowledge.list("policies")).length, 0);
  assert.equal((await core.knowledge.list("works")).length, 1, "the Work log page");
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND scope = 'work' AND issuer_role = 'core' AND tried LIKE '%Pin the migration number early%'", workId).n,
    0,
    "saving the rule does not open a policy Decision",
  );
});
