import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeLocation } from "../../packages/core/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

test("move accepts a target containing only .DS_Store", async (t) => {
  const base = await tempDir(t, "owl-kb-ds-store-");
  const source = join(base, "source");
  const target = join(base, "target");
  await fs.mkdir(source);
  await fs.writeFile(join(source, ".owl-knowledge"), "{}");
  await fs.mkdir(target);
  await fs.writeFile(join(target, ".DS_Store"), "finder metadata");

  const stored = { value: source };
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    persistence: { read: () => stored.value, write: (value) => { stored.value = value; } },
  });
  t.after(() => location.stop());
  assert.equal((await location.initialize()).state, "available");

  const result = await location.move({ path: target, mode: "move" });

  assert.equal(result.status.state, "available");
  assert.equal(stored.value, target);
  assert.equal(await fs.readFile(join(target, ".DS_Store"), "utf8"), "finder metadata");
});

test("move succeeds when source and target both contain .DS_Store", async (t) => {
  const base = await tempDir(t, "owl-kb-ds-both-");
  const source = join(base, "source");
  const target = join(base, "target");
  await fs.mkdir(source);
  await fs.writeFile(join(source, ".owl-knowledge"), "{}");
  await fs.writeFile(join(source, ".DS_Store"), "source meta");
  await fs.writeFile(join(source, "note.md"), "body");
  await fs.mkdir(target);
  await fs.writeFile(join(target, ".DS_Store"), "target meta");

  const stored = { value: source };
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    persistence: { read: () => stored.value, write: (value) => { stored.value = value; } },
  });
  t.after(() => location.stop());
  assert.equal((await location.initialize()).state, "available");

  const result = await location.move({ path: target, mode: "move" });

  assert.equal(result.status.state, "available");
  assert.equal(await fs.readFile(join(target, ".DS_Store"), "utf8"), "target meta");
  assert.equal(await fs.readFile(join(target, "note.md"), "utf8"), "body");
});
