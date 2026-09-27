import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { ownerLanguageFromLocale } from "../packages/shared/dist/owner-language.js";

// One Owl-wide language setting decides what the Owner reads: the
// human-readable values agents return, Owl's own Decision text, and the
// headings of notifications. These tests hold that it is stored once, only
// seeded from the OS locale on first start, and reaches every role request.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return { request_id: createUlid(), idempotency_key: `language:${suffix}`, expected_version: expectedVersion, payload };
}

async function openCore(t, agentRunner, coreOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-language-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner, version: "test", owlRoot: root, dispatcher: { tick_interval_ms: 25 }, ...coreOptions });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  return { core, db, root };
}

async function waitFor(read, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value || Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const idleRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unexpected" }),
  runWorker: async () => ({ outcome: "failed", message: "unexpected" }),
  runReviewer: async () => ({ outcome: "failed", message: "unexpected" }),
  runAdvisor: async () => ({ reply: "" }),
};

test("notes changes debounce Librarian runs, serialize reruns, and warn on failure", async (t) => {
  const { core } = await openCore(t, idleRunner, { skillCuratorDebounceMs: 10 });
  await core.start();

  let runCount = 0;
  let activeRuns = 0;
  let maxActiveRuns = 0;
  let releaseFirstRun;
  const warnings = [];
  core.librarian.run = async () => {
    runCount += 1;
    activeRuns += 1;
    maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
    try {
      if (runCount === 1) {
        await new Promise((resolve) => { releaseFirstRun = resolve; });
        throw new Error("test Librarian failure");
      }
    } finally {
      activeRuns -= 1;
    }
  };

  const onNotesChanged = core.learningPipeline.onNotesChanged;
  assert.equal(onNotesChanged(), undefined);
  assert.equal(onNotesChanged(), undefined);
  assert.equal(runCount, 0, "notifications return without running the Librarian");
  core.logger.warn = (message) => warnings.push(message);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runCount, 1, "notifications in one debounce window produce one run");

  onNotesChanged();
  onNotesChanged();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runCount, 1, "a run already in progress is not overlapped");
  releaseFirstRun();

  const deadline = Date.now() + 1_000;
  while (runCount < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runCount, 2, "notifications during a run coalesce into one follow-up run");
  assert.equal(maxActiveRuns, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Librarian/);
});

test("Core stop clears and unreferences the pending Librarian debounce timer", async (t) => {
  const { core } = await openCore(t, idleRunner, { skillCuratorDebounceMs: 25 });
  await core.start();
  let runCount = 0;
  core.librarian.run = async () => { runCount += 1; };

  core.learningPipeline.onNotesChanged();
  assert.equal(core.librarianDebounceTimer.hasRef(), false);
  await core.stop({ force: true });
  assert.equal(core.librarianDebounceTimer, null);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runCount, 0);
});

test("the OS locale only seeds the language; a stored choice is kept", async (t) => {
  assert.equal(ownerLanguageFromLocale("ja-JP"), "ja");
  assert.equal(ownerLanguageFromLocale("ja_JP.UTF-8"), "ja");
  assert.equal(ownerLanguageFromLocale("en-US"), "en");
  assert.equal(ownerLanguageFromLocale("de-DE"), "en");
  assert.equal(ownerLanguageFromLocale(undefined), "en");

  const { core, db } = await openCore(t, idleRunner);
  await core.start();
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
        return { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [{ id: "T1", title: "Research", type: "research", acceptance: "Done.", depends_on: [], replaces: [], review: false }] } };
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
  await core.setLanguage("en");
  const created = await core.createWork(commandEnvelope({ title: "Language", summary: "x", size: "normal", project_id: null }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, commandEnvelope({ mode: "normal" }, "start", created.version));

  const job = await waitFor(() => db.get("SELECT * FROM learning_jobs WHERE work_id = ? AND status = 'done'", workId), 15_000);
  assert.ok(job, JSON.stringify({ work: db.get("SELECT state FROM works WHERE id = ?", workId), jobs: db.all("SELECT status, attempts, last_error, result_json FROM learning_jobs WHERE work_id = ?", workId), requests: managerRequests.map((request) => request.mode ?? request.context?.mode), workerCalls: workerRequests.length }));
  assert.ok(managerRequests.length >= 2, "plan and finalize both ran");
  for (const request of managerRequests) assert.equal(request.language, "en", JSON.stringify(request.mode ?? request.context?.mode));
  assert.ok(workerRequests.length > 0);
  for (const request of workerRequests) assert.equal(request.language, "en");
  const result = JSON.parse(job.result_json);
  const proposal = db.get("SELECT * FROM rule_proposals WHERE id = ?", result.rule_proposal_ids[0]);
  assert.equal(proposal.status, "awaiting_approval");
  assert.equal(proposal.text, "Pin the migration number early.");
  assert.equal(proposal.rationale, "Two Works clashed.");
  assert.equal((await core.knowledge.list("policies")).length, 0);
  assert.equal((await core.knowledge.list("works")).length, 0);
  assert.equal(
    db.get("SELECT COUNT(*) AS n FROM decisions WHERE work_id = ? AND scope = 'work' AND issuer_role = 'core' AND tried LIKE '%Pin the migration number early%'", workId).n,
    0,
    "saving the rule does not open a policy Decision",
  );
});
