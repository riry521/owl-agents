import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { writeFile } from "node:fs/promises";
import { createConfiguredCore, ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { normalizeWorkDetailData } from "../../apps/web/lib/work-detail-safety.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { createStubTestRunner, openTestRunCore, plannedTask, workerReport } from "../helpers/test-run-core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";
const sizes = ["small", "normal", "large"];
const workTypesSource = readFileSync(join(repoRoot, "apps/server/src/types.ts"), "utf8");
const workStateDeclaration = workTypesSource.match(/export type WorkState =([\s\S]*?);/);
assert.ok(workStateDeclaration, "apps/server/src/types.ts should declare WorkState");
const workStates = [...workStateDeclaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert.ok(workStates.length > 0, "WorkState should declare at least one known state");
const contractSchemas = {
  "common.json": JSON.parse(readFileSync(join(repoRoot, "contracts/jsonschema/owl-v1/common.json"), "utf8")),
  "work-detail.json": JSON.parse(readFileSync(join(repoRoot, "contracts/jsonschema/owl-v1/work-detail.json"), "utf8")),
};
const taskStates = [
  "waiting",
  "ready",
  "running",
  "verifying",
  "review_fix_waiting",
  "failed",
  "judgement_waiting",
  "completed",
  "paused",
  "cancelled",
];

function commandEnvelope(payload, label) {
  return {
    request_id: createUlid(),
    idempotency_key: "work-detail-regression:" + label + ":" + createUlid(),
    expected_version: 0,
    payload,
  };
}

function assertPage(body, expectedLength) {
  assert.equal(typeof body.request_id, "string");
  assert.ok(Array.isArray(body.data));
  assert.equal(typeof body.has_more, "boolean");
  assert.ok(body.cursor === null || typeof body.cursor === "string");
  if (expectedLength !== undefined) assert.equal(body.data.length, expectedLength);
}

function assertError(response, body, status, code) {
  assert.equal(response.status, status);
  assert.equal(typeof body.request_id, "string");
  assert.equal(body.error?.code, code);
  assert.equal(typeof body.error?.message, "string");
  assert.equal(typeof body.error?.details, "object");
}

function schemaErrors(value, schema, path = "$", seenRefs = new Set()) {
  const errors = [];
  if (schema.$ref) {
    const [file, fragment] = schema.$ref.split("#");
    const reference = `${file}#${fragment ?? ""}`;
    if (seenRefs.has(reference)) return errors;
    const referencedDocument = contractSchemas[file];
    if (!referencedDocument) return [`${path}: cannot resolve ${schema.$ref}`];
    let referencedSchema = referencedDocument;
    if (fragment) {
      for (const part of fragment.replace(/^\//, "").split("/")) {
        const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
        referencedSchema = referencedSchema?.[key];
      }
    }
    if (!referencedSchema) return [`${path}: cannot resolve ${schema.$ref}`];
    const nextRefs = new Set(seenRefs).add(reference);
    return schemaErrors(value, referencedSchema, path, nextRefs);
  }

  if (Array.isArray(schema.type)) {
    const typeMatches = {
      object: value !== null && typeof value === "object" && !Array.isArray(value),
      array: Array.isArray(value),
      string: typeof value === "string",
      number: typeof value === "number" && Number.isFinite(value),
      integer: Number.isInteger(value),
      boolean: typeof value === "boolean",
      null: value === null,
    };
    const matchingType = schema.type.find((type) => typeMatches[type]);
    if (!matchingType) return [`${path}: expected ${schema.type.join(" or ")}`];
    return schemaErrors(value, { ...schema, type: matchingType }, path, seenRefs);
  }

  if (schema.anyOf) {
    if (!schema.anyOf.some((candidate) => schemaErrors(value, candidate, path, seenRefs).length === 0)) {
      errors.push(`${path}: does not match any allowed schema`);
    }
    return errors;
  }

  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required property is missing`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], childSchema, `${path}.${key}`, seenRefs));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${path}.${key}: additional property is not allowed`);
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return [`${path}: expected string`];
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) {
      errors.push(`${path}: expected date-time`);
    }
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) return [`${path}: expected integer`];
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${path}: expected number`];
  } else if (schema.type === "null") {
    if (value !== null) return [`${path}: expected null`];
  } else if (schema.type && typeof value !== schema.type) {
    return [`${path}: expected ${schema.type}`];
  }

  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: value is not in the allowed enum`);
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  return errors;
}

function assertMatchesWorkDetailSchema(work, label) {
  const errors = schemaErrors(work, contractSchemas["work-detail.json"]);
  assert.deepEqual(errors, [], `${label} does not match work-detail.json / common.json:\n${errors.join("\n")}`);
}

// Tasks superseded by a replan (cancelled in a Work that goes on) are not counted.
function progressOf(item) {
  const counted = item.state === "cancelled" ? item.tasks : item.tasks.filter((task) => task.status !== "cancelled");
  const completed = counted.filter((task) => task.status === "completed").length;
  return {
    total_tasks: counted.length,
    completed_tasks: completed,
    percent: counted.length === 0 ? 0 : Math.round((completed / counted.length) * 100),
  };
}

function assertFrontendDetailContract(body, expected) {
  assert.equal(typeof body.request_id, "string");
  assert.equal(typeof body.version, "number");
  assert.ok(body.data && typeof body.data === "object" && !Array.isArray(body.data));
  assertMatchesWorkDetailSchema(body.data, `Work ${expected.id}`);

  // getWorkDetail unwraps the REST envelope's `data` field, then normalizes
  // the Work DTO into the aggregate consumed by WorkDetailView. Check both
  // the actual response fields and the frontend's resulting display model.
  for (const field of [
    "id",
    "title",
    "state",
    "state_version",
    "updated_at",
    "owner_id",
    "project_id",
    "summary",
    "size",
    "plan_revision",
    "progress",
  ]) {
    assert.ok(Object.hasOwn(body.data, field), "frontend Work DTO is missing " + field);
  }
  const detail = normalizeWorkDetailData({ work: body.data }, expected.id);
  for (const [field, value] of Object.entries(expected)) {
    if (field === "progress") continue;
    assert.equal(detail.work[field], value, "frontend Work DTO mismatch for " + field);
  }
  assert.deepEqual(body.data.progress, expected.progress, "API progress should match the task data displayed by the frontend");
}

test("Work detail endpoints return valid pages and details for every size and state", async (t) => {
  const root = await tempDir(t, "owl-work-detail-");
  const oldMode = process.env.OWL_CORE_MODE;
  process.env.OWL_CORE_MODE = "external";

  let db;
  let core;
  try {
    db = createTestDatabase(root);
    core = await createConfiguredCore({
      db,
      agentRunner: {},
      version: "work-detail-regression",
      owlRoot: root,
      dataDir: root,
    });
    const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root }, { token: "work-detail-regression-token" });
    if (!api) return t.skip("localhost listen is unavailable");

    const base = api.baseUrl + "/api/v1";
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer work-detail-regression-token",
    };
    const request = async (path, init = {}) => {
      const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        assert.fail("Expected a JSON response from " + path + ", got: " + text);
      }
      return { response, body };
    };
    const createWork = async (
      size,
      label,
      title = "Work detail regression " + label,
      summary = "Checks the detail API response shape.",
    ) => {
      const result = await request("/works", {
        method: "POST",
        body: JSON.stringify(commandEnvelope({
          title,
          summary,
          size,
          project_id: null,
        }, label)),
      });
      assert.equal(result.response.status, 201);
      assert.equal(typeof result.body.data?.work_id, "string");
      return result.body.data.work_id;
    };

    // Brand-new Works have no Tasks, Agent runs, or Decisions yet.
    for (const size of sizes) {
      const label = "empty-" + size;
      const workId = await createWork(size, label);
      const work = await request("/works/" + workId);
      assert.equal(work.response.status, 200);
      assert.equal(work.body.data.id, workId);
      assert.equal(work.body.data.title, "Work detail regression " + label);
      assert.equal(work.body.data.summary, "Checks the detail API response shape.");
      assert.equal(work.body.data.state, "memo");
      assert.equal(work.body.data.size, size);
      assert.equal(work.body.data.project_id, null);
      assert.equal(work.body.version, work.body.data.state_version);
      assertFrontendDetailContract(work.body, {
        id: workId,
        title: "Work detail regression " + label,
        summary: "Checks the detail API response shape.",
        state: "memo",
        size,
        project_id: null,
        progress: { total_tasks: 0, completed_tasks: 0, percent: 0 },
      });

      const tasks = await request("/works/" + workId + "/tasks?limit=200");
      assert.equal(tasks.response.status, 200);
      assertPage(tasks.body, 0);
      assert.equal(tasks.body.cursor, null);
      assert.equal(tasks.body.has_more, false);

      const agents = await request("/agents?work_id=" + workId + "&limit=200");
      assert.equal(agents.response.status, 200);
      assertPage(agents.body, 0);
      assert.equal(agents.body.cursor, null);
      assert.equal(agents.body.has_more, false);
    }

    const slackWorkTitle = "Slack返信をSlack mrkdwn記法で出力する";
    const slackWorkSummary = "Render the reply using Slack mrkdwn.";
    const slackWorkId = await createWork("normal", "slack-mrkdwn", slackWorkTitle, slackWorkSummary);
    const slackWork = await request("/works/" + slackWorkId);
    assert.equal(slackWork.response.status, 200);
    assertFrontendDetailContract(slackWork.body, {
      id: slackWorkId,
      title: slackWorkTitle,
      summary: slackWorkSummary,
      state: "memo",
      size: "normal",
      project_id: null,
      progress: { total_tasks: 0, completed_tasks: 0, percent: 0 },
    });

    for (const status of ["open", "resolved", "cancelled"]) {
      const decisions = await request("/decisions?status=" + status + "&limit=200");
      assert.equal(decisions.response.status, 200);
      assertPage(decisions.body, 0);
      assert.equal(decisions.body.cursor, null);
      assert.equal(decisions.body.has_more, false);
    }

    const cases = [];
    for (const size of sizes) {
      for (const state of workStates) {
        const label = size + "-" + state;
        const workId = await createWork(size, label);
        cases.push({ size, state, workId, title: "Work detail regression " + label, tasks: [] });
      }
    }

    const now = new Date().toISOString();
    await db.createWriteLane().transact((transaction) => {
      for (const item of cases) {
        transaction.run(
          "UPDATE works SET state = ?, state_version = 2, updated_at = ? WHERE id = ?",
          item.state,
          now,
          item.workId,
        );
      }
    });

    // Check each code-declared status while these API-created Works still
    // have no Tasks. This locks in the empty-detail response for every size
    // and status, including its zero progress and contract shape.
    for (const item of cases) {
      const work = await request("/works/" + item.workId);
      assert.equal(work.response.status, 200);
      assert.equal(work.body.data.id, item.workId);
      assert.equal(work.body.data.title, item.title);
      assert.equal(work.body.data.summary, "Checks the detail API response shape.");
      assert.equal(work.body.data.state, item.state);
      assert.equal(work.body.data.size, item.size);
      assert.deepEqual(work.body.data.progress, { total_tasks: 0, completed_tasks: 0, percent: 0 });
      assertFrontendDetailContract(work.body, {
        id: item.workId,
        title: item.title,
        summary: "Checks the detail API response shape.",
        state: item.state,
        size: item.size,
        progress: { total_tasks: 0, completed_tasks: 0, percent: 0 },
      });
    }

    const insertTasks = [];
    for (const item of cases) {
      const fixtureStates = item.size === "large" && item.state === "running"
        ? [...taskStates, ...Array.from({ length: 195 }, () => "ready")]
        : taskStates;
      insertTasks.push(...fixtureStates.map((status, index) => {
        const task = {
          id: createUlid(),
          workId: item.workId,
          title: "Task " + status + " " + index,
          status,
          createdAt: now,
        };
        item.tasks.push(task);
        return task;
      }));
    }

    await db.createWriteLane().transact((transaction) => {
      for (const task of insertTasks) {
        transaction.run(
          [
            "INSERT INTO tasks (",
            "id, work_id, parent_task_id, title, type, status, review_override, priority,",
            "context, acceptance, state_version, failure_count, same_error_count,",
            "last_error_key, last_error_generation, review_round, worker_generation,",
            "worktree_path, worktree_state, last_failure_class, paused_from, cancel_reason,",
            "created_at, updated_at",
            ") VALUES (?, ?, NULL, ?, 'code', ?, NULL, 'normal', '', ?, 3, 0, 0,",
            "NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)",
          ].join(" "),
          task.id,
          task.workId,
          task.title,
          task.status,
          "Regression acceptance criteria for " + task.status,
          task.createdAt,
          task.createdAt,
        );
      }
    });

    for (const item of cases) {
      const work = await request("/works/" + item.workId);
      assert.equal(work.response.status, 200);
      assert.equal(work.body.data.id, item.workId);
      assert.equal(work.body.data.state, item.state);
      assert.equal(work.body.data.size, item.size);
      assert.equal(work.body.data.state_version, 2);
      assert.equal(work.body.version, 2);
      assert.equal(work.body.data.title, item.title);
      assert.equal(typeof work.body.data.updated_at, "string");
      assert.equal(typeof work.body.data.owner_id, "string");
      assert.equal(work.body.data.summary, "Checks the detail API response shape.");
      assert.equal(typeof work.body.data.plan_revision, "number");
      assertFrontendDetailContract(work.body, {
        id: item.workId,
        title: item.title,
        summary: "Checks the detail API response shape.",
        state: item.state,
        size: item.size,
        progress: progressOf(item),
      });

      let cursor = null;
      const listedTasks = [];
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (cursor !== null) query.set("cursor", cursor);
        const page = await request("/works/" + item.workId + "/tasks?" + query.toString());
        assert.equal(page.response.status, 200);
        assertPage(page.body);
        listedTasks.push(...page.body.data);
        cursor = page.body.has_more ? page.body.cursor : null;
        if (page.body.has_more) assert.ok(cursor, "has_more pages must include a cursor");
      } while (cursor !== null);
      assert.equal(listedTasks.length, item.tasks.length);
      assert.deepEqual(new Set(listedTasks.map((task) => task.status)), new Set(taskStates));

      const agents = await request("/agents?work_id=" + item.workId + "&limit=200");
      assert.equal(agents.response.status, 200);
      assertPage(agents.body, 0);
      assert.equal(agents.body.has_more, false);

      const taskDetails = [];
      for (let offset = 0; offset < item.tasks.length; offset += 25) {
        const batch = await Promise.all(item.tasks.slice(offset, offset + 25).map(async (task) => {
          const result = await request("/tasks/" + task.id + "?include_report=true");
          assert.equal(result.response.status, 200, "task detail failed for " + task.status);
          assert.equal(typeof result.body.request_id, "string");
          assert.equal(result.body.data.id, task.id);
          assert.equal(result.body.data.work_id, item.workId);
          assert.equal(result.body.data.status, task.status);
          assert.equal(result.body.data.type, "code");
          assert.equal(result.body.data.parent_task_id, null);
          assert.equal(typeof result.body.data.acceptance, "string");
          assert.equal(typeof result.body.data.review_round, "number");
          assert.equal(typeof result.body.data.failure_count, "number");
          assert.equal(typeof result.body.data.worker_generation, "number");
          assert.equal(result.body.version, result.body.data.state_version);
          assert.ok(Object.hasOwn(result.body, "report"));
          assert.equal(result.body.report, null);
          return result.body.data.status;
        }));
        taskDetails.push(...batch);
      }
      assert.equal(taskDetails.length, item.tasks.length);
    }

    const missingWorkId = createUlid();
    const missingTaskId = createUlid();
    const missingWork = await request("/works/" + missingWorkId);
    assertError(missingWork.response, missingWork.body, 404, "work_not_found");
    assert.match(missingWork.response.headers.get("content-type") ?? "", /application\/json/u);
    const missingWorkTasks = await request("/works/" + missingWorkId + "/tasks?limit=200");
    assertError(missingWorkTasks.response, missingWorkTasks.body, 404, "work_not_found");
    const missingTask = await request("/tasks/" + missingTaskId + "?include_report=true");
    assertError(missingTask.response, missingTask.body, 404, "task_not_found");
  } finally {
    if (core) {
      await core.shutdown({ force: true, timeoutMs: 1000 }).catch(() => {});
    } else if (db) {
      db.close();
    }
    if (oldMode === undefined) delete process.env.OWL_CORE_MODE;
    else process.env.OWL_CORE_MODE = oldMode;
  }
});

// ---- GET /works/:id/core-activity ----

// Prints every 50ms inside the Work's integration worktree until the gate file exists; elsewhere it exits at once.
const GATED_CHECK = "const { existsSync } = require('node:fs');"
  + "if (!process.cwd().includes('__work__') || existsSync(process.argv[1])) process.exit(0);"
  + "const timer = setInterval(() => { if (existsSync(process.argv[1])) { clearInterval(timer); } else console.log('still running'); }, 50);";

test("core-activity lists the running step with its command and output time, and is empty once it ends", async (t) => {
  const root = await tempDir(t, "owl-core-activity-");
  const gate = join(root, "gate");
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? { outcome: "success", report_valid: true, report: { tasks: [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
      : { outcome: "success", report_valid: true, report: { event: "work.planned", tasks: [plannedTask("T1")] } },
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "src/a.mjs"), "export const a = 2;\n");
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id, ["src/a.mjs"]) };
    },
    runReviewer: async (request) => ({ outcome: "success", report_valid: true, report: { kind: "review", invocation_id: request.invocation_id }, review: { verdict: "pass", findings: [], tests: {} } }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { run } = createStubTestRunner(() => false);
  const projectCheckArgv = [process.execPath, "-e", GATED_CHECK, gate];
  const { db, core, projectId, envelope } = await openTestRunCore(t, { agentRunner, runner: run, prefix: "owl-core-activity-core-", projectCheckArgv });
  const adapter = new ExternalCoreAdapter(core, db, root, root);
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root }, { token: "core-activity-token" });
  if (!api) return t.skip("localhost listen is unavailable");
  const activity = async (workId) => {
    const response = await fetch(api.baseUrl + "/api/v1/works/" + workId + "/core-activity", { headers: { authorization: "Bearer core-activity-token" } });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };

  const created = await core.createWork(envelope({ title: "Activity API", summary: "x", size: "normal", project_id: projectId }, "work"));
  const workId = created.data.work_id;
  await core.startWork(workId, { ...envelope({ mode: "normal" }, "start"), expected_version: created.version });

  let first = null;
  await waitFor(async () => {
    first = (await activity(workId)).activities.find((entry) => entry.kind === "integration_verification" && entry.last_output_at !== null) ?? null;
    return first !== null;
  }, { timeoutMs: 60_000, message: "the integration verification to print" });
  assert.deepEqual(Object.keys(first).sort(), ["activity_id", "command", "kind", "last_output_at", "started_at"]);
  assert.deepEqual(first.command, projectCheckArgv);
  assert.ok(Date.parse(first.started_at) <= Date.parse(first.last_output_at));
  await waitFor(async () => (await activity(workId)).activities.some((entry) => entry.activity_id === first.activity_id && entry.last_output_at !== first.last_output_at), { timeoutMs: 10_000, message: "last_output_at to advance" });

  await writeFile(gate, "go\n");
  await waitFor(() => workState(db, workId) === "completed", { timeoutMs: 60_000, message: "the Work to complete" });
  assert.deepEqual(await activity(workId), { work_id: workId, activities: [] });
});

test("core-activity answers with an empty list from the in-memory Core too", async (t) => {
  const root = await tempDir(t, "owl-core-activity-memory-");
  const oldMode = process.env.OWL_CORE_MODE;
  process.env.OWL_CORE_MODE = "standalone";
  t.after(() => { if (oldMode === undefined) delete process.env.OWL_CORE_MODE; else process.env.OWL_CORE_MODE = oldMode; });
  const db = createTestDatabase(root);
  const core = await createConfiguredCore({ db, agentRunner: {}, version: "core-activity", owlRoot: root, dataDir: root });
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root }, { token: "core-activity-token" });
  if (!api) return t.skip("localhost listen is unavailable");
  const workId = createUlid();
  const response = await fetch(api.baseUrl + "/api/v1/works/" + workId + "/core-activity", { headers: { authorization: "Bearer core-activity-token" } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { work_id: workId, activities: [] });
});

const workState = (db, workId) => db.get("SELECT state FROM works WHERE id = ?", workId).state;
