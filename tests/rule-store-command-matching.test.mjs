import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuleStore } from "../packages/core/dist/rule-store.js";

test("rule store matches parsed commands and does not confuse unrelated paths", async () => {
  const store = new RuleStore(process.cwd());
  await store.load();
  const cwd = process.cwd();
  const home = process.env.HOME;

  for (const command of [
    "git push --force",
    "git push -f",
    "git \"push\" \"-f\"",
    "! git push -f",
    "echo safe && git push -f",
    "$(git push -f)",
    "bash -lc 'git push -f'",
    "env -S 'git push -f'",
    "env --split-string='git push -f'",
    "eval 'git push -f'",
    "git reset --hard",
    "git clean -fdx",
    "git clean --force --directories --ignored",
    "rm -rf /",
    "rm -rf /*",
    "rm -R -f /",
    "rm --recursive --force /",
    "rm -rf \"$HOME\"",
    "rm -rf \"$HOME\"/*",
    "rm -rf \"$TARGET\"",
    "rm -rf ${HOME:-/}",
    "git push $PUSH_FLAGS origin main",
    "git reset --${RESET_MODE}",
    "${COMMAND:-echo} safe",
    "env ACTION=$COMMAND $ACTION safe",
    "cd \"$HOME\" && rm -rf ..",
    "sudo -n rm -f /tmp/small-file",
  ]) {
    assert.equal(store.checkCommand(command, cwd, home).blocked, true, command);
  }

  for (const command of [
    "git push --force-with-lease",
    "rm -rf /tmp/x",
    "rm -rf /tmp/x/*",
    "rm -rf ./tmp/x",
  ]) {
    assert.equal(store.checkCommand(command, cwd, home).blocked, false, command);
  }
});

test("path rules protect secrets and sqlite writes while allowing read-only sqlite", async () => {
  const store = new RuleStore(process.cwd());
  await store.load();
  const root = await mkdtemp(path.join(os.tmpdir(), "owl-rule-store-"));
  try {
    assert.equal(store.checkPath(path.join(root, ".env.local"), "read", root, "worker").blocked, true);
    assert.equal(store.checkPath(path.join(root, "nested", "secrets.json"), "read", root, "worker").blocked, true);
    assert.equal(store.checkPath(path.join(root, ".env.local"), "write", root, "worker").blocked, false);
    assert.equal(store.checkPath(path.join(root, "data", "state.sqlite"), "write", root, "worker").blocked, true);
    assert.equal(store.checkPath(path.join(root, "data", "state.sqlite"), "read", root, "worker").blocked, false);
    assert.equal(store.checkPath(path.join(root, "nested", "..", ".env.local"), "read", root, "worker").blocked, true);
    assert.equal(store.checkPath(path.join(process.env.HOME, ".ssh", "id_ed25519"), "read", root, "worker").blocked, true);
    assert.equal(store.checkPath(path.join(process.env.HOME, ".ssh"), "read", root, "worker").blocked, true);

    const dataDirectory = path.join(root, "data");
    const linkedData = path.join(root, "data-link");
    await mkdir(dataDirectory, { recursive: true });
    await symlink(dataDirectory, linkedData, "dir");
    assert.equal(store.checkPath(path.join(linkedData, "state.sqlite"), "write", root, "worker").blocked, true);

    await writeFile(path.join(root, ".env.local"), "KEY=value\n");
    await symlink(path.join(root, ".env.local"), path.join(root, "ordinary-name.txt"));
    assert.equal(store.checkPath(path.join(root, "ordinary-name.txt"), "read", root, "worker").blocked, true);
    await writeFile(path.join(root, "ordinary-secret.txt"), "KEY=value\n");
    await symlink(path.join(root, "ordinary-secret.txt"), path.join(root, ".env.shadow"));
    assert.equal(store.checkPath(path.join(root, ".env.shadow"), "read", root, "worker").blocked, true);

    const bashSecretRead = store.checkGuard({ role: "worker", toolName: "Bash", toolInput: { command: "cat .env.local" }, cwd: root });
    const pythonSecretRead = store.checkGuard({ role: "worker", toolName: "Bash", toolInput: { command: "python3 -c \"open('.env.local').read()\"" }, cwd: root });
    const globSecretRead = store.checkGuard({ role: "worker", toolName: "Glob", toolInput: { pattern: "**/.env*", path: root }, cwd: root });
    const grepSecretRead = store.checkGuard({ role: "worker", toolName: "Grep", toolInput: { pattern: "KEY", path: root, glob: ".env*" }, cwd: root });
    assert.equal(bashSecretRead.allowed, false);
    assert.equal(pythonSecretRead.allowed, false);
    assert.equal(globSecretRead.allowed, false);
    assert.equal(grepSecretRead.allowed, false);

    const pythonDatabaseWrite = store.checkGuard({
      role: "worker",
      toolName: "Bash",
      toolInput: { command: "python3 -c \"sqlite3.connect('data/state.sqlite')\"" },
      cwd: root,
    });
    assert.equal(pythonDatabaseWrite.allowed, false);
    assert.equal(pythonDatabaseWrite.rule_id, "block-sqlite-file-writes");

    const readonly = store.checkGuard({
      role: "worker",
      toolName: "Bash",
      toolInput: { command: "sqlite3 -readonly data/state.sqlite 'select 1'" },
      cwd: root,
    });
    assert.equal(readonly.allowed, true);

    const directWrite = store.checkGuard({
      role: "worker",
      toolName: "Bash",
      toolInput: { command: "sqlite3 data/state.sqlite 'delete from events'" },
      cwd: root,
    });
    assert.equal(directWrite.allowed, false);
    assert.equal(directWrite.rule_id, "block-sqlite-file-writes");

    const gitDelete = store.checkGuard({ role: "worker", toolName: "Bash", toolInput: { command: "git rm data/state.sqlite" }, cwd: root });
    assert.equal(gitDelete.allowed, false);
    assert.equal(gitDelete.rule_id, "block-sqlite-file-writes");

    const advisorEdit = store.checkGuard({ role: "advisor", toolName: "Edit", toolInput: { file_path: "src/index.ts" }, cwd: root });
    const advisorWrite = store.checkGuard({ role: "advisor", toolName: "Write", toolInput: { file_path: "src/index.ts", content: "new" }, cwd: root });
    const advisorShellWrite = store.checkGuard({ role: "advisor", toolName: "Bash", toolInput: { command: "printf x > src/index.ts" }, cwd: root });
    const advisorRead = store.checkGuard({ role: "advisor", toolName: "Read", toolInput: { file_path: "src/index.ts" }, cwd: root });
    const advisorPatch = store.checkGuard({ role: "advisor", toolName: "apply_patch", toolInput: { command: "*** Begin Patch\n*** Update File: src/index.ts\n*** End Patch" }, cwd: root });
    const workerPatchDatabase = store.checkGuard({ role: "worker", toolName: "apply_patch", toolInput: { command: "*** Begin Patch\n*** Update File: data/state.sqlite\n*** End Patch" }, cwd: root });
    assert.equal(advisorEdit.allowed, true);
    assert.equal(advisorWrite.allowed, true);
    assert.equal(advisorShellWrite.allowed, true);
    assert.equal(advisorRead.allowed, true);
    assert.equal(advisorPatch.allowed, true);
    assert.equal(workerPatchDatabase.allowed, false);
    assert.equal(workerPatchDatabase.rule_id, "block-sqlite-file-writes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
