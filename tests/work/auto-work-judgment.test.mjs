import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { Core, NoopGitGateway } from "../../packages/core/dist/index.js";
import { buildDedupeKey, normalizeDedupeText } from "../../packages/core/dist/auto-work/stage-one.js";
import { FakeClock } from "../helpers/clock.mjs";
import { createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const T0 = new Date(2026, 5, 1, 10, 0, 0);
const minutes = (n) => new Date(T0.getTime() + n * 60_000);

const worth = (extra = {}) => ({
  ok: true,
  judgment: { worth_fixing: true, reason: "直す価値がある", duplicate_of_work_id: null, duplicate_reason: null, work: { title: "自動 Work", summary: "原因を調べて直す", size: "normal" }, ...extra },
});

function signal(overrides = {}) {
  return {
    source: "scheduled_check",
    project_id: "proj1",
    kind: "nightly_test_failed",
    title: "夜間テストが失敗した",
    detail: "tests/foo.test.mjs が落ちた",
    dedupe: { kind: "id", value: "nightly:1" },
    occurred_at: T0.toISOString(),
    backlog_item_ids: [],
    github: null,
    failure: null,
    ...overrides,
  };
}

/** A Core with automatic Work creation on, a fake clock and a judgment stub that records its requests. */
async function setup(t, { respond = async () => worth(), local = null, project = null, enabled = true, ...coreOptions } = {}) {
  const calls = [];
  const runAutoWorkJudgment = async (request) => {
    calls.push(request);
    return respond(request, calls.length);
  };
  const clock = new FakeClock(T0);
  const { root, db, core } = await createTestCore(t, {
    git: new NoopGitGateway(),
    version: "auto-work-judgment",
    agentRunner: { runAutoWorkJudgment },
    // gh is never the real one in tests: a GitHub signal here would otherwise comment on a real repository.
    autoWork: { clock, gh: async () => ({ exit_code: 1, stdout: "", stderr: "gh is not available in this test", timed_out: false, stdout_truncated: false }) },
    ...coreOptions,
  }, { prefix: "owl-auto-work-judgment-" });
  const directory = join(root, "rules", "auto-work");
  await mkdir(join(directory, "projects"), { recursive: true });
  await writeFile(join(directory, "defaults.json"), await readFile(new URL("../../rules/auto-work/defaults.json", import.meta.url), "utf8"));
  if (local) await writeFile(join(directory, "local.json"), JSON.stringify(local));
  if (project) await writeFile(join(directory, "projects", "proj1.json"), JSON.stringify(project));
  const now = T0.toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'owner:default', ?, ?)", now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
         verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES ('proj1', 'owner:default', 'Project 1', ?, 'main', '[]', '[]', '[]', ?, ?)`,
      join(root, "proj1"), now, now,
    );
    if (enabled) {
      tx.run(
        `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('auto_work', 'owner:default', '1.0.0', ?, ?)`,
        JSON.stringify({ schema_version: "1.0.0", version: 1, enabled: true, projects: { proj1: { enabled: true } } }), now,
      );
    }
  });
  await core.start();
  const events = () => db.all("SELECT * FROM auto_work_events ORDER BY created_at, id");
  const works = () => db.all("SELECT * FROM works ORDER BY created_at, id");
  return { root, db, core, clock, calls, events, works };
}

test("normalizeDedupeText hides times, long numbers and hashes but keeps short numbers", () => {
  assert.equal(normalizeDedupeText("Failed at 2026-06-01T10:00:00Z pid 123456"), normalizeDedupeText("Failed at 2026-06-02T11:30:05Z pid 987654"));
  assert.equal(normalizeDedupeText("error 12:30:05 abcdef0123456789"), normalizeDedupeText("error 08:01 0123456789abcdef"));
  assert.notEqual(normalizeDedupeText("exit code 1"), normalizeDedupeText("exit code 2"));
  assert.notEqual(normalizeDedupeText("status 404"), normalizeDedupeText("status 500"));
});

test("dedupe_key keeps id values as they are and normalizes only text", () => {
  const key = (dedupe, extra = {}) => buildDedupeKey("proj1", { source: "failure_notice", dedupe, ...extra });
  assert.equal(key({ kind: "text", value: "pid 123456 died" }), key({ kind: "text", value: "pid 987654 died" }));
  assert.notEqual(key({ kind: "id", value: "pid 123456 died" }), key({ kind: "id", value: "pid 987654 died" }));
  const sha = (last) => `${"a".repeat(63)}${last}`;
  assert.notEqual(key({ kind: "id", value: sha("1") }), key({ kind: "id", value: sha("2") }));
  assert.notEqual(key({ kind: "id", value: "owner/repo#123456" }), key({ kind: "id", value: "owner/repo#123457" }));
  assert.equal(key({ kind: "id", value: sha("1") }), createHash("sha256").update(["proj1", "failure_notice", "id", sha("1")].join("\0")).digest("hex"));
  assert.equal(key({ kind: "text", value: "error at 10:00:01 pid 4242424" }), key({ kind: "text", value: "error at 11:30:59 pid 9191919" }));
  assert.notEqual(key({ kind: "id", value: "same" }), key({ kind: "text", value: "same" }));
  assert.notEqual(buildDedupeKey("proj1", { source: "failure_notice", dedupe: { kind: "id", value: "x" } }), buildDedupeKey("proj2", { source: "failure_notice", dedupe: { kind: "id", value: "x" } }));
  assert.notEqual(buildDedupeKey("proj1", { source: "failure_notice", dedupe: { kind: "id", value: "x" } }), buildDedupeKey("proj1", { source: "github", dedupe: { kind: "id", value: "x" } }));
});

test("the default rule makes a memo Work with the fixed footer and asks the model set for judge_role", async (t) => {
  const { core, calls, events, works } = await setup(t);
  const result = await core.receiveAutoWorkSignal(signal());
  assert.equal(result.verdict, "created");
  const [work] = works();
  assert.equal(work.id, result.work_id);
  assert.equal(work.state, "memo");
  assert.equal(work.project_id, "proj1");
  assert.equal(work.title, "自動 Work");
  assert.match(work.summary, /^原因を調べて直す/);
  assert.match(work.summary, /---\n自動作成: 定期の見回り \/ ルール nightly-test-failed \/ 起きた時刻 .+\nきっかけ: 夜間テストが失敗した\n$/);
  const [event] = events();
  assert.equal(event.verdict, "created");
  assert.equal(event.work_id, work.id);
  assert.equal(event.action, "draft");
  assert.equal(event.rule_id, "nightly-test-failed");
  assert.equal(calls.length, 1);
  const role = core.getModelSettings().roles.find((setting) => setting.role === "manager");
  assert.deepEqual(calls[0].model, { provider: role.provider.trim().toLowerCase(), model: role.model, effort: role.effort });
});

test("the agent runner hands the judgment request's provider, model and effort to the provider", async (t) => {
  const { core, calls } = await setup(t);
  await core.receiveAutoWorkSignal(signal());
  const role = core.getModelSettings().roles.find((setting) => setting.role === "manager");
  const requests = [];
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: {
      execute: async (request) => {
        requests.push(request);
        return { adapter: request.adapter, stdout: JSON.stringify(worth().judgment), stderr: "", exit_code: 0, signal: null, format: "plain-text" };
      },
    },
  });
  for (const [provider, adapter] of [["anthropic", "claude-cli/v1"], ["openai", "codex"]]) {
    const result = await runner.runAutoWorkJudgment({ ...calls[0], model: { ...calls[0].model, provider } });
    assert.equal(result.ok, true);
    const request = requests.at(-1);
    assert.equal(request.adapter, adapter);
    assert.equal(request.model, role.model);
    assert.equal(request.effort, role.effort);
  }
});

test("a failed judgment leaves no Work, and a stage-one skip never reaches the model", async (t) => {
  const { core, calls, events, works } = await setup(t, { respond: async (_request, n) => (n === 1 ? { ok: false, error: "provider_failed:boom" } : n === 2 ? (() => { throw new Error("exploded"); })() : { ok: true, judgment: { nonsense: true } }) });
  for (const [index, expected] of ["provider_failed:boom", "exploded", /^invalid_judgment:/].entries()) {
    const result = await core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: `failing:${index}` } }));
    assert.equal(result.verdict, "judge_failed");
    const reason = events().find((event) => event.id === result.event_id).verdict_reason;
    if (typeof expected === "string") assert.equal(reason, expected); else assert.match(reason, expected);
  }
  assert.equal(works().length, 0);
  assert.equal(calls.length, 3);
  const before = calls.length;
  assert.equal((await core.receiveAutoWorkSignal(signal({ kind: "unknown_kind", source: "github" }))).verdict, "unauthorized");
  assert.equal((await core.receiveAutoWorkSignal(signal({ kind: "unknown_kind" }))).verdict, "no_rule");
  assert.equal(calls.length, before);
  assert.equal(events().length, 5);
});

test("an AI answer that the signal is not worth a Work is recorded with its reason", async (t) => {
  const { core, events, works } = await setup(t, { respond: async () => worth({ worth_fixing: false, reason: "価値が低い", work: null }) });
  const result = await core.receiveAutoWorkSignal(signal());
  assert.equal(result.verdict, "not_worth");
  assert.equal(events()[0].verdict_reason, "価値が低い");
  assert.equal(works().length, 0);
});

test("a duplicate answer from the AI refers to an open Work it was shown", async (t) => {
  let shown = null;
  const { core, events, works } = await setup(t, {
    respond: async (request, n) => {
      if (n === 1) return worth();
      shown = request.open_works;
      return worth({ duplicate_of_work_id: request.open_works[0].work_id, duplicate_reason: "同じ原因" });
    },
  });
  const first = await core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: "a" } }));
  const second = await core.receiveAutoWorkSignal(signal({ title: "別の見え方", dedupe: { kind: "id", value: "b" } }));
  assert.equal(second.verdict, "duplicate");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].auto_created, true);
  const row = events().find((event) => event.id === second.event_id);
  assert.equal(row.duplicate_of_work_id, first.work_id);
  assert.equal(row.verdict_reason, "同じ原因");
  assert.equal(works().length, 1);
});

test("the same signal is a duplicate while its Work is open and inside the cooldown, then creates again", async (t) => {
  const { core, clock, calls, db, works } = await setup(t);
  const first = await core.receiveAutoWorkSignal(signal());
  assert.equal(first.verdict, "created");
  const again = await core.receiveAutoWorkSignal(signal());
  assert.equal(again.verdict, "duplicate");
  assert.equal(calls.length, 1);
  assert.equal(db.get("SELECT duplicate_of_work_id AS id FROM auto_work_events WHERE id = ?", again.event_id).id, first.work_id);

  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'completed' WHERE id = ?", first.work_id));
  await clock.advanceTo(minutes(60));
  assert.equal((await core.receiveAutoWorkSignal(signal())).verdict, "duplicate");
  assert.equal(calls.length, 1);

  await clock.advanceTo(new Date(T0.getTime() + 25 * 3_600_000));
  assert.equal((await core.receiveAutoWorkSignal(signal())).verdict, "created");
  assert.equal(works().length, 2);
});

test("below_threshold counts occurrences inside the window only", async (t) => {
  const { core, clock, calls, works } = await setup(t);
  const failing = (value) => signal({ source: "failure_notice", kind: "process_failed", dedupe: { kind: "text", value } });
  assert.equal((await core.receiveAutoWorkSignal(failing("worker died pid 111111"))).verdict, "below_threshold");
  // 90 minutes later the first one left the 60-minute window.
  await clock.advanceTo(minutes(90));
  assert.equal((await core.receiveAutoWorkSignal(failing("worker died pid 222222"))).verdict, "below_threshold");
  await clock.advanceTo(minutes(100));
  assert.equal((await core.receiveAutoWorkSignal(failing("worker died pid 333333"))).verdict, "created");
  assert.equal(calls.length, 1);
  assert.equal(works().length, 1);
});

test("max_works_per_day stops creation until the day that starts at day_start_time", async (t) => {
  const { core, clock, calls, works } = await setup(t, { local: { limits: { max_works_per_day: 1, day_start_time: "04:00" } } });
  const next = (n) => signal({ dedupe: { kind: "id", value: `n:${n}` } });
  assert.equal((await core.receiveAutoWorkSignal(next(1))).verdict, "created");
  assert.equal((await core.receiveAutoWorkSignal(next(2))).verdict, "daily_cap");
  // 03:30 the next calendar day still belongs to the first day.
  await clock.advanceTo(new Date(2026, 5, 2, 3, 30));
  assert.equal((await core.receiveAutoWorkSignal(next(3))).verdict, "daily_cap");
  await clock.advanceTo(new Date(2026, 5, 2, 4, 0));
  assert.equal((await core.receiveAutoWorkSignal(next(4))).verdict, "created");
  assert.equal(calls.length, 2);
  assert.equal(works().length, 2);
});

test("day_start_time in a Project file is rejected and the effective value is unchanged", async (t) => {
  const { core } = await setup(t, { project: { limits: { day_start_time: "04:00" } } });
  assert.match(core.autoWorkConfig.configError ?? "", /day_start_time/);
  assert.equal(core.autoWorkConfig.effective("proj1", { global: true, project: true }).limits.day_start_time, "00:00");
});

test("two signals received at the same time make one Work", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { core, calls, events, works } = await setup(t, { respond: async () => { await gate; return worth(); } });
  const both = Promise.all([core.receiveAutoWorkSignal(signal()), core.receiveAutoWorkSignal(signal())]);
  await waitFor(() => events().length === 2);
  release();
  const results = await both;
  assert.deepEqual(results.map((result) => result.verdict).sort(), ["created", "duplicate"]);
  assert.equal(works().length, 1);
  assert.equal(calls.length, 1);
  const duplicate = events().find((event) => event.verdict === "duplicate");
  assert.equal(duplicate.duplicate_of_work_id, null);
  assert.equal(duplicate.duplicate_of_event_id, events().find((event) => event.verdict === "created").id);
});

test("with max_works_per_day 1 two different signals received at the same time make one Work and one daily_cap", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { core, calls, events, works } = await setup(t, { local: { limits: { max_works_per_day: 1 } }, respond: async () => { await gate; return worth(); } });
  const both = Promise.all([
    core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: "x:1" } })),
    core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: "x:2" } })),
  ]);
  await waitFor(() => events().length === 2);
  release();
  assert.deepEqual((await both).map((result) => result.verdict).sort(), ["created", "daily_cap"]);
  assert.equal(works().length, 1);
  assert.equal(calls.length, 1);
});

const githubSignal = (overrides = {}) => signal({
  source: "github",
  kind: "issue_opened",
  title: "他人の Issue の題",
  detail: "他人の Issue の本文",
  dedupe: { kind: "id", value: "owner/repo#7" },
  github: { repo: "owner/repo", issue_number: 7, is_pull_request: false, comment_id: null, author: "Some-User", author_is_bot: false, labels: [], url: "https://example.test/7", updated_at: T0.toISOString() },
  ...overrides,
});

test("an unauthorized GitHub signal is recorded without its text and without the AI", async (t) => {
  const { core, calls, events } = await setup(t);
  const result = await core.receiveAutoWorkSignal(githubSignal());
  assert.equal(result.verdict, "unauthorized");
  const [row] = events();
  assert.equal(row.title, "");
  assert.equal(row.detail, "");
  assert.equal(row.github_author, "Some-User");
  assert.equal(row.github_repo, "owner/repo");
  assert.equal(row.github_issue_number, 7);
  assert.equal(row.github_url, "https://example.test/7");
  assert.equal(calls.length, 0);
});

test("@me allows the login the GitHub side resolved, and nobody when it is not resolved", async (t) => {
  const { core, calls, works } = await setup(t);
  assert.equal((await core.receiveAutoWorkSignal(githubSignal())).verdict, "unauthorized");
  core.autoWork.registerGithubLogin(() => null);
  assert.equal((await core.receiveAutoWorkSignal(githubSignal())).verdict, "unauthorized");
  core.autoWork.registerGithubLogin(() => "SOME-user");
  assert.equal((await core.receiveAutoWorkSignal(githubSignal())).verdict, "created");
  assert.equal((await core.receiveAutoWorkSignal(githubSignal({ dedupe: { kind: "id", value: "owner/repo#8" }, github: { ...githubSignal().github, author: "someone-else" } }))).verdict, "unauthorized");
  assert.equal(calls.length, 1);
  assert.equal(works().length, 1);
});

test("the AI is shown the head of the Project overview, cut to max_detail_chars", async (t) => {
  const { core, calls } = await setup(t, { local: { max_detail_chars: 100 } });
  const none = await core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: "o:1" } }));
  assert.equal(none.verdict, "created");
  assert.equal(calls[0].project.overview, null);
  core.pageRouter.readOverview = async (projectId) => (projectId === "proj1" ? [`【目的】${"あ".repeat(150)}`] : []);
  await core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: "o:2" } }));
  assert.equal(calls[1].project.overview, `【目的】${"あ".repeat(96)}`);
});

test("the created alert names the Work and how it was made, in the same row as the Work", async (t) => {
  const { core, db, events } = await setup(t);
  const result = await core.receiveAutoWorkSignal(signal());
  const [alert] = db.all("SELECT work_id, payload_json FROM events WHERE type = 'system.alert'");
  assert.equal(alert.work_id, result.work_id);
  const payload = JSON.parse(alert.payload_json);
  assert.equal(payload.kind, "auto_work_created");
  assert.equal(payload.event_id, result.event_id);
  assert.equal(payload.work_id, result.work_id);
  assert.equal(payload.source, "scheduled_check");
  assert.equal(payload.rule_id, "nightly-test-failed");
  assert.equal(payload.action, "draft");
  assert.equal(payload.display_number, db.get("SELECT display_number AS n FROM works WHERE id = ?", result.work_id).n);
  assert.match(payload.message, new RegExp(`#${payload.display_number} 自動 Work（下書き）`));
  assert.equal(events().length, 1);
});

test("a failure alert is held back only for the same signal, and names the Project and the title", async (t) => {
  const { core, db } = await setup(t, { respond: async () => ({ ok: false, error: "provider_failed:boom" }) });
  const failing = (value, title) => core.receiveAutoWorkSignal(signal({ title, dedupe: { kind: "id", value } }));
  await failing("a", "題A");
  await failing("a", "題A");
  await failing("b", "題B");
  const alerts = db.all("SELECT payload_json FROM events WHERE type = 'system.alert'").map((row) => JSON.parse(row.payload_json));
  assert.equal(alerts.length, 2);
  assert.match(alerts[0].message, /Project 1 \/ 題A/);
  assert.match(alerts[1].message, /Project 1 \/ 題B/);
});

test("finishing a Work reaches the registered handler for a GitHub Work only", async (t) => {
  const { core, db } = await setup(t, { local: { github: { allowed_users: ["some-user"] } } });
  const seen = [];
  core.autoWork.registerWorkFinished(async (event, state) => { seen.push([event.work_id, state]); });
  const github = await core.receiveAutoWorkSignal(githubSignal());
  const plain = await core.receiveAutoWorkSignal(signal());
  assert.equal(github.verdict, "created");
  await core.autoWork.onWorkFinished(plain.work_id, "completed");
  assert.deepEqual(seen, []);
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'running' WHERE id = ?", github.work_id));
  await core.cancelWork(github.work_id, { request_id: "r1", idempotency_key: "cancel-1", expected_version: db.get("SELECT state_version AS v FROM works WHERE id = ?", github.work_id).v, payload: { reason: "不要" } });
  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen, [[github.work_id, "cancelled"]]);
});

test("a judgment that was running when Core stopped is marked judge_failed on the next start", async (t) => {
  const first = await setup(t, { respond: () => new Promise(() => {}) });
  void first.core.receiveAutoWorkSignal(signal());
  await waitFor(() => first.events().some((event) => event.verdict === "judging"));
  await first.core.stop({ force: true });
  const second = new Core({ db: first.db, owlRoot: first.root, git: new NoopGitGateway(), version: "auto-work-judgment", agentRunner: {} });
  try {
    await second.start();
    const [row] = first.db.all("SELECT verdict, verdict_reason FROM auto_work_events");
    assert.deepEqual({ ...row }, { verdict: "judge_failed", verdict_reason: "interrupted" });
    assert.equal(first.db.all("SELECT id FROM works").length, 0);
  } finally {
    await second.stop({ force: true });
  }
});

test("action start starts the new Work, and a failed start keeps the draft with action_error", async (t) => {
  const rule = { rules: [{ id: "nightly-test-failed", action: "start", size: "small" }] };
  const { core, events, works } = await setup(t, { local: rule, respond: async () => worth({ work: { title: "すぐ", summary: "直す", size: "small" } }) });
  const started = [];
  const realStart = core.startWork.bind(core);
  core.startWork = async (workId, request) => {
    started.push({ workId, request });
    return realStart(workId, request);
  };
  const result = await core.receiveAutoWorkSignal(signal());
  assert.equal(result.verdict, "created");
  assert.equal(started.length, 1);
  assert.equal(started[0].workId, result.work_id);
  assert.equal(started[0].request.idempotency_key, `auto-work-start:${result.event_id}`);
  assert.equal(started[0].request.expected_version, 0);
  assert.deepEqual(started[0].request.payload, { mode: "small" });
  assert.ok(["running", "ready"].includes(works()[0].state), works()[0].state);
  assert.equal(events()[0].action, "start");
  assert.equal(events()[0].action_error, null);

  core.startWork = async () => { throw new Error("start refused"); };
  const failed = await core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: "other" } }));
  assert.equal(failed.verdict, "created");
  const draft = works().find((work) => work.id === failed.work_id);
  assert.equal(draft.state, "memo");
  const row = events().find((event) => event.id === failed.event_id);
  assert.equal(row.verdict, "created");
  assert.match(row.action_error, /start refused/);
});

test("with the feature off nothing is judged or created", async (t) => {
  const { core, calls, works, events } = await setup(t, { enabled: false });
  const result = await core.receiveAutoWorkSignal(signal());
  assert.equal(result.verdict, "disabled");
  assert.equal(calls.length, 0);
  assert.equal(works().length, 0);
  assert.equal(events()[0].verdict, "disabled");
});

test("runAutoWorkNow only dispatches to a registered handler and refuses a Project that is off", async (t) => {
  const { core } = await setup(t);
  await assert.rejects(() => core.autoWork.runAutoWorkNow("no_such_check", "proj1"), (error) => error.code === "invalid_state_transition");
  core.autoWork.registerRunNow("scheduled_check", async (projectId) => ({ ran: projectId }));
  assert.deepEqual(await core.autoWork.runAutoWorkNow("scheduled_check", "proj1"), { ran: "proj1" });
  const off = await setup(t, { enabled: false });
  off.core.autoWork.registerRunNow("scheduled_check", async () => "ran");
  await assert.rejects(() => off.core.autoWork.runAutoWorkNow("scheduled_check", "proj1"), (error) => error.code === "invalid_state_transition");
});

test("runAutoWorkNow does not run the handler while the global switch is off", async (t) => {
  const { core, db } = await setup(t);
  let ran = 0;
  core.autoWork.registerRunNow("scheduled_check", async () => { ran += 1; });
  await db.createWriteLane().transact((tx) => tx.run(
    "UPDATE settings SET value_json = ? WHERE key = 'auto_work'",
    JSON.stringify({ schema_version: "1.0.0", version: 2, enabled: false, projects: { proj1: { enabled: true } } }),
  ));
  await assert.rejects(() => core.autoWork.runAutoWorkNow("scheduled_check", "proj1"), (error) => error.code === "invalid_state_transition");
  for (const projectId of [null, undefined, ""]) {
    await assert.rejects(() => core.autoWork.runAutoWorkNow("scheduled_check", projectId), (error) => error.code === "invalid_state_transition");
  }
  assert.equal(ran, 0);
});

function stubTrigger() {
  const log = [];
  return {
    log,
    source: "scheduled_check",
    start: (_sink, config, projectId) => log.push(["start", projectId, config.limits.max_works_per_day]),
    reconfigure: (config, projectId) => log.push(["reconfigure", projectId, config.limits.max_works_per_day]),
    stop: async () => { log.push(["stop"]); },
  };
}

test("a registered trigger gets the settings on start, on reconfigure and on a file change, and is stopped with the service", async (t) => {
  const { core, root } = await setup(t, { local: { limits: { max_works_per_day: 3 } } });
  const trigger = stubTrigger();
  core.autoWork.registerTrigger(trigger);
  assert.deepEqual(trigger.log, [["start", "proj1", 3]]);
  core.autoWork.reconfigure();
  assert.deepEqual(trigger.log.at(-1), ["reconfigure", "proj1", 3]);
  // fs.watch can miss a change on a busy machine, so the file is written again until the change arrives.
  await waitFor(async () => {
    await writeFile(join(root, "rules", "auto-work", "local.json"), JSON.stringify({ limits: { max_works_per_day: 7 } }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    return trigger.log.at(-1)?.[2] === 7;
  }, { intervalMs: 0 });
  assert.deepEqual(trigger.log.at(-1), ["reconfigure", "proj1", 7]);
  await core.stop({ force: true });
  assert.deepEqual(trigger.log.at(-1), ["stop"]);
});

test("a trigger sends its signals into receive", async (t) => {
  const { core, works } = await setup(t);
  let sink;
  core.autoWork.registerTrigger({ source: "scheduled_check", start: (s) => { sink = s; }, reconfigure() {}, stop: async () => {} });
  await sink(signal());
  assert.equal(works().length, 1);
});

test("on start, a GitHub Work that finished while Core was off is handed to the handler once", async (t) => {
  const first = await setup(t, { local: { github: { allowed_users: ["some-user"] } } });
  const github = await first.core.receiveAutoWorkSignal(githubSignal());
  const plain = await first.core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: "other" } }));
  assert.equal(github.verdict, "created");
  await first.core.stop({ force: true });
  await first.db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'completed' WHERE id IN (?, ?)", github.work_id, plain.work_id));
  const seen = [];
  const restart = async () => {
    const core = new Core({ db: first.db, owlRoot: first.root, git: new NoopGitGateway(), version: "auto-work-judgment", agentRunner: {} });
    core.autoWork.registerWorkFinished(async (event, state) => { seen.push([event.work_id, state]); });
    await core.start();
    await core.stop({ force: true });
  };
  await restart();
  assert.deepEqual(seen, [[github.work_id, "completed"]]);
  assert.notEqual(first.db.get("SELECT finished_notified_at AS at FROM auto_work_events WHERE id = ?", github.event_id).at, null);
  await restart();
  assert.equal(seen.length, 1);
});

test("when GitHub cannot be told the finished row stays unmarked so a later start can tell it", async (t) => {
  const { core, db } = await setup(t, { local: { github: { allowed_users: ["some-user"] } } });
  const github = await core.receiveAutoWorkSignal(githubSignal());
  await assert.rejects(core.autoWork.onWorkFinished(github.work_id, "completed"));
  assert.equal(db.get("SELECT finished_notified_at AS at FROM auto_work_events WHERE id = ?", github.event_id).at, null);
});

test("a duplicate inside the cooldown of a finished Work still points at that Work", async (t) => {
  const { core, clock, db } = await setup(t);
  const first = await core.receiveAutoWorkSignal(signal());
  await db.createWriteLane().transact((tx) => tx.run("UPDATE works SET state = 'completed' WHERE id = ?", first.work_id));
  await clock.advanceTo(minutes(60));
  const again = await core.receiveAutoWorkSignal(signal());
  assert.equal(again.verdict, "duplicate");
  assert.equal(db.get("SELECT duplicate_of_work_id AS id FROM auto_work_events WHERE id = ?", again.event_id).id, first.work_id);
});

test("the summary footer follows the Owner language and names the source for people", async (t) => {
  const { core, db } = await setup(t);
  const receive = (id) => core.receiveAutoWorkSignal(signal({ dedupe: { kind: "id", value: id } }));
  const ja = await receive("ja");
  const jaSummary = db.get("SELECT summary FROM works WHERE id = ?", ja.work_id).summary;
  assert.match(jaSummary, /自動作成: 定期の見回り \/ ルール nightly-test-failed/);
  assert.doesNotMatch(jaSummary, /scheduled_check/);
  await db.createWriteLane().transact((tx) => tx.run("INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('language', 'owner:default', '1.0.0', '\"en\"', ?)", T0.toISOString()));
  const en = await receive("en");
  const enSummary = db.get("SELECT summary FROM works WHERE id = ?", en.work_id).summary;
  assert.match(enSummary, /Created automatically: scheduled check \/ rule nightly-test-failed/);
  assert.doesNotMatch(enSummary, /自動作成/);
});
