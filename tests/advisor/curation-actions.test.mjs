import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import {
  ADVISOR_CURATION_ACTIONS,
  ADVISOR_CURATION_ACTION_TYPES,
  ADVISOR_CURATION_INSTRUCTION,
  advisorCurationKind,
} from "../../packages/shared/dist/index.js";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

const KINDS = {
  run_librarian: "librarian",
  run_skill_curation: "skill_curation",
  run_rule_curation: "rule_curation",
};

/** Action types that resolve on Object.prototype; none of them is a curation action. */
const HOSTILE_TYPES = ["toString", "constructor", "valueOf", "hasOwnProperty"];

async function setup(t) {
  const { root, db, core } = await createTestCore(t, { agentRunner, version: "advisor-curation-test" }, { prefix: "owl-advisor-curation-" });
  const calls = [];
  core.pageLibrarian.run = async () => {
    calls.push("librarian");
    return { actions_taken: [], actions_needing_approval: [], merged: [], merge_skipped: [], warnings: [] };
  };
  core.curateSkills = async () => {
    calls.push("skill_curation");
    return { state_changes: [], awaiting_approval: [], warnings: [] };
  };
  core.curateRules = () => {
    calls.push("rule_curation");
    return { awaiting_approval: [], rule_findings: [], warnings: [] };
  };
  return { db, root, core, calls };
}

/** Waits for every background curation to finish (the same promises core.stop() waits for). */
const settle = (core) => Promise.allSettled([...core.activeCurations.values()]);

async function startServer(t, core, db, root) {
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const prior = process.env.OWL_API_TOKEN;
  delete process.env.OWL_API_TOKEN;
  t.after(() => {
    if (prior !== undefined) process.env.OWL_API_TOKEN = prior;
  });
  const api = await startTestHttpServer(t, { core: adapter, webOut: root, owlRoot: root });
  if (!api) {
    t.skip("localhost listen is not permitted in this environment");
    return null;
  }
  return `${api.baseUrl}/api/v1`;
}

function action(type, sequence, payload = {}) {
  return { action_id: createUlid(), sequence, type, payload, expected_version: 0 };
}

function envelope(actions, key) {
  return command({ invocation_id: createUlid(), actions }, `idem-${key}`);
}

test("the shared curation action list never resolves an inherited key", () => {
  for (const [type, kind] of Object.entries(KINDS)) {
    assert.equal(ADVISOR_CURATION_ACTION_TYPES.has(type), true);
    assert.equal(advisorCurationKind(type), kind);
    assert.equal(ADVISOR_CURATION_ACTIONS[type], kind);
  }
  for (const type of [...HOSTILE_TYPES, "create_work", "", "RUN_LIBRARIAN"]) {
    assert.equal(ADVISOR_CURATION_ACTION_TYPES.has(type), false, type);
    assert.equal(advisorCurationKind(type), null, type);
  }
  // Reading the map itself must not hand back a function from Object.prototype.
  for (const type of HOSTILE_TYPES) {
    assert.equal(typeof ADVISOR_CURATION_ACTIONS[type], "undefined", type);
  }
  // The Advisor is told to run the curation instead of guessing its result.
  assert.equal(ADVISOR_CURATION_INSTRUCTION.includes('"ナレッジ整理して"'), true);
  assert.equal(ADVISOR_CURATION_INSTRUCTION.includes('"スキル整理して"'), true);
  assert.equal(ADVISOR_CURATION_INSTRUCTION.includes('"ルール整理して"'), true);
  assert.match(ADVISOR_CURATION_INSTRUCTION, /never answer a tidy-up request with create_work/u);
  assert.match(ADVISOR_CURATION_INSTRUCTION, /do not guess or describe the result yourself/u);
  assert.match(ADVISOR_CURATION_INSTRUCTION, /rule proposals that are waiting for the Owner's approval/u);
  assert.match(ADVISOR_CURATION_INSTRUCTION, /never rewrites rules/u);
});

test("the chat reply runs each curation action once, records one run, and appends its summary", async (t) => {
  const { core, calls } = await setup(t);
  const { conversation_id: conversationId } = await core.getActiveConversation();

  for (const [type, kind] of Object.entries(KINDS)) {
    const before = core.listCurationRuns({ limit: 50 }).items.length;
    const turnId = createUlid();
    const messageId = await core.persistAdvisorReply(
      conversationId,
      "承知しました。",
      turnId,
      { channel: "web" },
      [{ type, description: type, payload: {} }],
    );
    assert.ok(messageId, `${type} should still persist a reply`);
    await settle(core);
    const body = core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
    assert.match(body, /承知しました。/, body);
    assert.match(body, /整理を開始しました/u, body);

    const list = core.listCurationRuns({ limit: 50 }).items;
    assert.equal(list.length, before + 1, `${type} should record exactly one run`);
    // Runs created within the same millisecond do not come back in creation
    // order, so find this turn's run by its actor_ref instead of by index.
    const recorded = list.filter((item) => item.actor_ref === turnId);
    assert.equal(recorded.length, 1, `${type} should record one run for this turn`);
    const run = core.getCurationRun(recorded[0].id);
    assert.equal(run.kind, kind);
    assert.equal(run.trigger, "advisor_action");
    assert.equal(run.actor, "advisor");
    assert.equal(run.actor_ref, turnId);
    assert.equal(run.status, "succeeded");
    assert.equal(run.counts.warnings, 0);
    // The reply is written before the run ends, so it carries the run id, not the summary.
    assert.ok(body.includes(run.id), body);
    assert.ok(calls.includes(kind), `${kind} should have run`);
  }
  assert.deepEqual(calls.sort(), ["librarian", "rule_curation", "skill_curation"]);
});

test("the chat reply runs each curation kind at most once per turn, whatever the reply repeats", async (t) => {
  const { core } = await setup(t);
  const { conversation_id: conversationId } = await core.getActiveConversation();
  const before = core.listCurationRuns({ limit: 50 }).items.length;
  const messageId = await core.persistAdvisorReply(
    conversationId,
    "",
    createUlid(),
    { channel: "web" },
    [
      { type: "run_librarian", description: "a", payload: {} },
      { type: "run_librarian", description: "b", payload: {} },
      { type: "run_skill_curation", description: "c", payload: {} },
    ],
  );
  await settle(core);
  assert.equal(core.listCurationRuns({ limit: 50 }).items.length, before + 2);
  const body = core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
  assert.equal(body.split("整理を開始しました").length - 1, 2, body);
});

test("the chat reply ignores a prototype-inherited action type instead of crashing the turn", async (t) => {
  const { core } = await setup(t);
  const { conversation_id: conversationId } = await core.getActiveConversation();
  const before = core.listCurationRuns({ limit: 50 }).items.length;

  for (const type of HOSTILE_TYPES) {
    const messageId = await core.persistAdvisorReply(
      conversationId,
      "そのままでお願いします。",
      createUlid(),
      { channel: "web" },
      [{ type, description: type, payload: {} }],
    );
    assert.ok(messageId, `${type} should not stop the reply from being persisted`);
    const body = core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
    assert.match(body, /そのままでお願いします。/, body);
    assert.doesNotMatch(body, /整理を開始しました/u, body);
  }
  assert.equal(core.listCurationRuns({ limit: 50 }).items.length, before, "no run may be recorded");
});

test("the chat reply summarises the Librarian report from the current Librarian without throwing", async (t) => {
  const { core } = await setup(t);
  core.pageLibrarian.run = async () => ({
    actions_taken: [
      { kind: "merge", path: "notes/a.md" },
      { kind: "merge", path: "notes/b.md" },
      { kind: "tag", path: "notes/c.md" },
      { kind: "archive", path: "notes/d.md" },
    ],
    actions_needing_approval: [{ kind: "delete", path: "notes/e.md" }],
    merged: [{ path: "notes/a.md" }, { path: "notes/b.md" }],
    merge_skipped: [{ path: "notes/f.md", reason: "cross_folder" }],
    warnings: ["w1"],
  });
  const { conversation_id: conversationId } = await core.getActiveConversation();
  const messageId = await core.persistAdvisorReply(
    conversationId,
    "",
    createUlid(),
    { channel: "web" },
    [{ type: "run_librarian", description: "tidy", payload: {} }],
  );
  await settle(core);
  const run = core.listCurationRuns({ limit: 10 }).items[0];
  assert.equal(run.counts.merged, 2);
  assert.equal(run.counts.merge_skipped, 1);
  assert.equal(run.counts.warnings, 1);
  assert.equal(run.counts.actions_taken, 4);
  const body = core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
  assert.ok(body.includes(run.id), body);
  assert.match(run.summary, /merged=2/u);
  assert.match(run.summary, /ほか1件/u);
});

test("the recorded rule curation run says it did not rewrite rules", async (t) => {
  const { core } = await setup(t);
  core.curateRules = () => ({
    awaiting_approval: [
      { id: "p1", text: "ルール案A", verdict: "ok" },
      { id: "p2", text: "ルール案B", verdict: "conflict" },
    ],
    rule_findings: [{ rule_id: "r1", verdict: "near_duplicate" }],
    warnings: [],
  });
  const { conversation_id: conversationId } = await core.getActiveConversation();
  const messageId = await core.persistAdvisorReply(
    conversationId,
    "",
    createUlid(),
    { channel: "web" },
    [{ type: "run_rule_curation", description: "tidy", payload: {} }],
  );
  await settle(core);
  const run = core.listCurationRuns({ limit: 10 }).items[0];
  assert.equal(run.kind, "rule_curation");
  assert.equal(run.counts.awaiting_approval, 2);
  assert.match(run.summary, /ルールは書き換えていません/u);
  assert.match(run.summary, /ルール案A/u);
  assert.equal(core.getCurationRun(run.id).report.awaiting_approval[0].text, "ルール案A");
});

test("POST /advisor/actions runs each kind, returns its summary, and records one run", async (t) => {
  const { db, root, core, calls } = await setup(t);
  const base = await startServer(t, core, db, root);
  if (!base) return;

  for (const [index, [type, kind]] of Object.entries(KINDS).entries()) {
    const before = core.listCurationRuns({ limit: 50 }).items.length;
    const response = await fetch(`${base}/advisor/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope([action(type, 1)], `ok${index}`)),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const result = body.data.results[0];
    assert.equal(result.status, "executed", JSON.stringify(result));
    assert.equal(result.error_code, null);
    assert.equal(result.result.status, "running");
    assert.equal(result.result.started, true);
    assert.match(result.result.run_id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);

    await settle(core);
    const list = core.listCurationRuns({ limit: 50 }).items;
    assert.equal(list.length, before + 1, `${type} should record exactly one run`);
    const run = core.getCurationRun(result.result.run_id);
    assert.equal(run.status, "succeeded");
    assert.match(run.summary, new RegExp(`${kind} run`, "u"));
    assert.equal(run.kind, kind);
    assert.equal(run.trigger, "advisor_action");
    assert.equal(run.actor, "advisor");
    assert.equal(run.actor_ref, body.request_id);
    assert.ok(calls.includes(kind));
  }
});

test("POST /advisor/actions accepts an omitted, null, empty, or reason-only payload", async (t) => {
  const { db, root, core } = await setup(t);
  const base = await startServer(t, core, db, root);
  if (!base) return;

  const variants = [
    { action_id: createUlid(), sequence: 1, type: "run_librarian", expected_version: 0 },
    action("run_librarian", 1, null),
    action("run_librarian", 1, {}),
    action("run_librarian", 1, { reason: "Operator asked for it." }),
  ];
  const responses = await Promise.all(variants.map(async (value, index) => {
    const response = await fetch(`${base}/advisor/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope([value], `variant${index}`)),
    });
    return { status: response.status, body: await response.json() };
  }));
  for (const [index, { status, body }] of responses.entries()) {
    assert.equal(status, 200, `variant ${index}: ${JSON.stringify(body)}`);
    assert.equal(body.data.results[0].status, "executed", `variant ${index}: ${JSON.stringify(body.data.results[0])}`);
  }
  await settle(core);
  // Requests that overlap a running librarian share its run; the rest start after it ended.
  const runs = core.listCurationRuns({ limit: 50 }).items;
  assert.ok(runs.length >= 1 && runs.length <= variants.length);
  assert.ok(runs.every((run) => run.status === "succeeded"));
});

test("POST /advisor/actions rejects an unexpected payload as a contract mismatch", async (t) => {
  const { db, root, core } = await setup(t);
  const base = await startServer(t, core, db, root);
  if (!base) return;

  const rejected = [
    action("run_librarian", 1, { unexpected: true }),
    action("run_librarian", 1, "tidy"),
    action("run_librarian", 1, ["tidy"]),
  ];
  for (const [index, value] of rejected.entries()) {
    const response = await fetch(`${base}/advisor/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope([value], `bad${index}`)),
    });
    const body = await response.json();
    assert.equal(response.status, 400, `case ${index}: ${JSON.stringify(body)}`);
    assert.equal(body.error.code, "validation_error", `case ${index}`);
  }
  assert.equal(core.listCurationRuns({ limit: 50 }).items.length, 0, "a rejected payload must not run a curation");
});

test("POST /advisor/actions refuses a prototype-inherited action type before dispatching", async (t) => {
  const { db, root, core } = await setup(t);
  const base = await startServer(t, core, db, root);
  if (!base) return;

  for (const [index, type] of HOSTILE_TYPES.entries()) {
    const response = await fetch(`${base}/advisor/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope([action(type, 1)], `hostile${index}`)),
    });
    const body = await response.json();
    assert.equal(response.status, 422, `${type}: ${JSON.stringify(body)}`);
    assert.equal(body.error.code, "action_rejected", type);
  }
  assert.equal(core.listCurationRuns({ limit: 50 }).items.length, 0, "no inherited key may reach runCuration");
});

test("POST /advisor/actions returns before a failing curation ends, then the run is failed", async (t) => {
  const { db, root, core } = await setup(t);
  const base = await startServer(t, core, db, root);
  if (!base) return;
  core.pageLibrarian.run = async () => { throw new Error("librarian exploded"); };

  const response = await fetch(`${base}/advisor/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope([action("run_librarian", 1)], "failed")),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.results[0].status, "executed");
  assert.equal(body.data.results[0].result.status, "running");
  await settle(core);
  const run = core.listCurationRuns({ limit: 10 }).items[0];
  assert.equal(run.status, "failed");
  assert.equal(run.error, "librarian exploded");
});

/** A librarian that stays running until release() is called. */
function gatedLibrarian(core) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started = 0;
  core.pageLibrarian.run = async () => {
    started += 1;
    return gate;
  };
  return { release: (value) => release(value), started: () => started };
}

function alerts(core, kind) {
  return core.db.all("SELECT payload_json FROM events WHERE type = 'system.alert'")
    .map((row) => JSON.parse(row.payload_json))
    .filter((payload) => payload.kind === kind);
}

test("the chat reply and POST /advisor/actions return while the curation is still running", async (t) => {
  const { db, root, core } = await setup(t);
  const base = await startServer(t, core, db, root);
  if (!base) return;
  const librarian = gatedLibrarian(core);
  let releaseSkills;
  const skillGate = new Promise((resolve) => { releaseSkills = resolve; });
  core.curateSkills = async () => skillGate;
  const { conversation_id: conversationId } = await core.getActiveConversation();

  const turnId = createUlid();
  const messageId = await core.persistAdvisorReply(conversationId, "", turnId, { channel: "web" }, [{ type: "run_skill_curation", description: "tidy", payload: {} }]);
  const chatRun = core.listCurationRuns({ limit: 10 }).items.find((item) => item.actor_ref === turnId);
  assert.equal(chatRun.status, "running");
  assert.ok(core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body.includes(chatRun.id));

  const response = await fetch(`${base}/advisor/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope([action("run_librarian", 1)], "gated")),
  });
  const result = (await response.json()).data.results[0];
  assert.equal(result.status, "executed");
  assert.equal(result.result.status, "running");
  assert.equal(core.getCurationRun(result.result.run_id).status, "running");

  librarian.release({ warnings: [] });
  releaseSkills({ state_changes: [], awaiting_approval: [], warnings: [] });
  await settle(core);
  assert.equal(core.getCurationRun(result.result.run_id).status, "succeeded");
  assert.equal(core.getCurationRun(chatRun.id).status, "succeeded");
});

/** Waits for the curations and then for the notice write that follows them. */
async function settleNotices(core) {
  await settle(core);
  await new Promise((resolve) => setImmediate(resolve));
  await core.writeLane.write({ mutateState: () => null }).catch(() => {});
}

const NOTHING_RUNS = [
  { type: "run_librarian", description: "a", payload: {} },
  { type: "run_skill_curation", description: "b", payload: {} },
  { type: "run_rule_curation", description: "c", payload: {} },
];

async function replyWithAllCurations(core) {
  const { conversation_id: conversationId } = await core.getActiveConversation();
  await core.persistAdvisorReply(conversationId, "", createUlid(), { channel: "web" }, NOTHING_RUNS);
  await settleNotices(core);
}

/** The Owner must read plain sentences: no run id, JSON, proposal text or path. */
function assertPlain(message, runIds) {
  for (const id of runIds) assert.equal(message.includes(id), false, message);
  assert.doesNotMatch(message, /\{|\//u, message);
}

test("three curations from one reply raise one plain info notice with a line per kind", async (t) => {
  const { core } = await setup(t);
  core.pageLibrarian.run = async () => ({ actions_taken: [{ path: "notes/secret.md" }], warnings: [] });
  core.curateSkills = async () => ({ state_changes: [{ skill: "s1" }], awaiting_approval: [], warnings: [] });
  core.curateRules = () => ({ awaiting_approval: [{ id: "p1", text: "ルール案の全文" }, { id: "p2", text: "別の案" }], warnings: [] });
  await replyWithAllCurations(core);

  assert.equal(alerts(core, "curation_run_finished").length + alerts(core, "curation_run_failed").length, 0);
  const notices = alerts(core, "curation_notice");
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.equal(notices[0].severity, "info");
  assert.deepEqual(notices[0].message.split("\n"), ["ナレッジを整理しました", "スキルを整理しました", "承認待ちのルール提案があります（2件）"]);
  assertPlain(notices[0].message, core.listCurationRuns({ limit: 10 }).items.map((run) => run.id));
});

test("a failed curation is one plain line in the same warning notice, without its error", async (t) => {
  const { core } = await setup(t);
  core.pageLibrarian.run = async () => { throw new Error("librarian exploded at /secret/path {x}"); };
  core.curateSkills = async () => ({ state_changes: [{ skill: "s1" }], awaiting_approval: [], warnings: [] });
  await replyWithAllCurations(core);

  const notices = alerts(core, "curation_notice");
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.equal(notices[0].severity, "warning");
  assert.deepEqual(notices[0].message.split("\n"), ["ナレッジ整理に失敗しました", "スキルを整理しました"]);
  assertPlain(notices[0].message, core.listCurationRuns({ limit: 10 }).items.map((run) => run.id));
});

test("a skill curation that only applied proposals still raises the skill line", async (t) => {
  const { core } = await setup(t);
  core.curateSkills = async () => ({ state_changes: [], applied: [{ id: "p1", target: "s1" }], trials_ended: [], awaiting_approval: [], warnings: [] });
  await replyWithAllCurations(core);
  assert.deepEqual(alerts(core, "curation_notice").map((n) => n.message), ["スキルを整理しました"]);
});

test("curations that changed nothing raise no notice", async (t) => {
  const { core } = await setup(t);
  await replyWithAllCurations(core);
  assert.equal(alerts(core, "curation_notice").length, 0);
});

test("a single background curation raises one notice for itself, for success and for failure", async (t) => {
  const { core } = await setup(t);
  const outcomes = [
    ["success", () => ({ actions_taken: [{ path: "a.md" }], warnings: [] }), "ナレッジを整理しました", "info"],
    ["thrown", () => { throw new Error("librarian exploded"); }, "ナレッジ整理に失敗しました", "warning"],
    ["report error", () => ({ error: "bad report", warnings: [] }), "ナレッジ整理に失敗しました", "warning"],
  ];
  for (const [label, impl, message, severity] of outcomes) {
    const before = alerts(core, "curation_notice").length;
    core.pageLibrarian.run = async () => impl();
    const { started } = await core.startCurationInBackground({ kind: "librarian", trigger: "advisor_action", actor: "advisor", request_key: `k-${label}` });
    assert.equal(started, true, label);
    await settleNotices(core);
    const notices = alerts(core, "curation_notice");
    assert.equal(notices.length, before + 1, label);
    assert.equal(notices.at(-1).message, message, label);
    assert.equal(notices.at(-1).severity, severity, label);
  }
});

test("a second request for a running kind returns the running run without starting another", async (t) => {
  const { core } = await setup(t);
  const librarian = gatedLibrarian(core);
  const first = await core.startCurationInBackground({ kind: "librarian", trigger: "advisor_action", actor: "advisor", request_key: "a" });
  const second = await core.startCurationInBackground({ kind: "librarian", trigger: "advisor_action", actor: "advisor", request_key: "b" });
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.run.id, first.run.id);
  // A different kind is not blocked by it.
  const other = await core.startCurationInBackground({ kind: "rule_curation", trigger: "advisor_action", actor: "advisor", request_key: "c" });
  assert.equal(other.started, true);

  librarian.release({ warnings: [] });
  await settle(core);
  assert.equal(librarian.started(), 1);
  assert.equal(core.listCurationRuns({ kind: "librarian", limit: 10 }).items.length, 1);
  // Once it has ended, the kind can be started again.
  core.pageLibrarian.run = async () => ({ warnings: [] });
  const again = await core.startCurationInBackground({ kind: "librarian", trigger: "advisor_action", actor: "advisor", request_key: "d" });
  assert.equal(again.started, true);
  await settle(core);
});
