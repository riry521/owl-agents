import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { Core } from "../packages/core/dist/index.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";

const apiRoot = "/api/v1";
const migrations = join(resolve(new URL("..", import.meta.url).pathname), "packages/db/migrations");

function command(payload, suffix = createUlid(), expectedVersion = 0) {
  return {
    request_id: createUlid(),
    idempotency_key: `learning-e2e:${suffix}`,
    expected_version: expectedVersion,
    payload,
  };
}

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

async function waitFor(read, accept, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.fail(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

test("completed Work learning flows through HTTP proposals and applies rules only after approval", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "owl-work-completion-learning-e2e-"));
  const owlRoot = join(parent, "owl-root");
  const dataDir = join(parent, "data");
  const webOut = join(parent, "web-out");
  await Promise.all([
    mkdir(owlRoot, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
    mkdir(webOut, { recursive: true }),
  ]);
  await writeFile(join(webOut, "index.html"), "Owl test server");

  const db = openDatabase(join(dataDir, "owl.db"));
  db.migrate(migrations);
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
    question_for_manager: null,
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
    runWorker: async (request) => ({ outcome: "success", report_valid: true, report: workerReport(request.invocation_id) }),
    runReviewer: async () => ({
      outcome: "success",
      report_valid: true,
      report: { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } },
    }),
    runAdvisor: async () => ({ reply: "" }),
    runCurator: async () => ({ ok: false, error: "curator_unavailable" }),
  };

  const durableCore = new Core({
    db,
    agentRunner,
    version: "test",
    owlRoot,
    dataDir,
    skillCuratorDebounceMs: 25,
    dispatcher: { tick_interval_ms: 25 },
  });
  const token = randomBytes(32).toString("hex");
  const previousToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = token;
  const core = new ExternalCoreAdapter(durableCore, db, owlRoot, dataDir);
  const http = createOwlHttpServer({
    core,
    db,
    webOut,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot,
    dataDir,
  });
  t.after(async () => {
    await http.close().catch(() => undefined);
    await durableCore.stop({ force: true }).catch(() => undefined);
    db.close();
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
    await rm(parent, { recursive: true, force: true });
  });
  await durableCore.start();
  await http.listen();

  const origin = `http://127.0.0.1:${http.server.address().port}${apiRoot}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async (path) => {
    const response = await fetch(`${origin}${path}`, { headers });
    assert.equal(response.status, 200, `GET ${path} should succeed`);
    return response.json();
  };
  const post = async (path, payload, expectedVersion = 0) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(command(payload, createUlid(), expectedVersion)),
    });
    if (response.status < 200 || response.status >= 300) {
      assert.fail(`POST ${path} returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };

  const rulesDir = join(owlRoot, "rules");
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

  const completedWork = await waitFor(
    async () => (await get(`/works/${workId}`)).data,
    (work) => work.state === "completed",
    `Work ${workId} completion`,
  );
  assert.equal(completedWork.state, "completed");

  const outputs = await waitFor(async () => {
    const [jobs, notes, works, policies, skills, rules] = await Promise.all([
      get("/learning-jobs?status=done"),
      get("/knowledge?folder=notes"),
      get("/knowledge?folder=works"),
      get("/knowledge?folder=policies"),
      get("/skill-proposals"),
      get("/rule-proposals?status=awaiting_approval"),
    ]);
    return {
      job: jobs.data.find((item) => item.work_id === workId),
      notes: notes.data,
      works: works.data,
      policies: policies.data,
      skills: skills.data.filter((item) => item.source_work_id === workId),
      rules: rules.data.filter((item) => item.source_work_ids?.includes(workId)),
    };
  }, (value) => value.job?.status === "done"
    && value.notes.length >= 1
    && value.skills.length >= 1
    && value.rules.length >= 2,
  `learning outputs for Work ${workId}`);

  assert.equal(outputs.job.status, "done");
  assert.equal(outputs.skills.length, 1);
  assert.equal(outputs.rules.length, 2);
  assert.deepEqual(outputs.works, [], "Work lessons must not be saved as legacy knowledge/works files");
  assert.deepEqual(outputs.policies, [], "rule candidates must not be saved as legacy knowledge/policies files");
  const noteDetails = await Promise.all(outputs.notes.map(async (note) => (await get(`/knowledge/${encodeURIComponent(note.path)}`)).data));
  const sourcedNotes = noteDetails.filter((note) => note.body.includes(workId));
  assert.ok(sourcedNotes.length >= 1, "a note returned by the knowledge API must include the source Work ID");
  assert.equal(outputs.rules.every((proposal) => proposal.status === "awaiting_approval"), true);

  const rulesAfterCompletion = await rulesSnapshot(rulesDir);
  assert.deepEqual(rulesAfterCompletion, rulesBefore, "completing Work and creating proposals must not write rules automatically");

  const systemProposal = outputs.rules.find((proposal) => proposal.level === "system");
  const workerProposal = outputs.rules.find((proposal) => proposal.level === "role" && proposal.role === "worker");
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
  const rejectedList = await get("/rule-proposals?status=rejected");
  assert.equal(rejectedList.data.some((proposal) => proposal.id === workerProposal.id), true);
  t.diagnostic(JSON.stringify({
    work: { id: workId, status: completedWork.state },
    learning_job: { id: outputs.job.id, status: outputs.job.status },
    notes: sourcedNotes.map((note) => ({ id: note.note_id, status: "source_recorded" })),
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
