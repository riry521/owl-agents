import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { RULE_ROLES, RuleStore } from "../../packages/core/dist/rule-store.js";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const ruleFile = (text, level = "project", kind = "instruction") => `level: ${level}
rules:
  - id: r_${text}
    kind: ${kind}
    ${kind === "instruction" ? "text" : "pattern"}: "${text}"
`;

async function setup(t) {
  const root = await tempDir(t, "owl-project-scope-");
  await mkdir(join(root, "rules", "project"), { recursive: true });
  await mkdir(join(root, "rules", "system"), { recursive: true });
  await writeFile(join(root, "rules", "project", "alpha.yaml"), ruleFile("alpha-rule"));
  await writeFile(join(root, "rules", "project", "beta.yaml"), ruleFile("beta-rule"));
  const store = new RuleStore(root);
  await store.load();
  return { root, store };
}

test("project rules reach every role of that project's Works only", async (t) => {
  const { store } = await setup(t);
  for (const role of RULE_ROLES) {
    const alpha = store.getInstructionsForRole(role, [], "alpha");
    assert.ok(alpha.includes("[project] alpha-rule"), role);
    assert.ok(!alpha.includes("[project] beta-rule"), role);
    assert.deepEqual(store.getInstructionsForRole(role, [], "gamma"), []);
    assert.deepEqual(store.getInstructionsForRole(role), []);
    assert.deepEqual(store.getInstructionsForRole(role, [], null), []);
  }
});

test("project rules come after system rules and before Work rules", async (t) => {
  const { root, store } = await setup(t);
  await writeFile(join(root, "rules", "system", "s.yaml"), ruleFile("sys-rule", "system"));
  await store.load();
  assert.deepEqual(store.getInstructionsForRole("worker", ["w"], "alpha"), ["[system] sys-rule", "[project] alpha-rule", "[work] w"]);
});

test("project files reject block rules and misplaced levels, keeping the previous rules", async (t) => {
  const { root, store } = await setup(t);
  const bad = [
    ["project", "alpha.yaml", ruleFile("x", "project", "block_command"), ruleFile("alpha-rule")],
    ["project", "alpha.yaml", ruleFile("x", "system"), ruleFile("alpha-rule")],
    ["system", "p.yaml", ruleFile("x", "project"), ruleFile("ok", "system")],
  ];
  for (const [dir, name, content, good] of bad) {
    await writeFile(join(root, "rules", dir, name), content);
    await assert.rejects(store.load());
    assert.ok(store.getInstructionsForRole("worker", [], "alpha").includes("[project] alpha-rule"));
    await writeFile(join(root, "rules", dir, name), good);
  }
});

test("ensureDirectories creates rules/project", async (t) => {
  const root = await tempDir(t, "owl-project-scope-dirs-");
  await new RuleStore(root).ensureDirectories();
  await assert.rejects(mkdir(join(root, "rules", "project")), { code: "EEXIST" });
});

test("adding or editing a project file is picked up while watching", async (t) => {
  const { root, store } = await setup(t);
  await store.startWatching(() => {});
  t.after(() => store.stopWatching());
  const file = join(root, "rules", "project", "gamma.yaml");
  const rewriteUntil = (text) => waitFor(async () => {
    await writeFile(file, ruleFile(text));
    return store.getInstructionsForRole("worker", [], "gamma").includes(`[project] ${text}`);
  }, { timeoutMs: 8_000, intervalMs: 300 });
  await rewriteUntil("gamma-1");
  await rewriteUntil("gamma-2");
  assert.ok(!store.getInstructionsForRole("worker", [], "gamma").includes("[project] gamma-1"));
});
