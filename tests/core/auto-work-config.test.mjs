import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AutoWorkConfigLoader, findAutoWorkRule, mergeAutoWorkConfig, readAutoWorkConfigFile,
} from "../../packages/core/dist/auto-work/config.js";

const defaultsPath = fileURLToPath(new URL("../../rules/auto-work/defaults.json", import.meta.url));
const defaultsText = await readFile(defaultsPath, "utf8");
const defaults = readAutoWorkConfigFile("defaults.json", defaultsText, "defaults");
const NONE = { global: null, project: null };
const read = (value, layer) => readAutoWorkConfigFile("x.json", JSON.stringify(value), layer);
const customRule = (id) => ({ id, source: "failure_notice", kinds: ["process_failed"], min_occurrences: 1, window_minutes: 0, action: "draft", size: "small", intent: "custom" });

test("a Project layer overrides a rule field and the field is listed in overridden_fields", () => {
  const project = read({ rules: [{ id: "failure-notice", min_occurrences: 1 }] }, "project");
  const merged = mergeAutoWorkConfig(defaults, null, project, NONE);
  const base = defaults.rules.find((rule) => rule.id === "failure-notice");
  const rule = merged.rules.find((entry) => entry.id === "failure-notice");
  assert.equal(rule.min_occurrences, 1);
  assert.notEqual(rule.min_occurrences, base.min_occurrences);
  assert.deepEqual(rule.overridden_fields, ["min_occurrences"]);
  assert.equal(rule.origin, "defaults");
  assert.equal(rule.window_minutes, base.window_minutes);
});

test("a custom rule is appended after the base rules and a disabled rule is not matched", () => {
  const project = read({ rules: [customRule("deploy-failed"), { id: "failure-notice", disabled: true }] }, "project");
  const merged = mergeAutoWorkConfig(defaults, null, project, NONE);
  assert.equal(merged.rules.at(-1).id, "deploy-failed");
  assert.equal(merged.rules.at(-1).origin, "project");
  assert.equal(merged.rules.length, defaults.rules.length + 1);
  // failure-notice is off, so process_failed falls to the custom rule.
  assert.equal(findAutoWorkRule(merged.rules, "failure_notice", "process_failed").id, "deploy-failed");
  assert.equal(findAutoWorkRule(merged.rules, "failure_notice", "log_error"), null);
});

test("a rule matches by the highest layer first", () => {
  const local = read({ rules: [customRule("local-rule")] }, "local");
  const project = read({ rules: [customRule("project-rule")] }, "project");
  const merged = mergeAutoWorkConfig(defaults, local, project, NONE);
  assert.equal(findAutoWorkRule(merged.rules, "failure_notice", "process_failed").id, "project-rule");
  const withoutProject = mergeAutoWorkConfig(defaults, local, null, NONE);
  assert.equal(findAutoWorkRule(withoutProject.rules, "failure_notice", "process_failed").id, "local-rule");
});

test("arrays are replaced whole, scalars come from the highest layer, comments merge by key", () => {
  const local = read({ github: { allowed_users: ["@me", "friend"], mention: "@helper" }, scheduled_check: { times: ["07:00", "19:00"] } }, "local");
  const project = read({ github: { repo: "owner/name", allowed_users: ["@me"], comments: { created: "created" } }, scheduled_check: { times: ["08:30"] } }, "project");
  const merged = mergeAutoWorkConfig(defaults, local, project, NONE);
  assert.deepEqual(merged.github.allowed_users, ["@me"]);
  assert.deepEqual(merged.scheduled_check.times, ["08:30"]);
  assert.deepEqual(merged.scheduled_check.items, defaults.scheduled_check.items);
  assert.equal(merged.github.mention, "@helper");
  assert.equal(merged.github.repo, "owner/name");
  assert.equal(merged.github.comments.created, "created");
  assert.equal(merged.github.comments.completed, defaults.github.comments.completed);
  assert.deepEqual(mergeAutoWorkConfig(defaults, local, null, NONE).github.allowed_users, ["@me", "friend"]);
});

test("the DB switch beats the files", () => {
  const project = read({ enabled: true }, "project");
  const local = read({ enabled: false }, "local");
  assert.deepEqual(mergeAutoWorkConfig(defaults, local, project, NONE).enabled, { effective: true, from: "project_file" });
  assert.deepEqual(mergeAutoWorkConfig(defaults, local, project, NONE).global_enabled, { effective: false, from: "local_file" });
  const off = mergeAutoWorkConfig(defaults, local, project, { global: true, project: false });
  assert.deepEqual(off.enabled, { effective: false, from: "db" });
  assert.deepEqual(off.global_enabled, { effective: true, from: "db" });
  assert.deepEqual(mergeAutoWorkConfig(defaults, null, null, NONE).enabled, { effective: false, from: "defaults" });
});

test("files that hold credentials, a model, or values only the global layers decide are refused", () => {
  assert.throws(() => read({ github: { api_token: "x" } }, "local"), /api_token/);
  assert.throws(() => read({ rules: [{ ...customRule("a"), params: { Secret: 1 } }] }, "project"), /Secret/);
  assert.throws(() => read({ model: "m" }, "local"), /model/);
  assert.throws(() => read({ limits: { day_start_time: "04:00" } }, "project"), /day_start_time/);
  assert.throws(() => read({ limits: { max_works_per_day_all: 5 } }, "project"), /max_works_per_day_all/);
  assert.throws(() => read({ judge_role: "worker" }, "project"), /judge_role/);
  assert.throws(() => read({ github: { repo: "owner/name" } }, "local"), /github\.repo/);
  assert.doesNotThrow(() => read({ limits: { max_works_per_day: 1, cooldown_hours: 2 } }, "project"));
});

test("values are validated", () => {
  assert.throws(() => read({ unknown: 1 }, "local"), /unknown/);
  assert.throws(() => read({ scheduled_check: { times: ["9:00"] } }, "local"), /HH:MM/);
  assert.throws(() => read({ github: { per_page: 101 } }, "local"), /per_page/);
  assert.throws(() => read({ github: { since_margin_seconds: -1 } }, "local"), /since_margin_seconds/);
  assert.throws(() => read({ github: { max_item_attempts: 0 } }, "local"), /max_item_attempts/);
  assert.throws(() => read({ github: { output_limit_bytes: 0 } }, "local"), /output_limit_bytes/);
  assert.throws(() => read({ github: { repo: "not a repo" } }, "project"), /owner\/name/);
  assert.throws(() => read({ watch: { logs: [{ path: "relative.log", pattern: "x", kind: "log_error" }] } }, "project"), /absolute/);
  assert.throws(() => read({ watch: { logs: [{ path: "/a.log", pattern: "(", kind: "log_error" }] } }, "project"), /regular expression/);
  assert.throws(() => read({ watch: { commands: [{ argv: [], interval_minutes: 1, kind: "process_stopped" }] } }, "project"), /argv/);
  assert.throws(() => read({ rules: [{ id: "Bad Id" }] }, "local"), /id/);
  assert.throws(() => read({ rules: [{ id: "dup" }, { id: "dup" }] }, "local"), /twice/);
  assert.throws(() => read({ rules: [{ id: "a", action: "run" }] }, "local"), /action/);
  assert.throws(() => readAutoWorkConfigFile("defaults.json", JSON.stringify({ schema_version: 1 }), "defaults"), /required/);
  assert.throws(() => readAutoWorkConfigFile("x.json", "{", "local"), /JSON/);
});

test("a new rule that lacks required fields is refused when merged", () => {
  const project = read({ rules: [{ id: "half", source: "github" }] }, "project");
  assert.throws(() => mergeAutoWorkConfig(defaults, null, project, NONE), /half/);
});

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "owl-auto-work-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "projects"));
  await writeFile(join(directory, "defaults.json"), defaultsText);
  const alerts = [];
  const loader = new AutoWorkConfigLoader({ directory, onAlert: (kind, detail) => alerts.push({ kind, detail }) });
  return { directory, loader, alerts };
}

test("a broken Project file keeps the previous settings and sets config_error; fixing it clears the error", async (t) => {
  const { directory, loader, alerts } = await setup(t);
  const file = join(directory, "projects", "proj1.json");
  await writeFile(file, JSON.stringify({ scheduled_check: { times: ["08:30"] } }));
  await loader.reload();
  assert.equal(loader.configError, null);
  assert.deepEqual(loader.effective("proj1", NONE).scheduled_check.times, ["08:30"]);

  await writeFile(file, "{ broken");
  await loader.reload();
  assert.match(loader.configError, /proj1\.json/);
  assert.deepEqual(loader.effective("proj1", NONE).scheduled_check.times, ["08:30"]);
  assert.equal(loader.effective("proj1", NONE).config_error, loader.configError);
  assert.deepEqual(alerts.map((alert) => alert.kind), ["auto_work_config_invalid"]);

  await loader.reload();
  assert.equal(alerts.length, 1, "the same error does not alert twice");

  await writeFile(file, JSON.stringify({ scheduled_check: { times: ["10:00"] } }));
  await loader.reload();
  assert.equal(loader.configError, null);
  assert.deepEqual(loader.effective("proj1", NONE).scheduled_check.times, ["10:00"]);
  assert.deepEqual(alerts.map((alert) => alert.kind), ["auto_work_config_invalid", "auto_work_config_restored"]);

  await rm(file);
  await loader.reload();
  assert.deepEqual(loader.effective("proj1", NONE).scheduled_check.times, defaults.scheduled_check.times);
});

test("a token key in local.json is refused and the previous local settings stay", async (t) => {
  const { directory, loader } = await setup(t);
  await writeFile(join(directory, "local.json"), JSON.stringify({ github: { mention: "@first" } }));
  await loader.reload();
  await writeFile(join(directory, "local.json"), JSON.stringify({ github: { mention: "@second", gh_token: "x" } }));
  await loader.reload();
  assert.match(loader.configError, /gh_token/);
  assert.equal(loader.effective("p", NONE).github.mention, "@first");
});

test("without a readable defaults.json the feature has no settings and reports an error", async (t) => {
  const { directory, loader } = await setup(t);
  await rm(join(directory, "defaults.json"));
  await loader.reload();
  assert.equal(loader.effective("p", NONE), null);
  assert.match(loader.configError, /defaults\.json/);
});

test("the shipped defaults.json is valid and carries no personal values", () => {
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.github.repo, null);
  assert.ok(!/\/Users\/|\/home\//.test(defaultsText));
});
