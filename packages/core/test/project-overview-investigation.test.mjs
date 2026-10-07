import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeNotes, ProjectOverviewService } from "../dist/index.js";

const PROJECT_ID = "01M3W8TMGHXETCSVDSM390EEDV";
const DOC = `# Demo\n\n${"これはタスクを管理するためのツールで、利用者の作業を支援する。".repeat(30)}\n`;
const OK = {
  ok: true,
  investigation: {
    purpose: { text: "タスク管理を行うサーバーアプリケーションである。", evidence_paths: ["src/main.ts"] },
    architecture_flow: { text: "main.ts がリクエストを受け core に渡す。", evidence_paths: ["./src/main.ts", ".env", "nope.ts"] },
    entry_points: { text: "入口は src/main.ts である。", evidence_paths: ["src/main.ts"] },
    run_and_test: { text: "pnpm test でテストを実行する。", evidence_paths: ["package.json"] },
    cautions: [{ text: "main への直接の書き込みは避け、必ず Work を経由する。", evidence_paths: ["src/main.ts"] }],
  },
};

async function setup(t, { files, investigate, stat = [], now }) {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-investigation-"));
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
    now,
    log: (message, error) => logs.push([message, String(error)]),
  });
  const read = () => readFile(join(root, "knowledge/notes", `project-overview-${PROJECT_ID}.md`), "utf8");
  return { service, read, logs };
}
const completed = (extra = {}) => ({ kind: "work_completed", work_id: "01M3W8TMGHXETCSVDSM390EEDX", title: "変更", merge: { old_base_commit: "aaa", new_base_commit: "bbb" }, ...extra });
const stat = (n) => Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, added: 1, deleted: 0 }));

test("a project without README gets the investigation written, with only tracked evidence paths", async (t) => {
  const calls = [];
  const s = await setup(t, { files: {}, investigate: async (input) => { calls.push(input.reason); return OK; } });
  await s.service.refresh(PROJECT_ID, { kind: "work_completed", work_id: "01M3W8TMGHXETCSVDSM390EEDX", title: "t", merge: null });
  const text = await s.read();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^thin:/u);
  assert.match(text, /【目的】〔調査 \d{4}-\d{2}-\d{2} unknown〕タスク管理を行うサーバーアプリケーションである。（根拠: src\/main\.ts）/u);
  assert.match(text, /【構成】〔調査[^\n]*（根拠: src\/main\.ts）/u);
  assert.match(text, /【主要コマンド】〔調査[^\n]*（根拠: package\.json）/u);
  assert.ok(!text.includes(".env") && !text.includes("nope.ts"));
  assert.ok(!text.includes("構成から推定した"));
});

test("an ordinary work_completed does not call the investigation", async (t) => {
  let calls = 0;
  const s = await setup(t, { files: { "README.md": DOC, "CLAUDE.md": DOC, "package.json": '{"scripts":{"test":"x"}}' }, investigate: async () => { calls += 1; return OK; }, stat: stat(29) });
  await s.service.refresh(PROJECT_ID, completed());
  assert.equal(calls, 0);
});

test("a merge over the threshold calls the investigation", async (t) => {
  const reasons = [];
  const s = await setup(t, { files: { "README.md": DOC, "CLAUDE.md": DOC, "package.json": '{"scripts":{"test":"x"}}' }, investigate: async (input) => { reasons.push(input.reason); return OK; }, stat: stat(30) });
  await s.service.refresh(PROJECT_ID, completed());
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /^big_change:files=30/u);
});

test("a light refresh keeps the investigated claims and adds the recent change", async (t) => {
  const s = await setup(t, { files: {}, investigate: async () => OK });
  await s.service.refresh(PROJECT_ID, { kind: "project_created" });
  const first = await s.read();
  const lightService = new ProjectOverviewService({ ...s.service.options, investigate: undefined });
  await lightService.refresh(PROJECT_ID, completed({ merge: null }));
  const text = await s.read();
  for (const line of first.split("\n").filter((l) => l.includes("〔調査"))) assert.ok(text.includes(line));
  assert.ok(text.includes("【最近の変更】"));
  assert.ok(!text.includes("構成から推定した") && !text.includes("注意書きは見つからなかった") && !text.includes("見つからなかった。変更前に"));
});

test("a throwing, failed or empty investigation falls back to the rule note and logs", async (t) => {
  for (const investigate of [async () => { throw new Error("boom"); }, async () => ({ ok: false, error: "timeout" }), async () => ({ ok: true, investigation: { ...OK.investigation, purpose: { text: "English only.", evidence_paths: [] } } })]) {
    const s = await setup(t, { files: {}, investigate });
    await s.service.refresh(PROJECT_ID, { kind: "project_created" });
    const text = await s.read();
    assert.ok(!text.includes("〔調査"));
    assert.match(text, /【目的】/u);
    assert.equal(s.logs.length, 1);
  }
});

test("cautions drive the summary and survive a light refresh", async (t) => {
  const inv = { ...OK.investigation, purpose: { text: "設定を読み込むアプリである。タスク管理を行う。", evidence_paths: ["src/main.ts"] } };
  const s = await setup(t, { files: {}, investigate: async () => ({ ok: true, investigation: inv }) });
  await s.service.refresh(PROJECT_ID, { kind: "project_created" });
  const text = await s.read();
  assert.match(text, /タスク管理を行う。/u);
  assert.match(text, /## Summary\n[^\n]*注意: main への直接の書き込みは避け/u);
  assert.ok(!text.includes("注意書きは見つからなかった"));
  const light = new ProjectOverviewService({ ...s.service.options, investigate: undefined });
  await light.refresh(PROJECT_ID, completed({ merge: null }));
  assert.match(await s.read(), /## Summary\n[^\n]*注意: main への直接の書き込みは避け/u);
});

test("an incomplete investigation falls back, logs, and keeps the existing investigated claims", async (t) => {
  const partial = { ok: true, investigation: { purpose: OK.investigation.purpose, architecture_flow: OK.investigation.architecture_flow, entry_points: { text: "", evidence_paths: [] }, run_and_test: { text: "", evidence_paths: [] }, cautions: [] } };
  const bare = await setup(t, { files: {}, investigate: async () => partial });
  await bare.service.refresh(PROJECT_ID, { kind: "project_created" });
  assert.ok(!(await bare.read()).includes("〔調査"));
  assert.equal(bare.logs.length, 1);
  let result = OK;
  const s = await setup(t, { files: {}, investigate: async () => result });
  await s.service.refresh(PROJECT_ID, { kind: "project_created" });
  const first = await s.read();
  result = partial;
  await s.service.reinvestigate(PROJECT_ID);
  const text = await s.read();
  for (const line of first.split("\n").filter((l) => l.includes("〔調査"))) assert.ok(text.includes(line));
  assert.equal(s.logs.length, 1);
});

test("the text of an accepted investigation is written as it is", async (t) => {
  const inv = { ...OK.investigation, purpose: { text: "environment 変数を使う。README.md を読む。", evidence_paths: ["src/main.ts"] } };
  const s = await setup(t, { files: {}, investigate: async () => ({ ok: true, investigation: inv }) });
  await s.service.refresh(PROJECT_ID, { kind: "project_created" });
  const text = await s.read();
  assert.match(text, /environment 変数を使う。/u);
  assert.match(text, /README\.md を読む。/u);
});

test("a failure at 01:00 does not hold back the automatic run at 08:00 the same day", async (t) => {
  let calls = 0;
  let clock = "2026-01-01T01:00:00.000Z";
  const s = await setup(t, { files: {}, now: () => clock, investigate: async () => { calls += 1; return { ok: false, error: "timeout" }; } });
  await s.service.refresh(PROJECT_ID, { kind: "project_created" });
  clock = "2026-01-01T08:00:00.000Z";
  await s.service.refresh(PROJECT_ID, { kind: "project_created" });
  assert.equal(calls, 2);
});
