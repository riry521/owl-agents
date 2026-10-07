import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeNotes, ProjectOverviewService } from "../dist/index.js";

const PROJECT_ID = "01M3W8TMGHXETCSVDSM390EEDV";

async function generate(t, files, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-quality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ProjectOverviewService({
    notes: new KnowledgeNotes({ knowledgeDir: join(root, "knowledge") }),
    withWrite: (fn) => fn(),
    getProject: () => ({ id: PROJECT_ID, name: "demo", canonical_path: root, base_branch: "main" }),
    reader: { listFiles: async () => Object.keys(files), readFile: async (_r, _ref, path) => files[path] ?? "", changedPaths: async () => [] },
    ...options,
  });
  await service.refresh(PROJECT_ID, { kind: "project_created" });
  const file = join(root, "knowledge/notes", `project-overview-${PROJECT_ID}.md`);
  if (options.seed) {
    await writeFile(file, (await readFile(file, "utf8")).replace(/(【目的】)[^\n]*?( <!-- claim:)/u, `$1${options.seed}$2`));
    await service.refresh(PROJECT_ID, { kind: "project_created" });
  }
  const text = await readFile(file, "utf8");
  const summary = text.match(/^## Summary\n(.*)$/mu)?.[1] ?? "";
  const claimText = (m) => m[1].replace(/ <!-- claim:.*$/u, "");
  const cautions = [...text.matchAll(/【注意】(.*)$/gmu)].map(claimText);
  return { text, summary, cautions };
}

test("long purpose ends at a sentence boundary in claim and summary", async (t) => {
  const sentence = "このプロジェクトはタスクを管理するための仕組みである。";
  const { text, summary } = await generate(t, { "README.md": `# Demo\n\n${sentence.repeat(4)}ここから先は途中で切れるはずの長い説明が続いていきます${"あ".repeat(200)}\n` });
  const purpose = text.split("【目的】")[1].split("\n")[0].replace(/ <!-- claim:.*$/u, "");
  assert.ok(purpose.endsWith("。"), purpose);
  assert.ok(summary.startsWith("demo: このプロジェクト"));
  assert.ok(summary.length <= 360 && !summary.includes("…"));
  assert.ok(/[。！？]"?$/u.test(summary), summary);
  assert.ok(!/あ。/u.test(summary));
});

test("caution prefixes are stripped and not duplicated", async (t) => {
  const { cautions, summary } = await generate(t, { "CLAUDE.md": "# R\n- 注意: 本番 DB には直接つながないこと\n- ※ 必ず pnpm を使うこと\n- 重要：ビルド前にテストを通す\n" });
  assert.deepEqual(cautions, ["本番 DB には直接つながないこと", "必ず pnpm を使うこと", "ビルド前にテストを通す"]);
  assert.ok(summary.includes("注意: 本番 DB"));
  assert.ok(!/注意: 注意|【注意】注意/u.test(summary));
});

test("non-permanent notes are excluded from cautions", async (t) => {
  const { text, cautions } = await generate(t, {
    "CLAUDE.md": [
      "# R",
      "- 注意: 2026-09-30 23:01 に Socket Mode の再接続警告",
      "- 注意: WARN gateway 重要な再接続に失敗",
      "- 注意: D は実際に codex exec --json で起動しました。builder が --dangerously-bypass を使う",
      "- 注意: 重要な作業を完了しました",
      "- 注意: 案A を採用する",
      "- 注意: 選択肢のうち必ず B を選ぶ",
      "- 重要 | 必ず | 列",
      "```",
      "- 注意: コードブロック内の断片",
      "```",
      "- 必ずテストを書くこと",
    ].join("\n"),
  });
  assert.deepEqual(cautions, ["必ずテストを書くこと"]);
  const none = await generate(t, { "CLAUDE.md": "- 注意: D は起動しました\n" });
  assert.ok(none.text.includes("運用ルールは CLAUDE.md に記載されている"));
  assert.ok(!text.includes("codex exec"));
});

const purposeOf = (text) => text.split("【目的】")[1].split("\n")[0].replace(/ <!-- claim:.*$/u, "");

test("an unfinished tail within the limit is dropped, not completed", async (t) => {
  const { text, summary } = await generate(t, { "README.md": "# Demo\n\nこのプロジェクトはタスク管理のツールです。途中の語\n" });
  assert.equal(purposeOf(text), "このプロジェクトはタスク管理のツールです。");
  assert.ok(summary.startsWith("demo: このプロジェクトはタスク管理のツールです。"), summary);
  assert.ok(!summary.includes("途中の語"));
});

test("a newline is a sentence boundary and a body-less element is omitted", async (t) => {
  const { text, summary } = await generate(t, { "README.md": `# Demo\n\nタスクを管理するための仕組み\n${"長い説明が続きます".repeat(40)}\n` });
  assert.equal(purposeOf(text), "タスクを管理するための仕組み");
  assert.ok(summary.startsWith("demo: タスクを管理するための仕組み。"), summary);
  const none = await generate(t, { "README.md": `# Demo\n\n${"区切りの無い長い説明です".repeat(40)}\n` });
  assert.ok(!none.summary.includes("区切りの無い") && !/: *。/u.test(none.summary), none.summary);
});

test("repeated caution prefixes are all stripped", async (t) => {
  const { cautions, summary } = await generate(t, { "CLAUDE.md": "# R\n- 注意: 注意：重要: 必ず確認する。\n" });
  assert.deepEqual(cautions, ["必ず確認する。"]);
  assert.ok(summary.includes("注意: 必ず確認する。"), summary);
});

test("tilde fences are excluded from cautions", async (t) => {
  const { cautions } = await generate(t, { "CLAUDE.md": "# R\n~~~\n- 注意: コードの断片です。\n~~~\n- 必ず確認する。\n````\n```\n- 注意: 内側の断片です。\n````\n" });
  assert.deepEqual(cautions, ["必ず確認する。"]);
});

test("past-tense reports are excluded but standing instructions stay", async (t) => {
  const { cautions } = await generate(t, { "CLAUDE.md": "# R\n- 注意: サーバーを起動した。\n- 注意: 検証を完了した。\n- 本番への直接接続は禁止であり、してはいけない。\n- 必ずテストを通す。\n" });
  assert.deepEqual(cautions, ["本番への直接接続は禁止であり、してはいけない。", "必ずテストを通す。"]);
});

test("purposeOf, describe and a kept purpose never leave an unfinished tail", async (t) => {
  const tail = "このプロジェクトは管理ツールです。途中の語";
  const viaFixed = await generate(t, { "README.md": "# Demo\n" }, { purposeOf: () => tail });
  assert.equal(purposeOf(viaFixed.text), "このプロジェクトは管理ツールです。");
  assert.ok(viaFixed.summary.startsWith("demo: このプロジェクトは管理ツールです。") && !viaFixed.summary.includes("途中の語"), viaFixed.summary);
  const english = { "README.md": "# Demo\n\nThis tool manages tasks for many teams.\n" };
  const viaDescribe = await generate(t, english, { describe: async () => tail });
  assert.equal(purposeOf(viaDescribe.text), "このプロジェクトは管理ツールです。");
  assert.ok(!viaDescribe.summary.includes("途中の語"), viaDescribe.summary);
  const kept = await generate(t, english, { seed: tail });
  assert.ok(!kept.text.includes("途中の語") && !kept.summary.includes("途中の語"), kept.summary);
  const none = await generate(t, { "README.md": "# Demo\n" }, { purposeOf: () => "区切りの無い説明" });
  assert.ok(!none.text.includes("区切りの無い説明") && !none.summary.includes("区切りの無い"), none.summary);
});

test("multi-sentence work reports are excluded", async (t) => {
  const { cautions } = await generate(t, { "CLAUDE.md": "# R\n- 注意: サーバーを起動しました。動作確認は明日行う。\n- 必ず確認する。次に本番へ反映する。\n" });
  assert.deepEqual(cautions, ["必ず確認する。次に本番へ反映する。"]);
});

test("indented code blocks are excluded but nested lists stay", async (t) => {
  const { cautions } = await generate(t, { "CLAUDE.md": "# R\n\n段落です。\n\n    - 注意: これはコードの断片です。\n    - 注意: 続きの断片です。\n\n- 必ず確認する。\n    - 注意: 入れ子の項目です。\n\n    - 注意: 空行を挟んだ入れ子です。\n" });
  assert.deepEqual(cautions, ["必ず確認する。", "入れ子の項目です。", "空行を挟んだ入れ子です。"]);
});

for (const [name, lead] of [["spaces", "    "], ["tab", "\t"]]) {
  test(`indented code block at file start is excluded (${name})`, async (t) => {
    const { cautions, summary } = await generate(t, { "CLAUDE.md": `${lead}- 注意: これはコードの断片です。\n` });
    assert.ok(!cautions.some((c) => c.includes("コードの断片")), cautions.join("|"));
    assert.ok(!summary.includes("コードの断片"), summary);
    assert.deepEqual(cautions, ["運用ルールは CLAUDE.md に記載されている。作業前に読む"]);
  });
}

test("indented list continuation at file start is kept", async (t) => {
  const { cautions } = await generate(t, { "CLAUDE.md": "- 必ず確認する。\n    - 注意: 入れ子の項目です。\n" });
  assert.deepEqual(cautions, ["必ず確認する。", "入れ子の項目です。"]);
});

for (const [name, lead] of [["spaces", "    "], ["tab", "\t"]]) {
  test(`indented code block right after frontmatter is excluded (${name})`, async (t) => {
    const { cautions, summary } = await generate(t, { "CLAUDE.md": `---\ntitle: x\n---\n${lead}- 注意: これはコードの断片です。\n` });
    assert.ok(!cautions.some((c) => c.includes("コードの断片")), cautions.join("|"));
    assert.ok(!summary.includes("コードの断片"), summary);
    assert.deepEqual(cautions, ["運用ルールは CLAUDE.md に記載されている。作業前に読む"]);
  });
}

for (const [name, lead] of [["spaces", "    "], ["tab", "\t"]]) {
  test(`CRLF frontmatter then indented code block is excluded (${name})`, async (t) => {
    const { text, cautions, summary } = await generate(t, { "CLAUDE.md": `---\r\ntitle: x\r\n---\r\n${lead}- 注意: これはコードの断片です。\r\n` });
    assert.ok(!cautions.some((c) => c.includes("コードの断片")), cautions.join("|"));
    assert.ok(!summary.includes("コードの断片"), summary);
    assert.deepEqual(cautions, ["運用ルールは CLAUDE.md に記載されている。作業前に読む"]);
    const purpose = text.match(/【目的】(.*)$/mu)?.[1] ?? "";
    assert.ok(!/title: x|コードの断片/u.test(purpose + summary), purpose + summary);
  });
}
