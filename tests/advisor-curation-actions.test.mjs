import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createCore } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import {
  ADVISOR_CURATION_ACTIONS,
  ADVISOR_CURATION_ACTION_TYPES,
  ADVISOR_CURATION_INSTRUCTION,
  advisorCurationKind,
} from "../packages/shared/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-curation-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = createCore({ db, agentRunner, version: "advisor-curation-test", owlRoot: root, dataDir: root });
  t.after(async () => {
    await core.stop({ force: true }).catch(() => {});
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const calls = [];
  core.librarian.run = async () => {
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

async function startServer(t, core, db, root) {
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const prior = process.env.OWL_API_TOKEN;
  delete process.env.OWL_API_TOKEN;
  const http = createOwlHttpServer({
    core: adapter,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  t.after(async () => {
    await http.close().catch(() => {});
    if (prior !== undefined) process.env.OWL_API_TOKEN = prior;
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is not permitted in this environment");
      return null;
    }
    throw error;
  }
  return `http://127.0.0.1:${http.server.address().port}/api/v1`;
}

function action(type, sequence, payload = {}) {
  return { action_id: createUlid(), sequence, type, payload, expected_version: 0 };
}

function envelope(actions, key) {
  return {
    request_id: `req-${key}`,
    idempotency_key: `idem-${key}`,
    expected_version: 0,
    payload: { invocation_id: createUlid(), actions },
  };
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

test("chat: each curation action runs once, records one run, and appends its summary", async (t) => {
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
    const body = core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
    assert.match(body, /承知しました。/, body);
    assert.match(body, /整理を実行しました/u, body);

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
    // The chat notification carries the same string the run recorded.
    assert.ok(body.includes(run.summary), body);
    assert.ok(calls.includes(kind), `${kind} should have run`);
  }
  assert.deepEqual(calls.sort(), ["librarian", "rule_curation", "skill_curation"]);
});

test("chat: one turn runs each kind at most once, whatever the reply repeats", async (t) => {
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
  assert.equal(core.listCurationRuns({ limit: 50 }).items.length, before + 2);
  const body = core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
  assert.equal(body.split("整理を実行しました").length - 1, 2, body);
});

test("chat: a prototype-inherited action type is ignored instead of crashing the turn", async (t) => {
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
    assert.doesNotMatch(body, /整理を実行しました/u, body);
  }
  assert.equal(core.listCurationRuns({ limit: 50 }).items.length, before, "no run may be recorded");
});

test("chat: the Librarian report from the current Librarian summarises without throwing", async (t) => {
  const { core } = await setup(t);
  core.librarian.run = async () => ({
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
  const run = core.listCurationRuns({ limit: 10 }).items[0];
  assert.equal(run.counts.merged, 2);
  assert.equal(run.counts.merge_skipped, 1);
  assert.equal(run.counts.warnings, 1);
  assert.equal(run.counts.actions_taken, 4);
  const body = core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
  assert.ok(body.includes(run.summary), body);
  assert.match(run.summary, /merged=2/u);
  assert.match(run.summary, /ほか1件/u);
});

test("chat: rule curation always reports that rules were not rewritten", async (t) => {
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
  const run = core.listCurationRuns({ limit: 10 }).items[0];
  assert.equal(run.kind, "rule_curation");
  assert.equal(run.counts.awaiting_approval, 2);
  assert.match(run.summary, /ルールは書き換えていません/u);
  assert.match(run.summary, /ルール案A/u);
  const body = core.db.get("SELECT body FROM messages WHERE id = ?", messageId).body;
  assert.match(body, /ルールは書き換えていません/u, body);
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
    assert.match(result.result.summary, new RegExp(`${kind} run`, "u"));
    assert.match(result.result.run_id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);

    const list = core.listCurationRuns({ limit: 50 }).items;
    assert.equal(list.length, before + 1, `${type} should record exactly one run`);
    const run = core.getCurationRun(result.result.run_id);
    assert.equal(run.kind, kind);
    assert.equal(run.trigger, "advisor_action");
    assert.equal(run.actor, "advisor");
    assert.equal(run.actor_ref, body.request_id);
    assert.equal(run.summary, result.result.summary);
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
  assert.equal(core.listCurationRuns({ limit: 50 }).items.length, variants.length);
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

test("POST /advisor/actions reports a failed curation run as a rejected action", async (t) => {
  const { db, root, core } = await setup(t);
  const base = await startServer(t, core, db, root);
  if (!base) return;
  core.librarian.run = async () => { throw new Error("librarian exploded"); };

  const response = await fetch(`${base}/advisor/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope([action("run_librarian", 1)], "failed")),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.results[0].status, "rejected");
  assert.equal(body.data.results[0].error_code, "curation_failed");
  assert.equal(body.data.results[0].result, null);
  const run = core.listCurationRuns({ limit: 10 }).items[0];
  assert.equal(run.status, "failed");
  assert.equal(run.error, "librarian exploded");
});
