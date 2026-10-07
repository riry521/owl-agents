import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase, composeEntry } from "../dist/knowledge-base.js";
import { parseScalar } from "../dist/knowledge-notes.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-kb-frontmatter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new KnowledgeBase(root);
}

const lineOf = (text, key) => text.split("\n").find((l) => l.startsWith(`${key}: `)).slice(key.length + 2);

test("composeEntry and create write the same text", async (t) => {
  const kb = await setup(t);
  const input = { tags: ["x", "two words"], created: "2026-10-03", metadata: { title: "T", project_ids: ["01HZZZZZZZZZZZZZZZZZZZZZZP"] }, body: "# T\n\nbody\n" };
  await kb.create({ folder: "global/test-clips", filename: "a.md", ...input });
  assert.equal(await readFile(join(kb.knowledgeDir, "global/test-clips/a.md"), "utf8"), composeEntry(input));
});

test("values that read back unchanged are written as before", () => {
  const text = composeEntry({
    tags: ["x"], created: "2026-10-03", body: "b",
    metadata: { id: "01HZZZZZZZZZZZZZZZZZZZZZZP", retrieved_at: "2026-10-03T05:00:00Z", status: "active", ids: ["a1", "b2"] },
  });
  assert.equal(text, "---\ntags: [x]\ncreated: 2026-10-03\nid: 01HZZZZZZZZZZZZZZZZZZZZZZP\nretrieved_at: 2026-10-03T05:00:00Z\nstatus: active\nids: [a1, b2]\n---\n\nb");
});

test("a title that would be misread is quoted and reads back the same", async (t) => {
  const kb = await setup(t);
  const title = '[PDF] "a": b #c';
  const entry = await kb.create({ folder: "global/test-clips", filename: "b.md", tags: [], body: "b", created: "2026-10-03", metadata: { title, quoted: '"leading', arr: ['"x', "'y", "plain"] } });
  const text = await readFile(join(kb.knowledgeDir, entry.path), "utf8");
  assert.equal(parseScalar(lineOf(text, "title")), title);
  assert.equal(parseScalar(lineOf(text, "quoted")), '"leading');
  assert.equal(lineOf(text, "quoted"), '"\\"leading"');
  assert.equal(lineOf(text, "arr"), `["\\"x", "'y", plain]`);
});

// Same rule as knowledge-notes.ts splitFlowArray (not exported): split on commas outside quotes, trim, reject empties.
function readArray(line) {
  const inner = line.slice(1, -1);
  const items = [];
  let start = 0, quote = "", escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && c === "\\") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ",") { items.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  assert.equal(quote, "");
  items.push(inner.slice(start).trim());
  assert.ok(items.every((x) => x.length > 0));
  return items.map(parseScalar);
}

test("padded strings and delimiter-bearing array items read back the same", async (t) => {
  const kb = await setup(t);
  const arr = ["a, b", "", " c ", 'x"y', "[z]", "日本語"];
  const entry = await kb.create({ folder: "global/test-clips", filename: "d.md", tags: [], body: "b", created: "2026-10-03", metadata: { padded: "  p  ", empty: "", arr } });
  const text = await readFile(join(kb.knowledgeDir, entry.path), "utf8");
  assert.equal(lineOf(text, "padded"), '"  p  "');
  assert.equal(parseScalar(lineOf(text, "padded")), "  p  ");
  assert.deepEqual(readArray(lineOf(text, "arr")), arr);
});

test("update keeps existing quoted values verbatim", async (t) => {
  const kb = await setup(t);
  const entry = await kb.create({ folder: "global/test-clips", filename: "c.md", tags: [], body: "b", metadata: { title: '"q' } });
  const before = await readFile(join(kb.knowledgeDir, entry.path), "utf8");
  await kb.update(entry.path, { body: "b2" });
  assert.equal(await readFile(join(kb.knowledgeDir, entry.path), "utf8"), before.replace(/b$/u, "b2"));
});
