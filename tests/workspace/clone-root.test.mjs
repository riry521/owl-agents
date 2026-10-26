import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { planClone, resolveCloneRoot } from "../../packages/core/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { tempDir } from "../helpers/temp.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

/** A temp home, data folder and git config; nothing outside the temp folder is read or written. */
async function box(t, ghqRoot = null) {
  const base = await realpath(await tempDir(t, "owl-clone-root-"));
  const home = path.join(base, "home");
  const dataDir = path.join(base, "data");
  await mkdir(home, { recursive: true });
  const gitConfig = path.join(base, "gitconfig");
  await writeFile(gitConfig, ghqRoot === null ? "" : `[ghq]\n\troot = ${ghqRoot}\n`);
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return { base, home, dataDir };
}
const clones = async (dir, names) => {
  for (const name of names) await mkdir(path.join(dir, name, ".git"), { recursive: true });
};
const resolveIn = (b, projectPaths = []) => resolveCloneRoot({ home: b.home, dataDir: b.dataDir, projectPaths });

test("ghq.root wins over a home folder of clones", async (t) => {
  const b = await box(t);
  const ghq = path.join(b.base, "ghq");
  await writeFile(process.env.GIT_CONFIG_GLOBAL, `[ghq]\n\troot = ${ghq}\n`);
  await clones(path.join(b.home, "tools"), ["a", "b"]);
  assert.equal(await resolveIn(b), ghq);
});

test("without ghq.root the home folder with the most clones is chosen, ignoring registered Projects", async (t) => {
  const b = await box(t);
  await clones(path.join(b.home, "few"), ["a", "b"]);
  await clones(path.join(b.home, "many"), ["a", "b", "c"]);
  await clones(path.join(b.home, ".hidden"), ["a", "b", "c", "d"]);
  assert.equal(await resolveIn(b), path.join(b.home, "many"));
  const c = await box(t);
  await clones(path.join(c.home, "few"), ["a", "b"]);
  await clones(path.join(c.home, "many"), ["a", "b", "c"]);
  const registered = [path.join(c.home, "many", "a"), path.join(c.home, "many", "b")];
  assert.equal(await resolveIn(c, registered), path.join(c.home, "few"));
});

test("with no candidate the root is a folder under the data folder", async (t) => {
  const b = await box(t);
  await clones(path.join(b.home, "one"), ["a"]);
  const root = await resolveIn(b);
  assert.equal(path.dirname(root), b.dataDir);
});

test("an unwritable ghq.root falls through, and the choice is remembered", async (t) => {
  const b = await box(t);
  const locked = path.join(b.base, "locked");
  await mkdir(locked);
  await chmod(locked, 0o555);
  t.after(() => chmod(locked, 0o755).catch(() => {}));
  await writeFile(process.env.GIT_CONFIG_GLOBAL, `[ghq]\n\troot = ${path.join(locked, "sub")}\n`);
  await clones(path.join(b.home, "tools"), ["a", "b"]);
  const first = await resolveIn(b);
  assert.equal(first, path.join(b.home, "tools"));
  await clones(path.join(b.home, "bigger"), ["a", "b", "c"]);
  assert.equal(await resolveIn(b), first);
});

test("the clone path comes from the URL; same URL is reused, others are left alone", async (t) => {
  const b = await box(t);
  const root = path.join(b.base, "root");
  const https = await planClone(root, "https://example.com/alice/lib.git");
  const ssh = await planClone(root, "git@example.com:bob/lib.git");
  assert.equal(https.path, path.join(root, "example.com", "alice", "lib"));
  assert.equal(ssh.path, path.join(root, "example.com", "bob", "lib"));
  assert.equal((await planClone(root, "file:///tmp/src/lib")).path, path.join(root, "local", "tmp", "src", "lib"));

  const url = "https://example.com/alice/lib.git";
  await mkdir(https.path, { recursive: true });
  git(https.path, "init", "-q");
  git(https.path, "remote", "add", "origin", url);
  assert.deepEqual(await planClone(root, url), { path: https.path, state: "existing" });

  git(https.path, "remote", "set-url", "origin", "https://example.com/other/lib.git");
  await writeFile(path.join(https.path, "mine.txt"), "keep");
  const other = await planClone(root, url);
  assert.ok("reason" in other);
  assert.equal(await readFile(path.join(https.path, "mine.txt"), "utf8"), "keep");
  assert.equal(git(https.path, "config", "remote.origin.url").trim(), "https://example.com/other/lib.git");

  await mkdir(ssh.path, { recursive: true });
  await writeFile(path.join(ssh.path, "notes.txt"), "mine");
  assert.ok("reason" in (await planClone(root, "git@example.com:bob/lib.git")));
  assert.equal(await readFile(path.join(ssh.path, "notes.txt"), "utf8"), "mine");
});

test("the Worker guard allows writes into the clone root and still denies other outside paths", async (t) => {
  const b = await box(t);
  await clones(path.join(b.home, "tools"), ["a", "b"]);
  const { core } = await createTestCore(t, { homeDir: b.home, dataDir: b.dataDir });
  const root = await core.cloneRoot();
  assert.equal(root, path.join(b.home, "tools"));
  const proj = path.join(b.base, "proj");
  const stray = path.join(b.base, "stray");
  await mkdir(proj);
  await mkdir(stray);
  const source = path.join(b.base, "source");
  await mkdir(source);
  git(source, "init", "-q");
  await writeFile(path.join(source, "hello.txt"), "hi");
  git(source, "add", ".");
  git(source, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  core.registerTestSetupRun("run-1", { project_id: "P1", roots: [proj], env: { PATH: process.env.PATH, HOME: b.home }, approved: [], installs: [] });
  const check = (tool_name, tool_input) => core.checkTestSetupTool({ agent_run_id: "run-1", tool_name, tool_input, cwd: proj });

  const url = `file://${source}`;
  const planned = await planClone(root, url);
  const command = `git clone ${url} ${planned.path}`;
  assert.equal((await check("Bash", { command })).denied, false);
  assert.equal((await check("Write", { file_path: path.join(planned.path, "x.txt") })).denied, false);
  assert.equal((await check("Bash", { command: `echo x > ${path.join(stray, "x.txt")}` })).denied, true);
  assert.equal((await check("Write", { file_path: path.join(stray, "x.txt") })).denied, true);

  execFileSync("sh", ["-c", command], { env: process.env });
  assert.equal(await readFile(path.join(planned.path, "hello.txt"), "utf8"), "hi");
});

test("a relative ghq.root, a root inside a Project and worktree folders are not chosen", async (t) => {
  const b = await box(t, "relative/ghq");
  const project = path.join(b.home, "proj");
  await clones(project, ["x", "y"]);
  await mkdir(path.join(b.home, "wt", "a"), { recursive: true });
  await mkdir(path.join(b.home, "wt", "b"), { recursive: true });
  await writeFile(path.join(b.home, "wt", "a", ".git"), "gitdir: elsewhere");
  await writeFile(path.join(b.home, "wt", "b", ".git"), "gitdir: elsewhere");
  const root = await resolveIn(b, [project]);
  assert.equal(path.dirname(root), b.dataDir);
});

test("a URL with an encoded backslash cannot leave the clone root", async () => {
  const result = await planClone("/tmp/owl-root", "https://example.com/a%5c..%5cb/repo.git");
  assert.ok("reason" in result);
});

test("when the data folder is inside a Project, the root is Owl's own folder outside every Project", async (t) => {
  const b = await box(t);
  const project = path.join(b.base, "owl");
  const ownDir = path.join(b.base, "own");
  const root = await resolveCloneRoot({ home: b.home, dataDir: path.join(project, "data"), projectPaths: [project], ownDir });
  assert.equal(root, path.join(ownDir, "clones"));
});

test("a Windows file:// URL keeps its drive letter; other colons and backslashes are still refused", async () => {
  const root = path.join(path.sep, "owl-root");
  assert.equal((await planClone(root, "file:///C:/source/repo.git")).path, path.join(root, "local", "C", "source", "repo"));
  assert.ok("reason" in (await planClone(root, "file:///C:/a%5c..%5cb/repo.git")));
  assert.ok("reason" in (await planClone(root, "file:///src/C:/repo.git")));
  assert.ok("reason" in (await planClone(root, "https://example.com/C:/repo.git")));
});

test("a ghq.root or clone path that reaches a Project through a symlink is not chosen, even before it exists", async (t) => {
  const b = await box(t);
  const project = path.join(b.base, "project");
  await mkdir(project);
  await mkdir(path.join(b.base, "ext"));
  await symlink(project, path.join(b.base, "ext", "link"));
  const ghq = path.join(b.base, "ext", "link", "new");
  await writeFile(process.env.GIT_CONFIG_GLOBAL, `[ghq]\n\troot = ${ghq}\n`);
  await clones(path.join(b.home, "tools"), ["a", "b"]);
  const root = await resolveIn(b, [project]);
  assert.equal(root, path.join(b.home, "tools"));
  assert.deepEqual(await readdir(project), []);
  assert.ok("reason" in (await planClone(path.join(b.base, "ext", "link"), "https://example.com/alice/lib.git", [project])));
  assert.ok("path" in (await planClone(root, "https://example.com/alice/lib.git", [project])));
});

test("an encoded slash in a URL part is refused instead of becoming a separator", async () => {
  assert.ok("reason" in (await planClone(path.join(path.sep, "owl-root"), "https://example.com/a%2F..%2F..%2Fx/repo.git")));
});
