import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { KnowledgeBase } from "../../dist/knowledge-base.js";
import { KnowledgeNotes } from "../../dist/knowledge-notes.js";
import { MemoryService } from "../../dist/memory/memory-service.js";

const fixture = (kind) => readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8");
const KEYWORD = "ふくろう";
// Files that match no template; the old folder rules used to type some of them as clipping / log / work-log.
const NON_TEMPLATE = {
  "notes/plain.md": `---\ntitle: 平文\n---\n${KEYWORD}\n`,
  "research/old-clip.md": `---\nkind: research\nurl: https://example.com/old\n---\n${KEYWORD}\n`,
  "advisor/session.md": `${KEYWORD}の古い要約\n`,
  "works/old-work.md": `---\ntitle: 古い Work\n---\n${KEYWORD}\n`,
  "research/bad.md": `---\ntype: clipping\n---\n${KEYWORD}\n`,
  "ext/typed-log.md": `---\ntitle: ログ\ntype: log\n---\n${KEYWORD}\n`,
};

test("files that match no template are not knowledge (search, recall, page search, KnowledgeNotes.list)", async () => {
  const root = mkdtempSync(join(tmpdir(), "owl-template-only-"));
  const vault = join(root, "vault");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const write = (rel, text) => { mkdirSync(dirname(join(vault, rel)), { recursive: true }); writeFileSync(join(vault, rel), text); };
  write("research/2026-10-01-日付.md", fixture("clipping").replace("JavaScript", KEYWORD));
  write("projects/kotori/テスト.md", fixture("theme"));
  for (const [path, text] of Object.entries(NON_TEMPLATE)) write(path, text);
  write("notes/legacy-note.md", `---\nid: 01JCCCCCCCCCCCCCCCCCCCCC01\ntitle: 旧ノート\ntags: []\nsources: []\nlinks: []\nproject_ids: []\ncreated: 2026-09-01T00:00:00.000Z\nupdated: 2026-09-02T00:00:00.000Z\n---\n\n## Summary\n旧\n\n## Claims\n- [fact] ${KEYWORD} <!-- claim:aaaa -->\n\n## Related notes\n`);
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const service = new MemoryService({ dataDir, storage, embedder: { enabled: false, health: () => ({}), stop: async () => {} }, indexOptions: { watch: false } });
  await service.start();
  try {
    await service.reindex({ mode: "full" });
    const paths = async () => (await service.search({ query: KEYWORD, include_raw: true, include_archived: true, include_superseded: true })).items.map((i) => i.path);
    const found = await paths();
    assert.deepEqual(found.filter((p) => p in NON_TEMPLATE || p === "notes/legacy-note.md"), []);
    assert.ok(found.includes("research/2026-10-01-日付.md"));
    assert.deepEqual((await service.recall({ topic: KEYWORD })).items.map((i) => i.path).filter((p) => p in NON_TEMPLATE), []);
    const clips = (await service.searchPages({ query: KEYWORD }, { caller: "owner", agent_run_id: null, work_id: null, task_id: null, project_id: null })).items.map((i) => i.path);
    assert.deepEqual(clips, ["research/2026-10-01-日付.md"]);
    const owner = { caller: "owner", agent_run_id: null, work_id: null, task_id: null, project_id: null };
    for (const path of Object.keys(NON_TEMPLATE)) assert.equal((await service.page({ page: path }, owner)).found, false, `page ${path}`);
    assert.equal((await service.page({ page: "research/2026-10-01-日付.md" }, owner)).found, true);
    const listedPages = service.index.listPages({ types: ["clipping", "theme", "project-index", "work-log"], status: ["active", "archived", "draft", "superseded"] }).map((r) => r.path);
    assert.ok(!listedPages.includes("research/bad.md"));

    // The note read-side is gone: the old note is not listed either.
    assert.deepEqual(await new KnowledgeNotes(new KnowledgeBase(root, { rootDir: () => vault })).list(), []);
  } finally { await service.stop(); rmSync(root, { recursive: true, force: true }); }
});
