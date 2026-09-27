import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid, openDatabase } from "../packages/db/dist/index.js";
import { Core } from "../packages/core/dist/index.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";

async function startServer(t, knownModels) {
  const root = await mkdtemp(join(tmpdir(), "owl-model-presets-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(process.cwd(), "packages/db/migrations"));
  const durableCore = new Core({ db, agentRunner: {}, version: "test", owlRoot: root, ...(knownModels ? { knownModels } : {}) });
  await durableCore.start();
  const core = new ExternalCoreAdapter(durableCore, db, root, root);
  const http = createOwlHttpServer({ core, db, webOut: root, bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, owlRoot: root });
  const previousToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "model-presets-test-token";
  t.after(async () => {
    await http.close().catch(() => undefined);
    await durableCore.stop({ force: true }).catch(() => undefined);
    db.close();
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  });
  await http.listen();
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1/settings`;
  async function request(method, path, payload, version = 0) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: "Bearer model-presets-test-token", "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify({ request_id: createUlid(), idempotency_key: createUlid(), expected_version: version, payload }) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { request, db };
}

function inputRoles(roles, workerModel) {
  return roles.map(({ role, provider, model, effort }) => ({ role, provider, model: role === "worker" && workerModel ? workerModel : model, effort }));
}

test("preset lifecycle preserves creation order and applies roles through model settings", async (t) => {
  const { request } = await startServer(t);
  const settings = (await request("GET", "/models")).body;
  const roles = inputRoles(settings.data.roles);
  const alternate = roles.find(({ role }) => role === "advisor");
  const workerModel = alternate.model;
  const overwritten = roles.map((role) => role.role === "worker" ? { ...role, provider: alternate.provider, model: workerModel } : role);
  const empty = await request("GET", "/model-presets");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.presets, []);
  assert.equal(empty.body.version, 0);

  const first = await request("POST", "/model-presets", { name: " First ", roles }, 0);
  assert.equal(first.status, 201);
  assert.equal(first.body.version, 1);
  assert.equal(first.body.data.preset.name, "First");
  assert.equal(first.body.data.preset.roles.length, 8);
  assert.match(first.body.data.preset.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(first.body.data.preset.created_at);
  const id = first.body.data.preset.id;
  const second = await request("POST", "/model-presets", { name: "Second", roles }, 1);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body.data.presets.map(({ name }) => name), ["First", "Second"]);

  const renamed = await request("PUT", `/model-presets/${id}`, { name: "Renamed" }, 2);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.preset.created_at, first.body.data.preset.created_at);
  assert.equal(renamed.body.data.preset.name, "Renamed");
  const updated = await request("PUT", `/model-presets/${id}`, { roles: overwritten }, 3);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.preset.roles.find(({ role }) => role === "worker").model, workerModel);

  const applied = await request("PUT", "/models", { roles: inputRoles(updated.body.data.preset.roles) }, settings.version);
  assert.equal(applied.status, 200);
  const active = await request("GET", "/models");
  assert.deepEqual(active.body.data.roles, updated.body.data.preset.roles);

  const deleted = await request("DELETE", `/model-presets/${id}`, {}, 4);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.version, 5);
  assert.deepEqual(deleted.body.data.presets.map(({ name }) => name), ["Second"]);
});

test("preset commands reject duplicate names, stale versions, missing IDs and invalid roles", async (t) => {
  const { request } = await startServer(t);
  const roles = inputRoles((await request("GET", "/models")).body.data.roles);
  const first = await request("POST", "/model-presets", { name: "Alpha", roles }, 0);
  assert.equal(first.status, 201);
  const id = first.body.data.preset.id;
  const duplicate = await request("POST", "/model-presets", { name: "alpha", roles }, 1);
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.error.code, "validation_error");
  assert.equal(duplicate.body.error.details.field, "name");
  const stale = await request("PUT", `/model-presets/${id}`, { name: "New" }, 0);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "version_conflict");
  const missing = await request("DELETE", `/model-presets/${createUlid()}`, {}, 1);
  assert.equal(missing.status, 404);
  const invalid = await request("POST", "/model-presets", { name: "Bad", roles: inputRoles(roles, "unknown-model-id") }, 1);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "validation_error");
  const emptyUpdate = await request("PUT", `/model-presets/${id}`, {}, 1);
  assert.equal(emptyUpdate.status, 400);
});

test("preset limit is 20 and old models do not block rename or delete", async (t) => {
  let known = undefined;
  const { request } = await startServer(t, () => known);
  const roles = inputRoles((await request("GET", "/models")).body.data.roles);
  const oldRoles = roles.map((role) => role.role === "worker" ? { ...role, provider: "openai", model: "retired-model" } : role);
  const old = await request("POST", "/model-presets", { name: "Old", roles: oldRoles }, 0);
  assert.equal(old.status, 201);
  known = new Set();
  const id = old.body.data.preset.id;
  const renamed = await request("PUT", `/model-presets/${id}`, { name: "Archived" }, 1);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.preset.roles.find(({ role }) => role === "worker").model, "retired-model");
  const removed = await request("DELETE", `/model-presets/${id}`, {}, 2);
  assert.equal(removed.status, 200);
  known = undefined;
  let version = 3;
  for (let index = 0; index < 20; index += 1) {
    const result = await request("POST", "/model-presets", { name: `Preset ${index}`, roles }, version);
    assert.equal(result.status, 201);
    version = result.body.version;
  }
  const overLimit = await request("POST", "/model-presets", { name: "Preset 20", roles }, version);
  assert.equal(overLimit.status, 400);
  assert.equal(overLimit.body.error.code, "validation_error");
});

test("a malformed stored preset is skipped instead of breaking the other presets", async (t) => {
  const { request, db } = await startServer(t);
  const roles = inputRoles((await request("GET", "/models")).body.data.roles);
  const created = await request("POST", "/model-presets", { name: "Good", roles }, 0);
  assert.equal(created.status, 201);
  const row = db.get("SELECT value_json FROM settings WHERE key = 'model_presets'");
  const stored = JSON.parse(row.value_json);
  await db.createWriteLane().transact((transaction) => {
    transaction.run("UPDATE settings SET value_json = ? WHERE key = 'model_presets'", JSON.stringify({ ...stored, presets: [null, { name: "No id" }, ...stored.presets] }));
  });

  const listed = await request("GET", "/model-presets");
  assert.deepEqual(listed.body.data.presets.map(({ name }) => name), ["Good"]);
  const removed = await request("DELETE", `/model-presets/${created.body.data.preset.id}`, {}, listed.body.version);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data.presets, []);
});
