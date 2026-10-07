import assert from "node:assert/strict";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  codexRateLimitsFromJsonl,
  codexRateLimitsObservation,
  findCodexRateLimits,
} from "../../packages/shared/dist/plan-usage-codex.js";
import { tempDir } from "../helpers/temp.mjs";
import { createCodexSessionLogSource } from "../../packages/core/dist/plan-usage/codex-source.js";

const observedAt = new Date("2026-10-03T00:00:00.000Z");

function rateLimits(usedPercent, overrides = {}) {
  return {
    primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1791000000 },
    secondary: { used_percent: 72, window_minutes: 10080, resets_at: 1791600000 },
    plan_type: "plus",
    ...overrides,
  };
}

function event(value, timestamp = "2026-10-03T00:00:00.000Z") {
  return JSON.stringify({ type: "event_msg", timestamp, payload: { type: "token_count", rate_limits: value } });
}

async function tempHome(t) {
  return tempDir(t, "owl-codex-usage-");
}

async function logFile(home, day, name, lines, mtime) {
  const path = join(home, "sessions", ...day.split("/"), name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n");
  if (mtime !== undefined) await utimes(path, mtime, mtime);
  return path;
}

test("finds Codex rate limits at exec and app-server paths and maps windows", () => {
  const raw = rateLimits(50);
  assert.equal(findCodexRateLimits({ payload: { rate_limits: raw } }), raw);
  assert.equal(findCodexRateLimits({ params: { rateLimits: raw } }), raw);

  const snapshot = codexRateLimitsObservation(raw, observedAt, "codex_live");
  assert.equal(snapshot.harness, "codex");
  assert.equal(snapshot.origin, "codex_live");
  assert.equal(snapshot.plan_type, "plus");
  assert.deepEqual(snapshot.windows.map(({ id, kind, used_percent, window_minutes, state }) => ({ id, kind, used_percent, window_minutes, state })), [
    { id: "primary", kind: "five_hour", used_percent: 50, window_minutes: 300, state: null },
    { id: "secondary", kind: "weekly", used_percent: 72, window_minutes: 10080, state: null },
  ]);
  assert.equal(codexRateLimitsObservation(rateLimits(100), observedAt, "codex_live").windows[0].state, "limited");
});

test("accepts snake and camel case Codex fields and ignores unreadable windows", () => {
  const snapshot = codexRateLimitsObservation({
    primary: { usedPercent: 41.26, windowDurationMins: 300, resetsAt: "2026-10-04T00:00:00Z" },
    secondary: { used_percent: "bad", window_minutes: -1 },
    planType: "team_1",
  }, observedAt, "codex_live");
  assert.equal(snapshot.windows.length, 1);
  assert.deepEqual(snapshot.windows[0], {
    id: "primary", kind: "five_hour", used_percent: 41.3,
    resets_at: "2026-10-04T00:00:00.000Z", window_minutes: 300,
    state: null, label: null,
  });
  assert.equal(snapshot.plan_type, "team_1");
  assert.equal(codexRateLimitsObservation({ primary: {}, secondary: {} }, observedAt, "codex_live"), null);
});

test("JSONL parsing skips corrupt rows and chooses the last readable event", () => {
  const parsed = codexRateLimitsFromJsonl([
    event(rateLimits(20)),
    "{broken rate_limits",
    event(rateLimits(80)),
  ].join("\n"), observedAt);
  assert.equal(parsed.windows[0].used_percent, 80);
  assert.equal(codexRateLimitsFromJsonl("{broken rate_limits\n{}", observedAt), null);
});

test("session source chooses the newest mtime, tolerating malformed and missing fields", async (t) => {
  const home = await tempHome(t);
  const old = new Date("2026-10-01T12:00:00Z");
  const newest = new Date("2026-10-03T12:00:00Z");
  await logFile(home, "2026/10/01", "rollout-old.jsonl", [event(rateLimits(20))], old);
  await logFile(home, "2026/10/03", "rollout-new.jsonl", [
    "{bad rate_limits",
    event({ primary: { used_percent: "missing" }, secondary: { usedPercent: 63, windowDurationMins: 10080 } }, "2026-10-03T11:00:00Z"),
  ], newest);

  const result = await createCodexSessionLogSource({ codexHome: home, tailBytes: 64 }).fetch(new AbortController().signal);
  assert.equal(result.status, "ok");
  assert.equal(result.snapshot.windows.length, 1);
  assert.equal(result.snapshot.windows[0].id, "secondary");
  assert.equal(result.snapshot.windows[0].used_percent, 63);
  assert.equal(result.snapshot.observed_at, "2026-10-03T11:00:00.000Z");
});

test("session source returns not_installed when sessions directory is absent", async (t) => {
  const home = await tempHome(t);
  const result = await createCodexSessionLogSource({ codexHome: home }).fetch(new AbortController().signal);
  assert.deepEqual(result, { status: "not_installed", snapshot: null, detail: null });
});

test("session source caches an unchanged newest file by path, mtime and size", async (t) => {
  const home = await tempHome(t);
  const fixedMtime = new Date("2026-10-03T00:00:00.000Z");
  const path = await logFile(home, "2026/10/03", "rollout-cache.jsonl", [event(rateLimits(11))], fixedMtime);
  const source = createCodexSessionLogSource({ codexHome: home });
  const first = await source.fetch(new AbortController().signal);
  const before = await stat(path);
  await writeFile(path, event(rateLimits(22)) + "\n");
  await utimes(path, before.atime, before.mtime);
  const second = await source.fetch(new AbortController().signal);
  assert.equal(first.snapshot.windows[0].used_percent, 11);
  assert.equal(second.snapshot.windows[0].used_percent, 11);
});

test("session source refreshes a snapshot when its older source file changes", async (t) => {
  const home = await tempHome(t);
  const older = new Date("2026-10-02T12:00:00Z");
  const newest = new Date("2026-10-03T12:00:00Z");
  const sourcePath = await logFile(home, "2026/10/02", "rollout-source.jsonl", [event(rateLimits(10))], older);
  await logFile(home, "2026/10/03", "rollout-newest.jsonl", ["{broken rate_limits"], newest);
  const source = createCodexSessionLogSource({ codexHome: home });

  const first = await source.fetch(new AbortController().signal);
  const sourceStat = await stat(sourcePath);
  await writeFile(sourcePath, event(rateLimits(60)) + "\n");
  await utimes(sourcePath, sourceStat.atime, sourceStat.mtime);
  const second = await source.fetch(new AbortController().signal);

  assert.equal(first.status, "ok");
  assert.equal(first.snapshot.windows[0].used_percent, 10);
  assert.equal(second.status, "ok");
  assert.equal(second.snapshot.windows[0].used_percent, 60);
});

test("session source enforces maxFiles when looking past the newest file", async (t) => {
  const home = await tempHome(t);
  const old = new Date("2026-10-02T12:00:00Z");
  const newest = new Date("2026-10-03T12:00:00Z");
  await logFile(home, "2026/10/02", "rollout-valid.jsonl", [event(rateLimits(44))], old);
  await logFile(home, "2026/10/03", "rollout-newest.jsonl", ["{broken rate_limits"], newest);

  const result = await createCodexSessionLogSource({ codexHome: home, maxFiles: 1 }).fetch(new AbortController().signal);
  assert.equal(result.status, "no_data");
  assert.equal(result.detail, "no_rate_limits");
});
