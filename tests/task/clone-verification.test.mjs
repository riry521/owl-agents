import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { cloneBaseline, cloneCheck, cloneUses, gitlinkPathsSince, pathsUnderCloneRoot, usedCloneCheck, usedClones } from "../../packages/core/dist/clone-check.js";
import { GitWorktreeGateway } from "../../packages/core/dist/git-gateway.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";

// Git children get a temp HOME and no global or system config, so the user's settings never apply.
const gitHome = mkdtempSync(join(tmpdir(), "owl-clone-git-home-"));
process.on("exit", () => rmSync(gitHome, { recursive: true, force: true }));

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: gitHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

async function worktree(t) {
  const root = await tempDir(t, "owl-clone-check-");
  git(root, "init", "-q");
  await writeFile(join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

const clone = async (root, path) => {
  await mkdir(join(root, path), { recursive: true });
  git(join(root, path), "init", "-q");
};

test("a clone in an untracked folder fails with its relative path and the fix", async (t) => {
  const { root } = await worktree(t);
  await clone(root, "tools/foo");
  const check = await cloneCheck(root, []);
  assert.equal(check.passed, false);
  assert.match(check.detail, /tools\/foo/u);
  assert.match(check.detail, /outside the project/u);
});

test("a clone in a .gitignore-d folder fails", async (t) => {
  const { root } = await worktree(t);
  await writeFile(join(root, ".gitignore"), "vendor/\n");
  await clone(root, "vendor/deep/bar");
  assert.match((await cloneCheck(root, [])).detail, /vendor\/deep\/bar/u);
});

test("a committed clone file fails, and the clone is not descended into", async (t) => {
  const { root } = await worktree(t);
  await mkdir(join(root, "baz"));
  await writeFile(join(root, "baz", "f.txt"), "x\n");
  git(root, "add", "baz/f.txt");
  git(root, "commit", "-q", "-m", "clone files");
  await clone(root, "baz");
  await clone(root, "baz/inner");
  const check = await cloneCheck(root, []);
  assert.match(check.detail, /baz/u);
  assert.doesNotMatch(check.detail, /baz\/inner/u);
});

test("a committed gitlink fails even when no clone is on disk", async (t) => {
  const { root, base } = await worktree(t);
  git(root, "update-index", "--add", "--cacheinfo", `160000,${base},sub/mod`);
  git(root, "commit", "-q", "-m", "gitlink");
  const links = await gitlinkPathsSince(root, base);
  assert.deepEqual(links, ["sub/mod"]);
  assert.match((await cloneCheck(root, links)).detail, /sub\/mod/u);
});

test("a regular file replaced by a gitlink is reported", async (t) => {
  const { root, base } = await worktree(t);
  git(root, "rm", "-q", "--cached", "a.txt");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${base},a.txt`);
  git(root, "commit", "-q", "-m", "type change");
  assert.deepEqual(await gitlinkPathsSince(root, base), ["a.txt"]);
});

test("a folder that cannot be scanned rejects instead of passing", async (t) => {
  const { root } = await worktree(t);
  await mkdir(join(root, "locked"));
  await chmod(join(root, "locked"), 0o000);
  try {
    await assert.rejects(cloneCheck(root, []), /locked/u);
  } finally {
    await chmod(join(root, "locked"), 0o755);
  }
});

test("a failure is a PolicyCheck like the existing checks; a plain change passes", async (t) => {
  const { root, base } = await worktree(t);
  await writeFile(join(root, "b.txt"), "b\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "plain");
  assert.equal(await cloneCheck(root, await gitlinkPathsSince(root, base)), null);
  await clone(root, "c");
  const check = await cloneCheck(root, []);
  assert.deepEqual(Object.keys(check).sort(), ["command_id", "detail", "error_key", "passed"]);
  assert.equal(check.error_key, "clone_in_worktree");
});

test("a Project Task whose fork point Git cannot find rejects with its path and the cause", async (t) => {
  const parent = await tempDir(t, "owl-clone-fork-");
  const project = join(parent, "repo");
  await mkdir(project);
  git(project, "init", "-q", "--initial-branch=main");
  await writeFile(join(project, "a.txt"), "a\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "base");
  const row = { canonical_path: project, base_branch: "main", allowed_roots_json: JSON.stringify([parent]) };
  const db = { get: (sql) => sql.includes("SELECT project_id FROM works") ? { project_id: "p" } : sql.includes("FROM projects") ? row : undefined };
  const gateway = new GitWorktreeGateway(db, join(parent, "owl"));
  const task = await gateway.prepareWorktree({ work_id: "W", task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  const request = { work_id: "W", task_id: "T1" };
  git(task.worktree_path, "update-index", "--add", "--cacheinfo", `160000,${git(project, "rev-parse", "HEAD")},sub/mod`);
  git(task.worktree_path, "commit", "-q", "-m", "gitlink");
  assert.deepEqual(await gateway.gitlinkPaths(request), ["sub/mod"]);
  row.base_branch = "no-such-branch";
  await assert.rejects(gateway.gitlinkPaths(request), (error) => error.message.includes(task.worktree_path) && /merge-base HEAD no-such-branch failed/u.test(error.message));
});

// A temp home and a temp data folder hold the clone folder; the real ~/tools is never touched.
async function cloneFolder(t) {
  const base = await tempDir(t, "owl-clone-root-");
  const home = join(base, "home");
  const dataDir = join(base, "data");
  const root = join(home, "tools");
  const used = join(root, "used");
  const other = join(root, "other");
  for (const dir of [used, other]) {
    await mkdir(dir, { recursive: true });
    git(dir, "init", "-q");
    await writeFile(join(dir, "f.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
  }
  return { base, home, dataDir, root, used, other };
}

const usesOf = (root, clone) => Promise.all(cloneUses(root, "Read", { file_path: join(clone, "f.txt") }, "/", dirname(root)).map(async (use) => ({ ...use, baseline: await cloneBaseline(use) })));

for (const [name, change] of [
  ["an edited file", (dir) => writeFile(join(dir, "f.txt"), "edited\n")],
  ["an added file", (dir) => writeFile(join(dir, "new.txt"), "new\n")],
  ["a deleted file", (dir) => rm(join(dir, "f.txt"))],
  ["the whole clone removed", (dir) => rm(dir, { recursive: true })],
  ["its .git removed", (dir) => rm(join(dir, ".git"), { recursive: true })],
]) {
  test(`a used clone with ${name} fails with its path and the fix`, async (t) => {
    const { root, used } = await cloneFolder(t);
    const uses = await usesOf(root, used);
    assert.deepEqual(uses, [{ path: used, exists: true, baseline: "" }]);
    await change(used);
    const check = await usedCloneCheck(root, uses);
    assert.equal(check.passed, false);
    assert.equal(check.error_key, "clone_modified");
    assert.ok(check.detail.includes(used));
    assert.match(check.detail, /Revert/u);
  });
}

test("an untouched used clone passes, and a changed clone the Task did not use is ignored", async (t) => {
  const { root, used, other } = await cloneFolder(t);
  await writeFile(join(other, "f.txt"), "someone else\n");
  assert.equal(await usedCloneCheck(root, await usesOf(root, used)), null);
  assert.equal(await usedCloneCheck(root, []), null);
});

test("Bash cwd, words, quotes, cd, git -C and a git clone destination map to the clone", async (t) => {
  const { home, root, used } = await cloneFolder(t);
  const other = join(root, "other");
  const bash = (command, cwd) => usedClones(root, pathsUnderCloneRoot(root, "Bash", { command }, cwd, home));
  assert.deepEqual(bash("ls", used), [used]);
  assert.deepEqual(bash(`cat ${used}/f.txt`, "/"), [used]);
  assert.deepEqual(bash(`cat "${used}/f.txt"`, "/"), [used]);
  assert.deepEqual(bash(`cd ${used} && ls`, "/"), [used]);
  assert.deepEqual(bash(`git -C '${used}' status`, "/"), [used]);
  assert.deepEqual(bash(`git -C${used} status`, "/"), [used]);
  assert.deepEqual(bash("cat ~/tools/used/f.txt", "/"), [used]);
  assert.deepEqual(bash("cat $HOME/tools/used/f.txt \"${HOME}/tools/used/g.txt\"", "/"), [used]);
  assert.deepEqual(bash("cd -- ~/tools/used && ls", "/"), [used]);
  assert.deepEqual(bash("rm -rf used", root), [used]);
  assert.deepEqual(bash("echo hi > used/out.txt", root), [used]);
  assert.deepEqual(pathsUnderCloneRoot(root, "Read", { file_path: "~/tools/used/f.txt" }, "/", home), [join(used, "f.txt")]);
  assert.deepEqual(bash("echo hi", "/"), []);
  // Every word that is not an option and every `=` value is taken, whatever the command, so text under the clone root counts too.
  assert.deepEqual(bash("echo other; grep needle used/f.txt 2>&1", root), [other, used]);
  assert.deepEqual(bash(`rg --regexp=needle ${used}`, "/"), [used]);
  assert.deepEqual(bash(`rg --files ${used}`, "/"), [used]);
  assert.deepEqual(bash(`git --work-tree=${used} status`, "/"), [used]);
  assert.deepEqual(bash(`git --git-dir=${used}/.git log`, "/"), [used]);
  assert.deepEqual(bash(`git -C ${used} log --format=${other}`, "/"), [other, used]);
  // A subshell's cd does not move the folder later commands run in.
  assert.deepEqual(bash("(cd used && cat f.txt); cat other/f.txt", root), [other, used]);
  assert.deepEqual(bash("cat '~/tools/other/f.txt'", "/"), []);
  const spaced = join(root, "my repo");
  await mkdir(spaced);
  git(spaced, "init", "-q");
  assert.deepEqual(bash(`cat "${spaced}/f.txt"`, "/"), [spaced]);
  const dests = [
    ["cd tools-root && git clone https://example.com/o/fresh.git", "fresh"],
    ["git -C tools-root clone --depth 1 -b main https://example.com/o/fresh.git", "fresh"],
    ["git clone git@example.com:o/fresh.git tools-root/named", "named"],
    ["cd -- ~/tools && git clone https://example.com/o/fresh.git", "fresh"],
    ["git -Ctools-root clone https://example.com/o/fresh.git", "fresh"],
    ["git clone --depth=1 -- https://example.com/o/fresh.git ~/tools/dashed", "dashed"],
  ];
  for (const [command, name] of dests) {
    const paths = pathsUnderCloneRoot(root, "Bash", { command: command.replaceAll("tools-root", root) }, "/", home);
    await mkdir(join(root, name), { recursive: true });
    git(join(root, name), "init", "-q");
    assert.deepEqual(usedClones(root, paths), [join(root, name)], command);
    await rm(join(root, name), { recursive: true });
  }
});

// Core on the temp home and data folder with a running Task T1; `record` passes a tool call through Core's guard as T1's.
async function taskCore(t, { base, home, dataDir }) {
  const gitConfig = join(base, "gitconfig");
  await writeFile(gitConfig, "");
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { core, db } = await createTestCore(t, { homeDir: home, dataDir });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('W1', 'owner:default', NULL, 'w', '', 'normal', 'running', '[]', '[]', ?, ?)", now, now);
    tx.run("INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at) VALUES ('T1', 'W1', 't', 'code', 'running', 'normal', '', '', ?, ?)", now, now);
    tx.run("INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at) VALUES ('run-1', 'W1', 'T1', 'worker', 'claude', 'm', 'running', ?, ?)", now, now);
  });
  const record = (command, cwd) => core.checkTestSetupTool({ agent_run_id: "run-1", tool_name: "Bash", tool_input: { command }, cwd });
  const uses = () => db.all("SELECT path, clone_exists, baseline FROM task_clone_uses WHERE task_id = 'T1' ORDER BY path").map((row) => ({ path: row.path, exists: row.clone_exists === 1, baseline: row.baseline }));
  return { core, record, uses };
}

test("Core records the clones a Task used in the DB, and verification reads them back", async (t) => {
  const folder = await cloneFolder(t);
  const { root, used, other } = folder;
  const { core, record, uses } = await taskCore(t, folder);
  assert.equal(await core.cloneRoot(), root);
  await record("cat ~/tools/used/f.txt", folder.base);
  assert.deepEqual(uses(), [{ path: used, exists: true, baseline: "" }]);
  await writeFile(join(other, "f.txt"), "someone else\n");
  assert.equal(await usedCloneCheck(root, uses()), null);
  await writeFile(join(used, "new.txt"), "n\n");
  assert.ok((await usedCloneCheck(root, uses())).detail.includes(used));
});

for (const [form, command] of [
  ["cd", (clone) => `cd ${clone} && ls`],
  ["git -C", (clone) => `git -C ${clone} status`],
  ["a path argument", (clone) => `cat ${clone}/f.txt`],
  ["an --x= value", (clone) => `git --work-tree=${clone} status`],
  ["a redirection target", (clone) => `echo hi > ${clone}/out.txt`],
  ["rg --regexp=", (clone) => `rg --regexp=needle ${clone}`],
]) {
  test(`a clone used through ${form} is recorded and fails once it is edited`, async (t) => {
    const folder = await cloneFolder(t);
    const { record, uses } = await taskCore(t, folder);
    await record(command(folder.used), folder.base);
    assert.deepEqual(uses().map((use) => use.path), [folder.used]);
    await writeFile(join(folder.used, "f.txt"), "edited\n");
    const check = await usedCloneCheck(folder.root, uses());
    assert.equal(check.error_key, "clone_modified");
    assert.ok(check.detail.includes(folder.used));
  });
}

test("a clone changed before it was recorded passes while unchanged, and fails when the Task changes it further", async (t) => {
  const folder = await cloneFolder(t);
  const { root, used, other } = folder;
  const { record, uses } = await taskCore(t, folder);
  await writeFile(join(other, "f.txt"), "someone else\n");
  await writeFile(join(other, "notes.txt"), "work in progress\n");
  await record(`git -C ${used} commit -m ${other}`, folder.base);
  await record(`git -C ${used} log --format ${other}/f.txt`, folder.base);
  assert.deepEqual(uses().map((use) => use.path), [other, used]);
  assert.equal(await usedCloneCheck(root, uses()), null);
  await writeFile(join(other, "f.txt"), "edited by the Task\n");
  const check = await usedCloneCheck(root, uses());
  assert.ok(check.detail.includes(other));
  assert.ok(!check.detail.includes(used));
});

test("a clone the Task creates has a clean baseline", async (t) => {
  const folder = await cloneFolder(t);
  const { root } = folder;
  const { record, uses } = await taskCore(t, folder);
  await record("git clone https://example.com/o/fresh.git", root);
  const fresh = join(root, "fresh");
  assert.ok(uses().some((use) => use.path === fresh && !use.exists && use.baseline === ""));
  git(root, "init", "-q", "fresh");
  assert.equal(await usedCloneCheck(root, uses()), null);
  await writeFile(join(fresh, "new.txt"), "n\n");
  assert.ok((await usedCloneCheck(root, uses())).detail.includes(fresh));
});
