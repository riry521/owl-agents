import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { openTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

const proposalModule = await import("../../packages/core/dist/rule-proposals.js").catch(() => ({}));

async function setup(t, { min_sources = 1, promptRules = [], ruleWriter, notes, now, judge } = {}) {
  const { db } = await openTestDatabase(t, { prefix: "owl-rule-proposals-" });
  const writeLane = db.createWriteLane();
  assert.equal(typeof proposalModule.RuleProposals, "function", "rule-proposals must export RuleProposals");
  assert.equal(proposalModule.RULE_PROPOSAL_MIN_SOURCES, 2);
  const ruleStore = { rules: { promptRules } };
  const proposals = new proposalModule.RuleProposals({
    db,
    writeLane,
    ruleStore,
    min_sources,
    ruleWriter: ruleWriter ?? { apply: async ({ level, role }) => ({ path: level === "system" ? "rules/system/owl-approved.yaml" : `rules/role/${role}.yaml`, generation: 1 }) },
    notes: notes ?? { recordPromotion: async () => undefined },
    now,
    judge,
  });
  return { db, writeLane, ruleStore, proposals };
}

const { RulePairJudge } = await import("../../packages/core/dist/rule-judge.js");
const MODEL = { provider: "claude", model: "cheap" };

/** A judge whose fake model answers every asked pair with decide(left, right); `calls` records each request. */
function fakeJudge(decide, calls = [], options = {}) {
  return new RulePairJudge({
    runner: () => async (request) => {
      calls.push(request);
      return { ok: true, output: { judgments: request.pairs.map((p) => ({ pair_id: p.pair_id, relation: decide(p.left, p.right) })) } };
    },
    model: () => MODEL,
    language: () => "ja",
    ...options,
  });
}
const negated = (text) => /\b(not|never)\b|禁止/iu.test(text);
const oppositePolarity = (a, b) => (negated(a) === negated(b) ? "different" : "conflict");

function input(ref, options = {}) {
  return {
    origin: "legacy_policy",
    source: { kind: "legacy_policy", ref },
    level: "system",
    text: "Validate the release state before deployment.",
    rationale: "This prevents publishing an incomplete release.",
    applies_to: "deployment work",
    project_id: null,
    ...options,
  };
}

test("a source is recorded once and returns its proposal regardless of proposal status", async (t) => {
  const f = await setup(t);
  const first = await f.proposals.create(input("policies/a.md#1"));
  assert.equal(first.status, "awaiting_approval");
  for (const status of ["awaiting_approval", "applied", "rejected"]) {
    await f.writeLane.transact((tx) => tx.run("UPDATE rule_proposals SET status=? WHERE id=?", status, first.proposal_id));
    const repeated = await f.proposals.create(input("policies/a.md#1"));
    assert.equal(repeated.proposal_id, first.proposal_id);
    assert.equal(repeated.status, status);
    assert.equal(repeated.already_recorded, true);
    assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources").n, 1);
  }
});

test("a reworded proposal from another Work folds into the open one, and two sources are needed for approval by default", async (t) => {
  const f = await setup(t, { min_sources: 0 });
  const first = await f.proposals.create(input("policies/a.md#1"));
  assert.equal(first.status, "pending");
  const reworded = await f.proposals.create(input("policies/b.md#1", { text: "Validate the release state before the deployment." }));
  assert.equal(reworded.proposal_id, first.proposal_id);
  assert.equal(reworded.status, "awaiting_approval");
  assert.equal(f.proposals.list().length, 1);
  assert.equal(f.proposals.list()[0].source_count, 2);
  const otherRole = await f.proposals.create(input("policies/c.md#1", { level: "role", role: "worker" }));
  assert.notEqual(otherRole.proposal_id, first.proposal_id, "a different level is never folded in");
});

test("invalid text and text the RuleStore parser cannot serialize are rejected", async (t) => {
  const f = await setup(t);
  const tooLong = await f.proposals.create(input("policies/long.md#1", { text: "x".repeat(301) }));
  assert.equal(tooLong.status, "rejected");
  assert.ok(tooLong.last_error);
  const multiline = await f.proposals.create(input("policies/multiline.md#1", { text: "first line\nsecond line" }));
  assert.equal(multiline.status, "rejected");
  const unrepresentable = await f.proposals.create(input("policies/unserializable.md#1", { text: `say "hi #1 and 'bye #2` }));
  assert.equal(unrepresentable.status, "rejected");
  assert.equal(unrepresentable.last_error, "text_not_serializable");
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources").n, 3);
});

test("a proposal merges with an applied proposal only while its exact rule key exists in RuleStore", async (t) => {
  const f = await setup(t);
  const created = await f.proposals.create(input("policies/first.md#1"));
  await f.writeLane.transact((tx) => tx.run("UPDATE rule_proposals SET status='applied' WHERE id=?", created.proposal_id));
  f.ruleStore.rules.promptRules = [{ id: "deployed", level: "system", kind: "instruction", text: "Validate the release state before deployment." }];
  const merged = await f.proposals.create(input("policies/second.md#1"));
  assert.equal(merged.status, "applied");
  assert.equal(merged.merged_into, created.proposal_id);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 1);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources").n, 2);

  f.ruleStore.rules.promptRules = [];
  const recreated = await f.proposals.create(input("policies/third.md#1"));
  assert.equal(recreated.status, "awaiting_approval");
  assert.notEqual(recreated.proposal_id, created.proposal_id);
});

test("a hand-written exact rule is rejected and a different level is kept as a separate key", async (t) => {
  const text = "Validate the release state before deployment.";
  const f = await setup(t, { promptRules: [{ id: "manual-system", level: "system", kind: "instruction", text }] });
  const duplicate = await f.proposals.create(input("policies/duplicate.md#1"));
  assert.equal(duplicate.status, "rejected");
  assert.equal(duplicate.last_error, "duplicate_of_existing_rule:manual-system");

  const f2 = await setup(t);
  const worker = await f2.proposals.create(input("policies/worker.md#1", { level: "role", role: "worker", text }));
  await f2.writeLane.transact((tx) => tx.run("UPDATE rule_proposals SET status='applied' WHERE id=?", worker.proposal_id));
  f2.ruleStore.rules.promptRules = [{ id: "approved-worker", level: "role", role: "worker", kind: "instruction", text }];
  const system = await f2.proposals.create(input("policies/system.md#1", { text }));
  assert.equal(system.status, "awaiting_approval");
  assert.notEqual(system.proposal_id, worker.proposal_id);
});

test("a rejected rule key is suppressed and later sources are recorded on the original proposal", async (t) => {
  const f = await setup(t);
  const rejected = await f.proposals.create(input("policies/first.md#1"));
  await f.writeLane.transact((tx) => tx.run("UPDATE rule_proposals SET status='rejected' WHERE id=?", rejected.proposal_id));
  const repeated = await f.proposals.create(input("policies/second.md#1"));
  assert.equal(repeated.status, "rejected");
  assert.equal(repeated.merged_into, rejected.proposal_id);
  assert.equal(repeated.last_error, `suppressed_by_rejection:${rejected.proposal_id}`);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposals").n, 1);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources").n, 2);
});

test("the complete rule key is used so identical open rules merge and role scopes stay separate", async (t) => {
  const f = await setup(t);
  const worker = await f.proposals.create(input("policies/worker.md#1", { level: "role", role: "worker" }));
  const reviewer = await f.proposals.create(input("policies/reviewer.md#1", { level: "role", role: "reviewer" }));
  assert.notEqual(worker.proposal_id, reviewer.proposal_id);
  const sameWorker = await f.proposals.create(input("policies/worker-2.md#1", { level: "role", role: "worker" }));
  assert.equal(sameWorker.proposal_id, worker.proposal_id);
  assert.equal(sameWorker.merged_into, worker.proposal_id);
  const systemA = await f.proposals.create(input("policies/system-a.md#1"));
  const systemB = await f.proposals.create(input("policies/system-b.md#1"));
  assert.equal(systemA.proposal_id, systemB.proposal_id, "NULL roles have one open key through COALESCE");
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposals WHERE status IN ('pending','awaiting_approval')").n, 3);
});

test("suppression is scoped by role so a rejected worker rule does not suppress a reviewer rule", async (t) => {
  const f = await setup(t);
  const worker = await f.proposals.create(input("policies/worker.md#1", { level: "role", role: "worker" }));
  await f.writeLane.transact((tx) => tx.run("UPDATE rule_proposals SET status='rejected' WHERE id=?", worker.proposal_id));
  const reviewer = await f.proposals.create(input("policies/reviewer.md#1", { level: "role", role: "reviewer" }));
  assert.equal(reviewer.status, "awaiting_approval");
  assert.notEqual(reviewer.proposal_id, worker.proposal_id);
});

test("promotion counts distinct sources, supports different min_sources values and emits one websocket event", async (t) => {
  const immediate = await setup(t, { min_sources: 1 });
  const one = await immediate.proposals.create(input("policies/one.md#1"));
  assert.equal(one.status, "awaiting_approval");

  const waiting = await setup(t, { min_sources: 2 });
  const first = await waiting.proposals.create(input("work-1", { origin: "lesson", source: { kind: "work", ref: "work-1" }, input_fingerprint: "lesson-one" }));
  assert.equal(first.status, "pending");
  const sameSource = await waiting.proposals.create(input("work-1", { origin: "lesson", source: { kind: "work", ref: "work-1" }, input_fingerprint: "lesson-two" }));
  assert.equal(sameSource.proposal_id, first.proposal_id);
  assert.equal(sameSource.status, "pending");
  const secondWork = await waiting.proposals.create(input("work-2", { origin: "lesson", source: { kind: "work", ref: "work-2" }, input_fingerprint: "lesson-three" }));
  assert.equal(secondWork.proposal_id, first.proposal_id);
  assert.equal(secondWork.status, "awaiting_approval");
  assert.equal(waiting.db.get("SELECT COUNT(*) AS n FROM events WHERE type='rule_proposal.awaiting_approval'").n, 1);
  assert.equal(waiting.db.get("SELECT COUNT(*) AS n FROM outbox_deliveries WHERE provider='websocket'").n, 1);
});

test("different inputs from one source merge without being counted as distinct sources", async (t) => {
  const f = await setup(t, { min_sources: 2 });
  const first = await f.proposals.create(input("work-1", { origin: "lesson", source: { kind: "work", ref: "work-1" }, input_fingerprint: "lesson-one" }));
  const second = await f.proposals.create(input("work-1", { origin: "lesson", source: { kind: "work", ref: "work-1" }, input_fingerprint: "lesson-two" }));
  assert.equal(first.proposal_id, second.proposal_id);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources WHERE proposal_id=?", first.proposal_id).n, 2);
  assert.deepEqual(JSON.parse(f.db.get("SELECT source_work_ids_json FROM rule_proposals WHERE id=?", first.proposal_id).source_work_ids_json), ["work-1"]);
  assert.equal(f.db.get("SELECT status FROM rule_proposals WHERE id=?", first.proposal_id).status, "pending");
});

test("list filters and deserializes proposals including derived sources", async (t) => {
  const f = await setup(t);
  await f.proposals.create(input("policies/a.md#1"));
  const all = await f.proposals.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].status, "awaiting_approval");
  assert.deepEqual(all[0].source_work_ids, []);
  assert.equal((await f.proposals.list("pending")).length, 0);
});

test("approval applies an awaiting proposal, records promotion, and preserves source idempotency", async (t) => {
  const writes = [];
  const promotions = [];
  const f = await setup(t, {
    now: () => "2026-09-27T00:00:00.000Z",
    ruleWriter: { apply: async (write) => { writes.push(write); return { path: "rules/system/owl-approved.yaml", generation: 2 }; } },
    notes: { recordPromotion: async (noteId, entry) => promotions.push({ noteId, entry }) },
  });
  const proposal = await f.proposals.create(input("note-source", {
    origin: "note",
    source: { kind: "note", ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV:abcdef0123456789" },
    note_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  }));

  const result = await f.proposals.approve(proposal.proposal_id);
  assert.deepEqual(result, {
    proposal_id: proposal.proposal_id,
    status: "applied",
    applied_rule_id: `owl-${proposal.proposal_id.toLowerCase()}`,
    applied_path: "rules/system/owl-approved.yaml",
  });
  assert.deepEqual(writes, [{
    id: `owl-${proposal.proposal_id.toLowerCase()}`,
    level: "system",
    text: "Validate the release state before deployment.",
  }]);
  assert.equal(f.db.get("SELECT status FROM rule_proposals WHERE id=?", proposal.proposal_id).status, "applied");
  assert.deepEqual(promotions, [{
    noteId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    entry: {
      date: "2026-09-27",
      proposal_id: proposal.proposal_id,
      status: "applied",
      path: "rules/system/owl-approved.yaml",
    },
  }]);
  const repeated = await f.proposals.create(input("note-source", {
    origin: "note",
    source: { kind: "note", ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV:abcdef0123456789" },
    note_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  }));
  assert.equal(repeated.proposal_id, proposal.proposal_id);
  assert.equal(repeated.status, "applied");
  assert.equal(repeated.already_recorded, true);
});

test("approval that adds the rule raises one 'rule added' notice; rejection and a merged proposal raise none", async (t) => {
  const f = await setup(t);
  const notices = () => f.db.all("SELECT payload_json FROM events WHERE type = 'system.alert'").map((row) => JSON.parse(row.payload_json));
  const rejected = await f.proposals.create(input("policies/no.md#1"));
  await f.proposals.reject(rejected.proposal_id);
  assert.equal(notices().length, 0);

  const merged = await f.proposals.create(input("policies/merged.md#1", { text: "Another rule that gets merged away." }));
  await f.writeLane.transact((tx) => tx.run("UPDATE rule_proposals SET status='merged' WHERE id=?", merged.proposal_id));
  await assert.rejects(f.proposals.approve(merged.proposal_id));
  assert.equal(notices().length, 0);

  const proposal = await f.proposals.create(input("policies/yes.md#1", { text: "Always add a rollback note before release." }));
  await f.proposals.approve(proposal.proposal_id);
  assert.deepEqual(notices().map(({ kind, severity, message }) => ({ kind, severity, message })), [{ kind: "curation_notice", severity: "info", message: "ルールを追加しました" }]);
});

test("approval failure keeps approval pending and increments attempts with a last error", async (t) => {
  const f = await setup(t, {
    ruleWriter: { apply: async () => { throw Object.assign(new Error("rules are broken"), { code: "rules_currently_broken" }); } },
  });
  const proposal = await f.proposals.create(input("policies/broken.md#1"));

  await assert.rejects(f.proposals.approve(proposal.proposal_id), (error) => error.code === "rule_apply_failed");
  const row = f.db.get("SELECT status, attempts, last_error FROM rule_proposals WHERE id=?", proposal.proposal_id);
  assert.equal(row.status, "awaiting_approval");
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /rules are broken/u);
});

test("approval whose rule was already written by an interrupted attempt completes without writing it again", async (t) => {
  let writes = 0;
  const f = await setup(t, { ruleWriter: { apply: async () => { writes += 1; throw Object.assign(new Error("duplicate"), { code: "duplicate_rule_id" }); } } });
  const proposal = await f.proposals.create(input("policies/interrupted.md#1"));
  const ruleId = `owl-${proposal.proposal_id.toLowerCase()}`;
  const rule = { id: ruleId, level: "system", kind: "instruction", text: "Validate the release state before deployment." };
  f.ruleStore.rules.files = [{ path: "rules/system/owl-approved.yaml", level: "system", rules: [rule] }];

  const result = await f.proposals.approve(proposal.proposal_id);

  assert.equal(writes, 0);
  assert.deepEqual(result, { proposal_id: proposal.proposal_id, status: "applied", applied_rule_id: ruleId, applied_path: "rules/system/owl-approved.yaml" });
  assert.equal(f.db.get("SELECT status FROM rule_proposals WHERE id=?", proposal.proposal_id).status, "applied");
});

test("only awaiting proposals can be approved or rejected, and rejection suppresses the rule key", async (t) => {
  const promotions = [];
  const f = await setup(t, {
    min_sources: 2,
    notes: { recordPromotion: async (noteId, entry) => promotions.push({ noteId, entry }) },
  });
  const pending = await f.proposals.create(input("work-a", {
    origin: "lesson", source: { kind: "work", ref: "work-a" }, input_fingerprint: "lesson-a",
  }));
  await assert.rejects(f.proposals.approve(pending.proposal_id), (error) => error.code === "invalid_state_transition");
  await assert.rejects(f.proposals.reject(pending.proposal_id), (error) => error.code === "invalid_state_transition");

  const f2 = await setup(t, {
    notes: { recordPromotion: async (noteId, entry) => promotions.push({ noteId, entry }) },
  });
  const awaiting = await f2.proposals.create(input("01ARZ3NDEKTSV4RRFFQ69G5FAV:claim", {
    origin: "note",
    source: { kind: "note", ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV:claim" },
    note_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  }));
  const rejected = await f2.proposals.reject(awaiting.proposal_id);
  assert.equal(rejected.status, "rejected");
  assert.equal(f2.db.get("SELECT status FROM rule_proposals WHERE id=?", awaiting.proposal_id).status, "rejected");
  assert.equal(promotions.at(-1).entry.status, "rejected");

  const suppressed = await f2.proposals.create(input("another-source", {
    origin: "lesson", source: { kind: "work", ref: "another-source" },
  }));
  assert.equal(suppressed.proposal_id, awaiting.proposal_id);
  assert.equal(suppressed.status, "rejected");
  await assert.rejects(f2.proposals.approve(awaiting.proposal_id), (error) => error.code === "invalid_state_transition");
});

test("curate lists awaiting proposals and rule overlaps without changing rules or proposals", async (t) => {
  const promptRules = [
    { id: "r1", level: "system", kind: "instruction", text: "Do not push directly to the main branch." },
    { id: "r2", level: "system", kind: "instruction", text: "Push directly to the main branch when urgent." },
    { id: "r3", level: "system", kind: "instruction", text: "Validate the release state before deployment!" },
  ];
  const files = [{ path: "rules/system/a.yaml", level: "system", rules: promptRules }];
  let writes = 0;
  const f = await setup(t, { promptRules, ruleWriter: { apply: async () => { writes += 1; return { path: "x", generation: 1 }; } } });
  f.ruleStore.rules.files = files;
  await f.proposals.create(input("policies/a.md#1", { text: "Always write tests for new code paths." }));
  await f.proposals.create(input("policies/b.md#1", { text: "Never push directly to the main branch." }));
  const rulesBefore = JSON.stringify(f.ruleStore.rules);
  const rowsBefore = JSON.stringify(f.db.all("SELECT * FROM rule_proposals ORDER BY id"));
  const report = await f.proposals.curate(fakeJudge(oppositePolarity));
  assert.equal(JSON.stringify(f.ruleStore.rules), rulesBefore);
  assert.equal(JSON.stringify(f.db.all("SELECT * FROM rule_proposals ORDER BY id")), rowsBefore);
  assert.equal(writes, 0);
  assert.equal(report.target.open_proposals, 2);
  assert.equal(report.awaiting_approval.length, report.proposals.filter((p) => p.status === "awaiting_approval").length);
  const verdicts = Object.fromEntries(report.proposals.map((p) => [p.text, p.verdict]));
  assert.equal(verdicts["Always write tests for new code paths."], "approve_candidate");
  assert.notEqual(verdicts["Never push directly to the main branch."], "approve_candidate");
  assert.equal(report.rule_findings.some((x) => x.kind === "possible_conflict" && x.rules[0].path === "rules/system/a.yaml"), true);
});

test("curate compares role proposals and role rules with absolute rules, which apply to every role", async (t) => {
  const promptRules = [
    { id: "a1", level: "absolute", kind: "instruction", text: "Never force push to main." },
    { id: "w1", level: "role", role: "worker", kind: "instruction", text: "Force push to main." },
  ];
  const f = await setup(t, { promptRules });
  await f.proposals.create(input("policies/abs.md#1", { level: "role", role: "worker", text: "Never force push to main." }));

  const report = await f.proposals.curate(fakeJudge(oppositePolarity));

  assert.equal(report.proposals[0].verdict, "duplicate_of_rule");
  assert.equal(report.rule_findings.some((x) => x.kind === "possible_conflict" && x.rules.map((r) => r.id).sort().join() === "a1,w1"), true);
});

test("curate finds conflicts across system and role rules and leaves real rule files byte-identical", async (t) => {
  const { RuleStore } = await import("../../packages/core/dist/rule-store.js");
  const { readFile } = await import("node:fs/promises");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const root = await tempDir(t, "owl-rule-curate-");
  await mkdir(join(root, "rules/system"), { recursive: true });
  await mkdir(join(root, "rules/role"), { recursive: true });
  const sysFile = join(root, "rules/system/a.yaml");
  const roleFile = join(root, "rules/role/worker.yaml");
  await writeFile(sysFile, 'level: system\nrules:\n  - id: s1\n    kind: instruction\n    text: "Do not push directly to main."\n');
  await writeFile(roleFile, 'level: role\nrole: worker\nrules:\n  - id: w1\n    kind: instruction\n    text: "Push directly to main."\n');
  const store = new RuleStore(root);
  await store.load();
  const f = await setup(t);
  f.proposals.ruleStore = store;
  const before = [await readFile(sysFile, "utf8"), await readFile(roleFile, "utf8")];
  const report = await f.proposals.curate(fakeJudge(oppositePolarity));
  assert.deepEqual([await readFile(sysFile, "utf8"), await readFile(roleFile, "utf8")], before);
  assert.equal(report.rule_findings.some((x) => x.kind === "possible_conflict" && x.rules.map((r) => r.id).sort().join() === "s1,w1"), true);
});

test("a metrics proposal needs a metrics_snapshot source and is stored with origin metrics", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.proposals.create(input("policies/a.md#1", { origin: "metrics" })), /invalid_rule_proposal_source/);
  await assert.rejects(f.proposals.create(input("work-1", { origin: "metrics", source: { kind: "work", ref: "work-1" } })), /invalid_rule_proposal_source/);
  const created = await f.proposals.create(input("work-1", { origin: "metrics", source: { kind: "metrics_snapshot", ref: "metrics:code:abc" }, level: "role", role: "worker" }));
  assert.equal(created.status, "awaiting_approval");
  assert.equal(f.proposals.list("awaiting_approval")[0].origin, "metrics");
});

/** Stores open proposals directly: create() would fold close rewordings, and these tests need them separate. */
async function insertOpen(f, rows) {
  await f.writeLane.transact((tx) => {
    rows.forEach(([id, text, level = "system", role = null], i) => {
      const at = `2026-02-01T00:00:${String(i).padStart(2, "0")}.000Z`;
      tx.run(
        `INSERT INTO rule_proposals (id, fingerprint, origin, level, role, text, rationale, applies_to, source_work_ids_json, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'legacy_policy', ?, ?, ?, 'r', 'a', '[]', 'pending', 0, ?, ?)`, id, `fp-${id}`, level, role, text, at, at);
    });
    return null;
  });
}

// Fixed so tidy does not expire the fixture proposals (30 days after 2026-02-01).
const FIXED_NOW = () => "2026-02-05T00:00:00.000Z";
const SSH = "~/.ssh 配下のファイルの読み取り・書き込み・削除は禁止する。";
const AWS = "~/.aws 配下のファイルの読み取り・書き込み・削除は禁止する。";

test("a pair the model calls different is neither merged nor reported, though the cheap filter still sent it", async (t) => {
  const f = await setup(t, { promptRules: [
    { id: "ssh", level: "system", kind: "instruction", text: SSH },
    { id: "aws", level: "system", kind: "instruction", text: AWS },
  ], now: FIXED_NOW });
  await insertOpen(f, [["01PROPSSH", SSH], ["01PROPAWS", AWS]]);
  const calls = [];
  const judge = fakeJudge(() => "different", calls);

  const tidied = await f.proposals.tidy(judge);
  const report = await f.proposals.curate(judge);

  assert.deepEqual(tidied.merged, []);
  assert.equal(calls.flatMap((c) => c.pairs).some((p) => [p.left, p.right].sort().join() === [SSH, AWS].sort().join()), true);
  assert.equal(report.rule_findings.length, 0);
});

test("a proposal the model calls a conflict with a rule becomes possible_conflict", async (t) => {
  const rule = "設計・計画・検証・レビュー結果・作業記録などの内部資料は git で追跡しないこと。git add -f や .gitignore の例外（!）で無視設定を破らないこと。";
  const proposal = "gitignore 対象のパス（docs/verification/ など）に成果物を作らせる Task では、受け入れ条件に『git ls-files で追跡されていること』を入れ、context に git add -f でコミットするよう書くこと。";
  const f = await setup(t, { promptRules: [{ id: "internal", level: "system", kind: "instruction", text: rule }] });
  await insertOpen(f, [["01PROPGITADD", proposal, "role", "manager"]]);
  const calls = [];

  const report = await f.proposals.curate(fakeJudge(() => "conflict", calls));

  assert.equal(report.proposals[0].verdict, "possible_conflict");
  assert.equal(report.proposals[0].related[0].rule_id, "internal");
  assert.equal(calls.length, 1);
});

test("without a usable model answer nothing is merged by meaning and a warning is kept", async (t) => {
  const f = await setup(t, { now: FIXED_NOW, promptRules: [{ id: "r", level: "system", kind: "instruction", text: "Never push directly to the main branch." }] });
  await insertOpen(f, [["01PROPA", "Always run the full migration check before every release."], ["01PROPB", "Always run the full migration check before each release."], ["01PROPC", "Push directly to the main branch."]]);
  const runners = {
    throws: async () => { throw new Error("boom"); },
    not_ok: async () => ({ ok: false, error: "rate limited" }),
    broken: async () => ({ ok: true, output: "not json" }),
    wrong_shape: async () => ({ ok: true, output: { something: 1, other: 2 } }),
    unknown_pair: async () => ({ ok: true, output: { judgments: [{ pair_id: "nope", relation: "same" }, { pair_id: "p0", relation: "bogus" }] } }),
    missing: undefined,
  };
  for (const [name, runner] of Object.entries(runners)) {
    const judge = new RulePairJudge({ runner: () => runner, model: () => MODEL, language: () => "ja" });
    assert.deepEqual((await f.proposals.tidy(judge)).merged, [], name);
    const report = await f.proposals.curate(judge);
    assert.equal(report.proposals.every((p) => p.verdict === "approve_candidate"), true, name);
    assert.ok(report.warnings.length > 0, name);
  }
});

test("wrapped judgments are read, and unknown pair_ids or unreadable items leave a warning while valid answers still apply", async () => {
  const output = { judgments: [{ " Same ": { " Pair_ID ": "p0" } },{ " Pair_ID ": "p1", Relation: " Conflict " }, { pair_id: "nope", relation: "same" }, "junk"] };
  const judge = new RulePairJudge({ runner: () => async () => ({ ok: true, output }), model: () => MODEL, language: () => "ja" });
  await judge.judge([["a1 a2 a3", "a1 a2 a3 a4"], ["b1 b2 b3", "b1 b2 b3 b4"]]);
  assert.equal(judge.get("a1 a2 a3", "a1 a2 a3 a4"), "same");
  assert.equal(judge.get("b1 b2 b3", "b1 b2 b3 b4"), "conflict");
  assert.equal(judge.warnings.length, 1);
});

test("only candidate pairs reach the model, each pair is asked once per run, and large sets are split by the batch size", async (t) => {
  const P1 = "Always run the full migration check before every release.";
  const P2 = "Always run the full migration check before each release.";
  const f = await setup(t, { promptRules: [
    { id: "r1", level: "system", kind: "instruction", text: "Never skip the full migration check before a release." },
    { id: "r2", level: "system", kind: "instruction", text: "ZZZ qqq www." },
  ], now: FIXED_NOW });
  await insertOpen(f, [["01P1", P1], ["01P2", P2], ["01P3", "ZZZ qqq www unrelated"], ["01P4", P2, "role", "worker"]]);
  const calls = [];
  const judge = fakeJudge(() => "different", calls);

  await f.proposals.tidy(judge);
  await f.proposals.curate(judge);

  const asked = calls.flatMap((c) => c.pairs).map((p) => [p.left, p.right].sort().join(" | "));
  const sorted = (pair) => [pair.left, pair.right].sort();
  assert.deepEqual(calls.map((c) => c.pairs.map(sorted)), [
    [[P1, P2].sort()],
    [
      [P1, "Never skip the full migration check before a release."].sort(),
      [P2, "Never skip the full migration check before a release."].sort(),
      ["ZZZ qqq www unrelated", "ZZZ qqq www."].sort(),
    ],
  ], "tidy asks the proposal pair, curate asks only related proposal/rule pairs");
  assert.equal(new Set(asked).size, asked.length, "no pair is asked twice");
  assert.equal(asked.includes([P1, P2].sort().join(" | ")), true);
  assert.equal(asked.some((pair) => pair.includes("ZZZ") && pair.includes("migration")), false, "unrelated texts are filtered out before the model");

  const batched = [];
  const small = fakeJudge(() => "same", batched, { batchSize: 2 });
  const pairs = [["a1 a2 a3", "a1 a2 a3 a4"], ["b1 b2 b3", "b1 b2 b3 b4"], ["c1 c2 c3", "c1 c2 c3 c4"]];
  await small.judge(pairs);
  await small.judge(pairs);
  assert.deepEqual(batched.map((c) => c.pairs.length), [2, 1]);
  assert.equal(small.get("a1 a2 a3 a4", "a1 a2 a3"), "same");
  assert.deepEqual(batched[0].model, MODEL);
  assert.equal(batched[0].language, "ja");
});

const gitRule = { id: "rule-git", level: "system", role: null, text: "Do not track internal documents in git." };

test("a lesson the judge finds in conflict with an existing rule is rejected without notice or a pending proposal", async (t) => {
  const f = await setup(t, { min_sources: 1, promptRules: [gitRule], judge: () => fakeJudge(() => "conflict") });
  const created = await f.proposals.create(input("w/a#1", { text: "Commit internal documents with git add -f in git." }));
  assert.equal(created.status, "rejected");
  assert.equal(created.last_error, "conflicts_with_existing_rule:rule-git");
  assert.equal(f.proposals.list("pending").length + f.proposals.list("awaiting_approval").length, 0);
  assert.equal(f.db.get("SELECT COUNT(*) AS n FROM events WHERE type='rule_proposal.awaiting_approval'").n, 0);
});

test("a lesson the judge finds the same as an existing rule is a duplicate; the same as an open proposal joins its sources", async (t) => {
  const same = await setup(t, { promptRules: [gitRule], judge: () => fakeJudge(() => "same") });
  const dup = await same.proposals.create(input("w/a#1", { text: "Internal documents must stay out of git tracking." }));
  assert.equal(dup.status, "rejected");
  assert.equal(dup.last_error, "duplicate_of_existing_rule:rule-git");

  const open = await setup(t, { min_sources: 2, judge: () => fakeJudge(() => "same") });
  const first = await open.proposals.create(input("w/a#1", { text: "Always run the linter before committing code." }));
  const second = await open.proposals.create(input("w/b#1", { text: "Lint the code prior to each commit, every time." }));
  assert.equal(second.proposal_id, first.proposal_id);
  assert.equal(open.proposals.list().length, 1);
  assert.equal(open.proposals.list()[0].source_count, 2);
});

test("without a usable judge create still works and exact duplicates are still caught", async (t) => {
  const f = await setup(t, { promptRules: [gitRule], judge: () => new RulePairJudge({ runner: () => undefined, model: () => MODEL, language: () => "ja" }) });
  assert.equal((await f.proposals.create(input("w/a#1", { text: "Commit internal documents with git add -f in git." }))).status, "awaiting_approval");
  assert.equal((await f.proposals.create(input("w/b#1", { text: gitRule.text }))).last_error, "duplicate_of_existing_rule:rule-git");
  const none = await setup(t, { promptRules: [gitRule] });
  assert.equal((await none.proposals.create(input("w/c#1"))).status, "awaiting_approval");
});

test("a conflict with an existing rule wins over folding into a near-identical open proposal", async (t) => {
  const rule = { id: "rule-release", level: "system", role: null, text: "Validate the release state before deployment." };
  const f = await setup(t, { min_sources: 2, promptRules: [rule], judge: () => fakeJudge((left) => (left.includes("skip") ? "conflict" : "different")) });
  const first = await f.proposals.create(input("w/a#1", { text: "Validate the release state before deployment, nothing else." }));
  assert.equal(first.status, "pending");
  const second = await f.proposals.create(input("w/b#1", { text: "Validate the release state before deployment, skip nothing." }));
  assert.equal(second.status, "rejected");
  assert.equal(second.last_error, "conflicts_with_existing_rule:rule-release");
  assert.equal(f.proposals.list("awaiting_approval").length, 0);
  assert.equal(f.proposals.list("pending")[0].source_count, 1);
});
