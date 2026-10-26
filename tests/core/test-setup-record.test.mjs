import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { diffSnapshots, isLegacyWholeSetup, readStoredTestSetup, selectTestSetup, selectTestSetupInCheckout, snapshotCheckout, sourcesDigest, testSetupDigests } from "../../packages/core/dist/test-setup.js";
import { DEFAULT_TEST_SETUP_SETTINGS } from "../../packages/shared/dist/test-setup-settings.js";
import { createTestRepo } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

const settings = DEFAULT_TEST_SETUP_SETTINGS;
const digestsOf = (root, sources = []) => testSetupDigests({ root, rules_version: "rules-1", settings, sources });
const write = async (root, name, content) => {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), content);
};

const BASE_FILES = {
  "conftest.py": "import pytest\n",
  "requirements.txt": "pytest\n",
  "app/main.py": "def add(a, b):\n    return a + b\n",
  "tests/test_main.py": "import pytest\nfrom app.main import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
};

test("testSetupDigests: layout follows input files and test folders, tests follows test paths and import lines", async (t) => {
  const repo = await createTestRepo(t, { files: BASE_FILES });
  const base = await digestsOf(repo);

  await write(repo, "conftest.py", "import pytest\nimport os\n");
  const conftest = await digestsOf(repo);
  assert.notEqual(conftest.layout, base.layout);
  assert.equal(conftest.tests, base.tests);

  await write(repo, "requirements.txt", "pytest\nrequests\n");
  assert.notEqual((await digestsOf(repo)).layout, conftest.layout);

  await write(repo, "requirements.txt", "pytest\n");
  await write(repo, "conftest.py", BASE_FILES["conftest.py"]);
  assert.deepEqual(await digestsOf(repo), base);

  await write(repo, "tests/test_main.py", BASE_FILES["tests/test_main.py"].replace("from app.main import add", "from app.main import add, sub"));
  const importChanged = await digestsOf(repo);
  assert.notEqual(importChanged.tests, base.tests);

  await write(repo, "tests/test_main.py", BASE_FILES["tests/test_main.py"]);
  await write(repo, "tests/test_other.py", "def test_other():\n    assert True\n");
  const added = await digestsOf(repo);
  assert.notEqual(added.tests, base.tests);
  await rm(join(repo, "tests/test_other.py"));
  assert.equal((await digestsOf(repo)).tests, base.tests);
});

test("testSetupDigests: expected values and .venv content change nothing; a non-git folder gives null", async (t) => {
  const repo = await createTestRepo(t, { files: BASE_FILES });
  const base = await digestsOf(repo);
  await write(repo, "tests/test_main.py", BASE_FILES["tests/test_main.py"].replace("== 3", "== 4"));
  await write(repo, ".venv/lib/site.py", "x = 1\n");
  await write(repo, ".venv/bin/pytest", "#!/bin/sh\n");
  await write(repo, "node_modules/a/index.js", "module.exports = 1;\n");
  assert.deepEqual(await digestsOf(repo), base);

  const withSources = await digestsOf(repo, ["requirements.txt"]);
  assert.equal(withSources.sources, sourcesDigest(repo, ["requirements.txt"]));
  assert.notEqual(withSources.sources, base.sources);
  const plain = await tempDir(t, "owl-not-git-");
  assert.equal(await digestsOf(plain), null);
});

const record = (status, digests, extra = {}) => ({
  status, test_run: null, executables: {}, sources: [], digests, explicit_digest: null, confirmed_at: null,
  attempts: [], outside_installs: [], missing: [], trigger: "test", investigated_at: "2026-01-01T00:00:00.000Z", ...extra,
});

test("selectTestSetup: tries Task, Work, other Tasks, then Project; different digests are never exact", () => {
  const current = { layout: "L", tests: "T", settings: "S" };
  const same = { layout: "L", tests: "T", sources: "X", settings: "S" };
  const sourcesDigestOf = () => "X";
  const select = (records, extra = {}) => selectTestSetup({ records, current, sourcesDigestOf, explicitDigest: null, currentTestFiles: () => 1, ...extra });
  const named = (name) => record("ready", same, { trigger: name });

  const order = ["task", "work", "sibling", "project"].map(named);
  assert.equal(select(order).setup.trigger, "task");
  assert.equal(select(order.slice(1)).setup.trigger, "work");
  assert.equal(select(order.slice(2)).setup.trigger, "sibling");
  assert.equal(select(order.slice(3)).setup.trigger, "project");
  assert.equal(select(order).match, "exact");

  const otherLayout = record("ready", { ...same, layout: "L2" }, { trigger: "task" });
  const picked = select([otherLayout, named("project")]);
  assert.deepEqual([picked.setup.trigger, picked.match], ["project", "exact"]);
  const onlyOther = select([otherLayout]);
  assert.deepEqual([onlyOther.setup.trigger, onlyOther.match], ["task", "stale"]);
  assert.equal(select([record("tests_failing", { ...same, layout: "L2" })]), null);

  const testsDiffer = select([record("ready", { ...same, tests: "T2" })]);
  assert.equal(testsDiffer.match, "tests_changed");
  const sourcesDiffer = select([record("ready", same)], { sourcesDigestOf: () => "Y" });
  assert.equal(sourcesDiffer.match, "stale");

  const noTests = record("no_tests", same);
  assert.equal(select([noTests]).match, "tests_changed");
  assert.equal(select([noTests], { currentTestFiles: () => 0 }).match, "exact");
});

test("selectTestSetupInCheckout: records are selected under the max_file_bytes they were made with; imports are sorted and unique", async (t) => {
  const repo = await createTestRepo(t, { files: BASE_FILES });
  const small = 20;
  const args = { root: repo, rules_version: "rules-1", settings };
  const made = (digests) => record("ready", { ...digests, sources: sourcesDigest(repo, []) });
  const withSmall = made(await testSetupDigests({ ...args, max_file_bytes: small }));
  const withDefault = made(await testSetupDigests(args));
  assert.notEqual(withSmall.digests.tests, withDefault.digests.tests);

  assert.equal((await selectTestSetupInCheckout({ ...args, records: [withSmall], max_file_bytes: small })).match, "exact");
  assert.equal((await selectTestSetupInCheckout({ ...args, records: [withSmall] })).match, "tests_changed");
  assert.equal((await selectTestSetupInCheckout({ ...args, records: [withDefault] })).match, "exact");

  const base = await testSetupDigests(args);
  await write(repo, "tests/test_main.py", "from app.main import add\nimport pytest\nimport pytest\n\ndef test_add():\n    assert add(1, 2) == 3\n");
  assert.equal((await testSetupDigests(args)).tests, base.tests);
});

test("selectTestSetup: a repair record applies only to its explicit test_run digest", () => {
  const current = { layout: "L", tests: "T", settings: "S" };
  const same = { layout: "L", tests: "T", sources: "X", settings: "S" };
  const repair = record("ready", same, { explicit_digest: "D" });
  const args = { records: [repair], current, sourcesDigestOf: () => "X", currentTestFiles: () => 1 };
  assert.equal(selectTestSetup({ ...args, explicitDigest: null }), null);
  assert.equal(selectTestSetup({ ...args, explicitDigest: "E" }), null);
  assert.equal(selectTestSetup({ ...args, explicitDigest: "D" }).match, "explicit");
  const unresolved = record("unresolved", same, { explicit_digest: "D" });
  assert.equal(selectTestSetup({ ...args, records: [unresolved], explicitDigest: "D" }), null);
});

test("readStoredTestSetup: a broken value is dropped with a warning", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const digests = { layout: "a", tests: "b", sources: "c", settings: "d" };
  assert.equal(readStoredTestSetup(null, warn), null);
  assert.equal(readStoredTestSetup("{not json", warn), null);
  assert.equal(readStoredTestSetup(JSON.stringify({ status: "weird", digests, sources: [] }), warn), null);
  assert.equal(readStoredTestSetup(JSON.stringify({ status: "ready", sources: [] }), warn), null);
  assert.equal(warnings.length, 3);
  const ok = readStoredTestSetup(JSON.stringify(record("ready", digests)), warn);
  assert.equal(ok.status, "ready");
  assert.equal(warnings.length, 3);
});

test("snapshotCheckout and diffSnapshots: report rewrites, additions and deletions, but not environment_dirs", async (t) => {
  const repo = await createTestRepo(t, { files: { "a.txt": "one\n", "b.txt": "b\n", "keep/old.txt": "old\n", ".gitignore": "out/\n" } });
  const dirs = settings.environment_dirs;
  const snap = () => snapshotCheckout(repo, dirs);

  // A tracked file that is already modified and then rewritten again.
  await write(repo, "a.txt", "two\n");
  const before = await snap();
  assert.deepEqual(diffSnapshots(before, await snap()), []);
  await write(repo, "a.txt", "three\n");
  assert.deepEqual(diffSnapshots(before, await snap()), [{ kind: "tracked", path: "a.txt" }]);
  await write(repo, "a.txt", "two\n");
  assert.deepEqual(diffSnapshots(before, await snap()), []);

  // A file added to an untracked folder that already exists.
  await write(repo, "fresh/first.txt", "1\n");
  const withFolder = await snap();
  await write(repo, "fresh/second.txt", "2\n");
  assert.deepEqual(diffSnapshots(withFolder, await snap()), [{ kind: "left", path: "fresh/second.txt" }]);

  // A deleted file: tracked and untracked.
  const beforeDelete = await snap();
  await rm(join(repo, "b.txt"));
  await rm(join(repo, "fresh/first.txt"));
  assert.deepEqual(diffSnapshots(beforeDelete, await snap()), [
    { kind: "tracked", path: "b.txt" },
    { kind: "removed", path: "fresh/first.txt" },
  ]);

  // Environment folders are never reported.
  const beforeEnv = await snap();
  await write(repo, ".venv/lib/x.py", "x\n");
  await write(repo, "sub/node_modules/pkg/index.js", "1\n");
  await write(repo, "__pycache__/m.pyc", "1\n");
  assert.deepEqual(diffSnapshots(beforeEnv, await snap()), []);

  // Files that .gitignore covers (build output) are not reported; unignored ones still are.
  const beforeIgnored = await snap();
  await write(repo, "out/.next/cache/x.js", "1\n");
  await write(repo, "kept.txt", "1\n");
  assert.deepEqual(diffSnapshots(beforeIgnored, await snap()), [{ kind: "left", path: "kept.txt" }]);
});

test("isLegacyWholeSetup: only a whole record without a reason is investigated again", () => {
  const digests = { layout: "l", tests: "t", sources: "s", settings: "x" };
  const read = (extra) => readStoredTestSetup(JSON.stringify({ status: "ready", sources: [], digests, ...extra }));
  assert.equal(isLegacyWholeSetup(read({ test_run: { mode: "whole" } })), true);
  assert.equal(isLegacyWholeSetup(read({ test_run: { mode: "per_file" } })), false);
  assert.equal(isLegacyWholeSetup(read({ test_run: { mode: "whole" }, whole_reason: "pytest cannot take one file" })), false);
  assert.equal(isLegacyWholeSetup(read({ test_run: { mode: "whole" }, explicit_digest: "abc" })), false);
});
