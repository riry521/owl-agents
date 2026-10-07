import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { DEFAULT_PLAN_USAGE_SETTINGS, PlanUsageSettingsValidationError, readPlanUsageSettings, validatePlanUsageSettings } from "../../packages/shared/dist/plan-usage-settings.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const canary = "plan-usage-test-canary-not-a-credential";
const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

async function setup(t, sources = {}) {
  const { root, db, core: firstCore } = await createTestCore(t, { agentRunner, version: "plan-usage-test", planUsageSources: sources }, { prefix: "owl-plan-usage-" });
  let core = firstCore;
  return { root, db, get core() { return core; }, replaceCore(next) { core = next; } };
}

function snapshot(harness, origin, observedAt, extras = {}) {
  return {
    harness,
    origin,
    windows: [{ id: "five_hour", kind: "five_hour", used_percent: 41.5, resets_at: "2026-10-03T12:00:00.000Z", window_minutes: 300, state: null, label: null }],
    plan_type: null,
    observed_at: observedAt,
    ...extras,
  };
}

test("manual polling records independent source checks and their snapshots", async (t) => {
  let claudeCalls = 0;
  let codexCalls = 0;
  const { core, db } = await setup(t, {
    claude: { harness: "claude", origin: "claude_usage_api", fetch: async () => {
      claudeCalls += 1;
      return { status: "ok", detail: null, snapshot: snapshot("claude", "claude_usage_api", "2026-10-03T10:00:00.000Z") };
    } },
    codex: { harness: "codex", origin: "codex_session_log", fetch: async () => {
      codexCalls += 1;
      return { status: "unavailable", detail: "network", snapshot: null };
    } },
  });

  const view = await core.refreshPlanUsage();

  assert.equal(claudeCalls, 1);
  assert.equal(codexCalls, 1);
  assert.equal(view.claude.display_origin, "claude_usage_api");
  assert.equal(view.codex.status, "unavailable");
  assert.deepEqual(db.all("SELECT harness, origin, status FROM plan_usage_snapshots ORDER BY harness"), [
    { harness: "claude", origin: "claude_usage_api", status: "ok" },
    { harness: "codex", origin: "codex_session_log", status: "unavailable" },
  ]);
  assert.equal(JSON.parse(db.get("SELECT snapshot_json FROM plan_usage_snapshots WHERE harness = 'claude'").snapshot_json).windows[0].used_percent, 41.5);
});

test("default Core plan usage sources include Claude API and Codex session log readers", async (t) => {
  const { core } = await setup(t, "default");

  assert.equal(core.planUsageService.claude?.origin, "claude_usage_api");
  assert.equal(core.planUsageService.codex?.origin, "codex_session_log");
});

test("the scheduled poller saves a source result after its first delay", async (t) => {
  let calls = 0;
  const { core, db } = await setup(t, {
    codex: { harness: "codex", origin: "codex_session_log", fetch: async () => {
      calls += 1;
      return { status: "ok", detail: null, snapshot: snapshot("codex", "codex_session_log", new Date().toISOString()) };
    } },
  });

  assert.equal(typeof core.planUsageService?.start, "function", "Core owns a startable PlanUsageService");
  core.planUsageService.start();
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  await db.createWriteLane().drain();

  assert.equal(calls, 1);
  assert.equal(db.get("SELECT status FROM plan_usage_snapshots WHERE harness = 'codex'").status, "ok");
  await core.stop({ force: true });
  assert.equal(core.planUsageService.running, false);
  assert.equal(core.planUsageService.timeout, null);
});

test("Claude rate_limit_event observations replace a recent API snapshot after API failure", async (t) => {
  let calls = 0;
  const observedAt = Date.now();
  const { core, db } = await setup(t, {
    claude: { harness: "claude", origin: "claude_usage_api", fetch: async () => {
      calls += 1;
      return calls === 1
        ? { status: "ok", detail: null, snapshot: snapshot("claude", "claude_usage_api", new Date(observedAt - 2_000).toISOString()) }
        : { status: "unauthorized", detail: "http_401", snapshot: null };
    } },
  });
  await core.refreshPlanUsage();
  core.planUsageService.lastClaudeFetchAt = Number.NEGATIVE_INFINITY;
  await core.refreshPlanUsage();
  core.planUsageService.observe(snapshot("claude", "claude_rate_limit_event", new Date(observedAt - 1_000).toISOString(), {
    windows: [{ id: "five_hour", kind: "five_hour", used_percent: 88, resets_at: "2026-10-03T12:00:00.000Z", window_minutes: 300, state: "warning", label: null }],
  }));
  await db.createWriteLane().drain();

  const view = await core.getPlanUsage();
  assert.equal(calls, 2);
  assert.equal(view.claude.status, "unauthorized");
  assert.equal(view.claude.fallback, true);
  assert.equal(view.claude.display_origin, "claude_rate_limit_event");
  assert.equal(view.claude.display.windows[0].used_percent, 88);
  assert.equal(view.claude.display.windows[0].state, "warning");
  assert.equal(view.claude.display.windows[0].resets_at, "2026-10-03T12:00:00.000Z");
});

test("disabling the Claude API hides its prior snapshot when no event fallback exists", async (t) => {
  const { core } = await setup(t, {
    claude: { harness: "claude", origin: "claude_usage_api", fetch: async () => ({
      status: "ok", detail: null, snapshot: snapshot("claude", "claude_usage_api", new Date().toISOString()),
    }) },
  });
  await core.refreshPlanUsage();
  await core.setPlanUsageSettings({ claude_usage_api_enabled: false, poll_interval_minutes: 15 });

  const view = await core.getPlanUsage();
  assert.equal(view.claude.status, "disabled");
  assert.equal(view.claude.display, null);
  assert.equal(view.claude.display_origin, null);
});

test("rescheduling during a poll keeps one timer and stopped timers cannot start a poll", async (t) => {
  let calls = 0;
  let resolveFetch;
  const { core } = await setup(t, {
    codex: { harness: "codex", origin: "codex_session_log", fetch: async () => {
      calls += 1;
      return new Promise((resolve) => { resolveFetch = resolve; });
    } },
  });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.set(timer, timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timers.delete(timer); };
  try {
    const service = core.planUsageService;
    service.start();
    const firstTimer = timers.keys().next().value;
    timers.delete(firstTimer);
    firstTimer.callback();
    assert.equal(calls, 1);

    service.reschedule();
    assert.equal(timers.size, 1);
    resolveFetch({ status: "ok", detail: null, snapshot: snapshot("codex", "codex_session_log", new Date().toISOString()) });
    await service.activePoll;
    await new Promise((resolve) => originalSetTimeout(resolve, 0));
    assert.equal(timers.size, 1);

    const remainingTimer = timers.keys().next().value;
    service.stop();
    assert.equal(timers.size, 0);
    remainingTimer.callback();
    assert.equal(calls, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("settings survive Core recreation using the same database", async (t) => {
  const setupResult = await setup(t);
  const { root, db } = setupResult;
  const saved = await setupResult.core.setPlanUsageSettings({ claude_usage_api_enabled: false, poll_interval_minutes: 15 });
  await setupResult.core.stop({ force: true });
  const { core: restarted } = await createTestCore(t, { db, agentRunner, version: "plan-usage-test", owlRoot: root });
  setupResult.replaceCore(restarted);

  assert.deepEqual(saved, { claude_usage_api_enabled: false, poll_interval_minutes: 15 });
  assert.deepEqual(await restarted.getPlanUsageSettings(), saved);
  assert.equal(db.get("SELECT type FROM events WHERE type = 'settings.plan_usage_updated'").type, "settings.plan_usage_updated");
});

test("plan usage settings validate strictly and recover each stored field independently", () => {
  assert.throws(() => validatePlanUsageSettings({ claude_usage_api_enabled: true, poll_interval_minutes: 3 }), (error) =>
    error instanceof PlanUsageSettingsValidationError && error.field === "poll_interval_minutes");
  assert.throws(() => validatePlanUsageSettings({ ...DEFAULT_PLAN_USAGE_SETTINGS, extra: true }), (error) =>
    error instanceof PlanUsageSettingsValidationError && error.field === "payload");
  const warnings = [];
  assert.deepEqual(readPlanUsageSettings({ claude_usage_api_enabled: false, poll_interval_minutes: 3 }, (message) => warnings.push(message)), {
    claude_usage_api_enabled: false,
    poll_interval_minutes: 5,
  });
  assert.equal(warnings.length, 1);
});

test("plan usage HTTP routes use an ExternalCoreAdapter and isolate missing harnesses", async (t) => {
  const warnings = [];
  const oldWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  const { root, db, core } = await setup(t, {
    claude: { harness: "claude", origin: "claude_usage_api", fetch: async () => ({ status: "unavailable", detail: canary, snapshot: null }) },
    codex: { harness: "codex", origin: "codex_session_log", fetch: async () => ({
      status: "ok", detail: null, snapshot: snapshot("codex", "codex_session_log", "2026-10-03T10:05:00.000Z", { secret: canary }),
    }) },
  });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  await core.planUsageService.store.recordCheck({
    harness: "claude", origin: "claude_usage_api", status: "ok", detail: null,
    snapshot: snapshot("claude", "claude_usage_api", "2026-10-03T10:04:00.000Z"),
  }, "2026-10-03T10:04:00.000Z");
  t.after(() => { console.warn = oldWarn; });
  const api = await startTestHttpServer(t, { core: adapter, webOut: root, owlRoot: root }, { token: "plan-usage-http-test-token" });
  if (!api) return t.skip("localhost listen is unavailable");

  const initial = await api.request("GET", "/api/v1/plan-usage");
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).data.codex.status, "no_data");
  const refreshed = await api.request("POST", "/api/v1/plan-usage/refresh", command({}, "plan-refresh"));
  assert.equal(refreshed.status, 200);
  const payload = await refreshed.text();
  assert.equal(payload.includes(canary), false);
  const data = JSON.parse(payload).data;
  assert.equal(data.claude.status, "unavailable");
  assert.equal(data.codex.status, "ok");
  assert.equal(data.codex.display_origin, "codex_session_log");

  const settings = await api.request("GET", "/api/v1/settings/plan-usage");
  assert.equal(settings.status, 200);
  assert.deepEqual((await settings.json()).data, { claude_usage_api_enabled: true, poll_interval_minutes: 5 });
  const updated = await api.request("PUT", "/api/v1/settings/plan-usage", command({ claude_usage_api_enabled: false, poll_interval_minutes: 10 }, "plan-settings"));
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).data, { claude_usage_api_enabled: false, poll_interval_minutes: 10 });
  assert.equal(db.all("SELECT snapshot_json FROM plan_usage_snapshots").some((row) => row.snapshot_json?.includes(canary)), false);
  assert.ok(warnings.some((message) => message.includes("claude_usage_api: ok -> unavailable")));
  assert.equal(warnings.join("\n").includes(canary), false);
});
