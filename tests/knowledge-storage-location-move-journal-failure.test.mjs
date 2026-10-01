import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeLocation } from "../packages/core/dist/index.js";

test("move restores source and setting when the cleaning_up journal write fails", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "owl-kb-journal-fail-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  const target = join(base, "target");
  await fs.mkdir(source);
  await fs.writeFile(join(source, ".owl-knowledge"), "{}");
  await fs.writeFile(join(source, "note.md"), "body");

  const failingFs = {
    ...fs,
    writeFile: async (path, data, ...rest) => {
      if (String(path).endsWith(".tmp") && String(data).includes('"cleaning_up"')) {
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      }
      return fs.writeFile(path, data, ...rest);
    },
  };
  const stored = { value: source };
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    fs: failingFs,
    persistence: { read: () => stored.value, write: (value) => { stored.value = value; } },
  });
  t.after(() => location.stop());
  assert.equal((await location.initialize()).state, "available");

  await assert.rejects(location.move({ path: target, mode: "move" }));

  assert.equal(await fs.readFile(join(source, "note.md"), "utf8"), "body");
  assert.equal(await fs.readFile(join(source, ".owl-knowledge"), "utf8"), "{}");
  assert.equal(stored.value, source);
  const status = location.status();
  assert.equal(status.state, "available");
  assert.equal(status.path, source);
});

test("writes stay paused while the cleaning_up journal write is pending and land in the source after failure", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "owl-kb-journal-pause-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  const target = join(base, "target");
  await fs.mkdir(source);
  await fs.writeFile(join(source, ".owl-knowledge"), "{}");
  await fs.writeFile(join(source, "note.md"), "body");

  let reached;
  const atJournal = new Promise((resolve) => { reached = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowFs = {
    ...fs,
    writeFile: async (path, data, ...rest) => {
      if (String(path).endsWith(".tmp") && String(data).includes('"cleaning_up"')) {
        reached();
        await gate;
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      }
      return fs.writeFile(path, data, ...rest);
    },
  };
  const stored = { value: source };
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    fs: slowFs,
    persistence: { read: () => stored.value, write: (value) => { stored.value = value; } },
  });
  t.after(() => location.stop());
  await location.initialize();

  const moved = assert.rejects(location.move({ path: target, mode: "move" }));
  await atJournal;
  let ran = false;
  const write = location.withWrite(async () => {
    ran = true;
    await fs.writeFile(join(location.status().path, "note.md"), "updated");
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ran, false);

  release();
  await moved;
  await write;
  assert.equal(await fs.readFile(join(source, "note.md"), "utf8"), "updated");
  assert.equal(location.status().path, source);
});
