import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Core } from "../../../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../../../packages/db/dist/index.js";
import { ExternalCoreAdapter, MemoryCore } from "../dist/core.js";
import { createOwlHttpServer } from "../dist/http.js";

const repoRoot = join(import.meta.dirname, "../../..");

async function setup(t, kind, { investigate = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-investigate-"));
  const calls = [];
  const investigateProjectOverview = async (input) => { calls.push(input); return { dry_run: false, state: "running" }; };
  let httpCore, projectId, close = async () => {};
  if (kind === "memory") {
    const memory = new MemoryCore({ version: "test" });
    const created = await memory.createProject({ name: "p", canonical_path: root, base_branch: "main", allowed_roots: [root], verification_plan: [] }, { request_id: "r", idempotency_key: "k", expected_version: 0 });
    projectId = created.data.id;
    if (investigate) memory.investigateProjectOverview = investigateProjectOverview;
    httpCore = memory;
  } else {
    const db = openDatabase(join(root, "owl.db"));
    db.migrate(join(repoRoot, "packages/db/migrations"));
    const agentRunner = { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) };
    const core = new Core({ db, agentRunner, version: "test", owlRoot: root });
    const ownerId = createUlid();
    projectId = createUlid();
    const now = new Date().toISOString();
    await db.createWriteLane().transact((tx) => {
      tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)", ownerId, "Owner", now, now);
      tx.run("INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at) VALUES (?, ?, 'p', ?, 'main', ?, '[]', '[]', ?, ?)", projectId, ownerId, root, JSON.stringify([root]), now, now);
    });
    core.investigateProjectOverview = investigate ? investigateProjectOverview : undefined;
    httpCore = new ExternalCoreAdapter(core, db, root, join(root, "data"));
    close = async () => { await core.stop({ force: true }); db.close(); };
  }
  const priorToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "investigate-token";
  const http = createOwlHttpServer({ core: httpCore, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root });
  t.after(async () => {
    await http.close().catch(() => {});
    if (priorToken === undefined) delete process.env.OWL_API_TOKEN; else process.env.OWL_API_TOKEN = priorToken;
    await close();
    await rm(root, { recursive: true, force: true });
  });
  try { await http.listen(); } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("listen not permitted"); return null; }
    throw error;
  }
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const post = (id) => fetch(`${base}/projects/${id}/overview/investigate`, { method: "POST", headers: { authorization: "Bearer investigate-token", "content-type": "application/json" }, body: "{}" });
  return { post, calls, projectId };
}

for (const kind of ["memory", "adapter"]) {
  test(`POST /projects/:id/overview/investigate calls the investigation (${kind})`, async (t) => {
    const api = await setup(t, kind);
    if (!api) return;
    const res = await api.post(api.projectId);
    assert.equal(res.status, 202);
    assert.deepEqual((await res.json()).data, { dry_run: false, state: "running" });
    assert.deepEqual(api.calls, [{ project_id: api.projectId }]);
  });

  test(`investigate answers 404 for an unknown project (${kind})`, async (t) => {
    const api = await setup(t, kind);
    if (!api) return;
    const res = await api.post("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "project_not_found");
    assert.deepEqual(api.calls, []);
  });

  test(`investigate answers 503 dependency_unavailable without the feature (${kind})`, async (t) => {
    const api = await setup(t, kind, { investigate: false });
    if (!api) return;
    const res = await api.post(api.projectId);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "dependency_unavailable");
  });
}
