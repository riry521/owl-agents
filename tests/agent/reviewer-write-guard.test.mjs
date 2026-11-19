import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { RuleStore } from "../../packages/core/dist/rule-store.js";
import { tempDir } from "../helpers/temp.mjs";

test("a Reviewer can write only the files in its fix permit and cannot change git state", async (t) => {
  const root = await realpath(await tempDir(t, "owl-reviewer-write-guard-"));
  const store = new RuleStore(root);
  await store.ensureDirectories();
  await store.load();
  const worktree = join(root, "wt");
  const sibling = join(root, "wt-other");
  const outside = join(root, "data");
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(join(worktree, ".git"), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await mkdir(outside, { recursive: true });
  const editable = join(worktree, "src", "a.ts");
  await writeFile(editable, "x");
  await writeFile(join(worktree, "src", "b.ts"), "x");
  await symlink(outside, join(worktree, "src", "link"));
  const paths = [editable];
  const check = (role, toolName, toolInput, reviewerWritePaths = paths) => store.checkGuard({
    role, toolName, toolInput, cwd: worktree, reviewerWritePaths,
  });
  const denied = (result) => {
    assert.equal(result.allowed, false);
    assert.equal(result.rule_id, "reviewer-write-path");
  };

  assert.equal(check("reviewer", "Write", { file_path: editable }).allowed, true);
  assert.equal(check("reviewer", "Edit", { file_path: editable, old_string: "x", new_string: "y" }).allowed, true);
  assert.equal(check("reviewer", "apply_patch", { command: `*** Begin Patch\n*** Update File: ${editable}\n@@\n-x\n+y\n*** End Patch` }).allowed, true);
  assert.equal(check("reviewer", "Bash", { command: `printf x > ${editable}` }).allowed, true);
  assert.equal(check("reviewer", "Bash", { command: `sed -i 's/x/y/' ${editable}` }).allowed, true);
  assert.equal(check("reviewer", "Bash", { command: "git diff" }).allowed, true);
  assert.equal(check("reviewer", "Read", { file_path: join(worktree, "src", "b.ts") }).allowed, true);

  denied(check("reviewer", "Write", { file_path: join(worktree, "src", "b.ts") }));
  denied(check("reviewer", "Write", { file_path: join(worktree, "src", "new.ts") }));
  denied(check("reviewer", "Write", { file_path: join(outside, "x.txt") }));
  denied(check("reviewer", "Write", { file_path: join(sibling, "a.ts") }));
  denied(check("reviewer", "Write", { file_path: "/tmp/owl-reviewer-guard-x" }));
  denied(check("reviewer", "Write", { file_path: join(worktree, ".git", "config") }));
  denied(check("reviewer", "Write", { file_path: join(worktree, "src", "link", "x.txt") }));
  denied(check("reviewer", "Bash", { command: `printf x > ${join(worktree, "src", "b.ts")}` }));
  denied(check("reviewer", "Bash", { command: `sed -i 's/x/y/' ${join(outside, "x.txt")}` }));
  for (const command of ["git commit -am x", "git reset --hard", "git stash", "git checkout -- src/a.ts"]) {
    denied(check("reviewer", "Bash", { command }));
  }
  denied(check("reviewer", "Write", { file_path: editable }, null));
  denied(store.checkGuard({ role: "reviewer", toolName: "Write", toolInput: { file_path: editable }, cwd: worktree }));
  denied(check("reviewer", "Bash", { command: `printf x > ${editable}` }, null));

  assert.equal(check("worker", "Write", { file_path: join(worktree, "src", "b.ts") }).allowed, true);
});
