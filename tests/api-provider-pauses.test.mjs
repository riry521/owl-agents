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

  const resumePath = "/providers/pauses/openai%2Fcodex/resume";
  assert.equal((await fetch(`${base}${resumePath}`, { method: "POST" })).status, 401);
  const resumedResponse = await request(resumePath, { method: "POST" });
  assert.equal(resumedResponse.status, 200);
  const resumed = await resumedResponse.json();
  assert.ok(resumed.request_id);
  assert.deepEqual(resumed.data.pause, { ...listed.data.pauses[0], state: "probing", resume_at: NOW });
  const repeated = await request("/providers/pauses/codex/resume", { method: "POST" });
  assert.equal(repeated.status, 200);
  assert.deepEqual((await repeated.json()).data, resumed.data);
  for (const provider of ["missing", "codex"]) {
    if (provider === "codex") await store.noteProviderSucceeded("openai", NOW);
    const missing = await request(`/providers/pauses/${provider}/resume`, { method: "POST" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "provider_pause_not_found");
  }

});

test("Core resumes provider aliases and reports absent pauses in the Owner language", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-core-provider-pauses-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({ db, agentRunner: {}, version: "provider-pauses-test", owlRoot: root, dataDir: root, now: () => NOW });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const store = createProviderPauseStore(db, () => NOW);
  await store.recordRateLimit({ provider: "anthropic" });
  const pause = await core.resumeProviderPause(" CLAUDE ");
  assert.equal(pause.provider, "anthropic");
  assert.equal(pause.state, "probing");
  assert.equal(pause.resume_at, NOW);
  assert.deepEqual(await core.resumeProviderPause("anthropic"), pause);
  await store.noteProviderSucceeded("anthropic", NOW);
  for (const language of ["ja", "en"]) {
    await core.setLanguage(language);
    for (const provider of ["claude", "missing"]) {
      await assert.rejects(core.resumeProviderPause(provider), (error) => {
        assert.equal(error.code, "provider_pause_not_found");
        assert.match(error.message, language === "ja" ? /一時停止/u : /provider pause/u);
        return true;
      });
    }
  }
});
