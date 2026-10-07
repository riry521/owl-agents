import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core, KnowledgeNotes, ProjectOverviewService } from "../dist/index.js";
import { createUlid, openDatabase } from "../../db/dist/index.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const PROJECT_ID = "01M3W8TMGHXETCSVDSM390EEDV";
const WORK_ID = "01M3W8TMGHXETCSVDSM390EEDX";
const OK = {
  ok: true,
  investigation: {
    purpose: { text: "タスク管理を行うサーバーアプリケーションである。", evidence_paths: ["src/main.ts"] },
    architecture_flow: { text: "main.ts がリクエストを受け core に渡す。", evidence_paths: ["src/main.ts"] },
    entry_points: { text: "入口は src/main.ts である。", evidence_paths: ["src/main.ts"] },
    run_and_test: { text: "pnpm test でテストを実行する。", evidence_paths: ["package.json"] },
    cautions: [{ text: "main への直接の書き込みは避け、必ず Work を経由する。", evidence_paths: ["src/main.ts"] }],
  },
};
const waitFor = async (read) => {
  for (let i = 0; i < 400; i += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
};

// ---- ProjectOverviewService with a fake investigation function ----

async function serviceSetup(t, { files = {}, investigate, stat = [] }) {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-core-inv-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = [];
  const service = new ProjectOverviewService({
    notes: new KnowledgeNotes({ knowledgeDir: join(root, "knowledge") }),
    withWrite: (fn) => fn(),
    getProject: () => ({ id: PROJECT_ID, name: "demo", canonical_path: root, base_branch: "main" }),
    reader: {
      listFiles: async () => ["src/main.ts", "package.json", ...Object.keys(files)],
      readFile: async (_repo, _ref, path) => files[path] ?? null,
      changedPaths: async () => ["src/main.ts"],
      diffStat: async () => stat,
    },
    investigate,
    log: (message, error) => logs.push([message, String(error)]),
  });
  const read = () => readFile(join(root, "knowledge/notes", `project-overview-${PROJECT_ID}.md`), "utf8");
  return { service, read, logs };
}
const DOC = `# Demo\n\n${"これはタスクを管理するためのツールで、利用者の作業を支援する。".repeat(30)}\n`;
const THICK = { "README.md": DOC, "CLAUDE.md": DOC, "package.json": '{"scripts":{"test":"node --test"}}' };
const completed = (merge = null) => ({ kind: "work_completed", work_id: WORK_ID, title: "変更", merge });
const stat = (n) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, added: 1, deleted: 0 }));

test("a project without README gets the investigation written", async (t) => {
  const s = await serviceSetup(t, { investigate: async () => OK });
  await s.service.refresh(PROJECT_ID, completed());
  const text = await s.read();
  assert.match(text, /【目的】〔調査 \d{4}-\d{2}-\d{2} unknown〕タスク管理を行うサーバーアプリケーションである。（根拠: src\/main\.ts）/u);
});

test("a work_completed that meets no condition does not call the investigation", async (t) => {
  let calls = 0;
  const s = await serviceSetup(t, { files: THICK, investigate: async () => { calls += 1; return OK; } });
  await s.service.refresh(PROJECT_ID, completed({ old_base_commit: "aaa", new_base_commit: "bbb" }));
  assert.equal(calls, 0);
});

test("a merge over the threshold calls the investigation", async (t) => {
  let calls = 0;
  const s = await serviceSetup(t, { files: THICK, stat: stat(40), investigate: async () => { calls += 1; return OK; } });
  await s.service.refresh(PROJECT_ID, completed({ old_base_commit: "aaa", new_base_commit: "bbb" }));
  assert.equal(calls, 1);
});

test("a light refresh keeps the investigated content", async (t) => {
  let calls = 0;
  const s = await serviceSetup(t, { files: THICK, investigate: async () => { calls += 1; return OK; } });
  await s.service.refresh(PROJECT_ID, { kind: "manual_investigation" });
  const before = await s.read();
  await s.service.refresh(PROJECT_ID, completed());
  const after = await s.read();
  assert.equal(calls, 1);
  assert.match(after, /〔調査 [^\n]*タスク管理を行うサーバーアプリケーションである。/u);
  assert.ok(!after.includes("注意書きは見つからなかった"));
  assert.equal(after.match(/main への直接の書き込みは避け/gu)?.length, before.match(/main への直接の書き込みは避け/gu)?.length);
});

test("a failing investigation leaves the rule-based note and a log", async (t) => {
  for (const investigate of [async () => { throw new Error("boom"); }, async () => ({ ok: false, error: "timeout" })]) {
    const s = await serviceSetup(t, { investigate });
    await s.service.refresh(PROJECT_ID, completed());
    const text = await s.read();
    assert.ok(!text.includes("〔調査"));
    assert.match(text, /【目的】/u);
    assert.equal(s.logs.length, 1);
  }
});

async function vaultText(dir) {
  let out = "";
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out += await vaultText(path);
    else if (entry.name.endsWith(".md")) out += await readFile(path, "utf8").catch(() => "");
  }
  return out;
}

// ---- Core.investigateProjectOverview with a fake runner ----

async function coreSetup(t, impl, plan = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-overview-core-inv-")));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const requests = [];
  const clock = { value: "2026-01-01T23:00:00.000Z" };
  const agentRunner = impl ? { runProjectInvestigation: async (request) => { requests.push(request); return impl(requests.length); } } : {};
  const reader = {
    listFiles: async () => ["src/main.ts", "package.json", "README.md"],
    readFile: async () => DOC,
    changedPaths: async () => [],
    diffStat: async () => stat(400),
  };
  const core = new Core({ db, agentRunner, version: "t", owlRoot: root, projectSourceReader: reader, now: () => clock.value });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await core.start();
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "--initial-branch=main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  await writeFile(join(repo, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-m", "initial");
  const envelope = { request_id: createUlid(), idempotency_key: `t:project:${createUlid()}`, expected_version: 0, payload: { name: "demo", canonical_path: repo, base_branch: "main", allowed_roots: [root], verification_plan: plan } };
  const id = (await core.createProject(envelope)).data.id;
  await core.projectOverviews.idle();
  return { core, root, id, requests, clock, noteIn: (dir) => join(dir, "notes", `project-overview-${id}.md`) };
}

test("dry_run returns a plan and never calls the runner", async (t) => {
  const s = await coreSetup(t, async () => OK);
  const before = s.requests.length;
  const result = await s.core.investigateProjectOverview({ project_id: s.id, dry_run: true });
  assert.equal(result.dry_run, true);
  assert.equal(result.plan.would_investigate, true);
  assert.equal(result.plan.timeout_ms, 600_000);
  assert.ok(result.plan.model.model);
  assert.equal(s.requests.length, before);
});

test("knowledge_dir writes the note into that directory and the model comes from the librarian setting", async (t) => {
  const s = await coreSetup(t, async () => OK);
  const dir = join(s.root, "other-knowledge");
  const result = await s.core.investigateProjectOverview({ project_id: s.id, knowledge_dir: dir });
  assert.match(result.state, /^(queued|running)$/u);
  const note = await waitFor(() => readFile(s.noteIn(dir), "utf8").catch(() => null));
  assert.match(note ?? "", /〔調査 /u);
  const last = s.requests[s.requests.length - 1];
  assert.ok(last.model && last.provider);
});

test("an automatic run is suppressed during the cooldown after a failure, a manual one is not", async (t) => {
  const s = await coreSetup(t, async (n) => (n === 1 ? { ok: false, error: "timeout" } : OK));
  assert.equal(s.requests.length, 1);
  // The next calendar day starts 2 hours after the failure, so only the cooldown (6 hours) can hold the run back.
  s.clock.value = "2026-01-02T01:00:00.000Z";
  s.core.projectOverviews.schedule(s.id, { kind: "project_created" });
  await s.core.projectOverviews.idle();
  assert.equal(s.requests.length, 1, "the cooldown suppresses the automatic run");
  await s.core.investigateProjectOverview({ project_id: s.id });
  await waitFor(() => s.requests.length === 2);
  assert.equal(s.requests.length, 2, "a manual run ignores the cooldown");
});

test("unknown projects and bad input are rejected", async (t) => {
  const s = await coreSetup(t, async () => OK);
  await assert.rejects(s.core.investigateProjectOverview({ project_id: createUlid(), dry_run: true }), (e) => e.code === "not_found");
  await assert.rejects(s.core.investigateProjectOverview({ project_id: s.id, knowledge_dir: "relative/dir" }), (e) => e.code === "validation_error");
});

test("without a runner the investigation is unavailable", async (t) => {
  const s = await coreSetup(t, null);
  await assert.rejects(s.core.investigateProjectOverview({ project_id: s.id }), (e) => e.code === "dependency_unavailable");
  const plan = (await s.core.investigateProjectOverview({ project_id: s.id, dry_run: true })).plan;
  assert.equal(plan.unavailable_reason, "runner_unavailable");
});

test("a refusal by Core does not stop later retries the same day", async (t) => {
  let calls = 0;
  const s = await serviceSetup(t, { investigate: async () => { calls += 1; return calls === 1 ? { ok: false, error: "cooldown" } : OK; } });
  await s.service.refresh(PROJECT_ID, completed());
  await s.service.refresh(PROJECT_ID, completed());
  assert.equal(calls, 2);
  assert.match(await s.read(), /〔調査 /u);
});

test("unusable ok results count as failures and lead to the 24 hour cooldown", async (t) => {
  const s = await coreSetup(t, async () => ({ ok: true, investigation: {} }));
  assert.equal(s.requests.length, 1);
  s.clock.value = "2026-01-02T06:00:00.000Z";
  s.core.projectOverviews.schedule(s.id, { kind: "project_created" });
  await s.core.projectOverviews.idle();
  assert.equal(s.requests.length, 2, "6 hours have passed since the first empty result");
  s.clock.value = "2026-01-03T01:00:00.000Z";
  s.core.projectOverviews.schedule(s.id, { kind: "project_created" });
  await s.core.projectOverviews.idle();
  assert.equal(s.requests.length, 2, "the second consecutive failure holds for 24 hours");
});

test("dry_run agrees with the service when the docs are long but purpose and commands are missing", async (t) => {
  const s = await coreSetup(t, async (n) => (n === 1 ? { ok: false, error: "timeout" } : OK));
  const plan = (await s.core.investigateProjectOverview({ project_id: s.id, dry_run: true })).plan;
  assert.equal(plan.automatic.would_trigger, true);
  assert.match(plan.automatic.reason, /T-d/u);
  assert.equal(plan.metrics.commands, 0);
  assert.equal(typeof plan.metrics.purpose_chars, "number");
  s.clock.value = "2026-01-02T07:00:00.000Z";
  s.core.projectOverviews.schedule(s.id, { kind: "work_completed", work_id: WORK_ID, title: "変更", merge: null });
  await s.core.projectOverviews.idle();
  assert.equal(s.requests.length, 2, "the service starts the investigation the plan predicted");
});

test("a runner that never settles is cut off and later investigations proceed", async (t) => {
  const previous = process.env.OWL_PROJECT_INVESTIGATION_SAFETY_MS;
  process.env.OWL_PROJECT_INVESTIGATION_SAFETY_MS = "100";
  t.after(() => { if (previous === undefined) delete process.env.OWL_PROJECT_INVESTIGATION_SAFETY_MS; else process.env.OWL_PROJECT_INVESTIGATION_SAFETY_MS = previous; });
  const s = await coreSetup(t, (n) => (n === 1 ? new Promise(() => {}) : Promise.resolve(OK)));
  await s.core.investigateProjectOverview({ project_id: s.id });
  // The overview of a registered Project lives in its 構成 page (pages memory), not in a fixed note.
  const note = await waitFor(async () => (await vaultText(join(s.root, "knowledge"))).includes("〔調査 "));
  assert.ok(note, "the manual run behind the stuck one ran");
  assert.equal(s.requests.length, 2);
});

test("a success suppresses automatic runs for 6 hours across the date, then they resume", async (t) => {
  const s = await coreSetup(t, async () => OK);
  assert.equal(s.requests.length, 1);
  const big = { kind: "work_completed", work_id: WORK_ID, title: "変更", merge: { old_base_commit: "a", new_base_commit: "b" } };
  s.clock.value = "2026-01-02T01:00:00.000Z";
  s.core.projectOverviews.schedule(s.id, big);
  await s.core.projectOverviews.idle();
  assert.equal(s.requests.length, 1, "1 hour after the success the big merge is suppressed");
  s.clock.value = "2026-01-02T05:01:00.000Z";
  s.core.projectOverviews.schedule(s.id, big);
  await s.core.projectOverviews.idle();
  assert.equal(s.requests.length, 2, "6 hours later it resumes");
});

test("dry_run counts commands from the verification plan like the service", async (t) => {
  const s = await coreSetup(t, async () => OK, [{ command_id: "t", argv: ["pnpm", "test"], cwd: ".", env_allowlist: [], timeout_seconds: 60, stdout_limit: 1000, stderr_limit: 1000, expected_exit_codes: [0], executor: "core" }]);
  const plan = (await s.core.investigateProjectOverview({ project_id: s.id, dry_run: true })).plan;
  assert.equal(plan.metrics.commands, 1);
});
