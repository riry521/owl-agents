import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

async function setup(t) {
  return createTestCore(t, { agentRunner, version: "test" }, { prefix: "owl-curation-runs-" });
}

test("store records runs of any kind and lists them with paging", async (t) => {
  const { core } = await setup(t);
  const store = core.curationRuns;
  for (const kind of ["librarian", "skill_curation", "rule_curation"]) {
    await store.record({ kind, trigger: "manual_api", actor: "owner", status: "succeeded", summary: kind, counts: { a: 1 }, report: { kind } });
  }
  const failed = await store.record({ kind: "librarian", trigger: "scheduled", actor: "system", status: "failed", summary: "", counts: {}, report: null, error: "boom" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");

  const first = store.list({ limit: 3 });
  assert.equal(first.items.length, 3);
  assert.equal("report" in first.items[0], false);
  const second = store.list({ limit: 3, cursor: first.next_cursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.next_cursor, null);
  const ids = [...first.items, ...second.items].map((run) => run.id);
  assert.equal(new Set(ids).size, 4);
  assert.ok(ids.includes(failed.id));
  assert.equal(store.list({ kind: "skill_curation", limit: 10 }).items.length, 1);
  assert.equal(store.list({ status: "failed", limit: 10 }).items[0].id, failed.id);
});

test("a manual run and a scheduled run are stored and survive a Core restart", async (t) => {
  const { db, root, core } = await setup(t);
  core.pageLibrarian.run = async () => ({ merged: [1, 2], warnings: [] });
  const manual = await core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner", actor_ref: "req-1" });
  assert.equal(manual.status, "succeeded");
  assert.deepEqual(manual.report, { merged: [1, 2], warnings: [] });
  assert.equal(manual.counts.merged, 2);
  // The scheduler's run callback is the same entry point with trigger "scheduled".
  const scheduled = await core.librarianScheduler.run();
  assert.equal(scheduled.trigger, "scheduled");
  assert.equal(scheduled.actor, "system");

  await core.stop({ force: true });
  const { core: restarted } = await createTestCore(t, { db, agentRunner, version: "test", owlRoot: root });
  const list = restarted.listCurationRuns({ limit: 10 });
  assert.deepEqual(list.items.map((run) => run.trigger).sort(), ["manual_api", "scheduled"]);
  const loaded = restarted.getCurationRun(manual.id);
  assert.equal(loaded.actor_ref, "req-1");
  assert.deepEqual(loaded.report, manual.report);
});

test("a failing Librarian run is recorded as failed", async (t) => {
  const { core } = await setup(t);
  core.pageLibrarian.run = async () => { throw new Error("librarian exploded"); };
  const run = await core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner" });
  assert.equal(run.status, "failed");
  assert.equal(run.error, "librarian exploded");
});

test("interrupted running rows are marked failed on start", async (t) => {
  const { core } = await setup(t);
  const run = await core.curationRuns.start({ kind: "librarian", trigger: "manual_api", actor: "owner" });
  await core.start();
  const loaded = core.getCurationRun(run.id);
  assert.equal(loaded.status, "failed");
  assert.equal(loaded.error, "interrupted_by_restart");
});

test("POST /librarian/run returns the report and the run is readable through the API", async (t) => {
  const { db, root, core } = await setup(t);
  core.pageLibrarian.run = async () => ({ merged: [], warnings: ["w"] });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const api = await startTestHttpServer(t, { core: adapter, webOut: root, owlRoot: root }, { token: "curation-token" });
  if (!api) return t.skip("localhost listen is unavailable");

  const run = await api.request("POST", "/api/v1/librarian/run");
  assert.equal(run.status, 200);
  const data = (await run.json()).data;
  assert.deepEqual(data.report, { merged: [], warnings: ["w"] });

  const list = await (await api.request("GET", "/api/v1/curation-runs?kind=librarian")).json();
  assert.equal(list.data.items[0].id, data.run_id);
  const one = await (await api.request("GET", `/api/v1/curation-runs/${data.run_id}`)).json();
  assert.deepEqual(one.data.report, data.report);

  assert.equal((await api.request("GET", "/api/v1/curation-runs/01ARZ3NDEKTSV4RRFFQ69G5FAV")).status, 404);
  assert.equal((await api.request("GET", "/api/v1/curation-runs/nope")).status, 400);
  assert.equal((await api.request("GET", "/api/v1/curation-runs?kind=bad")).status, 400);
  assert.equal((await api.request("GET", "/api/v1/curation-runs?limit=0")).status, 400);

  core.pageLibrarian.run = async () => { throw new Error("nope"); };
  const failed = await api.request("POST", "/api/v1/librarian/run");
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, "curation_failed");
});

test("failed record keeps counts and large reports are stored whole", async (t) => {
  const { core } = await setup(t);
  const store = core.curationRuns;
  const failed = await store.record({ kind: "skill_curation", trigger: "manual_api", actor: "owner", status: "failed", summary: "s", counts: { merged: 2 }, report: { x: 1 }, error: "boom" });
  assert.deepEqual(failed.counts, { merged: 2 });
  const big = { text: "a".repeat(1_200_000) };
  const ok = await store.record({ kind: "librarian", trigger: "manual_api", actor: "owner", status: "succeeded", summary: "s", counts: {}, report: big });
  assert.equal(store.get(ok.id).report.text.length, 1_200_000);
});

test("overlapping runs of one kind each keep their own record", async (t) => {
  const { core } = await setup(t);
  const [a, b] = await Promise.all([
    core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner" }),
    core.runCuration({ kind: "librarian", trigger: "scheduled", actor: "system" }),
  ]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.trigger, "manual_api");
  assert.equal(b.trigger, "scheduled");
  assert.equal(core.listCurationRuns({ limit: 10 }).items.length, 2);
});

test("concurrent runs with the same request_key share one record and do not reject", async (t) => {
  const { core } = await setup(t);
  const input = { kind: "librarian", trigger: "advisor_action", actor: "advisor", request_key: "k1" };
  const [a, b] = await Promise.all([core.runCuration(input), core.runCuration(input)]);
  assert.equal(a.id, b.id);
  assert.equal(core.listCurationRuns({ limit: 10 }).items.length, 1);
});
