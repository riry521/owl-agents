import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const ID = "01M3W8TMGHXETCSVDSM390EEDV";
const SCRIPT = new URL("../../../scripts/create-project-overviews.mjs", import.meta.url).pathname;
const OLD = "OLD CONTENT";
const note = (ids) => `---\nid: 01M3W8TMGHXETCSVDSM390EEDW\ntitle: t\ntags: []\nsources: []\nlinks: []\nproject_ids: ${ids}\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\n${OLD}\n`;

async function setup(t, files) {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-rebuild-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = join(root, "notes");
  await mkdir(notes);
  for (const [file, content] of Object.entries(files)) await writeFile(join(notes, file), content);
  const server = createServer((_req, res) => { res.end(JSON.stringify({ data: [{ id: ID, name: "demo", canonical_path: root, base_branch: "main" }] })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const go = (...extra) => run("node", [SCRIPT, root, `--api=http://127.0.0.1:${server.address().port}`, ...extra]);
  return { notes, go };
}

const own = `project-overview-${ID}.md`;

test("--rebuild overwrites the project's own note under the same name", async (t) => {
  const s = await setup(t, { [own]: note(`['${ID}']`) });
  await s.go("--rebuild");
  assert.deepEqual(await readdir(s.notes), [own]);
  assert.ok(!(await readFile(join(s.notes, own), "utf8")).includes(OLD));
});

test("--rebuild does not overwrite a project only listed in another note, nor create a file", async (t) => {
  const s = await setup(t, { "other.md": note(`['${ID}']`) });
  await s.go("--rebuild");
  assert.deepEqual(await readdir(s.notes), ["other.md"]);
  assert.ok((await readFile(join(s.notes, "other.md"), "utf8")).includes(OLD));
});

test("--rebuild does not create a note when none exists", async (t) => {
  const s = await setup(t, {});
  await s.go("--rebuild");
  assert.deepEqual(await readdir(s.notes), []);
});

test("--rebuild --dry-run writes nothing and lists the target", async (t) => {
  const s = await setup(t, { [own]: note(`['${ID}']`) });
  const { stdout } = await s.go("--rebuild", "--dry-run");
  assert.match(stdout, new RegExp(`update  ${own}`));
  assert.ok((await readFile(join(s.notes, own), "utf8")).includes(OLD));
});
