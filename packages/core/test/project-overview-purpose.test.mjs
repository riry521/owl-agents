import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { KnowledgeNotes, ProjectOverviewService } from "../dist/index.js";

const run = promisify(execFile);
const ID = "01M3W8TMGHXETCSVDSM390EEDV";
const SCRIPT = new URL("../../../scripts/create-project-overviews.mjs", import.meta.url).pathname;
const PURPOSE = "動画を自動生成して投稿するための編集ツールである。";
const purposeLine = (text) => text.split("【目的】")[1].split("\n")[0].replace(/ <!--.*$/u, "");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-purpose-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "demo" }));
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const knowledge = join(root, "knowledge");
  await mkdir(join(knowledge, "notes"), { recursive: true });
  const project = { id: ID, name: "demo", canonical_path: repo, base_branch: "main" };
  return { root, knowledge, notes: join(knowledge, "notes"), project };
}

const serviceFor = (s, extra = {}) => new ProjectOverviewService({
  notes: new KnowledgeNotes({ knowledgeDir: s.knowledge }),
  withWrite: (fn) => fn(),
  getProject: () => s.project,
  reader: { listFiles: async () => ["package.json"], readFile: async () => "{}", changedPaths: async () => [] },
  ...extra,
});

async function script(t, s, ...extra) {
  const server = createServer((_req, res) => { res.end(JSON.stringify({ data: [s.project] })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const api = `--api=http://127.0.0.1:${server.address().port}`;
  return run("node", [SCRIPT, s.knowledge, api, ...extra]);
}

test("--purpose-file sets the given purpose in the note", async (t) => {
  const s = await setup(t);
  const file = join(s.root, "purposes.json");
  await writeFile(file, JSON.stringify({ [ID]: PURPOSE }));
  await script(t, s, "--purpose-file", file);
  assert.equal(purposeLine(await readFile(join(s.notes, `project-overview-${ID}.md`), "utf8")), PURPOSE);
});

test("a fixed-template fallback keeps the existing purpose", async (t) => {
  const s = await setup(t);
  await serviceFor(s, { purposeOf: () => PURPOSE }).refresh(ID, { kind: "project_created" });
  const work = { kind: "work_completed", work_id: "01M3W8TMGHXETCSVDSM390EEDX", title: "t", merge: null };
  await serviceFor(s).refresh(ID, work);
  const text = await readFile(join(s.notes, `project-overview-${ID}.md`), "utf8");
  assert.equal(purposeLine(text), PURPOSE);
});

test("an alias note with the same project_id prevents creation, and reruns do not add notes", async (t) => {
  const s = await setup(t);
  await writeFile(join(s.notes, "alias.md"), `---\nid: 01M3W8TMGHXETCSVDSM390EEDW\ntitle: "alias"\ntags: []\nsources: []\nlinks: []\nproject_ids: [${ID}]\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n`);
  await script(t, s);
  await script(t, s);
  assert.deepEqual(await readdir(s.notes), ["alias.md"]);
  await rm(join(s.notes, "alias.md"));
  await script(t, s);
  await script(t, s);
  assert.equal((await readdir(s.notes)).length, 1);
});
