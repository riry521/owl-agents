import assert from "node:assert/strict";
import { copyFile as copyFileFs, mkdir, open as openFs, readFile, readdir, rename as renameFs, rm, stat, unlink as unlinkFs, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { parseRuleYaml, RuleStore } from "../../packages/core/dist/rule-store.js";
import { RuleWriteError, RuleWriter } from "../../packages/core/dist/rule-writer.js";
import { tempDir } from "../helpers/temp.mjs";

async function setup(t, prefix = "owl-rule-writer-") {
  const root = await tempDir(t, prefix);
  const rulesDir = join(root, "rules");
  await mkdir(join(rulesDir, "system"), { recursive: true });
  await mkdir(join(rulesDir, "role"), { recursive: true });
  const ruleStore = new RuleStore(root);
  await ruleStore.load();
  return { root, rulesDir, ruleStore };
}

test("the writer writes approved rules to system and role files and merges existing rules", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  const systemPath = join(rulesDir, "system", "owl-approved.yaml");
  await writeFile(systemPath, `level: system\nrules:\n  - id: existing_rule\n    kind: instruction\n    text: "Keep the existing rule."\n`);
  await ruleStore.load();
  const writer = new RuleWriter(ruleStore, rulesDir);
  const text = `Preserve "both" and 'single' # tag\\path: safely.`;

  const systemResult = await writer.apply({ level: "system", id: "approved_system", text });
  assert.equal(systemResult.path, systemPath);
  assert.equal(systemResult.generation, ruleStore.status.generation);
  assert.deepEqual(ruleStore.getInstructionsForRole("worker"), [
    "[system] Keep the existing rule.",
    `[system] ${text}`,
  ]);

  const roleResult = await writer.apply({ level: "role", role: "worker", id: "approved_worker", text: "Worker only." });
  const rolePath = join(rulesDir, "role", "worker.yaml");
  assert.equal(roleResult.path, rolePath);
  assert.ok((await readFile(rolePath, "utf8")).includes("approved_worker"));
  assert.deepEqual(ruleStore.getInstructionsForRole("worker"), [
    "[system] Keep the existing rule.",
    `[system] ${text}`,
    "[role] Worker only.",
  ]);
  assert.deepEqual(ruleStore.getInstructionsForRole("reviewer"), [
    "[system] Keep the existing rule.",
    `[system] ${text}`,
  ]);
});

test("the writer rejects a broken current RuleStore before writing", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  const badPath = join(rulesDir, "system", "broken.yaml");
  await writeFile(badPath, "level: work\nrules: []\n");
  await assert.rejects(ruleStore.load());

  const writer = new RuleWriter(ruleStore, rulesDir);
  await assert.rejects(writer.apply({ level: "system", id: "new_rule", text: "New." }), (error) => {
    assert.ok(error instanceof RuleWriteError);
    assert.equal(error.code, "rules_currently_broken");
    return true;
  });
  await assert.rejects(readFile(join(rulesDir, "system", "owl-approved.yaml")));
});

test("the writer rejects duplicate rule IDs and a missing role", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  await writeFile(join(rulesDir, "system", "existing.yaml"), `level: system\nrules:\n  - id: taken\n    kind: instruction\n    text: "Already here."\n`);
  await ruleStore.load();
  const writer = new RuleWriter(ruleStore, rulesDir);

  await assert.rejects(writer.apply({ level: "system", id: "taken", text: "Duplicate." }), (error) => {
    assert.equal(error.code, "duplicate_rule_id");
    return true;
  });
  await assert.rejects(writer.apply({ level: "role", id: "missing_role", text: "Missing." }), TypeError);
  await assert.rejects(readFile(join(rulesDir, "system", "owl-approved.yaml")));
});

test("the writer rejects an invalid managed file", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  const managedPath = join(rulesDir, "system", "owl-approved.yaml");
  await writeFile(managedPath, "level: work\nrules: []\n");
  const writer = new RuleWriter(ruleStore, rulesDir);

  await assert.rejects(writer.apply({ level: "system", id: "new_rule", text: "New." }), (error) => {
    assert.equal(error.code, "managed_file_invalid");
    assert.equal(error.details.path, managedPath);
    return true;
  });
  assert.equal(await readFile(managedPath, "utf8"), "level: work\nrules: []\n");
});

test("the writer rolls back byte-for-byte and consumes the backup after RuleStore.load fails", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  const managedPath = join(rulesDir, "system", "owl-approved.yaml");
  const original = Buffer.from("level: system\n# keep spacing and comments\nrules: []\n\n");
  await writeFile(managedPath, original);
  await ruleStore.load();
  const brokenPath = join(rulesDir, "system", "other.yaml");
  await writeFile(brokenPath, "level: work\nrules: []\n");
  const writer = new RuleWriter(ruleStore, rulesDir);

  await assert.rejects(writer.apply({ level: "system", id: "new_rule", text: "New." }), (error) => {
    assert.equal(error.code, "rules_currently_broken");
    assert.ok(Array.isArray(error.details.failures));
    return true;
  });
  assert.deepEqual(await readFile(managedPath), original);
  assert.equal((await readdir(dirname(managedPath))).some((name) => name.includes(".bak-")), false);
});

test("the writer serializes concurrent apply calls without losing either rule", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  const writer = new RuleWriter(ruleStore, rulesDir);

  const results = await Promise.all([
    writer.apply({ level: "system", id: "first_rule", text: "First." }),
    writer.apply({ level: "system", id: "second_rule", text: "Second." }),
  ]);

  assert.deepEqual(results.map((result) => result.generation), [2, 3]);
  assert.deepEqual(ruleStore.getInstructionsForRole("worker"), ["[system] First.", "[system] Second."]);
});

test("startup removes tmp and backup files while preserving normal managed rules", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  const systemDir = join(rulesDir, "system");
  const managedPath = join(systemDir, "owl-approved.yaml");
  const normalRulePath = join(systemDir, "human.bak-archive.yaml");
  await writeFile(managedPath, `level: system\nrules:\n  - id: existing_rule\n    kind: instruction\n    text: "Keep this rule."\n`);
  await writeFile(normalRulePath, `level: system\nrules:\n  - id: human_rule\n    kind: instruction\n    text: "Keep this file."\n`);
  const tmpPath = join(systemDir, "owl-approved.crash.tmp");
  const backupPath = join(systemDir, "owl-approved.yaml.bak-crash");
  await writeFile(tmpPath, "staged");
  await writeFile(backupPath, "recovery copy");
  await ruleStore.load();
  const writer = new RuleWriter(ruleStore, rulesDir);

  await writer.apply({ level: "system", id: "new_rule", text: "New." });

  await assert.rejects(readFile(tmpPath));
  await assert.rejects(readFile(backupPath));
  assert.equal(await readFile(normalRulePath, "utf8"), `level: system\nrules:\n  - id: human_rule\n    kind: instruction\n    text: "Keep this file."\n`);
  assert.deepEqual(ruleStore.getInstructionsForRole("worker"), ["[system] Keep this file.", "[system] Keep this rule.", "[system] New."]);
  assert.equal((await readdir(systemDir)).some((name) => name.endsWith(".tmp") || /\.yaml\.bak-.+$/.test(name)), false);
});

test("loading during every apply file operation succeeds and the rename target stays continuously present", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  const managedPath = join(rulesDir, "system", "owl-approved.yaml");
  await writeFile(managedPath, `level: system\nrules:\n  - id: existing_rule\n    kind: instruction\n    text: "Old rule."\n`);
  await ruleStore.load();

  const text = String.raw`Preserve "both" and 'single' # tag\path: safely.`;
  const oldRules = ["[system] Old rule."];
  const newRules = [...oldRules, `[system] ${text}`];
  const observations = [];
  const inspectRules = async (operation) => {
    await ruleStore.load();
    const visible = ruleStore.getInstructionsForRole("worker");
    assert.ok(
      JSON.stringify(visible) === JSON.stringify(oldRules) || JSON.stringify(visible) === JSON.stringify(newRules),
      `${operation} exposed a partial rule set: ${JSON.stringify(visible)}`,
    );
    observations.push({ operation, visible });
  };
  const fsImpl = {
    writeFile: async (path, data, encoding) => {
      await writeFile(path, data, encoding);
      await inspectRules("writeFile");
    },
    open: async (path, flags) => {
      const handle = await openFs(path, flags);
      return {
        sync: async () => {
          await handle.sync();
          await inspectRules("sync");
        },
        close: () => handle.close(),
      };
    },
    copyFile: async (source, destination) => {
      await copyFileFs(source, destination);
      await inspectRules("copyFile");
    },
    rename: async (source, destination) => {
      assert.equal(destination, managedPath);
      await stat(destination);
      await renameFs(source, destination);
      await stat(destination);
      await inspectRules("rename");
    },
    unlink: async (path) => {
      await unlinkFs(path);
      await inspectRules("unlink");
    },
  };
  const writer = new RuleWriter(ruleStore, rulesDir, { fsImpl });

  await writer.apply({ level: "system", id: "approved_special", text });

  assert.deepEqual(observations.map(({ operation }) => operation), ["writeFile", "sync", "copyFile", "sync", "rename", "unlink"]);
  assert.ok(observations.some(({ visible }) => JSON.stringify(visible) === JSON.stringify(oldRules)));
  assert.ok(observations.some(({ visible }) => JSON.stringify(visible) === JSON.stringify(newRules)));

  const parsed = parseRuleYaml(await readFile(managedPath, "utf8"), managedPath);
  assert.equal(parsed.path, managedPath);
  assert.equal(parsed.level, "system");
  assert.equal(parsed.role, undefined);
  assert.equal(parsed.rules.length, 2);
  assert.equal(parsed.rules[0].id, "existing_rule");
  assert.equal(parsed.rules[0].kind, "instruction");
  assert.equal(parsed.rules[0].text, "Old rule.");
  assert.equal(parsed.rules[0].pattern, undefined);
  assert.equal(parsed.rules[0].mode, undefined);
  assert.equal(parsed.rules[0].message, undefined);
  assert.equal(parsed.rules[1].id, "approved_special");
  assert.equal(parsed.rules[1].kind, "instruction");
  assert.equal(parsed.rules[1].text, text);
  assert.equal(parsed.rules[1].pattern, undefined);
  assert.equal(parsed.rules[1].mode, undefined);
  assert.equal(parsed.rules[1].message, undefined);
  assert.deepEqual(ruleStore.getInstructionsForRole("worker"), newRules);
});

test("approving writes role rules to rules/role/<role>.yaml, keeps existing rules and leaves tracked defaults untouched", async (t) => {
  const { rulesDir, ruleStore } = await setup(t);
  const defaults = {
    "system/defaults.yaml": "level: system\nrules: []\n",
    "system/owl-defaults.yaml": "level: system\nrules: []\n",
    "system/safety.yaml": "level: system\nrules: []\n",
    "role/advisor-defaults.yaml": "level: role\nrole: advisor\nrules: []\n",
  };
  const hash = async () => Object.fromEntries(await Promise.all(Object.keys(defaults).map(async (f) => [f, createHash("sha256").update(await readFile(join(rulesDir, f))).digest("hex")])));
  for (const [f, body] of Object.entries(defaults)) await writeFile(join(rulesDir, f), body);
  const workerPath = join(rulesDir, "role", "worker.yaml");
  await writeFile(workerPath, `level: role\nrole: worker\nrules:\n  - id: r1\n    kind: instruction\n    text: "One."\n  - id: r2\n    kind: instruction\n    text: "Two."\n`);
  await ruleStore.load();
  const before = await hash();
  const writer = new RuleWriter(ruleStore, rulesDir);
  const roleResult = await writer.apply({ level: "role", role: "worker", id: "r3", text: "Three." });
  const systemResult = await writer.apply({ level: "system", id: "s1", text: "Sys." });
  assert.equal(roleResult.path, workerPath);
  assert.equal(systemResult.path, join(rulesDir, "system", "owl-approved.yaml"));
  const parsed = parseRuleYaml(await readFile(workerPath, "utf8"), workerPath);
  assert.deepEqual(parsed.rules.map((r) => [r.id, r.kind, r.text]), [["r1", "instruction", "One."], ["r2", "instruction", "Two."], ["r3", "instruction", "Three."]]);
  assert.deepEqual(await hash(), before);
  assert.deepEqual((await readdir(join(rulesDir, "role"))).filter((n) => n.startsWith("owl-approved-")), []);
  await assert.rejects(writer.apply({ level: "role", role: "advisor-defaults", id: "x", text: "X." }));
  assert.deepEqual(await hash(), before);
});
