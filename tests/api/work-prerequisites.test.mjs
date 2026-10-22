import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { command as envelope, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { repoRoot } from "../helpers/paths.mjs";

// The HTTP surface of Work prerequisites: creating with them, replacing them, releasing the wait,
// what GET and the list return, and what the OpenAPI contract says.

const openapi = await readFile(join(repoRoot, "contracts/openapi/owl-api-v1.yaml"), "utf8");

/** Return the indented YAML block that starts at `header` (exclusive of following siblings). */
function yamlBlock(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === header);
  assert.notEqual(start, -1, `missing OpenAPI block ${header.trim()}`);
  const indent = header.length - header.trimStart().length;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length > 0 && line.length - line.trimStart().length <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

async function setup(t) {
  const { root, db, core } = await createTestCore(t, { dispatcher: { tick_interval_ms: 600_000 } }, { prefix: "owl-api-work-prereq-", start: true });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const server = await startTestHttpServer(t, { core: adapter, webOut: root, owlRoot: root }, { token: "work-prereq-token" });
  if (!server) {
    t.skip("listen not permitted");
    return null;
  }
  const versionOf = (workId) => db.get("SELECT state_version FROM works WHERE id = ?", workId).state_version;
  const send = (method, path, payload, workId) => server.request(method, `/api/v1${path}`, {
    request_id: createUlid(), idempotency_key: `k:${createUlid()}`, expected_version: workId ? versionOf(workId) : 0, payload,
  });
  const create = async (title, prerequisiteIds, projectId = null) => {
    const payload = { title, summary: "s", size: "small", project_id: projectId };
    if (prerequisiteIds) payload.prerequisite_work_ids = prerequisiteIds;
    return send("POST", "/works", payload);
  };
  const createProject = async (name) => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    git(path, "init", "--initial-branch=main");
    await writeFile(join(path, "README.md"), "base\n");
    git(path, "add", ".");
    git(path, "commit", "-m", "initial");
    const response = await core.createProject(envelope({
      name, canonical_path: await realpath(path), base_branch: "main", allowed_roots: [root], verification_plan: [],
    }, `p:${createUlid()}`, 0));
    return response.data.id;
  };
  const get = async (path) => (await server.request("GET", `/api/v1${path}`)).json();
  return { db, core, adapter, send, create, createProject, get };
}

test("create, replace and release over HTTP refuse bad prerequisites with 4xx", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const missing = await api.create("x", [createUlid()]);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "prerequisite_work_not_found");

  const b = (await (await api.create("b")).json()).data.work_id;
  const a = (await (await api.create("a", [b])).json()).data.work_id;

  const self = await api.send("PUT", `/works/${a}/prerequisites`, { prerequisite_work_ids: [a] }, a);
  assert.equal(self.status, 400);
  assert.equal((await self.json()).error.code, "validation_error");
  const cycle = await api.send("PUT", `/works/${b}/prerequisites`, { prerequisite_work_ids: [a] }, b);
  assert.equal(cycle.status, 409);
  assert.equal((await cycle.json()).error.code, "prerequisite_cycle");
  const duplicate = await api.send("PUT", `/works/${a}/prerequisites`, { prerequisite_work_ids: [b, b] }, a);
  assert.equal(duplicate.status, 400);

  const notReady = await api.send("POST", `/works/${a}/prerequisites/release`, {}, a);
  assert.equal(notReady.status, 409, "a memo Work is not waiting");

  const started = await api.send("POST", `/works/${a}/start`, { mode: "normal" }, a);
  assert.equal(started.status, 200);
  const startedData = (await started.json()).data;
  assert.equal(startedData.state, "ready");
  assert.equal(startedData.waiting_for_prerequisites, true);

  const released = await api.send("POST", `/works/${a}/prerequisites/release`, {}, a);
  assert.equal(released.status, 200);
  assert.equal((await released.json()).data.state, "running");
  assert.equal(api.db.get("SELECT state FROM works WHERE id = ?", a).state, "running");
});

test("GET and the list return prerequisites of another Project through the adapter", async (t) => {
  const api = await setup(t);
  if (!api) return;
  const alpha = await api.createProject("Alpha");
  const beta = await api.createProject("Beta");
  const first = (await (await api.create("first", undefined, alpha)).json()).data.work_id;
  const waiting = (await (await api.create("waiting", [first], beta)).json()).data.work_id;
  await api.send("POST", `/works/${waiting}/start`, { mode: "normal" }, waiting);

  const detail = (await api.get(`/works/${waiting}`)).data;
  assert.equal(detail.state, "ready");
  assert.equal(detail.prerequisite_wait, true);
  assert.equal(detail.prerequisites.length, 1);
  const prerequisite = detail.prerequisites[0];
  assert.equal(prerequisite.work_id, first);
  assert.equal(prerequisite.project_name, "Alpha");
  assert.equal(prerequisite.display_number, 1);
  assert.equal(prerequisite.state, "memo");
  assert.equal(prerequisite.satisfied, false);

  const listed = (await api.get("/works")).data.find((work) => work.id === waiting);
  assert.equal(listed.prerequisite_wait, true);
  assert.deepEqual(listed.waiting_on.map((row) => [row.work_id, row.project_name, row.display_number]), [[first, "Alpha", 1]]);
});

test("OpenAPI documents Work prerequisites", () => {
  const replace = yamlBlock(openapi, "  /api/v1/works/{work_id}/prerequisites:");
  assert.match(replace, /operationId: replaceWorkPrerequisites/u);
  assert.match(replace, /x-error-codes: \[work_not_found, prerequisite_work_not_found\]/u);
  assert.match(replace, /prerequisite_cycle/u);
  const release = yamlBlock(openapi, "  /api/v1/works/{work_id}/prerequisites/release:");
  assert.match(release, /operationId: releaseWorkPrerequisiteWait/u);
  assert.match(release, /x-error-codes: \[invalid_state_transition,/u);
  const prerequisite = yamlBlock(openapi, "    WorkPrerequisite:");
  for (const key of ["work_id", "project_name", "display_number", "state", "deleted", "satisfied"]) assert.match(prerequisite, new RegExp(`\\n        ${key}:\\n`, "u"), key);
  assert.match(yamlBlock(openapi, "    CreateWorkPayload:"), /prerequisite_work_ids:/u);
  assert.match(yamlBlock(openapi, "    WorkSummary:"), /waiting_on:/u);
  assert.match(yamlBlock(openapi, "    WorkDetail:"), /prerequisites:/u);
  assert.match(yamlBlock(openapi, "    StartWorkResponse:"), /waiting_for_prerequisites:/u);
});
