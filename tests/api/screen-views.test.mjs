import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_SCREEN_VIEW_LIMITS } from "../../apps/server/dist/http.js";
import { ExternalCoreAdapter, createCore as createMemoryCore } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { repoRoot } from "../helpers/paths.mjs";

const token = "screen-views-token";
const schemaDir = join(repoRoot, "contracts/jsonschema/owl-v1");
const schemas = new Map();
const loadSchema = (file) => {
  if (!schemas.has(file)) schemas.set(file, JSON.parse(readFileSync(join(schemaDir, file), "utf8")));
  return schemas.get(file);
};

/** Minimal validator for the keywords the view schemas use: $ref, type, required, properties, items. */
function schemaErrors(value, schema, path = "$") {
  if (schema.$ref) {
    const [file, fragment] = schema.$ref.split("#");
    let target = loadSchema(file);
    for (const part of (fragment ?? "").split("/").filter(Boolean)) target = target?.[part];
    return target ? schemaErrors(value, target, path) : [`${path}: cannot resolve ${schema.$ref}`];
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types.length > 0 && !types.some((type) => type === kindOf(value) || (type === "number" && typeof value === "number"))) {
    return [`${path}: expected ${types.join("|")}`];
  }
  const errors = [];
  if (kindOf(value) === "object") {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], child, `${path}.${key}`));
    }
  }
  if (kindOf(value) === "array" && schema.items) value.forEach((item, i) => errors.push(...schemaErrors(item, schema.items, `${path}[${i}]`)));
  return errors;
}

function seed(db) {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 1000).toISOString();
  const ids = { workA: createUlid(), workB: createUlid() };
  ids.taskA = createUlid();
  ids.taskASuperseded = createUlid();
  ids.taskB = createUlid();
  ids.runOld = createUlid();
  ids.runNew = createUlid();
  ids.runB = createUlid();
  ids.reportOld = createUlid();
  ids.reportNew = createUlid();
  ids.reportB = createUlid();
  ids.decisionAOpen = createUlid();
  ids.decisionAResolved = createUlid();
  ids.decisionBOpen = createUlid();
  db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    for (const [id, title] of [[ids.workA, "Work A"], [ids.workB, "Work B"]]) {
      tx.run(
        `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
         VALUES (?, 'owner:default', NULL, ?, '', 'normal', 'running', '[]', '[]', ?, ?)`,
        id, title, now, now,
      );
    }
    for (const [id, workId, superseded] of [[ids.taskA, ids.workA, null], [ids.taskASuperseded, ids.workA, now], [ids.taskB, ids.workB, null]]) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, superseded_at, created_at, updated_at)
         VALUES (?, ?, 'Task', 'code', 'running', 'normal', '', '', ?, ?, ?)`,
        id, workId, superseded, now, now,
      );
    }
    for (const [id, workId, taskId] of [[ids.runOld, ids.workA, ids.taskA], [ids.runNew, ids.workA, ids.taskA], [ids.runB, ids.workB, ids.taskB]]) {
      tx.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
         VALUES (?, ?, ?, 'worker', 'claude', 'test-model', 'completed', ?, ?)`,
        id, workId, taskId, now, now,
      );
    }
    for (const [id, runId, summary, at] of [[ids.reportOld, ids.runOld, "old", now], [ids.reportNew, ids.runNew, "new", later], [ids.reportB, ids.runB, "other work", later]]) {
      tx.run(
        `INSERT INTO reports (id, agent_run_id, schema_version, result, payload_json, raw_response_sha256, raw_response_bytes, created_at)
         VALUES (?, ?, '1', 'success', ?, ?, 0, ?)`,
        id, runId, JSON.stringify({ kind: "report", work_done: summary }), "0".repeat(64), at,
      );
    }
    for (const [id, workId, status, blocked] of [
      [ids.decisionAOpen, ids.workA, "open", [ids.taskA, ids.taskASuperseded]],
      [ids.decisionAResolved, ids.workA, "resolved", []],
      [ids.decisionBOpen, ids.workB, "open", [ids.taskB]],
    ]) {
      tx.run(
        `INSERT INTO decisions
           (id, work_id, scope, status, blocked_task_ids_json, reason, question, tried, current_state, options_json, recommended, allow_free_text, issuer_role, state_version, created_at)
         VALUES (?, ?, 'task', ?, ?, 'r', 'q', 't', 's', '[]', NULL, 1, 'core', 0, ?)`,
        id, workId, status, JSON.stringify(blocked), now,
      );
    }
    return null;
  });
  return ids;
}

async function openApi(t) {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-screen-views-" });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root }, { token });
  if (!api) return null;
  const get = async (route) => {
    const response = await fetch(`${api.baseUrl}/api/v1${route}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  };
  return { db, core, adapter, get, ids: seed(db) };
}

test("GET /works/{id}/view returns only that Work's decisions, the newest report per Task and no superseded Task", async (t) => {
  const api = await openApi(t);
  if (!api) return t.skip("localhost listen is unavailable");
  const { ids } = api;

  const { status, body } = await api.get(`/works/${ids.workA}/view`);
  assert.equal(status, 200);
  assert.equal(typeof body.request_id, "string");
  assert.equal(body.version, body.data.work.state_version);
  assert.deepEqual(body.data.decisions.map((d) => d.id).sort(), [ids.decisionAOpen, ids.decisionAResolved].sort());
  assert.deepEqual(body.data.decisions.map((d) => d.status).sort(), ["open", "resolved"]);
  assert.deepEqual(body.data.reports.map((r) => r.id), [ids.reportNew]);
  assert.equal(body.data.reports[0].task_id, ids.taskA);
  assert.deepEqual(body.data.tasks.map((task) => task.id), [ids.taskA]);
  assert.deepEqual(schemaErrors(body.data, loadSchema("work-view.json")), []);

  assert.equal((await api.get(`/works/${createUlid()}/view`)).status, 404);
});

test("GET /works/{id}/view takes the conversation size from the query", async (t) => {
  const api = await openApi(t);
  if (!api) return t.skip("localhost listen is unavailable");
  const { ids, db } = api;
  const now = new Date().toISOString();
  const conversationId = createUlid();
  const accountId = createUlid();
  db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, 'owner:default', ?, 'web', 1, ?, ?)`,
      conversationId, ids.workA, now, now,
    );
    tx.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, 'owner:default', 'web', 'web:owner', ?)", accountId, now);
    for (let i = 0; i < 5; i += 1) {
      tx.run(
        `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
         VALUES (?, ?, 'web', ?, ?, 'hello', '[]', ?, ?)`,
        createUlid(), conversationId, accountId, `src-${i}`, now, now,
      );
    }
    return null;
  });
  const small = await api.get(`/works/${ids.workA}/view?conversation_limit=2`);
  assert.equal(small.status, 200);
  assert.ok(small.body.data.conversation.messages.length <= 2);
  const normal = await api.get(`/works/${ids.workA}/view`);
  assert.equal(normal.body.data.conversation.messages.length, 5);
});

test("GET /decisions/{id}/view returns the decision, its Work and blocked Tasks including superseded ones", async (t) => {
  const api = await openApi(t);
  if (!api) return t.skip("localhost listen is unavailable");
  const { ids } = api;

  const { status, body } = await api.get(`/decisions/${ids.decisionAOpen}/view`);
  assert.equal(status, 200);
  assert.equal(body.version, body.data.decision.state_version);
  assert.equal(body.data.decision.id, ids.decisionAOpen);
  assert.equal(body.data.work.id, ids.workA);
  assert.deepEqual(body.data.blocked_tasks.map((task) => task.id).sort(), [ids.taskA, ids.taskASuperseded].sort());
  assert.deepEqual(schemaErrors(body.data, loadSchema("decision-view.json")), []);

  assert.equal((await api.get(`/decisions/${createUlid()}/view`)).status, 404);

  const open = await api.get("/decisions?status=open");
  assert.deepEqual(open.body.data.map((d) => d.id).sort(), [ids.decisionAOpen, ids.decisionBOpen].sort());
});

test("every view route answers 503 dependency_unavailable on a Core without view methods", async (t) => {
  const previous = process.env.OWL_API_TOKEN;
  delete process.env.OWL_API_TOKEN;
  t.after(() => {
    if (previous !== undefined) process.env.OWL_API_TOKEN = previous;
  });
  const root = await tempDir(t, "owl-screen-views-memory-");
  const api = await startTestHttpServer(t, { core: createMemoryCore({ version: "1.0.0" }), owlRoot: root, webOut: root });
  if (!api) return t.skip("localhost listen is unavailable");
  const routes = [
    `/works/${createUlid()}/view`, `/decisions/${createUlid()}/view`, "/board/view", "/backlog/linkable-works?project_id=x",
    "/backlog/view", "/tokens/view", "/settings/view",
  ];
  for (const route of routes) {
    const response = await fetch(`${api.baseUrl}/api/v1${route}`);
    assert.equal(response.status, 503, route);
    assert.equal((await response.json()).error.code, "dependency_unavailable");
  }
});

const insertWork = (tx, { id = createUlid(), projectId = null, state = "running", updatedAt, archivedAt = null }) => {
  tx.run(
    `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at, archived_at)
     VALUES (?, 'owner:default', ?, ?, '', 'normal', ?, '[]', '[]', ?, ?, ?)`,
    id, projectId, `Work ${id}`, state, updatedAt, updatedAt, archivedAt,
  );
  return id;
};

const timeAt = (offset) => new Date(Date.now() + offset).toISOString();

test("GET /board/view pages Works with next_cursor, keeps open decisions on the first page and rejects archived=include", async (t) => {
  const api = await openApi(t);
  if (!api) return t.skip("localhost listen is unavailable");
  const { ids, db } = api;
  const archived = await db.createWriteLane().transact((tx) => [
    insertWork(tx, { updatedAt: timeAt(0), archivedAt: timeAt(1000) }),
    insertWork(tx, { updatedAt: timeAt(0), archivedAt: timeAt(2000) }),
  ]);

  const first = await api.get("/board/view?limit=1");
  assert.equal(first.status, 200);
  assert.equal(first.body.data.works.length, 1);
  assert.equal(typeof first.body.data.next_cursor, "string");
  assert.deepEqual(first.body.data.open_decisions.map((d) => d.id).sort(), [ids.decisionAOpen, ids.decisionBOpen].sort());
  assert.ok(Array.isArray(first.body.data.projects));
  assert.deepEqual(schemaErrors(first.body.data, loadSchema("board-view.json")), []);

  const second = await api.get(`/board/view?limit=1&cursor=${first.body.data.next_cursor}`);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.next_cursor, null);
  assert.deepEqual(second.body.data.open_decisions, []);
  const seen = [...first.body.data.works, ...second.body.data.works].map((w) => w.id);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...seen].sort(), [ids.workA, ids.workB].sort());

  const onlyFirst = await api.get("/board/view?archived=only&limit=1");
  assert.equal(onlyFirst.status, 200);
  assert.deepEqual(onlyFirst.body.data.open_decisions, []);
  assert.equal(typeof onlyFirst.body.data.next_cursor, "string");
  const onlySecond = await api.get(`/board/view?archived=only&limit=1&cursor=${onlyFirst.body.data.next_cursor}`);
  assert.equal(onlySecond.body.data.next_cursor, null);
  assert.deepEqual([onlyFirst.body.data.works[0].id, onlySecond.body.data.works[0].id], [archived[1], archived[0]], "newest archived first, no overlap");

  assert.equal((await api.get("/board/view?archived=include")).status, 400);
  assert.equal((await api.get("/board/view?limit=0")).status, 400);
  assert.equal((await api.get("/board/view?cursor=not-a-cursor")).status, 400);
});

test("GET /board/view takes its default page size from the server options", async (t) => {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-screen-views-limit-" });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root, screenViewLimits: { boardWorks: 1 } }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  seed(db);
  const response = await fetch(`${api.baseUrl}/api/v1/board/view`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  assert.equal(body.data.works.length, 1);
  assert.equal(typeof body.data.next_cursor, "string");
});

test("board and linkable-works views answer 200 with default page sizes when no limit query or screenViewLimits is given", async (t) => {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-screen-views-default-" });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  seed(db);
  const projectId = createUlid();
  const total =DEFAULT_SCREEN_VIEW_LIMITS.boardWorks + 1;
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'P', ?, 'main', '[]', '[]', '[]', ?, ?)`,
      projectId, `/tmp/${projectId}`, timeAt(0), timeAt(0),
    );
    for (let i = 0; i < total; i += 1) {
      insertWork(tx, { projectId, state: "running", updatedAt: timeAt(i) });
      insertWork(tx, { projectId, state: "completed", updatedAt: timeAt(i), archivedAt: timeAt(i) });
    }
  });
  for (const [route, limit] of [
    ["/board/view", DEFAULT_SCREEN_VIEW_LIMITS.boardWorks],
    ["/board/view?archived=only", DEFAULT_SCREEN_VIEW_LIMITS.boardWorks],
    [`/backlog/linkable-works?project_id=${projectId}`, DEFAULT_SCREEN_VIEW_LIMITS.linkableWorks],
  ]) {
    const response = await fetch(`${api.baseUrl}/api/v1${route}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json();
    assert.equal(response.status, 200, route);
    assert.equal(body.data.works.length, limit, route);
    assert.equal(typeof body.data.next_cursor, "string", route);
  }
});

test("GET /backlog/linkable-works excludes cancelled, puts unfinished first and pages with next_cursor", async (t) => {
  const api = await openApi(t);
  if (!api) return t.skip("localhost listen is unavailable");
  const { db } = api;
  const projectId = createUlid();
  const otherProjectId = createUlid();
  const works = await db.createWriteLane().transact((tx) => {
    for (const id of [projectId, otherProjectId]) {
      tx.run(
        `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
         VALUES (?, 'owner:default', ?, ?, 'main', '[]', '{}', '[]', ?, ?)`,
        id, `P ${id}`, `/tmp/${id}`, timeAt(0), timeAt(0),
      );
    }
    return {
      completed: insertWork(tx, { projectId, state: "completed", updatedAt: timeAt(3000) }),
      running: insertWork(tx, { projectId, state: "running", updatedAt: timeAt(1000) }),
      pausedNewer: insertWork(tx, { projectId, state: "paused", updatedAt: timeAt(2000), archivedAt: timeAt(2500) }),
      cancelled: insertWork(tx, { projectId, state: "cancelled", updatedAt: timeAt(4000) }),
      other: insertWork(tx, { projectId: otherProjectId, state: "running", updatedAt: timeAt(5000) }),
    };
  });
  const expected = [works.pausedNewer, works.running, works.completed];

  const all = await api.get(`/backlog/linkable-works?project_id=${projectId}&limit=10`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.data.works.map((w) => w.id), expected);
  assert.equal(all.body.data.next_cursor, null);
  assert.deepEqual(schemaErrors(all.body.data, loadSchema("linkable-works.json")), []);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await api.get(`/backlog/linkable-works?project_id=${projectId}&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.data.works.length, 1);
    seen.push(page.body.data.works[0].id);
    cursor = page.body.data.next_cursor;
    pages += 1;
  } while (cursor && pages < 10);
  assert.deepEqual(seen, expected);
});

test("backlog, tokens and settings views return what the existing GET routes return and no secret values", async (t) => {
  const api = await openApi(t);
  if (!api) return t.skip("localhost listen is unavailable");
  const secret = "typesafe-secret-value-1234567890";
  await api.adapter.setTypesafeApiKey(secret);
  const data = async (route) => (await api.get(route)).body.data;

  const backlog = await api.get("/backlog/view");
  assert.equal(backlog.status, 200);
  const list = await api.get("/backlog");
  assert.deepEqual(backlog.body.data.items, list.body.data);
  assert.equal(backlog.body.data.next_offset, list.body.next_offset);
  assert.deepEqual(backlog.body.data.projects, await data("/projects"));
  assert.deepEqual(schemaErrors(backlog.body.data, loadSchema("backlog-view.json")), []);

  const tokens = await api.get("/tokens/view?period=30d&top=5");
  assert.equal(tokens.status, 200);
  const withoutUntil = ({ until, ...rest }) => rest; // the report stamps the time it was built
  assert.deepEqual(withoutUntil(tokens.body.data.report), withoutUntil(await data("/token-usage?period=30d&top=5")));
  assert.deepEqual(tokens.body.data.plan_usage_settings, await data("/settings/plan-usage"));
  assert.deepEqual(tokens.body.data.projects, backlog.body.data.projects);
  const withoutGeneratedAt = ({ generated_at, ...rest }) => rest; // plan usage stamps the time it was read
  assert.deepEqual(withoutGeneratedAt(tokens.body.data.plan_usage), withoutGeneratedAt(await data("/plan-usage")));
  assert.deepEqual(schemaErrors(tokens.body.data, loadSchema("tokens-view.json")), []);

  const settings = await api.get("/settings/view");
  assert.equal(settings.status, 200);
  const routes = {
    models: "/settings/models",
    providers: "/settings/providers",
    hybrid: "/settings/hybrid",
    child_runs: "/settings/child-runs",
    language: "/settings/language",
    remake_limits: "/settings/remake-limits",
    knowledge_automation: "/settings/knowledge-automation",
    advisor_persona: "/settings/advisor-persona",
    advisor_folders: "/settings/advisor-folders",
    integrations: "/settings/integrations",
    typesafe: "/settings/typesafe",
    knowledge_storage: "/settings/knowledge-storage",
  };
  for (const [key, route] of Object.entries(routes)) assert.deepEqual(settings.body.data[key], await data(route), key);
  assert.deepEqual(settings.body.data.system_status, (await api.get("/system/status")).body);
  assert.deepEqual(schemaErrors(settings.body.data, loadSchema("settings-view.json")), []);
  assert.ok(!JSON.stringify(settings.body).includes(secret));
  assert.notEqual(settings.body.data.typesafe.typesafe_api_key, "");
});
