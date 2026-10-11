import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { command as envelope, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { withNecessity } from "../helpers/necessity.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const apiRoot = "/api/v1";

const command = (payload, suffix = createUlid(), expectedVersion = 0) => envelope(payload, `learning-e2e:${suffix}`, expectedVersion);

async function rulesSnapshot(rulesDir) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const content = await readFile(path);
        files.push([
          relative(rulesDir, path).split(sep).join("/"),
          createHash("sha256").update(content).digest("hex"),
        ]);
      }
    }
  }
  await visit(rulesDir);
  return files;
}

async function waitUntil(read, accept, label, timeoutMs = 12_000) {
  let value;
  try {
    return await waitFor(async () => {
      value = await read();
      return accept(value) ? value : null;
    }, { timeoutMs, intervalMs: 25, message: label });
  } catch (error) {
    if (!String(error?.message).startsWith("timed out after")) throw error;
    assert.fail(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
  }
}

test("completed Work learning flows through HTTP proposals and applies rules only after approval", async (t) => {
  const lessons = [
    {
      lesson: "A completed Work can teach a repeatable validation procedure.",
      basis: "The final verdict routes lessons to separate learning outputs.",
      applies_to: "When checking Work completion learning flows.",
      kind: "procedure",
      topic: "",
      procedure: "1. Complete the Work. 2. Query the learning job and each proposal through HTTP. 3. Check rule files before approval.",
      rule_text: "",
      rule_scope: "all",
    },
    {
      lesson: "The learning job records a stable fact from the completed Work.",
      basis: "The Final Manager verdict includes this fact lesson.",
      applies_to: "Future learning pipeline checks.",
      kind: "fact",
      topic: "Work completion learning e2e",
      procedure: "",
      rule_text: "",
      rule_scope: "all",
    },
    {
      lesson: "Without waiting for the learning job, generated proposals may not yet be visible.",
      basis: "Learning processing runs asynchronously after Work completion.",
      applies_to: "Checks that inspect learning outputs after a completed Work.",
      kind: "pitfall",
      topic: "Work completion learning e2e",
      procedure: "",
      rule_text: "",
      rule_scope: "all",
    },
    {
      lesson: "Require Owner approval before adding this system rule.",
      basis: "The proposal is a short instruction for all future Work.",
      applies_to: "Rule proposal approval flow checks.",
      kind: "rule_candidate",
      topic: "",
      procedure: "",
      rule_text: "Require Owner approval before adding this system rule.",
      rule_scope: "all",
    },
    {
      lesson: "Require a separate decision before adding this Worker rule.",
      basis: "The proposal applies only to Worker behavior.",
      applies_to: "Worker rule proposal checks.",
      kind: "rule_candidate",
      topic: "",
      procedure: "",
      rule_text: "Require a separate decision before adding this Worker rule.",
      rule_scope: "worker",
    },
  ];

  const workerReport = (invocationId) => ({
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Completed the test Work.",
    changes: [],
    verification: { passed: true, method: "The fake Worker returned a valid success report." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null, pending_process: null, external_blocker: null,
    verdict: "ok",
    retry_subtasks: [],
  });
  const agentRunner = {
    runManagerPlan: async (request) => {
      const mode = request.context?.mode ?? request.mode;
      if (mode === "plan") {
        return {
          outcome: "success",
          report_valid: true,
          report: {
            tasks: [{
              id: "T-learning-e2e",
              title: "Complete the learning flow fixture",
              type: "code",
              acceptance: "Return a successful Worker report.",
              depends_on: [],
              required_sections: [], required_tests: [], wait_for: null, base_sync_only: null,
              replaces: [],
              review: false,
            }],
            event: "work.planned",
          },
        };
      }
      if (mode === "finalize") {
        return {
          outcome: "success",
          report_valid: true,
          report: {
            tasks: request.tasks ?? [],
            event: null,
            verdict: { verdict: "complete", summary: "The learning e2e Work is complete.", missing: [], lessons },
          },
        };
      }
      return { outcome: "failed", message: `Unexpected Manager mode: ${String(mode)}` };
    },
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "out.mjs"), "export {};\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async () => ({
      outcome: "success",
      report_valid: true,
      report: { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } },
    }),
    runAdvisor: async () => ({ reply: "" }),
    runCurator: async () => ({ ok: false, error: "curator_unavailable" }),
  };

  // dataDir and the web output live in their own temp directory; the Core's root and DB are created (and cleaned up) by createTestCore.
  // t.after hooks run in registration order, so its removal is deferred until after Core.stop (registered by createTestCore below).
  const lateCleanups = [];
  const parent = await tempDir({ after: (fn) => lateCleanups.push(fn) }, "owl-work-completion-learning-e2e-");
  const dataDir = join(parent, "data");
  const webOut = join(parent, "web-out");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(webOut, { recursive: true })]);
  await writeFile(join(webOut, "index.html"), "Owl test server");
  const { root: owlRoot, db, core: durableCore } = await createTestCore(t, {
    agentRunner: withNecessity(agentRunner),
    dataDir,
    skillCuratorDebounceMs: 25,
    dispatcher: { tick_interval_ms: 25 },
  }, { prefix: "owl-work-completion-learning-e2e-", start: true });
  t.after(() => Promise.all(lateCleanups.map((cleanup) => cleanup())));
  const token = randomBytes(32).toString("hex");
  const core = new ExternalCoreAdapter(durableCore, db, owlRoot, dataDir);
  const api = await startTestHttpServer(t, { core, db, webOut, owlRoot, dataDir }, { token });
  if (!api) return t.skip("localhost listen is unavailable");

  const get = async (path) => {
    const response = await api.request("GET", `${apiRoot}${path}`);
    assert.equal(response.status, 200, `GET ${path} should succeed`);
    return response.json();
  };
  const post = async (path, payload, expectedVersion = 0) => {
    const response = await api.request("POST", `${apiRoot}${path}`, command(payload, createUlid(), expectedVersion));
    if (response.status < 200 || response.status >= 300) {
      assert.fail(`POST ${path} returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };

  const rulesDir = join(owlRoot, "rules");
  // Earlier reviewed Tasks of one type that mostly failed their first review, with thresholds from settings.
  const seedWork = (await post("/works", { title: "Seed metrics", summary: "", size: "small", project_id: null })).data.work_id;
  const seededAt = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("PRAGMA ignore_check_constraints = ON");
    const owner = tx.get("SELECT id FROM owners LIMIT 1").id;
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('learning_metrics', ?, '1', ?, ?)",
      owner, JSON.stringify({ enabled: true, min_tasks: 3, first_review_pass_rate_below: 0.5 }), seededAt);
    for (let index = 0; index < 3; index += 1) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
         VALUES (?, ?, 'seed', 'research', 'completed', 'normal', '', '', ?, ?)`, `seed-${index}`, seedWork, seededAt, seededAt);
      tx.run(
        `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
         VALUES (?, ?, 0, 'fix_required', '[]', '{}', ?)`, `seed-review-${index}`, `seed-${index}`, seededAt);
    }
    tx.run("PRAGMA ignore_check_constraints = OFF");
    return null;
  });
  const rulesBefore = await rulesSnapshot(rulesDir);
  const createdResponse = await post("/works", {
    title: "End to end Work completion learning",
    summary: "Exercise Final Manager learning outputs in temporary directories.",
    size: "normal",
    project_id: null,
  });
  const workId = createdResponse.data.work_id;
  assert.match(workId, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  await post(`/works/${workId}/start`, { mode: "normal" }, createdResponse.version);

  const completedWork = await waitUntil(
    async () => (await get(`/works/${workId}`)).data,
    (work) => work.state === "completed",
    `Work ${workId} completion`,
  );
  assert.equal(completedWork.state, "completed");

  // One source leaves a proposal pending; a second Work with the same lessons adds the second source that sends it to the Owner.
  const secondResponse = await post("/works", { title: "Second Work with the same lessons", summary: "Repeat the lessons.", size: "normal", project_id: null });
  const secondWorkId = secondResponse.data.work_id;
  await post(`/works/${secondWorkId}/start`, { mode: "normal" }, secondResponse.version);
  await waitUntil(
    async () => (await get(`/works/${secondWorkId}`)).data,
    (work) => work.state === "completed",
    `Work ${secondWorkId} completion`,
  );

  const outputs = await waitUntil(async () => {
    const [jobs, works, policies, skills, rules, pending] = await Promise.all([
      get("/learning-jobs?status=done"),
      get("/knowledge?folder=works"),
      get("/knowledge?folder=policies"),
      get("/skill-proposals"),
      get("/rule-proposals?status=awaiting_approval"),
      get("/rule-proposals?status=pending"),
    ]);
    return {
      job: jobs.data.find((item) => item.work_id === workId),
      works: works.data,
      policies: policies.data,
      skills: skills.data.filter((item) => item.source_work_id === workId),
      rules: rules.data.filter((item) => item.source_work_ids?.includes(workId)),
      // A metrics proposal's source is the aggregate, not this Work, so it has one source and stays pending.
      metrics: pending.data.filter((item) => item.origin === "metrics"),
    };
  }, (value) => value.job?.status === "done"
    && value.works.length >= 1
    && value.skills.length >= 1
    && value.rules.length >= 2
    && value.metrics.length >= 1,
  `learning outputs for Work ${workId}`);

  assert.equal(outputs.job.status, "done");
  assert.equal(outputs.skills.length, 1);
  assert.equal(outputs.rules.length, 2, "two lesson proposals backed by both Works");
  assert.equal(outputs.metrics.length, 1, "one pending proposal from Runtime metrics");
  const metricsProposal = outputs.metrics[0];
  assert.equal(metricsProposal.status, "pending", "a metrics proposal with one source is not yet with the Owner");
  assert.equal(metricsProposal.applies_to, "research");
  assert.equal(outputs.works.length, 2, "one Work log page per Work");
  assert.deepEqual(outputs.policies, [], "rule candidates must not be saved as legacy knowledge/policies files");
  const noteDetails = await Promise.all(outputs.works.map(async (note) => (await get(`/knowledge/${encodeURIComponent(note.path)}`)).data));
  const sourcedNotes = noteDetails.filter((note) => note.body.includes("End to end Work completion learning"));
  assert.ok(sourcedNotes.length >= 1, "the Work log page returned by the knowledge API must name the Work");
  assert.equal(outputs.rules.every((proposal) => proposal.status === "awaiting_approval"), true);

  const rulesAfterCompletion = await rulesSnapshot(rulesDir);
  assert.deepEqual(rulesAfterCompletion, rulesBefore, "completing Work and creating proposals must not write rules automatically");

  const systemProposal = outputs.rules.find((proposal) => proposal.level === "system");
  const workerProposal = outputs.rules.find((proposal) => proposal.level === "role" && proposal.role === "worker" && proposal.origin !== "metrics");
  assert.ok(systemProposal);
  assert.ok(workerProposal);

  const approvedResponse = await post(`/rule-proposals/${systemProposal.id}/approve`, {});
  assert.equal(approvedResponse.data.status, "applied");
  assert.equal(approvedResponse.data.proposal_id, systemProposal.id);
  const rulesAfterApproval = await rulesSnapshot(rulesDir);
  assert.notDeepEqual(rulesAfterApproval, rulesAfterCompletion);
  assert.ok(rulesAfterApproval.some(([path]) => path === "system/owl-approved.yaml"));
  assert.ok(await readFile(approvedResponse.data.applied_path, "utf8"));
  assert.ok(durableCore.ruleStore.getInstructionsForRole("worker").includes(`[system] ${systemProposal.text}`));

  const rejectedResponse = await post(`/rule-proposals/${workerProposal.id}/reject`, {});
  assert.equal(rejectedResponse.data.status, "rejected");
  const rulesAfterRejection = await rulesSnapshot(rulesDir);
  assert.deepEqual(rulesAfterRejection, rulesAfterApproval, "rejecting a proposal must not change rules");
  assert.equal((await get("/rule-proposals?status=pending")).data.some((proposal) => proposal.id === metricsProposal.id), true, "the metrics proposal is still not applied");
  const rejectedList = await get("/rule-proposals?status=rejected");
  assert.equal(rejectedList.data.some((proposal) => proposal.id === workerProposal.id), true);
  t.diagnostic(JSON.stringify({
    work: { id: workId, status: completedWork.state },
    learning_job: { id: outputs.job.id, status: outputs.job.status },
    pages: sourcedNotes.map((note) => ({ path: note.path, status: "source_recorded" })),
    skill_proposals: outputs.skills.map((proposal) => ({ id: proposal.id, status: proposal.status })),
    rule_proposals: [
      { id: systemProposal.id, status: approvedResponse.data.status },
      { id: workerProposal.id, status: rejectedResponse.data.status },
    ],
    rules_sha256: {
      before_work_and_after_completion: rulesBefore,
      after_approval: rulesAfterApproval,
      after_rejection: rulesAfterRejection,
    },
  }));
});
