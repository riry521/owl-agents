import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase } from "../../packages/core/dist/knowledge-base.js";
import { tempDir } from "../helpers/temp.mjs";

async function newKnowledgeBase(t) {
  const root = await tempDir(t, "owl-knowledge-base-naming-");
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  return knowledge;
}

async function seedNote(knowledge, filename = "sample.md") {
  await mkdir(join(knowledge.knowledgeDir, "notes"), { recursive: true });
  await writeFile(
    join(knowledge.knowledgeDir, "notes", filename),
    "---\ntags: []\ncreated: 2026-09-26\n---\n# Note\n\nBody\n",
  );
  return `notes/${filename}`;
}

test("update rejects notes managed files", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const path = await seedNote(knowledge);

  await assert.rejects(knowledge.update(path, { body: "Changed" }), /^Error: notes_managed: notes\/sample\.md$/u);
});

test("remove rejects notes managed files", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const path = await seedNote(knowledge);

  await assert.rejects(knowledge.remove(path), /^Error: notes_managed: notes\/sample\.md$/u);
});

test("upsert rejects the notes folder before creating a managed note", async (t) => {
  const knowledge = await newKnowledgeBase(t);

  await assert.rejects(knowledge.upsert({
    folder: "notes",
    filename: "sample.md",
    tags: [],
    body: "Body",
  }), /^Error: notes_managed: notes$/u);
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "notes")), []);
});

test("notes frontmatter titles are used by get, list, and search", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  await mkdir(join(knowledge.knowledgeDir, "notes"), { recursive: true });
  await writeFile(
    join(knowledge.knowledgeDir, "notes", "secret-elephant.md"),
    "---\ntitle: Secret Elephant\ntags: []\ncreated: 2026-09-26\n---\n\nA private note.\n",
  );

  const path = "notes/secret-elephant.md";
  assert.equal((await knowledge.get(path)).title, "Secret Elephant");
  assert.equal((await knowledge.list("notes")).find((entry) => entry.path === path)?.title, "Secret Elephant");
  const matches = await knowledge.search("Secret Elephant");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, path);
  assert.equal(matches[0].title, "Secret Elephant");
});

test("notes frontmatter titles restore JSON escapes for get, list, and search", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  await mkdir(join(knowledge.knowledgeDir, "notes"), { recursive: true });
  const title = '"Quoted" retry \\ policy';
  await writeFile(
    join(knowledge.knowledgeDir, "notes", "quoted-retry-policy.md"),
    `---\ntitle: ${JSON.stringify(title)}\ntags: []\ncreated: 2026-09-26\n---\n\nRetry safely.\n`,
  );

  const path = "notes/quoted-retry-policy.md";
  assert.equal((await knowledge.get(path)).title, title);
  assert.equal((await knowledge.list("notes")).find((entry) => entry.path === path)?.title, title);
  const matches = await knowledge.search(title);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, path);
  assert.equal(matches[0].title, title);
});

test("notes without a frontmatter title fall back to the filename", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const path = await seedNote(knowledge, "legacy-note.md");

  assert.equal((await knowledge.get(path)).title, "legacy-note");
  assert.equal((await knowledge.list("notes")).find((entry) => entry.path === path)?.title, "legacy-note");
});

test("upsertBySource never derives a fallback filename from frontmatter in its body", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const body = "---\ntags: [advisor-conversation]\ncreated: 2026-09-25\n---\n\n## Q&A\n!!!\n";

  const withoutFallback = await knowledge.upsertBySource({
    folder: "advisor/conversations",
    title: "!!!",
    source: { key: "conversation_id", value: "frontmatter-only" },
    body,
    tags: ["advisor-conversation"],
  });
  assert.match(withoutFallback.path, /^advisor\/conversations\/note-[a-f0-9]{8}\.md$/u);
  assert.doesNotMatch(withoutFallback.path, /tags|created|2026/u);

  const withFallback = await knowledge.upsertBySource({
    folder: "advisor/conversations",
    title: "!!!",
    source: { key: "conversation_id", value: "raw-text" },
    body,
    nameFallback: "!!!\nRecover stale database connections",
    tags: ["advisor-conversation"],
  });
  assert.equal(withFallback.path, "advisor/conversations/recover-stale-database-connections.md");
});

test("concurrent create calls reserve the same filename exclusively", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const outcomes = await Promise.allSettled([
    knowledge.create({ folder: "works", filename: "same.md", tags: [], body: "alpha" }),
    knowledge.create({ folder: "works", filename: "same.md", tags: [], body: "beta" }),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.match(String(rejected?.reason), /^Error: already_exists: works\/same\.md$/u);
  const contents = await readFile(join(knowledge.knowledgeDir, "works", "same.md"), "utf8");
  assert.ok(contents.endsWith("alpha") || contents.endsWith("beta"));
  assert.equal((await readdir(join(knowledge.knowledgeDir, "works"))).length, 1);
});

test("create accepts the research folder", async (t) => {
  const knowledge = await newKnowledgeBase(t);

  const entry = await knowledge.create({ folder: "research", filename: "example.md", tags: ["research"], body: "Source notes" });

  assert.equal(entry.path, "research/example.md");
  assert.equal((await knowledge.get(entry.path)).body.trim(), "Source notes");
});

test("upsertBySource keeps kind and no-kind conversation entries separate", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const source = { key: "conversation_id", value: "conversation-1" };

  const typed = await knowledge.upsertBySource({
    folder: "advisor/conversations",
    title: "Incident recovery",
    source: { ...source, kind: "summary" },
    body: "typed entry",
    tags: ["conversation"],
  });
  const untyped = await knowledge.upsertBySource({
    folder: "advisor/conversations",
    title: "Incident recovery",
    source,
    body: "untyped entry",
    tags: ["conversation"],
  });

  assert.notEqual(typed.path, untyped.path);
  assert.equal((await knowledge.get(typed.path)).body.trim(), "typed entry");
  assert.equal((await knowledge.get(untyped.path)).body.trim(), "untyped entry");
  assert.match(await readFile(join(knowledge.knowledgeDir, typed.path), "utf8"), /kind: summary\n/u);
  assert.doesNotMatch(await readFile(join(knowledge.knowledgeDir, untyped.path), "utf8"), /^kind:/mu);
  assert.equal((await readdir(join(knowledge.knowledgeDir, "advisor", "conversations"))).length, 2);
});

test("tags with delimiters, quotes and line breaks read back unchanged and add no frontmatter lines", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const tags = ["a, b", 'say "hi"', "[x]", "two words", "line\nkind: injected"];
  const entry = await knowledge.create({ folder: "global", filename: "tags.md", tags, body: "# Tags\n" });
  const text = await readFile(join(knowledge.knowledgeDir, entry.path), "utf8");

  assert.deepEqual((await knowledge.get(entry.path)).tags, [...tags.slice(0, 4), "line kind: injected"]);
  assert.equal(text.split("\n").some((line) => line.startsWith("kind:")), false);
});

test("update keeps frontmatter lines it does not parse as single-line values", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  await writeFile(
    join(knowledge.knowledgeDir, "global", "hand.md"),
    "---\ntags:\n  - alpha\n  - beta\ncreated: 2026-09-26\naliases:\n  - First\n  - Second\nsummary: |\n  line one\n\n  line two\nsource: x\n---\n# Hand\n\nold\n",
  );

  const updated = await knowledge.update("global/hand.md", { body: "# Hand\n\nnew\n" });
  const text = await readFile(join(knowledge.knowledgeDir, "global", "hand.md"), "utf8");

  assert.deepEqual(updated.tags, ["alpha", "beta"]);
  assert.match(text, /\naliases:\n {2}- First\n {2}- Second\n/u);
  assert.match(text, /\nsummary: \|\n {2}line one\n\n {2}line two\n/u);
  assert.match(text, /\nsource: x\n/u);
  assert.ok(text.endsWith("---\n\n# Hand\n\nnew\n"));
});

test("updating only the tags leaves the body text unchanged", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const entry = await knowledge.create({ folder: "global", filename: "retag.md", tags: ["a"], body: "# Retag\n\nbody\n" });
  const before = await readFile(join(knowledge.knowledgeDir, entry.path), "utf8");

  await knowledge.update(entry.path, { tags: ["b"] });
  await knowledge.update(entry.path, { tags: ["a"] });

  assert.equal(await readFile(join(knowledge.knowledgeDir, entry.path), "utf8"), before);
});

test("update refuses frontmatter it cannot keep instead of overwriting it", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const files = {
    "comment.md": "---\n# owner note\ntags: [a]\ncreated: 2026-09-26\n---\nbody\n",
    "crlf.md": "---\r\ntags: [a]\r\ncreated: 2026-09-26\r\nsource: x\r\n---\r\nbody\r\n",
    "tags-anchor.md": "---\ntags: &shared [alpha]\ncreated: 2026-09-26\naliases: *shared\n---\nbody\n",
    "tag-item-alias.md": "---\nbase: &b beta\ntags: [alpha, *b]\ncreated: 2026-09-26\n---\nbody\n",
    "tag-block-item.md": "---\ntags:\n  - !!str alpha\ncreated: 2026-09-26\n---\nbody\n",
    "tags-comment-anchor.md": "---\ntags: [&shared alpha] # note\ncreated: 2026-09-26\naliases: *shared\n---\nbody\n",
    "tags-mapping-item.md": "---\ntags:\n  - name: alpha\ncreated: 2026-09-26\n---\nbody\n",
    "tags-nested.md": "---\ntags: [[alpha, beta]]\ncreated: 2026-09-26\n---\nbody\n",
    "tags-quoted-mapping.md": "---\ntags: ['name': 'alpha']\ncreated: 2026-09-26\n---\nbody\n",
    "tags-nested-block.md": "---\ntags:\n  - - alpha\ncreated: 2026-09-26\n---\nbody\n",
    "tags-explicit-key.md": "---\ntags:\n  - ? alpha\ncreated: 2026-09-26\n---\nbody\n",
    "tags-comment-in-array.md": "---\ntags: ['alpha' # note ]\ncreated: 2026-09-26\n---\nbody\n",
    "created-anchor.md": "---\ntags: [a]\ncreated: &day 2026-09-26\nupdated: *day\n---\nbody\n",
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(knowledge.knowledgeDir, "global", name);
    await writeFile(path, content);
    await assert.rejects(knowledge.update(`global/${name}`, { body: "new" }), /unsupported_frontmatter/u);
    assert.equal(await readFile(path, "utf8"), content);
  }
});

test("update keeps a block-list tag with a comma as one tag and ignores a trailing comment on a flow list", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const dir = join(knowledge.knowledgeDir, "global");
  await writeFile(join(dir, "block.md"), "---\ntags:\n  - alpha, beta\ncreated: 2026-09-26\n---\nbody\n");
  await writeFile(join(dir, "flow.md"), "---\ntags: [a, b] # note ]\ncreated: 2026-09-26\n---\nbody\n");
  await writeFile(join(dir, "quoted.md"), "---\ntags:\n  - 'alpha' # owner says '\ncreated: 2026-09-26\n---\nbody\n");
  assert.deepEqual((await knowledge.update("global/quoted.md", { body: "new" })).tags, ["alpha"]);
  assert.deepEqual((await knowledge.update("global/block.md", { body: "new" })).tags, ["alpha, beta"]);
  assert.deepEqual((await knowledge.update("global/flow.md", { body: "new" })).tags, ["a", "b"]);
});

const bodyOnlyTagsLines = [
  "tags:\n  - alpha\n    - beta",
  "tags: [alpha]\n  - beta",
  "tags: [a, b] # note ]",
  "tags:\n  - name: alpha",
  "tags: [[alpha, beta]]",
];
for (const lines of bodyOnlyTagsLines) {
  test(`a body-only update leaves the tags lines as written or refuses the file: ${JSON.stringify(lines)}`, async (t) => {
    const knowledge = await newKnowledgeBase(t);
    const path = join(knowledge.knowledgeDir, "global", "raw.md");
    const original = `---\n${lines}\ncreated: 2026-09-26\n---\nold\n`;
    await writeFile(path, original);
    try {
      await knowledge.update("global/raw.md", { body: "new" });
    } catch (error) {
      assert.match(error.message, /unsupported_frontmatter/u);
      assert.equal(await readFile(path, "utf8"), original);
      return;
    }
    assert.equal(await readFile(path, "utf8"), `---\n${lines}\ncreated: 2026-09-26\n---\n\nnew`);
  });
}

test("a tag that starts with YAML node syntax can be created and then updated", async (t) => {
  const knowledge = await newKnowledgeBase(t);
  const tags = ["*literal", "&a", "!b", "|c", ">d"];
  const entry = await knowledge.create({ folder: "global", filename: "syntax.md", tags, body: "x" });
  assert.deepEqual((await knowledge.update(entry.path, { body: "y" })).tags, tags);
});
