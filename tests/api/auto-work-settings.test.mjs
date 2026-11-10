import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { NoopGitGateway } from "../../packages/core/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { FakeClock } from "../helpers/clock.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const apiRoot = "/api/v1/auto-work";
const token = "auto-work-settings-owner-token";
const T0 = new Date(2026, 5, 1, 10, 0, 0);

const worth = { ok: true, judgment: { worth_fixing: true, reason: "直す価値がある", duplicate_of_work_id: null, duplicate_reason: null, work: { title: "自動 Work", summary: "原因を調べて直す", size: "normal" } } };

function signal(projectId, overrides = {}) {
  return {
    source: "failure_notice",
    project_id: projectId,
    kind: "process_failed",
    title: "deploy.sh が失敗した",
    detail: "終了コード 1",
    dedupe: { kind: "id", value: createUlid() },
    occurred_at: T0.toISOString(),
    backlog_item_ids: [],
    github: null,
    failure: null,
    ...overrides,
  };
}

/** A real Core behind the HTTP server, wrapped in ExternalCoreAdapter like production. */
async function startServer(t, { defaults } = {}) {
  const clock = new FakeClock(T0);
  const { root, db, core: durable } = await createTestCore(t, {
    git: new NoopGitGateway(),
    agentRunner: { runAutoWorkJudgment: async () => worth },
    autoWork: { clock },
  }, { prefix: "owl-api-auto-work-" });
  const directory = join(root, "rules", "auto-work");
  await mkdir(join(directory, "projects"), { recursive: true });
  if (defaults !== null) {
    await writeFile(join(directory, "defaults.json"), defaults ?? await readFile(new URL("../../rules/auto-work/defaults.json", import.meta.url), "utf8"));
  }
  const projectId = createUlid();
  const otherProjectId = createUlid();
  await writeFile(join(directory, "projects", `${projectId}.json`), JSON.stringify({
    github: { repo: "someone/somewhere", allowed_users: ["@me", "collaborator"] },
    rules: [{ id: "failure-notice", min_occurrences: 1 }],
  }));
  const now = T0.toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'owner:default', ?, ?)", now, now);
    for (const [id, name] of [[projectId, "Project A"], [otherProjectId, "Project B"]]) {
      tx.run(
        `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
           verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
         VALUES (?, 'owner:default', ?, ?, 'main', '[]', '[]', '[]', ?, ?)`,
        id, name, join(root, name), now, now,
      );
    }
  });
  await durable.start();
  const core = new ExternalCoreAdapter(durable, db, root, join(root, "data"));
  const server = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  const get = (path) => server.request("GET", `${apiRoot}${path}`);
  const put = (payload, version, key = createUlid()) => server.request("PUT", `${apiRoot}/settings`, command(payload, key, version));
  const run = (id, body) => server.request("POST", `${apiRoot}/projects/${id}/run`, body);
  const record = async (overrides) => {
    await clock.advanceTo(new Date(clock.now().getTime() + 60_000));
    return durable.receiveAutoWorkSignal(signal(projectId, overrides));
  };
  return { durable, clock, projectId, otherProjectId, get, put, run, record, server };
}


test(`GET /auto-work/settings lists the layered settings with origin, overridden fields, today and an unresolved @me`, async (t) => {
  const api = await startServer(t);
  if (!api) return;
  const response = await api.get("/settings");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, 0);
  const { data } = body;
  assert.deepEqual(data.enabled, { effective: false, from: "defaults" });
  assert.equal(data.judge_role, "manager");
  assert.deepEqual(Object.keys(data.limits).sort(), ["cooldown_hours", "day_start_time", "max_works_per_day", "max_works_per_day_all"]);
  assert.equal(data.config_error, null);
  assert.deepEqual(data.files, { defaults: "rules/auto-work/defaults.json", local: "rules/auto-work/local.json", projects_dir: "rules/auto-work/projects" });
  assert.deepEqual(data.today, { day_key: `${T0.getFullYear()}-${T0.getMonth() + 1}-${T0.getDate()}`, created_all: 0, cap_all: data.limits.max_works_per_day_all });
  assert.deepEqual(data.projects.map((project) => project.project_name), ["Project A", "Project B"]);
  const [project, other] = data.projects;
  assert.equal(project.project_id, api.projectId);
  assert.equal(project.config_file_present, true);
  assert.equal(other.config_file_present, false);
  assert.deepEqual(project.github.allowed_users, ["@me", "collaborator"]);
  assert.equal(project.github.repo, "someone/somewhere");
  assert.deepEqual(project.github.lists.issues, { since: null, last_polled_at: null, last_completed_at: null, last_error: null, pending_items: 0, failed_items: 0 });
  assert.deepEqual(Object.keys(project.github.lists), ["issues", "comments"]);
  const rule = project.rules.find((candidate) => candidate.id === "failure-notice");
  assert.equal(rule.origin, "defaults");
  assert.deepEqual(rule.overridden_fields, ["min_occurrences"]);
  assert.equal(rule.min_occurrences, 1);
  assert.deepEqual(other.rules.find((candidate) => candidate.id === "failure-notice").overridden_fields, []);
  assert.deepEqual(project.today, { created: 0, cap: data.limits.max_works_per_day });
  assert.deepEqual(Object.keys(project.scheduled_check).sort(), ["items", "last_run_at", "next_run_at", "times"]);
  assert.deepEqual(Object.keys(project.watch).sort(), ["commands", "last_error", "logs"]);
  assert.equal(JSON.stringify(data).includes("detail"), false);
});

test(`PUT /auto-work/settings switches on and off, falls back with null and refuses a stale version`, async (t) => {
  const api = await startServer(t);
  if (!api) return;
  const on = await api.put({ enabled: true, projects: { [api.projectId]: { enabled: true } } }, 0);
  assert.equal(on.status, 200);
  const onBody = await on.json();
  assert.equal(onBody.version, 1);
  assert.deepEqual(onBody.data.enabled, { effective: true, from: "db" });
  assert.deepEqual(onBody.data.projects[0].enabled, { effective: true, from: "db" });
  assert.notEqual(onBody.data.projects[1].enabled.from, "db");

  const stale = await api.put({ enabled: false }, 0);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "version_conflict");

  const off = await api.put({ projects: { [api.projectId]: { enabled: false } } }, 1);
  const offBody = await off.json();
  assert.equal(offBody.version, 2);
  assert.deepEqual(offBody.data.enabled, { effective: true, from: "db" });
  assert.deepEqual(offBody.data.projects[0].enabled, { effective: false, from: "db" });

  const cleared = await (await api.put({ enabled: null, projects: { [api.projectId]: { enabled: null } } }, 2)).json();
  assert.deepEqual(cleared.data.enabled, { effective: false, from: "defaults" });
  assert.equal(cleared.data.projects[0].enabled.from, "defaults");
  const read = await (await api.get("/settings")).json();
  assert.equal(read.version, 3);

  for (const bad of [{ enabled: "yes" }, { extra: 1 }, { projects: { [api.projectId]: {} } }, { projects: { "not-an-id": { enabled: true } } }]) {
    assert.equal((await api.put(bad, 3)).status, 400, JSON.stringify(bad));
  }
  const unknown = await api.put({ projects: { [createUlid()]: { enabled: true } } }, 3);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "project_not_found");
});

test(`GET /auto-work/events lists newest first, filters, pages and returns one row with its detail`, async (t) => {
  const api = await startServer(t);
  if (!api) return;
  await api.put({ enabled: true, projects: { [api.projectId]: { enabled: true } } }, 0);
  const created = await api.record();
  const noRule = await api.record({ kind: "unknown_kind" });
  const second = await api.record();
  assert.equal(created.verdict, "created");
  assert.equal(noRule.verdict, "no_rule");

  const list = await (await api.get("/events")).json();
  assert.deepEqual(list.data.items.map((item) => item.id), [second.event_id, noRule.event_id, created.event_id]);
  assert.equal(list.data.next_offset, null);
  const [first] = list.data.items;
  assert.equal(first.project_name, "Project A");
  assert.equal(first.work_title, "自動 Work");
  assert.equal(first.work_state, "memo");
  assert.equal(typeof first.work_display_number === "number" || first.work_display_number === null, true);
  assert.equal("detail" in first, false);
  assert.equal("judge_json" in first, false);

  const ids = async (query) => (await (await api.get(`/events?${query}`)).json()).data.items.map((item) => item.id);
  assert.deepEqual(await ids("verdict=no_rule"), [noRule.event_id]);
  assert.deepEqual(await ids(`work_id=${created.work_id}`), [created.event_id]);
  assert.deepEqual(await ids(`project_id=${api.otherProjectId}`), []);
  assert.equal((await ids("source=failure_notice")).length, 3);
  assert.deepEqual(await ids("source=github"), []);

  const page = await (await api.get("/events?limit=2")).json();
  assert.equal(page.data.items.length, 2);
  assert.equal(page.data.next_offset, 2);
  const rest = await (await api.get("/events?limit=2&offset=2")).json();
  assert.deepEqual(rest.data.items.map((item) => item.id), [created.event_id]);
  assert.equal(rest.data.next_offset, null);

  const one = await api.get(`/events/${created.event_id}`);
  assert.equal(one.status, 200);
  const detail = (await one.json()).data;
  assert.equal(detail.id, created.event_id);
  assert.equal(detail.detail, "終了コード 1");
  assert.equal(detail.judge_json.worth_fixing, true);

  assert.equal((await api.get(`/events/${createUlid()}`)).status, 404);
  for (const query of ["verdict=nope", "source=nope", "limit=0", "limit=100000", "project_id=x"]) {
    assert.equal((await api.get(`/events?${query}`)).status, 400, query);
  }
});

test(`POST /auto-work/projects/{id}/run runs a registered handler once and refuses a Project that is off`, async (t) => {
  const api = await startServer(t);
  if (!api) return;
  let calls = 0;
  api.durable.autoWork.registerRunNow("scheduled_check", async (projectId) => {
    calls += 1;
    return [await api.durable.receiveAutoWorkSignal(signal(projectId, { source: "scheduled_check", kind: "nightly_test_failed", dedupe: { kind: "id", value: "nightly:1" } }))];
  });

  const disabled = await api.run(api.projectId, { what: "scheduled_check" });
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json()).error.code, "invalid_state");
  assert.equal(calls, 0);

  await api.put({ enabled: true, projects: { [api.projectId]: { enabled: true } } }, 0);
  const done = await api.run(api.projectId, { what: "scheduled_check" });
  assert.equal(done.status, 200);
  const { data } = await done.json();
  assert.equal(data.project_id, api.projectId);
  assert.equal(data.what, "scheduled_check");
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].source, "scheduled_check");
  assert.equal(data.events[0].verdict, "created");
  assert.equal(calls, 1);

  assert.equal((await api.run(createUlid(), { what: "scheduled_check" })).status, 404);
  assert.equal((await api.run(api.projectId, { what: "weekly" })).status, 400);
  assert.equal((await api.run(api.projectId, {})).status, 400);
});

test(`POST /auto-work/projects/{id}/run returns only the events its own run recorded`, async (t) => {
  const api = await startServer(t);
  if (!api) return;
  await api.put({ enabled: true, projects: { [api.projectId]: { enabled: true } } }, 0);
  const other = await api.record({ source: "scheduled_check", kind: "backlog_open", dedupe: { kind: "id", value: "other-run" } });
  api.durable.autoWork.registerRunNow("scheduled_check", async (projectId) => [
    await api.durable.receiveAutoWorkSignal(signal(projectId, { source: "scheduled_check", kind: "nightly_test_failed", dedupe: { kind: "id", value: "mine" } })),
  ]);
  const { data } = await (await api.run(api.projectId, { what: "scheduled_check" })).json();
  assert.equal(data.events.length, 1);
  assert.notEqual(data.events[0].id, other.event_id);
});

test(`GET /auto-work/settings answers in the same shape, switched off, when defaults.json is missing or broken`, async (t) => {
  for (const defaults of [null, "{ not json"]) {
    const api = await startServer(t, { defaults });
    if (!api) return;
    const response = await api.get("/settings");
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.enabled, { effective: false, from: "defaults" });
    assert.equal(typeof data.config_error, "string");
    assert.deepEqual(Object.keys(data.files), ["defaults", "local", "projects_dir"]);
    assert.deepEqual(data.projects, []);
  }
});
