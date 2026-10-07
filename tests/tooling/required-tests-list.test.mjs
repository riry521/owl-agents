import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { repoRoot as root } from "../helpers/paths.mjs";

const runner = path.join(root, "scripts/run-required-tests.mjs");
const listFile = path.join(root, "tests/required-tests.json");
const { readRequiredTestList } = await import(runner);
const { copyNativeBindings } = await import(path.join(root, "scripts/prepare-test-checkout.mjs"));

test("required-tests.json lists existing, unique test files for every main flow", () => {
  const list = JSON.parse(readFileSync(listFile, "utf8"));
  const files = readRequiredTestList(listFile, root);
  assert.equal(files.length, list.files.length);
  const flows = new Set(list.files.map((entry) => entry.flow));
  for (const flow of ["work_lifecycle", "decision_resume", "agent_reports", "remake_limits"]) {
    assert.ok(flows.has(flow), `missing flow ${flow}`);
  }
});

test("run-required-tests exits with code 2 and names the file when a listed file does not exist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "required-tests-"));
  const listPath = path.join(dir, "list.json");
  writeFileSync(listPath, JSON.stringify({ files: [{ path: "tests/no-such-file.test.mjs", flow: "work_lifecycle" }] }));
  const result = spawnSync(process.execPath, [runner, listPath], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tests\/no-such-file\.test\.mjs/);
});

test("run-required-tests runs only the listed files and prints TAP", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "required-tests-"));
  // 検査は *.test.mjs を要求するので、fixture は一時 checkout に .test.mjs としてコピーする。
  mkdirSync(path.join(dir, "tests"));
  writeFileSync(path.join(dir, "tests/only.test.mjs"), readFileSync(path.join(root, "tests/fixtures/required-tests/pass.fixture.mjs")));
  const listPath = path.join(dir, "list.json");
  writeFileSync(listPath, JSON.stringify({ files: [{ path: "tests/only.test.mjs", flow: "work_lifecycle" }] }));
  const result = spawnSync(process.execPath, [runner, listPath], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^TAP version/m);
  assert.match(result.stdout, /ok 1 - fixture passes/);
  assert.match(result.stdout, /# tests 1\b/);
});

test("prepare-test-checkout copies a missing better-sqlite3 binding from the source checkout", () => {
  const rel = "node_modules/.pnpm/better-sqlite3@9.9.9/node_modules/better-sqlite3/build/Release/better_sqlite3.node";
  const source = mkdtempSync(path.join(tmpdir(), "src-"));
  const checkout = mkdtempSync(path.join(tmpdir(), "dst-"));
  mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
  writeFileSync(path.join(source, rel), "binding");
  mkdirSync(path.join(checkout, "node_modules/.pnpm/better-sqlite3@9.9.9"), { recursive: true });
  const copied = copyNativeBindings({ checkout, source });
  assert.deepEqual(copied, [path.join(checkout, rel)]);
  assert.equal(readFileSync(path.join(checkout, rel), "utf8"), "binding");
});
