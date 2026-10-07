import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeNotes, ProjectOverviewService } from "../dist/index.js";

const ID = "01M3W8TMGHXETCSVDSM390EEDV";

test("cautions drop bold markup, heading-only items and repeated rule ids; CJK line wraps are joined", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-caution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    "README.md": "# demo\n\n複数媒体の素材を\n管理する共有基盤。\n",
    "CLAUDE.md": "- **I3**: claimなしの消費は禁止。書き込み\n- I3: claimなしの消費は禁止。書き込みは必ずCLI経由。\n- **シグナルを明示的に切断**\n- **注意事項**:\n- **本番環境への直接書き込みは禁止。**\n- **禁止事項**\n",
  };
  const service = new ProjectOverviewService({
    notes: new KnowledgeNotes({ knowledgeDir: join(root, "knowledge") }),
    withWrite: (fn) => fn(),
    getProject: () => ({ id: ID, name: "demo", canonical_path: root, base_branch: "main" }),
    reader: { listFiles: async () => Object.keys(files), readFile: async (_r, _ref, path) => files[path] ?? "", changedPaths: async () => [] },
  });
  await service.refresh(ID, { kind: "project_created" });
  const text = await readFile(join(root, "knowledge/notes", `project-overview-${ID}.md`), "utf8");
  const cautions = [...text.matchAll(/【注意】(.*?) <!--/gu)].map((m) => m[1]);
  assert.deepEqual(cautions, ["I3: claimなしの消費は禁止。書き込みは必ずCLI経由。", "本番環境への直接書き込みは禁止。"]);
  assert.match(text, /素材を管理する/u);
});

test("a fully bold prohibition without a full stop stays a caution, a bold heading does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-caution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = { "README.md": "# demo\n\n共有基盤。\n", "CLAUDE.md": "- **本番環境への直接書き込みは禁止**\n- **注意事項**\n" };
  const service = new ProjectOverviewService({
    notes: new KnowledgeNotes({ knowledgeDir: join(root, "knowledge") }),
    withWrite: (fn) => fn(),
    getProject: () => ({ id: ID, name: "demo", canonical_path: root, base_branch: "main" }),
    reader: { listFiles: async () => Object.keys(files), readFile: async (_r, _ref, path) => files[path] ?? "", changedPaths: async () => [] },
  });
  await service.refresh(ID, { kind: "project_created" });
  const text = await readFile(join(root, "knowledge/notes", `project-overview-${ID}.md`), "utf8");
  const cautions = [...text.matchAll(/【注意】(.*?) <!--/gu)].map((m) => m[1]);
  assert.deepEqual(cautions, ["本番環境への直接書き込みは禁止"]);
});

test("a feature description line mentioning 禁止ワード is not a caution, a real prohibition stays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-caution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = { "README.md": "# demo\n\n共有基盤。\n\n- 自動チェック: 禁止ワード検出、plat仕様適合、重複検出、センシティブ判定\n- 本番環境への直接書き込みは禁止\n- 禁止事項: 本番への直接書き込み、履歴の改変、外部への公開\n- 注意: 変更前に確認、変更後に確認、結果を記録\n- 運用: 履歴の改変は禁止、削除は必ず確認、公開前に承認\n" };
  const service = new ProjectOverviewService({
    notes: new KnowledgeNotes({ knowledgeDir: join(root, "knowledge") }),
    withWrite: (fn) => fn(),
    getProject: () => ({ id: ID, name: "demo", canonical_path: root, base_branch: "main" }),
    reader: { listFiles: async () => Object.keys(files), readFile: async (_r, _ref, path) => files[path] ?? "", changedPaths: async () => [] },
  });
  await service.refresh(ID, { kind: "project_created" });
  const text = await readFile(join(root, "knowledge/notes", `project-overview-${ID}.md`), "utf8");
  const cautions = [...text.matchAll(/【注意】(.*?) <!--/gu)].map((m) => m[1]);
  assert.equal(cautions.length, 4);
  for (const kept of ["本番環境への直接書き込みは禁止", "本番への直接書き込み、履歴の改変", "変更前に確認、変更後に確認", "履歴の改変は禁止、削除は必ず確認"]) assert.ok(cautions.some((c) => c.includes(kept)), kept);
  assert.ok(!cautions.some((c) => c.includes("禁止ワード")));
});
