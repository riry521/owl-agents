import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeNotes, ProjectOverviewService } from "../dist/index.js";

const PROJECT_ID = "01M3W8TMGHXETCSVDSM390EEDV";
const LABELS = ["【目的】", "【構成】", "【技術スタック】", "【主要コマンド】", "【注意】"];

async function generate(t, { files, describe }) {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-content-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reads = [];
  const service = new ProjectOverviewService({
    notes: new KnowledgeNotes({ knowledgeDir: join(root, "knowledge") }),
    withWrite: (fn) => fn(),
    getProject: () => ({ id: PROJECT_ID, name: "demo", canonical_path: root, base_branch: "main" }),
    reader: {
      listFiles: async () => [".env", ".env.local", "secrets.json", ...Object.keys(files)],
      readFile: async (_repo, _ref, path) => {
        reads.push(path);
        return files[path] ?? "SECRET=hunter2-should-never-appear";
      },
      changedPaths: async () => [],
    },
    describe,
  });
  await service.refresh(PROJECT_ID, { kind: "project_created" });
  const text = await readFile(join(root, "knowledge/notes", `project-overview-${PROJECT_ID}.md`), "utf8");
  return { text, reads };
}

const english = {
  "README.md": "# Demo\n\nA web application for managing tasks.\n",
  "package.json": JSON.stringify({ name: "demo", description: "A web application for managing tasks.", dependencies: { next: "1" } }),
  "CLAUDE.md": "# Rules\n- Do not commit directly to main\n",
};

test("English README/description yields a Japanese body without copying the English text", async (t) => {
  const { text } = await generate(t, { files: english });
  assert.ok(!text.includes("A web application"));
  assert.ok(!text.includes("Do not commit"));
  assert.match(text.split("【目的】")[1].split("\n")[0], /[぀-ヿ一-鿿]/u);
});

test("describe hook is used when it returns Japanese; English output or a throw falls back", async (t) => {
  const ok = await generate(t, { files: english, describe: async () => "タスク管理用のWebアプリ。" });
  assert.ok(ok.text.includes("タスク管理用のWebアプリ。"));
  for (const describe of [async () => "A web application", async () => { throw new Error("boom"); }]) {
    const { text } = await generate(t, { files: english, describe });
    assert.ok(!text.includes("A web application"));
    assert.ok(text.includes("【目的】"));
  }
});

test("all five sections exist even without cautions", async (t) => {
  const { text } = await generate(t, { files: { "package.json": "{}" } });
  for (const label of LABELS) assert.ok(text.includes(label), label);
  assert.ok(text.includes("注意書きが見つからなかった"));
});

test("secret files are neither read nor included", async (t) => {
  const { text, reads } = await generate(t, { files: english });
  assert.deepEqual(reads.filter((p) => p.startsWith(".env") || p === "secrets.json"), []);
  assert.ok(!text.includes("hunter2") && !text.includes(".env") && !text.includes("secrets.json"));
});

test("non-Node repos get tech, commands, structure and evidence instead of an unknown marker", async (t) => {
  const files = {
    "README.md": "# Tool\n\n## Usage\n\n```\npython cli.py run\n```\n",
    "requirements.txt": "fastapi==0.1\npytest\n",
    "cli.py": "",
    "src/a.py": "",
    "Makefile": "test:\n\tpytest\n",
  };
  const { text } = await generate(t, { files });
  assert.match(text, /Python/u);
  assert.match(text, /FastAPI/u);
  assert.match(text, /make test/u);
  assert.match(text, /python cli\.py run/u);
  assert.ok(!text.includes("（不明）") && !text.includes("A web"));
  const bare = (await generate(t, { files: { "README.md": "# X\n" } })).text;
  assert.match(bare, /pyproject\.toml・Cargo\.toml・go\.mod が無く/u);
  assert.ok(!bare.includes("（不明）"));
});

test("work records, design references and date-only paragraphs are not adopted as the purpose", async (t) => {
  const readme = "# デモ\n\n実施日: 2026-05-01\n\n2026-05-01\n\n設計書: docs/design/x.md を参照\n\n`docs/design/x.md`\n\nタスクを管理するためのWebアプリです。\n";
  const { text } = await generate(t, { files: { "README.md": readme } });
  const purpose = text.split("【目的】")[1].split("\n")[0];
  assert.ok(purpose.includes("タスクを管理するためのWebアプリです"));
  assert.ok(!purpose.includes("実施日") && !purpose.includes("設計書"));
  const none = (await generate(t, { files: { "README.md": "# デモ\n\n実施日: 2026-05-01\n\n設計書: docs/a.md\n" } })).text;
  const fallback = none.split("【目的】")[1].split("\n")[0];
  assert.ok(!fallback.includes("実施日") && !fallback.includes("設計書:") && fallback.includes("README"));
});
