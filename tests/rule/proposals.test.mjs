import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { openTestDatabase } from "../helpers/db.mjs";
import { tempDir } from "../helpers/temp.mjs";

const proposalModule = await import("../../packages/core/dist/rule-proposals.js").catch(() => ({}));

async function setup(t, { min_sources = 1, promptRules = [], ruleWriter, notes, now } = {}) {
  const { db } = await openTestDatabase(t, { prefix: "owl-rule-proposals-" });
  const writeLane = db.createWriteLane();
  assert.equal(typeof proposalModule.RuleProposals, "function", "rule-proposals must export RuleProposals");
  assert.equal(proposalModule.RULE_PROPOSAL_MIN_SOURCES, 1);
  const ruleStore = { rules: { promptRules } };
  const proposals = new proposalModule.RuleProposals({
    db,
    writeLane,
    ruleStore,
    min_sources,
    ruleWriter: ruleWriter ?? { apply: async ({ level, role }) => ({ path: level === "system" ? "rules/system/owl-approved.yaml" : `rules/role/owl-approved-${role}.yaml`, generation: 1 }) },
    notes: notes ?? { recordPromotion: async () => undefined },
    now,
  });
  return { db, writeLane, ruleStore, proposals };
}

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
  const report = f.proposals.curate();
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
  const report = f.proposals.curate();
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
