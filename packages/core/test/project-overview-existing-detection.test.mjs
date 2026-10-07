import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const ID = "01M3W8TMGHXETCSVDSM390EEDV";
const SCRIPT = new URL("../../../scripts/create-project-overviews.mjs", import.meta.url).pathname;
const note = (ids) => `---\nid: 01M3W8TMGHXETCSVDSM390EEDW\ntitle: t\ntags: []\nsources: []\nlinks: []\n${ids === null ? "" : `project_ids: ${ids}\n`}created: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nbody\n`;

async function setup(t, file, content) {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-exist-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const notes = join(root, "notes");
  await mkdir(notes);
  await writeFile(join(notes, file), content);
  const server = createServer((_req, res) => { res.end(JSON.stringify({ data: [{ id: ID, name: "demo", canonical_path: root, base_branch: "main" }] })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const purposeFile = join(root, "purposes.json");
  await writeFile(purposeFile, JSON.stringify({ [ID]: "指定された日本語の目的です。" }));
  const go = (...extra) => run("node", [SCRIPT, root, `--api=http://127.0.0.1:${server.address().port}`, ...extra]);
  return { notes, go, purposeFile };
}

test("a differently named note with single-quoted project_ids prevents creation, also on rerun", async (t) => {
  const s = await setup(t, "other.md", note(`['${ID}']`));
  await s.go();
  await s.go();
  assert.deepEqual(await readdir(s.notes), ["other.md"]);
});

test("a same-named note without project_ids prevents creation", async (t) => {
  const file = `project-overview-${ID}.md`;
  const s = await setup(t, file, note(null));
  await s.go();
  assert.deepEqual(await readdir(s.notes), [file]);
});

const sha = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

for (const [name, content] of [["without project_ids", note(null)], ["with another project's id", note("['OTHER']")], ["unparsable", "---\n: [broken\n---\n"]]) {
  test(`--purpose-file leaves a same-named note ${name} untouched`, async (t) => {
    const file = `project-overview-${ID}.md`;
    const s = await setup(t, file, content);
    const before = await sha(join(s.notes, file));
    await s.go("--purpose-file", s.purposeFile);
    assert.deepEqual(await readdir(s.notes), [file]);
    assert.equal(await sha(join(s.notes, file)), before);
  });
}

test("--purpose-file updates the purpose of a same-named note owned by the project", async (t) => {
  const file = `project-overview-${ID}.md`;
  const s = await setup(t, file, note(`['${ID}']`));
  await s.go("--purpose-file", s.purposeFile);
  assert.deepEqual(await readdir(s.notes), [file]);
  assert.match(await readFile(join(s.notes, file), "utf8"), /指定された日本語の目的です。/);
});
