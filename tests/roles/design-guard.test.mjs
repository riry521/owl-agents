import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { RuleStore } from "../../packages/core/dist/rule-store.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

test("a Designer token can write only its assigned external document", async (t) => {
  const root = await tempDir(t, "owl-design-guard-");
  const store = new RuleStore(root);
  await store.ensureDirectories();
  await store.load();
  const target = join(root, "data", "designs", "W1", "T1.md");
  await mkdir(join(root, "data", "designs", "W1"), { recursive: true });
  const check = (role, toolName, toolInput, designerWritePath) => store.checkGuard({
    role,
    toolName,
    toolInput,
    cwd: join(root, "repo"),
    designerWritePath,
  });

  assert.equal(check("designer", "Write", { file_path: target }, target).allowed, true);
  assert.equal(check("designer", "Write", { file_path: join(root, "repo", "src", "x.ts") }, target).allowed, false);
  assert.equal(check("designer", "Bash", { command: `printf x > ${target}` }, target).allowed, true);
  assert.equal(check("designer", "Bash", { command: `printf x > ${join(root, "repo", "stray.txt")}` }, target).allowed, false);
  assert.equal(check("worker", "Write", { file_path: join(root, "repo", "src", "x.ts") }, target).allowed, true);
});

test("a Designer token cannot mutate git state through global options but may read it", async (t) => {
  const root = await tempDir(t, "owl-design-guard-git-");
  const store = new RuleStore(root);
  await store.ensureDirectories();
  await store.load();
  const target = join(root, "data", "designs", "W1", "T1.md");
  const check = (command) => store.checkGuard({
    role: "designer",
    toolName: "Bash",
    toolInput: { command },
    cwd: join(root, "repo"),
    designerWritePath: target,
  }).allowed;

  for (const command of [
    "git commit -am x",
    "git -C . commit -am x",
    "git -c a=b commit -m x",
    "git --git-dir=.git --work-tree=. add .",
    "git --no-pager -p stash",
    "git branch feature",
    "git branch -D main",
    "git tag v1",
    "git worktree add ../x",
    "git stash push",
    "git diff --output=patch.diff",
  ]) assert.equal(check(command), false, command);

  for (const command of [
    "git status --porcelain",
    "git -C . diff HEAD",
    "git --no-pager log --oneline -5",
    "git show HEAD:README.md",
    "git branch",
    "git branch -a -v",
    "git stash list",
    "git worktree list",
    "git tag -l",
    "git rev-parse HEAD",
    "git ls-files",
    "git blame README.md",
    "git grep -n owl",
  ]) assert.equal(check(command), true, command);
});

test("the guard endpoint resolves a Designer token's writable document from its Agent run", async (t) => {
  const root = await tempDir(t, "owl-design-guard-http-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const db = createTestDatabase(dataDir);
  t.after(() => db.close());
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    transaction.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W1', 'owner:default', 'Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      now, now,
    );
    for (const [taskId, type] of [["T-design", "design"], ["T-code", "code"]]) {
      transaction.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
         VALUES (?, 'W1', 'Task', ?, 'running', 'normal', '', '', ?, ?)`,
        taskId, type, now, now,
      );
    }
    for (const [runId, taskId] of [["run-design", "T-design"], ["run-code", "T-code"]]) {
      transaction.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
         VALUES (?, 'W1', ?, 'designer', 'anthropic', 'm', 'running', ?, ?)`,
        runId, taskId, now, now,
      );
    }
  });
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  const ruleStore = new RuleStore(root);
  await ruleStore.ensureDirectories();
  await ruleStore.load();
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, {
    core: { ready: true }, db, webOut: root, owlRoot: root, dataDir, ruleStore, guardTokens,
  });
  if (!api) return t.skip("localhost listen is unavailable");
  const apiBase = api.baseUrl;
  const designDocument = join(dataDir, "designs", "W1", "T-design.md");
  const check = async (runId, filePath) => {
    const lease = guardTokens.issue({ agent_run_id: runId, role: "designer" });
    const token = (await readFile(lease.file, "utf8")).trim();
    const response = await fetch(`${apiBase}/api/v1/guard/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        request_id: "r",
        idempotency_key: "k",
        expected_version: 0,
        payload: { role: "designer", tool_name: "Write", tool_input: { file_path: filePath }, cwd: join(root, "repo") },
      }),
    });
    lease.release();
    assert.equal(response.status, 200);
    return (await response.json()).data.allowed;
  };

  assert.equal(await check("run-design", designDocument), true);
  assert.equal(await check("run-design", join(root, "repo", "src", "x.ts")), false);
  assert.equal(await check("run-design", join(dataDir, "designs", "W1", "T-code.md")), false);
  // A Designer run on a Task that is not a design Task has no writable document.
  assert.equal(await check("run-code", join(dataDir, "designs", "W1", "T-code.md")), false);
  assert.equal(await check("run-unknown", designDocument), false);
});
