import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RuleStore } from "../../packages/core/dist/rule-store.js";
import { tempDir } from "../helpers/temp.mjs";

// RuleStore expands ~ and $HOME from the environment; give it a home when the runner has none.
process.env.HOME ||= homedir();

test("rule store matches parsed commands and does not confuse unrelated paths", async () => {
  const store = new RuleStore(process.cwd());
  await store.load();
  const cwd = process.cwd();
  const home = homedir();

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

test("path rules protect secrets and sqlite writes while allowing read-only sqlite", async (t) => {
  const store = new RuleStore(process.cwd());
  await store.load();
  const root = await tempDir(t, "owl-rule-store-");
  assert.equal(store.checkPath(path.join(root, ".env.local"), "read", root, "worker").blocked, true);
  assert.equal(store.checkPath(path.join(root, "nested", "secrets.json"), "read", root, "worker").blocked, true);
  assert.equal(store.checkPath(path.join(root, ".env.local"), "write", root, "worker").blocked, true);
  assert.equal(store.checkPath(path.join(root, ".env.example"), "write", root, "worker").blocked, false);
  assert.equal(store.checkPath(path.join(root, "data", "state.sqlite"), "write", root, "worker").blocked, true);
  assert.equal(store.checkPath(path.join(root, "data", "state.sqlite"), "read", root, "worker").blocked, false);
  assert.equal(store.checkPath(path.join(root, "nested", "..", ".env.local"), "read", root, "worker").blocked, true);
  assert.equal(store.checkPath(path.join(homedir(), ".ssh", "id_ed25519"), "read", root, "worker").blocked, true);
  assert.equal(store.checkPath(path.join(homedir(), ".ssh"), "read", root, "worker").blocked, true);

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
});

test("here-document bodies are data while surrounding commands are still checked", async (t) => {
  const store = new RuleStore(process.cwd());
  await store.load();
  const cwd = process.cwd();
  const home = homedir();
  const blocked = (command) => store.checkCommand(command, cwd, home).blocked;

  for (const command of [
    "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: /abs/doc.md\n@@\n-old line with `code` in markdown\n+new line with `other code`\n*** End Patch\nPATCH\ngit status --short",
    "cat > /tmp/notes.md <<'EOF'\nuse `git` and $(rm -rf /) here\nEOF",
    "cat > /tmp/notes.md <<\"EOF\"\n`rm -rf /`\nEOF",
    "cat > /tmp/notes.md <<\\EOF\n`rm -rf /`\nEOF",
    "cat > /tmp/notes.md <<E'O'F\ngit push -f\nEOF",
    "cat <<EOF\nhome is $HOME and $UNKNOWN_VAR\nEOF",
    "cat <<-EOF\n\tgit push -f\n\tEOF\ngit status",
    "cat <<A <<'B'\none `x`\nA\ntwo `y`\nB\ngit status",
    "cat <<'EOF'\nunterminated `body` git push -f",
    "cat <<< 'here string'",
    "echo $((1<<2))",
    "git commit -F - <<'EOF'\nmsg with `code`\nEOF",
    "python3 - <<'PY'\nprint(`x`)\nPY",
    "cat <<-'EOF'\n\t`x`\n\tEOF",
    "cat <<EOF_1.x\nbody\nEOF_1.x\ngit status",
  ]) {
    assert.equal(blocked(command), false, command);
  }

  for (const command of [
    "cat <<EOF\n$(rm -rf /)\nEOF",
    "cat <<EOF\n`rm -rf /`\nEOF",
    "cat <<'EOF'\nbody\nEOF\ngit push -f",
    "cat <<-EOF\n\tbody\n\tEOF\ngit push -f",
    "cat <<A <<'B'\nx\nA\ny\nB\ngit push -f",
    "cat <<'EOF' && git push -f\nbody\nEOF",
    "cat <<< $(git push -f)",
    "((x=1<<2))\ngit push -f\n2",
    "for ((i=0;i<<1;i++)); do :; done\ngit push -f\n1",
    "echo $[1<<2]\ngit push -f\n2]",
    "cat <<$'EOF'\nEOF\ngit push -f\n$EOF",
    "cat <<$\"EOF\"\nEOF\ngit push -f\n$EOF",
    "cat <<\"a\\\"b\"\na\"b\ngit push -f\n",
    "cat <<$(x)\n$(x)\ngit push -f\n$",
    "cat <<E\\\nOF\n$(git push -f)\nEOF",
    "echo $[x[0]<<2 ]\ngit push -f\n2",
    "cat <<EOF\r\nbody\r\nEOF\r\ngit push -f #\r\n",
    "echo \"$[1]\"; cat <<'EOF'\n`x`\nEOF",
  ]) {
    assert.equal(blocked(command), true, command);
  }

  const root = await tempDir(t, "owl-heredoc-");
  for (const command of ["cat > data/state.sqlite", "cat > data/state.sqlite <<'EOF'\nrows\nEOF"]) {
    const result = store.checkGuard({ role: "worker", toolName: "Bash", toolInput: { command }, cwd: root });
    assert.equal(result.allowed, false, command);
    assert.equal(result.rule_id, "block-sqlite-file-writes", command);
  }
});
