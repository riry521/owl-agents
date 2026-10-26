import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const now = "2026-09-30T00:00:00.000Z";

test("PUT /advisor/windows/order sets the Project window order, keeps the general window first and rejects invalid keys", async (t) => {
  const { root, db, core: durableCore } = await createTestCore(t, { version: "advisor-window-order-test" }, { prefix: "owl-api-window-order-", start: true });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const server = await startTestHttpServer(t, { core: new ExternalCoreAdapter(durableCore, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir }, { token: randomBytes(24).toString("hex") });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return;
  }
  const request = (method, path, body) => server.request(method, `/api/v1${path}`, body);
  await db.createWriteLane().transact((tx) => tx.run(
    "INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'owner:default', ?, ?)", now, now,
  ));
  const ids = [];
  for (const name of ["A", "B", "C"]) {
    const id = createUlid();
    ids.push(id);
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, advisor_window_enabled, created_at, updated_at)
       VALUES (?, 'owner:default', ?, ?, 'main', '[]', '[]', '[]', 1, ?, ?)`,
      id, name, `/tmp/${id}`, now, now,
    ));
  }
  const keys = async () => (await (await request("GET", "/advisor/windows")).json()).data.map((window) => window.key);
  const [a, b, c] = ids;

  const put = await request("PUT", "/advisor/windows/order", command({ keys: [c, a, b] }, "order:1"));
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()).data.map((window) => window.key), ["general", c, a, b]);
  assert.deepEqual(await keys(), ["general", c, a, b]);

  for (const [i, payload] of [{ keys: ["general", a] }, { keys: [a, a] }, { keys: "x" }, { keys: [1] }, {}].entries()) {
    const rejected = await request("PUT", "/advisor/windows/order", command(payload, `order:bad:${i}`));
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, "validation_error");
  }
  assert.deepEqual(await keys(), ["general", c, a, b]);
});
