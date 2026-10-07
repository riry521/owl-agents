import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase, openTestDatabase } from "../helpers/db.mjs";
import { createTestRepo, git } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { disablePlanQuality } from "../helpers/plan-quality.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

test("createTestCore builds a Core on a migrated db and removes the root afterwards", async (t) => {
  let root;
  await t.test("inner", async (inner) => {
    const made = await createTestCore(inner);
    root = made.root;
    assert.ok(existsSync(root));
    assert.ok(made.db.get("SELECT count(*) AS n FROM schema_migrations").n > 0);
  });
  assert.equal(existsSync(root), false);
});

test("createTestCore neither closes nor removes a db and owlRoot it was given", async (t) => {
  const first = await createTestCore(t);
  await first.core.stop();
  const second = await createTestCore(t, { db: first.db, owlRoot: first.root });
  assert.equal(second.root, first.root);
  assert.equal(second.db, first.db);
  assert.ok(second.db.get("SELECT 1 AS n").n === 1);
});

test("waitFor returns the value and times out with the message", async () => {
  let calls = 0;
  assert.equal(await waitFor(() => (++calls > 2 ? "done" : null), { intervalMs: 1 }), "done");
  await assert.rejects(waitFor(() => false, { timeoutMs: 20, intervalMs: 5, message: "never" }), /never/);
});

test("createTestRepo returns a main repo with one commit; repoRoot is the repository", async (t) => {
  const repo = await createTestRepo(t);
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(repo, "rev-list", "--count", "HEAD"), "1");
  assert.ok(existsSync(`${repoRoot}/package.json`));
});

test("tempDir, createTestDatabase and openTestDatabase build removable fixtures", async (t) => {
  const dirs = [];
  await t.test("inner", async (inner) => {
    const dir = await tempDir(inner);
    const db = createTestDatabase(dir);
    inner.after(() => db.close());
    const opened = await openTestDatabase(inner);
    dirs.push(dir, opened.root);
    assert.ok(db.get("SELECT count(*) AS n FROM schema_migrations").n > 0);
    assert.ok(opened.db.get("SELECT count(*) AS n FROM schema_migrations").n > 0);
  });
  for (const dir of dirs) assert.equal(existsSync(dir), false);
});

test("disablePlanQuality stores plan_quality enabled=false", async (t) => {
  const { db } = await openTestDatabase(t);
  await disablePlanQuality(db);
  const row = db.get("SELECT value_json FROM settings WHERE key = 'plan_quality'");
  assert.equal(JSON.parse(row.value_json).enabled, false);
});

test("startTestHttpServer serves requests and restores OWL_API_TOKEN", async (t) => {
  const before = process.env.OWL_API_TOKEN;
  const { core, root } = await createTestCore(t);
  await t.test("inner", async (inner) => {
    const api = await startTestHttpServer(inner, { core, webOut: root, owlRoot: root, dataDir: root }, { token: "tok" });
    if (!api) return inner.skip("localhost listen is unavailable");
    assert.equal(process.env.OWL_API_TOKEN, "tok");
    const response = await api.request("GET", "/api/v1/health");
    assert.ok((await response.json()).request_id, "the server answered with an Owl envelope");
  });
  assert.equal(process.env.OWL_API_TOKEN, before);
});
