import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuleLoadError, RuleStore, parseWorkRules } from "../packages/core/dist/rule-store.js";

async function withRules(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-rule-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, "rules", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { root, store: new RuleStore(root) };
}

const ABSOLUTE = `level: absolute
rules:
  - id: no_force_push
    kind: block_command
    pattern: "git push --force"
    message: "Force push is forbidden."
  - id: verify
    kind: instruction
    text: "Verify before reporting done."
`;

const SYSTEM = `level: system
rules:
  - id: no_env
    kind: block_path
    pattern: "**/.env"
    mode: read
    message: "Do not read .env files."
  - id: tests
    kind: instruction
    text: "Run the tests."
`;

const ADVISOR = `level: role
role: advisor
rules:
  - id: no_publish
    kind: block_command
    pattern: "npm publish"
    message: "Advisors do not publish."
  - id: concise
    kind: instruction
    text: "Answer concisely."
`;

test("prompt lines are one per rule, ordered by level, scoped to the role, with Work rules last", async (t) => {
  const { store } = await withRules(t, {
    "system/safety.yaml": ABSOLUTE,
    "system/defaults.yaml": SYSTEM,
    "role/advisor.yaml": ADVISOR,
  });
  await store.load();
  assert.deepEqual(store.getInstructionsForRole("advisor", ["Keep the API stable."]), [
    "[absolute] Force push is forbidden.",
    "[absolute] Verify before reporting done.",
    "[system] Do not read .env files.",
    "[system] Run the tests.",
    "[role] Advisors do not publish.",
    "[role] Answer concisely.",
    "[work] Keep the API stable.",
  ]);
  const worker = store.getInstructionsForRole("worker");
  assert.equal(worker.some((line) => line.startsWith("[role]")), false);
  assert.equal(worker.length, 4);
});

test("two block rules with the same message produce one prompt line", async (t) => {
  const { store } = await withRules(t, {
    "system/a.yaml": `level: system
rules:
  - id: no_reset
    kind: block_command
    pattern: "git reset --hard"
    message: "Destructive git commands are forbidden."
  - id: no_clean
    kind: block_command
    pattern: "git clean -fdx"
    message: "Destructive git commands are forbidden."
`,
  });
  await store.load();
  assert.deepEqual(store.getInstructionsForRole("worker"), ["[system] Destructive git commands are forbidden."]);
  assert.equal(store.checkCommand("git clean -fdx").blocked, true);
  assert.equal(store.checkCommand("git reset --hard").blocked, true);
});

test("every rule appears exactly once in the prompt rules and role block rules apply only to that role", async (t) => {
  const { root, store } = await withRules(t, {
    "system/safety.yaml": ABSOLUTE,
    "system/defaults.yaml": SYSTEM,
    "role/advisor.yaml": ADVISOR,
  });
  const ruleSet = await store.load();
  assert.deepEqual(
    ruleSet.promptRules.map((rule) => rule.id).sort(),
    ["concise", "no_env", "no_force_push", "no_publish", "tests", "verify"],
  );
  assert.equal(ruleSet.promptRules.find((rule) => rule.id === "no_publish").role, "advisor");
  const bash = (role) => store.checkGuard({ role, toolName: "Bash", toolInput: { command: "npm publish" }, cwd: root });
  assert.equal(bash("advisor").allowed, false);
  assert.equal(bash("advisor").rule_id, "no_publish");
  assert.equal(bash("advisor").scope, "role");
  assert.equal(bash("worker").allowed, true);
});

const BROKEN_FILES = [
  ["level work", "level: work\nrules: []\n", /level 'work' is not supported/],
  ["role level without role", "level: role\nrules: []\n", /requires role/],
  ["role with system level", "level: system\nrole: worker\nrules: []\n", /role is only allowed/],
  ["unknown role", "level: role\nrole: janitor\nrules: []\n", /unknown role 'janitor'/],
  ["unknown key", "level: system\nrules:\n  - id: a\n    kind: block_command\n    patern: \"rm -rf /\"\n", /key 'patern' is not allowed/],
  ["block_command without pattern", "level: system\nrules:\n  - id: a\n    kind: block_command\n    message: \"x\"\n", /requires pattern/],
  ["multi-segment pattern", "level: system\nrules:\n  - id: a\n    kind: block_command\n    pattern: \"git status && rm -rf /\"\n", /exactly one simple command/],
  ["invalid block_path mode", "level: system\nrules:\n  - id: a\n    kind: block_path\n    pattern: \"**/.env\"\n    mode: sometimes\n", /mode must be one of/],
  ["instruction without text", "level: system\nrules:\n  - id: a\n    kind: instruction\n", /instruction requires text/],
];

for (const [name, content, reason] of BROKEN_FILES) {
  test(`a rule file is rejected: ${name}`, async (t) => {
    const { root, store } = await withRules(t, { "system/bad.yaml": content });
    await assert.rejects(store.load(), (error) => {
      assert.ok(error instanceof RuleLoadError);
      assert.equal(error.failures[0].path, path.join(root, "rules/system/bad.yaml"));
      assert.match(error.failures[0].reason, reason);
      return true;
    });
  });
}

test("a rule id used in two files is rejected", async (t) => {
  const rule = "level: system\nrules:\n  - id: same\n    kind: instruction\n    text: \"x\"\n";
  const { store } = await withRules(t, { "system/a.yaml": rule, "system/b.yaml": rule });
  await assert.rejects(store.load(), (error) => {
    assert.ok(error instanceof RuleLoadError);
    assert.match(error.failures[0].reason, /duplicate rule id 'same'/);
    return true;
  });
});

test("a YAML indentation error names its line, and every broken file is reported", async (t) => {
  const { store } = await withRules(t, {
    "system/indent.yaml": "level: system\nrules:\n  - id: a\n      kind: instruction\n    text: \"x\"\n",
    "system/work.yaml": "level: work\nrules: []\n",
  });
  await assert.rejects(store.load(), (error) => {
    assert.ok(error instanceof RuleLoadError);
    assert.equal(error.failures.length, 2);
    const indent = error.failures.find((failure) => failure.path.endsWith("indent.yaml"));
    assert.equal(typeof indent.line, "number");
    return true;
  });
});

test("Work rules are accepted only in their stored form", () => {
  assert.deepEqual(parseWorkRules(JSON.stringify({ schema_version: "1.0.0", rules: ["a", "b"] }), "W1"), ["a", "b"]);
  for (const stored of ["{}", "[]", JSON.stringify({ schema_version: "1.0.0", rules: [1] }), null, "not json"]) {
    assert.throws(() => parseWorkRules(stored, "W1"), (error) => error.code === "invalid_work_rules" && error.details.work_id === "W1");
  }
});

test("an unresolvable path is denied with the unresolved-path rule", async (t) => {
  const { store } = await withRules(t, {});
  await store.load();
  const result = store.checkPath("~-/file", "read", "/tmp");
  assert.equal(result.blocked, true);
  assert.equal(result.rule.id, "guard-unresolved-path");
});
