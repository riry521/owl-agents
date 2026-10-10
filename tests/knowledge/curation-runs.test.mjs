import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

async function setup(t) {
  return createTestCore(t, { agentRunner, version: "test" }, { prefix: "owl-curation-runs-" });
}

test("store records runs of any kind and lists them with paging", async (t) => {
  const { core } = await setup(t);
  const store = core.curationRuns;
  for (const kind of ["librarian", "skill_curation", "rule_curation"]) {
    await store.record({ kind, trigger: "manual_api", actor: "owner", status: "succeeded", summary: kind, counts: { a: 1 }, report: { kind } });
  }
  const failed = await store.record({ kind: "librarian", trigger: "scheduled", actor: "system", status: "failed", summary: "", counts: {}, report: null, error: "boom" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");

  const first = store.list({ limit: 3 });
  assert.equal(first.items.length, 3);
  assert.equal("report" in first.items[0], false);
  const second = store.list({ limit: 3, cursor: first.next_cursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.next_cursor, null);
  const ids = [...first.items, ...second.items].map((run) => run.id);
  assert.equal(new Set(ids).size, 4);
  assert.ok(ids.includes(failed.id));
  assert.equal(store.list({ kind: "skill_curation", limit: 10 }).items.length, 1);
  assert.equal(store.list({ status: "failed", limit: 10 }).items[0].id, failed.id);
});

test("a manual run and a scheduled run are stored and survive a Core restart", async (t) => {
  const { db, root, core } = await setup(t);
  core.pageLibrarian.run = async () => ({ merged: [1, 2], warnings: [] });
  const manual = await core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner", actor_ref: "req-1" });
  assert.equal(manual.status, "succeeded");
  assert.deepEqual(manual.report, { merged: [1, 2], warnings: [] });
  assert.equal(manual.counts.merged, 2);
  // The scheduler's run callback is the same entry point with trigger "scheduled".
  const scheduled = (await core.librarianScheduler.run()).find((run) => run.kind === "librarian");
  assert.equal(scheduled.trigger, "scheduled");
  assert.equal(scheduled.actor, "system");

  await core.stop({ force: true });
  const { core: restarted } = await createTestCore(t, { db, agentRunner, version: "test", owlRoot: root });
  const list = restarted.listCurationRuns({ limit: 10 });
  assert.deepEqual(list.items.filter((run) => run.kind === "librarian").map((run) => run.trigger).sort(), ["manual_api", "scheduled"]);
  const loaded = restarted.getCurationRun(manual.id);
  assert.equal(loaded.actor_ref, "req-1");
  assert.deepEqual(loaded.report, manual.report);
});

test("a failing Librarian run is recorded as failed", async (t) => {
  const { core } = await setup(t);
  core.pageLibrarian.run = async () => { throw new Error("librarian exploded"); };
  const run = await core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner" });
  assert.equal(run.status, "failed");
  assert.equal(run.error, "librarian exploded");
});

test("interrupted running rows are marked failed on start", async (t) => {
  const { core } = await setup(t);
  const run = await core.curationRuns.start({ kind: "librarian", trigger: "manual_api", actor: "owner" });
  await core.start();
  const loaded = core.getCurationRun(run.id);
  assert.equal(loaded.status, "failed");
  assert.equal(loaded.error, "interrupted_by_restart");
});

test("POST /librarian/run returns the report and the run is readable through the API", async (t) => {
  const { db, root, core } = await setup(t);
  core.pageLibrarian.run = async () => ({ merged: [], warnings: ["w"] });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const api = await startTestHttpServer(t, { core: adapter, webOut: root, owlRoot: root }, { token: "curation-token" });
  if (!api) return t.skip("localhost listen is unavailable");

  const run = await api.request("POST", "/api/v1/librarian/run");
  assert.equal(run.status, 200);
  const data = (await run.json()).data;
  assert.deepEqual(data.report, { merged: [], warnings: ["w"] });

  const list = await (await api.request("GET", "/api/v1/curation-runs?kind=librarian")).json();
  assert.equal(list.data.items[0].id, data.run_id);
  const one = await (await api.request("GET", `/api/v1/curation-runs/${data.run_id}`)).json();
  assert.deepEqual(one.data.report, data.report);

  assert.equal((await api.request("GET", "/api/v1/curation-runs/01ARZ3NDEKTSV4RRFFQ69G5FAV")).status, 404);
  assert.equal((await api.request("GET", "/api/v1/curation-runs/nope")).status, 400);
  assert.equal((await api.request("GET", "/api/v1/curation-runs?kind=bad")).status, 400);
  assert.equal((await api.request("GET", "/api/v1/curation-runs?limit=0")).status, 400);

  core.pageLibrarian.run = async () => { throw new Error("nope"); };
  const failed = await api.request("POST", "/api/v1/librarian/run");
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, "curation_failed");
});

test("failed record keeps counts and large reports are stored whole", async (t) => {
  const { core } = await setup(t);
  const store = core.curationRuns;
  const failed = await store.record({ kind: "skill_curation", trigger: "manual_api", actor: "owner", status: "failed", summary: "s", counts: { merged: 2 }, report: { x: 1 }, error: "boom" });
  assert.deepEqual(failed.counts, { merged: 2 });
  const big = { text: "a".repeat(1_200_000) };
  const ok = await store.record({ kind: "librarian", trigger: "manual_api", actor: "owner", status: "succeeded", summary: "s", counts: {}, report: big });
  assert.equal(store.get(ok.id).report.text.length, 1_200_000);
});

test("overlapping runs of one kind each keep their own record", async (t) => {
  const { core } = await setup(t);
  const [a, b] = await Promise.all([
    core.runCuration({ kind: "librarian", trigger: "manual_api", actor: "owner" }),
    core.runCuration({ kind: "librarian", trigger: "scheduled", actor: "system" }),
  ]);
  assert.notEqual(a.id, b.id);
  assert.equal(a.trigger, "manual_api");
  assert.equal(b.trigger, "scheduled");
  assert.equal(core.listCurationRuns({ limit: 10 }).items.length, 2);
});

test("concurrent runs with the same request_key share one record and do not reject", async (t) => {
  const { core } = await setup(t);
  const input = { kind: "librarian", trigger: "advisor_action", actor: "advisor", request_key: "k1" };
  const [a, b] = await Promise.all([core.runCuration(input), core.runCuration(input)]);
  assert.equal(a.id, b.id);
  assert.equal(core.listCurationRuns({ limit: 10 }).items.length, 1);
});

async function hashTree(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  return Promise.all(files.map(async (file) => `${file} ${createHash("sha256").update(await readFile(file)).digest("hex")}`));
}

/** A fake runRuleJudgments that answers each pair with decide(left, right) and records every request. */
function judgingRunner(decide) {
  const requests = [];
  return {
    requests,
    run: async (request) => {
      requests.push(request);
      return { ok: true, output: { judgments: request.pairs.map((p) => ({ pair_id: p.pair_id, relation: decide(p.left, p.right) })) } };
    },
  };
}

/** Stores open proposals directly so close rewordings stay separate; created_at follows the given order. */
async function insertOpenProposals(db, rows) {
  await db.createWriteLane().transact((tx) => {
    rows.forEach(([id, level, role, text], i) => {
      const at = `2026-02-01T00:${String(i).padStart(2, "0")}:00.000Z`;
      tx.run(
        `INSERT INTO rule_proposals (id, fingerprint, origin, level, role, text, rationale, applies_to, source_work_ids_json, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'legacy_policy', ?, ?, ?, 'r', 'a', '[]', 'pending', 0, ?, ?)`, id, `fp-${id}`, level, role, text, at, at);
      tx.run(
        `INSERT INTO rule_proposal_sources (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
         VALUES (?, 'legacy_policy', ?, ?, ?, ?, ?)`, `src-${id}`, id, `in-${id}`, `fp-${id}`, id, at);
    });
    return null;
  });
}

// Texts of nine real proposals that Dice scored 0.45-0.68 and so never merged: [id, level, role, text].
const REWORDED = [
  ["01M3KGS5S74X74XN1M59BVYY25", "role", "manager", "出力形式を変える code Task の確認方法には、対象を絞ったテストに加えて `node --test tests/*.test.mjs` の全件実行を含め、失敗行だけを報告すること。"],
  ["01M3KHA60R132W73TS9VTWF1VF", "role", "manager", "出力形式を変えるコード Task の確認には、指定テストに加えて `node --test tests/*.test.mjs` の全件実行を含め、旧形式を期待する既存テストを同じ Task 内で直すこと。"],
  ["01M3NS9RS89SGDCSBCZJM90FNJ", "role", "manager", "設計 Task に依存する実装 Task の context には、設計書の絶対パスと参照すべき節番号（例: §5.4）を必ず書く。「context.design_documents を参照」とだけ書かない。"],
  ["01M42EAW7PZCKPGP4RCPN5ZQBZ", "role", "manager", "設計 Task に続く実装 Task の context には、設計書の絶対パスと、読む節の番号を必ず書く。"],
  ["01M461VW4P7G3GY72H46E3QZ4S", "role", "worker", "Worker 報告の changes には、作業ツリーに実在するファイルを1行に1本ずつ書く。グロブ、ディレクトリ、注記付きのパス、削除済みの旧パスは書かない。"],
  ["01M4AJ1B21QK0AMJMEXV1EJ32W", "role", "worker", "報告の changes には git diff --name-only の結果を 1 件ずつ実在するパスで書き、「ほか」「約 N ファイル」とまとめないこと。"],
  ["01M4BMNX8JQ7VJ4FXDTQ7V4DQH", "role", "worker", "報告の changes には1エントリに1ファイルだけを書き、file には git diff --name-only に出るリポジトリのルートからの相対パスをそのまま書くこと。ディレクトリ名・まとめた説明・カンマ区切りは書かない。"],
  ["01M4E5MF6ZK5N5E2Q0SC0EM8HQ", "role", "manager", "CLI に渡すスキーマや引数を変える Task では、実際の CLI に安いモデルで1回実行して受け付けられることを確かめ、その出力を証拠として受け入れ条件に含めること。"],
  ["01M4EAF8MDA5F823KWH6W3WW83", "role", "manager", "プロバイダの CLI や API に渡すスキーマや引数の形を変える Task には、ビルド後の出力を実際の CLI に安いモデルで1回渡し、エラーにならないことを確かめる受け入れ条件を入れること。"],
];
const REWORDED_GROUPS = [
  ["01M3KGS5S74X74XN1M59BVYY25", "01M3KHA60R132W73TS9VTWF1VF"],
  ["01M3NS9RS89SGDCSBCZJM90FNJ", "01M42EAW7PZCKPGP4RCPN5ZQBZ"],
  ["01M461VW4P7G3GY72H46E3QZ4S", "01M4AJ1B21QK0AMJMEXV1EJ32W", "01M4BMNX8JQ7VJ4FXDTQ7V4DQH"],
  ["01M4E5MF6ZK5N5E2Q0SC0EM8HQ", "01M4EAF8MDA5F823KWH6W3WW83"],
];

async function curationFixture(t, runner) {
  const clock = "2026-02-05T00:00:00.000Z";
  const fixture = await createTestCore(t, { agentRunner: { ...agentRunner, ...runner }, version: "test", now: () => clock }, { prefix: "owl-rule-curation-" });
  await insertOpenProposals(fixture.db, REWORDED);
  return fixture;
}

test("rule_curation merges each group the model calls the same into its oldest proposal and moves the sources", async (t) => {
  const textOf = new Map(REWORDED.map(([id, , , text]) => [text, id]));
  const group = (id) => REWORDED_GROUPS.findIndex((g) => g.includes(id));
  const judging = judgingRunner((left, right) => (group(textOf.get(left)) === group(textOf.get(right)) ? "same" : "different"));
  const { core, db } = await curationFixture(t, { runRuleJudgments: judging.run });

  const run = await core.runCuration({ kind: "rule_curation", trigger: "manual_api", actor: "owner" });

  assert.equal(run.status, "succeeded");
  const row = (id) => db.get("SELECT status, decision_json FROM rule_proposals WHERE id = ?", id);
  for (const ids of REWORDED_GROUPS) {
    const [oldest, ...rest] = ids;
    assert.equal(row(oldest).status, "awaiting_approval", `${oldest} survives with the moved sources`);
    for (const id of rest) {
      assert.equal(row(id).status, "merged");
      assert.equal(JSON.parse(row(id).decision_json).merged_into, oldest);
    }
    assert.equal(db.get("SELECT COUNT(*) AS n FROM rule_proposal_sources WHERE proposal_id = ?", oldest).n, ids.length);
  }
  assert.equal(core.getCurationRun(run.id).counts.merged, 5);
  const seen = judging.requests.flatMap((r) => r.pairs.map((p) => [p.left, p.right].sort().join("\u0000")));
  assert.equal(new Set(seen).size, seen.length, "tidy and curate never ask the same pair twice");
});

test("rule_curation asks the model with the memory_librarian setting and the Owner language, and only about related pairs", async (t) => {
  const judging = judgingRunner(() => "different");
  const { core, db } = await curationFixture(t, { runRuleJudgments: judging.run });
  await insertOpenProposals(db, [["01UNRELATED", "role", "manager", "Reply to the Owner in plain words."]]);

  await core.runCuration({ kind: "rule_curation", trigger: "manual_api", actor: "owner" });

  const settings = await core.getMemorySettings();
  assert.ok(judging.requests.length >= 1);
  for (const request of judging.requests) {
    assert.deepEqual(request.model, settings.memory_librarian);
    assert.match(request.language, /^(ja|en)$/u);
  }
  const asked = judging.requests.flatMap((r) => r.pairs);
  assert.equal(asked.some((p) => p.left.includes("Reply to the Owner") || p.right.includes("Reply to the Owner")), false, "an unrelated proposal never reaches the model");
  assert.ok(asked.length < (REWORDED.length * (REWORDED.length - 1)) / 2, "fewer pairs than all combinations");
});

test("rule_curation succeeds and merges nothing when the model fails, answers {ok:false}, answers garbage or does not exist", async (t) => {
  const runners = {
    throws: { runRuleJudgments: async () => { throw new Error("boom"); } },
    not_ok: { runRuleJudgments: async () => ({ ok: false, error: "rate limited" }) },
    broken: { runRuleJudgments: async () => ({ ok: true, output: "{{{" }) },
    missing: {},
  };
  for (const [name, runner] of Object.entries(runners)) {
    const { core, db } = await curationFixture(t, runner);
    const run = await core.runCuration({ kind: "rule_curation", trigger: "manual_api", actor: "owner" });
    assert.equal(run.status, "succeeded", name);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM rule_proposals WHERE status = 'merged'").n, 0, name);
    assert.ok(core.getCurationRun(run.id).report.warnings.length > 0, name);
  }
});

test("scheduled rule_curation merges stored rewordings and expires stale proposals without approving, rejecting or touching rules", async (t) => {
  const clock = { value: "2026-01-01T00:00:00.000Z" };
  // The fake model calls two texts the same when they open with the same 20 characters (the rewordings above differ only later).
  const judging = judgingRunner((left, right) => (left.slice(0, 20) === right.slice(0, 20) ? "same" : "different"));
  const { core, db, root } = await createTestCore(t, { agentRunner: { ...agentRunner, runRuleJudgments: judging.run }, version: "test", now: () => clock.value }, { prefix: "owl-rule-curation-" });
  const proposal = (ref, text) => core.ruleProposals.create({
    origin: "legacy_policy", source: { kind: "legacy_policy", ref }, level: "system",
    text, rationale: "r", applies_to: "a", project_id: null,
  });
  const stale = await proposal("a", "Never deploy on Fridays without a rollback plan.");
  clock.value = "2026-01-20T00:00:00.000Z";
  const older = await proposal("b", "Always run the full migration check before every release.");
  const within = await proposal("c", "Record the reason in the commit log for every revert.");
  // Stored before create folded rewordings together, so it is a separate open proposal with its own source.
  const rewording = await proposal("d", "Always run the full migration check before each release.");
  assert.equal(rewording.proposal_id, older.proposal_id, "create folds a rewording into the open proposal");
  const legacyId = "01LEGACYREWORDING000000000";
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO rule_proposals (id, fingerprint, origin, level, role, text, rationale, applies_to, note_id, source_work_ids_json, project_id, status, attempts, created_at, updated_at)
       SELECT ?, 'legacy-fp', origin, level, role, ?, rationale, applies_to, NULL, '[]', NULL, 'pending', 0, ?, ? FROM rule_proposals WHERE id = ?`,
      legacyId, "Record the reason in the commit log for each revert.", "2026-01-21T00:00:00.000Z", "2026-01-21T00:00:00.000Z", within.proposal_id);
    tx.run(
      `INSERT INTO rule_proposal_sources (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
       VALUES ('01LEGACYSOURCE0000000000', 'legacy_policy', 'e', 'legacy-in', 'legacy-fp', ?, '2026-01-21T00:00:00.000Z')`, legacyId);
    // A stale rewording stored as its own proposal: merging must not refresh the target's age.
    tx.run(
      `INSERT INTO rule_proposals (id, fingerprint, origin, level, role, text, rationale, applies_to, note_id, source_work_ids_json, project_id, status, attempts, created_at, updated_at)
       SELECT '01LEGACYSTALE0000000000', 'legacy-stale-fp', origin, level, role, ?, rationale, applies_to, NULL, '[]', NULL, 'pending', 0, ?, ? FROM rule_proposals WHERE id = ?`,
      "Never deploy on Fridays without a rollback plan!", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", stale.proposal_id);
    tx.run(
      `INSERT INTO rule_proposal_sources (id, source_kind, source_ref, input_fingerprint, text_fingerprint, proposal_id, created_at)
       VALUES ('01LEGACYSOURCE0000000001', 'legacy_policy', 'f', 'legacy-in-2', 'legacy-stale-fp', '01LEGACYSTALE0000000000', '2026-01-02T00:00:00.000Z')`);
    for (const [id, status] of [["01CLOSEDAPPLIED000000000", "applied"], ["01CLOSEDREJECTED00000000", "rejected"]]) {
      tx.run(
        `INSERT INTO rule_proposals (id, fingerprint, origin, level, role, text, rationale, applies_to, note_id, source_work_ids_json, project_id, status, attempts, created_at, updated_at)
         SELECT ?, ?, origin, level, role, ?, rationale, applies_to, NULL, '[]', NULL, ?, 0, ?, ? FROM rule_proposals WHERE id = ?`,
        id, `${id}-fp`, `Closed long ago ${status}.`, status, "2025-12-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z", within.proposal_id);
    }
    return null;
  });
  await mkdir(join(root, "rules"), { recursive: true });
  await writeFile(join(root, "rules", "keep.yaml"), "rules: []\n");
  const beforeRules = await hashTree(join(root, "rules"));
  assert.ok(beforeRules.length > 0, "the comparison covers a real rule file");
  const closed = () => db.get("SELECT COUNT(*) AS n FROM rule_proposals WHERE status IN ('applied','rejected')").n;
  const closedBefore = closed();

  clock.value = "2026-02-05T00:00:00.000Z";
  const run = await core.runCuration({ kind: "rule_curation", trigger: "scheduled", actor: "system" });
  assert.equal(run.status, "succeeded");
  const row = (id) => db.get("SELECT status, decision_json FROM rule_proposals WHERE id = ?", id);
  assert.equal(row(stale.proposal_id).status, "expired", "last updated 35 days ago, past the 30-day default");
  assert.equal(row(legacyId).status, "merged");
  assert.equal(JSON.parse(row(legacyId).decision_json).merged_into, within.proposal_id);
  assert.equal(row(within.proposal_id).status, "awaiting_approval", "the merge adds the second source");
  assert.equal(row(older.proposal_id).status, "awaiting_approval", "16 days old: within the limit");
  const counts = core.getCurationRun(run.id).counts;
  assert.equal(counts.expired, 1);
  assert.equal(counts.merged, 2);
  assert.equal(row("01LEGACYSTALE0000000000").status, "merged");
  assert.equal(row(stale.proposal_id).status, "expired", "merging a stale rewording does not extend the target's age");
  assert.deepEqual(await hashTree(join(root, "rules")), beforeRules);
  assert.equal(closed(), closedBefore);
  assert.equal(row("01CLOSEDAPPLIED000000000").status, "applied");
  assert.equal(row("01CLOSEDREJECTED00000000").status, "rejected");

  // A configured 10-day limit expires the awaiting_approval proposals that were within the 30-day default.
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'owner:default', ?, ?)", clock.value, clock.value);
    tx.run(
      `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('rule_proposals', 'owner:default', '1.0.0', ?, ?)`,
      JSON.stringify({ expire_days: 10 }), clock.value);
    return null;
  });
  const second = await core.runCuration({ kind: "rule_curation", trigger: "scheduled", actor: "system" });
  assert.equal(second.status, "succeeded");
  assert.equal(row(within.proposal_id).status, "expired");
  assert.equal(row(older.proposal_id).status, "expired");
  assert.equal(core.getCurationRun(second.id).counts.expired, 2);
  assert.deepEqual(await hashTree(join(root, "rules")), beforeRules);
  assert.equal(closed(), closedBefore);
  assert.equal(row("01CLOSEDAPPLIED000000000").status, "applied");
  assert.equal(row("01CLOSEDREJECTED00000000").status, "rejected");
});
