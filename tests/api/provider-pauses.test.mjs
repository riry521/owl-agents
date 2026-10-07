import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createProviderPauseStore } from "../../packages/core/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const NOW = "2030-01-02T03:04:05.000Z";

test("provider pause route lists paused providers and their planned retry times", async (t) => {
  const clock = NOW;
  const { root, db, core: durableCore } = await createTestCore(t, { version: "provider-pauses-test", now: () => clock }, { prefix: "owl-api-provider-pauses-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const store = createProviderPauseStore(db, () => clock);
  await store.recordRateLimit({ provider: "anthropic", resets_at: "2030-01-02T04:00:00.000Z" });
  await store.recordRateLimit({ provider: "openai" });
  const core = new ExternalCoreAdapter(durableCore, db, root, dataDir);
  const token = randomBytes(24).toString("hex");
  const server = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!server) {
    t.skip("localhost listen is not permitted in this environment");
    return;
  }
  const base = `${server.baseUrl}/api/v1`;
  const request = (path, { method = "GET" } = {}) => server.request(method, `/api/v1${path}`);

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
  const { db, core } = await createTestCore(t, { version: "provider-pauses-test", now: () => NOW }, { prefix: "owl-core-provider-pauses-" });
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
