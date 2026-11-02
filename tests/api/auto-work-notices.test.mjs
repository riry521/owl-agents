import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { NoopGitGateway } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { ExternalCoreAdapter, MemoryCore } from "../../apps/server/dist/core.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const apiRoot = "/api/v1";
const token = "auto-work-notices-owner-token";
const judgment = { ok: true, judgment: { worth_fixing: true, reason: "直す価値がある", duplicate_of_work_id: null, duplicate_reason: null, work: { title: "自動 Work", summary: "原因を調べて直す", size: "normal" } } };

/** @param wrap "external" puts the Core behind ExternalCoreAdapter; "memory" assigns the method to a MemoryCore. */
async function startServer(t, wrap) {
  const judged = [];
  const { root, db, core: durable } = await createTestCore(t, {
    git: new NoopGitGateway(),
    agentRunner: { runAutoWorkJudgment: async (request) => { judged.push(request); return judgment; } },
  }, { prefix: "owl-api-auto-work-notices-" });
  // The default rule waits for a second occurrence; one is enough here so a single notice can make a Work.
  const directory = join(root, "rules", "auto-work");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "defaults.json"), await readFile(new URL("../../rules/auto-work/defaults.json", import.meta.url), "utf8"));
  await writeFile(join(directory, "local.json"), JSON.stringify({ rules: [{ id: "failure-notice", min_occurrences: 1 }] }));
  const projectId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
         verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Project 1', ?, 'main', '[]', '[]', '[]', ?, ?)`,
      projectId, join(root, "project"), now, now,
    );
    tx.run(
      "INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('auto_work', 'owner:default', '1.0.0', ?, ?)",
      JSON.stringify({ schema_version: "1.0.0", version: 1, enabled: true, projects: { [projectId]: { enabled: true } } }), now,
    );
  });
  await durable.start();
  let core;
  if (wrap === "external") core = new ExternalCoreAdapter(durable, db, root, join(root, "data"));
  else {
    core = new MemoryCore({ version: "test" });
    core.receiveAutoWorkNotice = (request) => durable.receiveAutoWorkNotice(request);
  }
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const server = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, guardTokens }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  const post = (payload, { key = createUlid(), bearer = token } = {}) => fetch(`${server.baseUrl}${apiRoot}/auto-work/notices`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }) },
    body: JSON.stringify(command(payload, key)),
  });
  const notice = (extra = {}) => ({ project_id: projectId, kind: "process_failed", title: "deploy.sh が終了コード 1 で終わりました", detail: "log tail", ...extra });
  const rows = () => db.all("SELECT * FROM auto_work_events ORDER BY created_at, id");
  const works = () => db.all("SELECT * FROM works");
  return { post, notice, rows, works, judged, projectId, guardTokens };
}

for (const wrap of ["external", "memory"]) {
  test(`a matching notice makes a draft Work and one history row (${wrap})`, async (t) => {
    const s = await startServer(t, wrap);
    if (!s) return;
    const response = await s.post(s.notice({ dedupe_hint: "deploy.sh", exit_code: 1, command: "./deploy.sh" }));
    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(data.verdict, "created");
    assert.equal(data.source, "failure_notice");
    assert.equal(data.project_name, "Project 1");
    assert.equal(data.work_state, "memo");
    assert.equal("detail" in data, false);
    assert.equal(s.rows().length, 1);
    assert.equal(s.rows()[0].id, data.id);
    assert.equal(s.works().length, 1);
    assert.equal(s.works()[0].id, data.work_id);
  });

  test(`a notice no rule covers is recorded and makes no Work (${wrap})`, async (t) => {
    const s = await startServer(t, wrap);
    if (!s) return;
    const response = await s.post(s.notice({ kind: "other" }));
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.verdict, "no_rule");
    assert.equal(s.rows().length, 1);
    assert.equal(s.works().length, 0);
    assert.equal(s.judged.length, 0);
  });
}

test("the same idempotency key returns the saved result without a second row", async (t) => {
  const s = await startServer(t, "external");
  if (!s) return;
  const first = await (await s.post(s.notice(), { key: "same-key" })).json();
  const second = await (await s.post(s.notice(), { key: "same-key" })).json();
  assert.equal(second.data.id, first.data.id);
  assert.equal(s.rows().length, 1);
});

test("a repeated notice with the same dedupe_hint is a duplicate", async (t) => {
  const s = await startServer(t, "external");
  if (!s) return;
  await s.post(s.notice({ dedupe_hint: "deploy.sh" }));
  const second = await (await s.post(s.notice({ dedupe_hint: "deploy.sh" }))).json();
  assert.equal(second.data.verdict, "duplicate");
  assert.equal(s.works().length, 1);
});

test("errors: 400 validation_error, 404 project_not_found, 401, advisor refused", async (t) => {
  const s = await startServer(t, "external");
  if (!s) return;
  for (const patch of [
    { kind: "bogus" }, { title: "" }, { title: "x".repeat(501) },
    { project_id: "nope" }, { exit_code: 1.5 }, { occurred_at: "yesterday" },
  ]) {
    const response = await s.post(s.notice(patch));
    assert.equal(response.status, 400, JSON.stringify(patch));
    assert.equal((await response.json()).error.code, "validation_error");
  }
  const missing = await s.post(s.notice({ project_id: createUlid() }));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "project_not_found");
  assert.equal((await s.post(s.notice(), { bearer: null })).status, 401);
  const advisor = (await readFile(s.guardTokens.issue({ agent_run_id: "advisor-1", role: "advisor" }).file, "utf8")).trim();
  const refused = await s.post(s.notice(), { bearer: advisor });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "advisor_action_required");
  assert.equal(s.rows().length, 0);
});

test("a Core without the feature answers 503 core_not_ready", async (t) => {
  const root = await tempDir(t, "owl-api-auto-work-notices-503-");
  const server = await startTestHttpServer(t, { core: new MemoryCore({ version: "test" }), webOut: root, owlRoot: root }, { token });
  if (!server) return t.skip("localhost listen is not permitted in this environment");
  const response = await server.request("POST", `${apiRoot}/auto-work/notices`, command({ project_id: createUlid(), kind: "other", title: "x" }, createUlid()));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "core_not_ready");
});
