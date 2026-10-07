import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../helpers/temp.mjs";

const script = new URL("../../scripts/check-test-layout.mjs", import.meta.url).pathname;
const layout = {
  description: "test",
  directories: { work: "works", task: "tasks" },
  support_directories: ["helpers", "fixtures"],
  root_files: ["layout.json"],
  forbidden_name_segments: ["^[0-9]+$", "^(v|stage|phase|item|issue|bug|pr)[0-9]+$", "^regressions?$", "^misc$"],
};

async function makeTree(t, files) {
  const root = await tempDir(t, "owl-layout-");
  const all = { "layout.json": JSON.stringify(layout), "work/create.test.mjs": "", "task/run.test.mjs": "", ...files };
  for (const [name, body] of Object.entries(all)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
  return root;
}

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("a layout with only allowed placements passes with exit code 0", async (t) => {
  const root = await makeTree(t, { "helpers/db.mjs": "", "fixtures/data.json": "{}" });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /test layout ok: 2 files in 2 directories/);
});

test("violating files are reported with a reason and exit code 1", async (t) => {
  const root = await makeTree(t, {
    "work-delete.test.mjs": "",
    "stray.mjs": "",
    "misc/a.test.mjs": "",
    "work/work-delete.test.mjs": "",
    "work/lifecycle-regressions.test.mjs": "",
    "work/Bad.test.mjs": "",
    "work/helper.mjs": "",
    "task/sub/x.test.mjs": "",
    "fixtures/only.test.mjs": "",
  });
  const result = run(join(root, "layout.json"));
  assert.equal(result.status, 1);
  for (const line of [
    "tests/work-delete.test.mjs: test files must be in a feature directory",
    "tests/stray.mjs: only layout.json",
    "tests/misc/: directory is not listed",
    'tests/work/work-delete.test.mjs: drop the "work-" prefix',
    'tests/work/lifecycle-regressions.test.mjs: name segment "regressions"',
    "tests/work/Bad.test.mjs: file name must be lowercase",
    "tests/work/helper.mjs: only *.test.mjs files",
    "tests/task/sub/: feature directories must not have subdirectories",
    "tests/fixtures/only.test.mjs: test files must not be under tests/fixtures/",
  ]) {
    assert.ok(result.stderr.includes(line), `missing: ${line}\n${result.stderr}`);
  }
});

test("a listed directory without test files is reported", async (t) => {
  const root = await makeTree(t, {});
  await rm(join(root, "task"), { recursive: true });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tests\/task\/: listed in tests\/layout.json but has no test files/);
});

test("naming feature directories skips the top-level check and limits the rest to them", async (t) => {
  const root = await makeTree(t, { "stray.test.mjs": "", "task/task-bad.test.mjs": "" });
  assert.equal(run(root, "work").status, 0);
  const result = run(root, "tests/task");
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes("stray"));
});

test("an unreadable or malformed layout.json exits with code 2", async (t) => {
  const root = await makeTree(t, { "layout.json": JSON.stringify({ directories: {} }) });
  assert.equal(run(root).status, 2);
  assert.equal(run(join(root, "missing.json")).status, 2);
});
