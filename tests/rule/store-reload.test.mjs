import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RuleLoadError, RuleStore } from "../../packages/core/dist/rule-store.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor as waitForCondition } from "../helpers/wait.mjs";

const GOOD = `level: system
rules:
  - id: no_reset
    kind: block_command
    pattern: "git reset --hard"
    message: "Hard resets are forbidden."
`;
const GOOD_V2 = `level: system
rules:
  - id: no_reset
    kind: block_command
    pattern: "git reset --hard"
    message: "Hard resets are still forbidden."
`;
const BROKEN = "level: work\nrules: []\n";

async function tempRoot(t, prefix) {
  const root = await tempDir(t, prefix);
  await mkdir(join(root, "rules", "system"), { recursive: true });
  return root;
}

// Resolves to the falsy last value (false) on timeout instead of throwing; callers poll for "not yet".
const pollOrFalse = (read, timeoutMs = 5_000) => waitForCondition(read, { timeoutMs, intervalMs: 100 }).catch(() => false);

/**
 * Writes `content` and keeps rewriting it until `seen()` holds: a freshly
 * started fs watcher may miss the first event on a loaded machine.
 */
async function writeUntil(file, content, seen, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await writeFile(file, content);
    if (await pollOrFalse(seen, 1_000)) return true;
    if (Date.now() > deadline) return false;
  }
}

/** True when fs.watch reports a change under `dir` within a second on this machine. */
async function watchWorks(dir) {
  const { watch } = await import("node:fs/promises");
  const abort = new AbortController();
  let seen = false;
  const loop = (async () => {
    try {
      for await (const _event of watch(dir, { recursive: true, signal: abort.signal })) {
        seen = true;
        break;
      }
    } catch {
      // unsupported or aborted
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  await writeFile(join(dir, ".probe"), "x");
  await pollOrFalse(() => seen, 1_000);
  abort.abort();
  await loop;
  await rm(join(dir, ".probe"), { force: true });
  return seen;
}

function guardReset(store, root) {
  return store.checkGuard({ role: "worker", toolName: "Bash", toolInput: { command: "git reset --hard" }, cwd: root });
}

test("a failed load keeps the last good rule set and the guard keeps judging with it", async (t) => {
  const root = await tempRoot(t, "owl-rule-reload-");
  const file = join(root, "rules/system/rules.yaml");
  await writeFile(file, GOOD);
  const store = new RuleStore(root);
  await store.load();
  assert.equal(store.status.generation, 1);
  assert.equal(store.status.error, null);
  const before = store.rules;
  const guardBefore = guardReset(store, root);
  assert.equal(guardBefore.allowed, false);

  await writeFile(file, BROKEN);
  await assert.rejects(store.load(), RuleLoadError);
  assert.equal(store.rules, before);
  assert.equal(store.status.generation, 1);
  assert.equal(store.status.error.failures[0].path, file);
  assert.deepEqual(guardReset(store, root), guardBefore);
  const otherTool = store.checkGuard({ role: "worker", toolName: "mcp__serena__find_symbol", toolInput: {}, cwd: root });
  assert.equal(otherTool.allowed, true);

  await writeFile(file, GOOD_V2);
  await store.load();
  assert.equal(store.status.generation, 2);
  assert.equal(store.status.error, null);
  assert.equal(guardReset(store, root).message, "Hard resets are still forbidden.");
});

test("the watcher reports failures, survives a throwing handler, recovers and stops", async (t) => {
  const root = await tempRoot(t, "owl-rule-watch-");
  if (!(await watchWorks(join(root, "rules")))) {
    t.skip("fs.watch is not available here");
    return;
  }
  const file = join(root, "rules/system/rules.yaml");
  await writeFile(file, GOOD);
  const store = new RuleStore(root);
  await store.load();
  const results = [];
  await store.startWatching((result) => {
    results.push(result);
    if (!result.ok) throw new Error("handler failure must not stop the watcher");
  });
  t.after(() => store.stopWatching());

  assert.ok(await writeUntil(file, BROKEN, () => results.some((result) => !result.ok)), "a failed reload is reported");
  assert.equal(guardReset(store, root).allowed, false);

  assert.ok(await writeUntil(file, GOOD_V2, () => results.some((result) => result.ok)), "the watcher keeps running after the handler threw");
  assert.equal(guardReset(store, root).message, "Hard resets are still forbidden.");

  store.stopWatching();
  await new Promise((r) => setTimeout(r, 100));
  const count = results.length;
  await writeFile(file, GOOD);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(results.length, count);
});

async function openCore(t, root) {
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "plan failed" }),
    runWorker: async () => ({ outcome: "failed" }),
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { core } = await createTestCore(t, { agentRunner, owlRoot: root, dispatcher: { tick_interval_ms: 25 } });
  return core;
}

function rulesAlerts(core, kind) {
  return core.listEventsAfter(0).filter((event) => event.type === "system.alert" && event.payload.kind === kind);
}

test("Core refuses to start when a rule file is invalid", async (t) => {
  const root = await tempRoot(t, "owl-rule-core-start-");
  const bad = join(root, "rules/system/bad.yaml");
  await writeFile(bad, BROKEN);
  const core = await openCore(t, root);
  await assert.rejects(core.start(), (error) => {
    assert.equal(error.code, "rules_invalid");
    assert.equal(error.details.failures[0].path, bad);
    return true;
  });
});

test("Core tells the Owner once per distinct reload failure and once when the rules recover", async (t) => {
  const root = await tempRoot(t, "owl-rule-core-alert-");
  const file = join(root, "rules/system/rules.yaml");
  await writeFile(file, GOOD);
  const core = await openCore(t, root);
  await core.start();
  const store = core.ruleStore;

  const failed = async () => {
    try {
      await store.load();
      return { ok: true, generation: store.status.generation };
    } catch (error) {
      return { ok: false, error };
    }
  };
  await writeFile(file, BROKEN);
  await core.onRulesReloaded(await failed());
  await core.onRulesReloaded(await failed());
  const alerts = rulesAlerts(core, "rules_load_failed");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].work_id, null);
  assert.equal(alerts[0].payload.kept_generation, 1);
  assert.equal(alerts[0].payload.files[0].path, file);

  await writeFile(file, GOOD_V2);
  await core.onRulesReloaded(await failed());
  assert.equal(rulesAlerts(core, "rules_reloaded").length, 1);
  await core.onRulesReloaded(await failed());
  assert.equal(rulesAlerts(core, "rules_reloaded").length, 1, "ordinary successful reloads are not announced");
});

test("Core's rule watcher raises the reload-failure alert from a saved file", async (t) => {
  const root = await tempRoot(t, "owl-rule-core-watch-");
  if (!(await watchWorks(join(root, "rules")))) {
    t.skip("fs.watch is not available here");
    return;
  }
  const file = join(root, "rules/system/rules.yaml");
  await writeFile(file, GOOD);
  const core = await openCore(t, root);
  await core.start();
  assert.ok(await writeUntil(file, BROKEN, () => rulesAlerts(core, "rules_load_failed").length > 0));
  await writeFile(file, BROKEN);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(rulesAlerts(core, "rules_load_failed").length, 1);
  assert.ok(await writeUntil(file, GOOD, () => rulesAlerts(core, "rules_reloaded").length === 1));
});

test("the Rule Store has no agents-md generator", () => {
  const store = new RuleStore(tmpdir());
  assert.equal(typeof store.generateAgentsMd, "undefined");
  assert.equal(typeof store.generateAllAgentsMd, "undefined");
});
