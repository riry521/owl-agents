import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../helpers/temp.mjs";

const script = new URL("../../scripts/check-test-hardcode.mjs", import.meta.url).pathname;
const config = {
  description: "test",
  include: ["tests/**/*.test.mjs"],
  exclude_dirs: ["node_modules"],
  allow_marker: "hardcode-check-allow",
  rules: JSON.parse(readFileSync(new URL("../hardcode-checks.json", import.meta.url), "utf8")).rules.map((r) => ({
    ...r,
    message: r.id === "hash-literal" ? "hash" : "list",
  })),
};
const hash = "a".repeat(64);
const list = '["a", "b", "c", "d", "e", "f", "g", "h"]';

async function makeTree(t, files, cfg = config) {
  const root = await tempDir(t, "owl-hardcode-");
  const all = { "tests/hardcode-checks.json": JSON.stringify(cfg), ...files };
  for (const [name, body] of Object.entries(all)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
  return root;
}

const run = (root) => spawnSync(process.execPath, [script, join(root, "tests/hardcode-checks.json"), root], { encoding: "utf8" });

test("a hash literal and a whole string list in an expectation are reported with file, line and rule, exit code 1", async (t) => {
  const root = await makeTree(t, {
    "tests/a/bad.test.mjs": `assert.equal(x, "${hash}");\n\nassert.deepStrictEqual(names, ${list});\n`,
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("tests/a/bad.test.mjs:1: hash-literal: hash"), result.stderr);
  assert.ok(result.stderr.includes("tests/a/bad.test.mjs:3: whole-list-equal: list"), result.stderr);
});

test("files that compare properties pass with exit code 0", async (t) => {
  const root = await makeTree(t, {
    "tests/a/ok.test.mjs": `assert.match(x, /^[0-9a-f]{64}$/);\nassert.deepStrictEqual(names, ["a", "b"]);\nassert.ok(names.includes("a"));\n`,
    "tests/a/skip.mjs": `assert.equal(x, "${hash}");\n`,
  });
  assert.equal(run(root).status, 0);
});

test("an allow marker with a reason on the line or the line before excludes only that match", async (t) => {
  const root = await makeTree(t, {
    "tests/a/allowed.test.mjs": [
      "// hardcode-check-allow hash-literal: fixed vector from the spec",
      `assert.equal(x, "${hash}");`,
      `assert.equal(y, "${hash}"); // hardcode-check-allow hash-literal: same vector`,
      `// hardcode-check-allow hash-literal:   `,
      `assert.equal(z, "${hash}");`,
      `// hardcode-check-allow whole-list-equal: wrong rule id`,
      `assert.equal(w, "${hash}");`,
    ].join("\n"),
  });
  const result = run(root);
  assert.equal(result.status, 1);
  const lines = result.stderr.trim().split("\n");
  assert.deepEqual(
    lines.map((l) => l.split(": ")[0]),
    ["tests/a/allowed.test.mjs:5", "tests/a/allowed.test.mjs:7"],
  );
});

test("a list of seven strings, with or without a trailing comma or a variable, is not a whole-list match", async (t) => {
  const root = await makeTree(t, {
    "tests/a/seven.test.mjs": [
      'assert.deepEqual(a, ["a", "b", "c", "d", "e", "f", "g",]);',
      'assert.deepEqual(b, ["a", "b", "c", "d", "e", "f", "g"]);',
      'assert.deepEqual(c, ["a", "b", "c", "d", "e", "f", "g", other]);',
    ].join("\n"),
  });
  assert.equal(run(root).status, 0);
});

test("a broken config exits with code 2", async (t) => {
  for (const cfg of [
    { ...config, include: [] },
    { ...config, extra: 1 },
    { ...config, rules: [{ id: "x", pattern: "(", message: "m" }] },
  ]) {
    const root = await makeTree(t, {}, cfg);
    assert.equal(run(root).status, 2);
  }
});
