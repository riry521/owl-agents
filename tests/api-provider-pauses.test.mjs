import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { Core, createProviderPauseStore } from "../packages/core/dist/index.js";
import { openDatabase } from "../packages/db/dist/index.js";

const NOW = "2030-01-02T03:04:05.000Z";
const repoRoot = resolve(process.cwd());

test("provider pause route lists paused providers and their planned retry times", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-api-provider-pauses-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const clock = NOW;
  const store = createProviderPauseStore(db, () => clock);
  await store.recordRateLimit({ provider: "anthropic", resets_at: "2030-01-02T04:00:00.000Z" });
  await store.recordRateLimit({ provider: "openai" });
  const durableCore = new Core({ db, agentRunner: {}, version: "provider-pauses-test", owlRoot: root, dataDir, now: () => clock });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const originalToken = process.env.OWL_API_TOKEN;
  const token = randomBytes(24).toString("hex");
  process.env.OWL_API_TOKEN = token;
  const http = createOwlHttpServer({
    core, db, webOut: root, bind: "127.0.0.1", port: 0,
    contract: { contract_version: "1.0.0" }, owlRoot: root, dataDir,
  });
  t.after(async () => {
    if (http.server.listening) await http.close();
    await durableCore.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = originalToken;
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return;
    }
    throw error;
  }
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });

  const unauthorized = await fetch(`${base}/providers/pauses`);
  assert.equal(unauthorized.status, 401);

  const listedResponse = await request("/providers/pauses");
  assert.equal(listedResponse.status, 200);
  const listed = await listedResponse.json();
  assert.ok(listed.request_id);
  assert.deepEqual(listed.data.pauses, [
    {
      provider: "openai", label: "Codex", state: "paused",
      paused_at: NOW, resume_at: "2030-01-02T03:19:05.000Z", resume_source: "backoff",
      reported_resets_at: null, backoff_step: 0,
      last_error: null, last_role: null,
    },
    {
      provider: "anthropic", label: "Claude", state: "paused",
      paused_at: NOW, resume_at: "2030-01-02T04:00:30.000Z", resume_source: "reported",
      reported_resets_at: "2030-01-02T04:00:00.000Z", backoff_step: 0,
      last_error: null, last_role: null,
    },
  ]);

});
