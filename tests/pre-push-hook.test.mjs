import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceHooks = join(root, "scripts", "git-hooks");
const exampleWord = "PRIVATE_WORD_EXAMPLE";

function run(command, args, options = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...options.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  return spawnSync(command, args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function git(cwd, ...args) {
  const result = run("git", ["-C", cwd, ...args], { cwd });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "owl-pre-push-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const owl = join(parent, "owl");
  const hookDir = join(owl, "scripts", "git-hooks");
  await mkdir(hookDir, { recursive: true });
  for (const file of ["pre-push", "install.sh"]) {
    const source = join(sourceHooks, file);
    try {
      await access(source);
      await copyFile(source, join(hookDir, file));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  try {
    await chmod(join(hookDir, "pre-push"), 0o755);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const repo = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(repo, { recursive: true });
  git(parent, "init", "--bare", remote);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  return {
    parent,
    owl,
    repo,
    remote,
    baseSha: git(repo, "rev-parse", "HEAD"),
    installPath: join(hookDir, "install.sh"),
    guardPath: join(hookDir, "pre-push"),
  };
}

function install(f, ...args) {
  return run("sh", [f.installPath, ...args, f.repo], { cwd: f.parent });
}

async function writeWordList(f, contents = `${exampleWord}\n`) {
  const path = join(f.parent, "private-words.txt");
  await writeFile(path, contents);
  return path;
}

async function addCommit(f, path, contents, message = "change") {
  const fullPath = join(f.repo, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, contents);
  git(f.repo, "add", "--", path);
  git(f.repo, "commit", "-m", message);
  return git(f.repo, "rev-parse", "HEAD");
}

function envWithList(path) {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", OWL_PRIVATE_WORDS_FILE: path };
}

function assertBlocked(result, location) {
  assert.equal(result.status, 1, result.stderr || result.error?.message);
  assert.match(result.stderr, /owl-pre-push: blocked:/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(exampleWord, "i"));
  if (location) assert.match(result.stderr, location);
}

test("a push with a matching added line is blocked without exposing the word, while a clean new branch passes", async (t) => {
  const f = await fixture(t);
  const list = await writeWordList(f, `# private entries\n  ${exampleWord}  \r\n`);
  const installed = install(f);
  assert.equal(installed.status, 0, installed.stderr);

  await addCommit(f, "src/note.txt", `contains ${exampleWord.toLowerCase()}\n`, "private change");
  const blocked = run("git", ["-C", f.repo, "push", "origin", "main"], { cwd: f.repo, env: envWithList(list) });
  assertBlocked(blocked, /private word #2 \(list line 2\) in added line at [a-f0-9]+ src\/note\.txt:1/);

  git(f.repo, "checkout", "-b", "safe", f.baseSha);
  await addCommit(f, "src/safe.txt", "ordinary text\n");
  const passed = run("git", ["-C", f.repo, "push", "origin", "safe"], { cwd: f.repo, env: envWithList(list) });
  assert.equal(passed.status, 0, passed.stderr || passed.error?.message);
});

test("a new branch push checks each commit, including a word removed by a later commit", async (t) => {
  const f = await fixture(t);
  const list = await writeWordList(f);
  assert.equal(install(f).status, 0);
  git(f.repo, "checkout", "-b", "new-branch", f.baseSha);
  await addCommit(f, "history.txt", `${exampleWord}\n`, "introduce text");
  await writeFile(join(f.repo, "history.txt"), "removed later\n");
  git(f.repo, "add", "history.txt");
  git(f.repo, "commit", "-m", "remove text");

  const blocked = run("git", ["-C", f.repo, "push", "origin", "new-branch"], { cwd: f.repo, env: envWithList(list) });
  assertBlocked(blocked, /in added line at [a-f0-9]+ history\.txt:1/);
});

test("an update checks only commits beyond the remote tip and fails closed when a pushed sha cannot be inspected", async (t) => {
  const f = await fixture(t);
  const list = await writeWordList(f);
  await addCommit(f, "already-published.txt", `${exampleWord}\n`, "published before guard");
  git(f.repo, "push", "origin", "main");
  assert.equal(install(f).status, 0);

  await addCommit(f, "new-clean.txt", "ordinary text\n");
  const update = run("git", ["-C", f.repo, "push", "origin", "main"], { cwd: f.repo, env: envWithList(list) });
  assert.equal(update.status, 0, update.stderr || update.error?.message);

  const badSha = "f".repeat(f.baseSha.length);
  const zeros = "0".repeat(f.baseSha.length);
  const badRef = `refs/heads/bad ${badSha} refs/heads/main ${zeros}\n`;
  const rejected = run("sh", [f.guardPath, "origin", f.remote], { cwd: f.repo, env: envWithList(list), input: badRef });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /owl-pre-push: blocked: could not inspect pushed ref #1/);
  assert.doesNotMatch(rejected.stderr, new RegExp(exampleWord, "i"));
});

test("new file paths and commit messages are checked, and ordinary branch deletion passes", async (t) => {
  const f = await fixture(t);
  const list = await writeWordList(f);
  assert.equal(install(f).status, 0);

  git(f.repo, "checkout", "-b", "path-check", f.baseSha);
  await addCommit(f, `src/${exampleWord}.txt`, "ordinary text\n");
  const pathBlocked = run("git", ["-C", f.repo, "push", "origin", "path-check"], { cwd: f.repo, env: envWithList(list) });
  assertBlocked(pathBlocked, /in file path at [a-f0-9]+ \(path hidden\)/);

  git(f.repo, "checkout", "-b", "message-check", f.baseSha);
  await addCommit(f, "message.txt", "ordinary text\n", `message contains ${exampleWord}`);
  const messageBlocked = run("git", ["-C", f.repo, "push", "origin", "message-check"], { cwd: f.repo, env: envWithList(list) });
  assertBlocked(messageBlocked, /in commit message at [a-f0-9]+ message line 1/);

  git(f.repo, "checkout", "-b", "disposable", f.baseSha);
  await addCommit(f, "disposable.txt", "ordinary text\n");
  const added = run("git", ["-C", f.repo, "push", "-u", "origin", "disposable"], { cwd: f.repo, env: envWithList(list) });
  assert.equal(added.status, 0, added.stderr || added.error?.message);
  const deleted = run("git", ["-C", f.repo, "push", "origin", "--delete", "disposable"], { cwd: f.repo, env: envWithList(list) });
  assert.equal(deleted.status, 0, deleted.stderr || deleted.error?.message);
  assert.throws(() => git(f.remote, "show-ref", "--verify", "refs/heads/disposable"));
});

test("a clean push with no private word list warns and proceeds", async (t) => {
  const f = await fixture(t);
  const installed = install(f);
  assert.equal(installed.status, 0, installed.stderr);
  await addCommit(f, "clean.txt", "ordinary text\n");

  const env = { ...process.env };
  delete env.OWL_PRIVATE_WORDS_FILE;
  const pushed = run("git", ["-C", f.repo, "push", "origin", "main"], { cwd: f.repo, env });
  assert.equal(pushed.status, 0, pushed.stderr || pushed.error?.message);
  assert.match(pushed.stderr, /owl-pre-push: warning: private word list not found/);

  const emptyList = join(f.parent, "empty-word-list.txt");
  await writeFile(emptyList, "# only a comment\n \t\r\n");
  await addCommit(f, "also-clean.txt", "still ordinary text\n");
  const emptyPush = run("git", ["-C", f.repo, "push", "origin", "main"], { cwd: f.repo, env: envWithList(emptyList) });
  assert.equal(emptyPush.status, 0, emptyPush.stderr || emptyPush.error?.message);
  assert.match(emptyPush.stderr, /owl-pre-push: warning: private word list is empty/);
});

test("a private word in a pushed ref is blocked even when the ref is being deleted", async (t) => {
  const f = await fixture(t);
  const list = await writeWordList(f);
  const zeros = "0".repeat(f.baseSha.length);
  const input = `refs/heads/old ${zeros} refs/heads/${exampleWord} ${f.baseSha}\n`;
  const result = run("sh", [f.guardPath, "origin", f.remote], { cwd: f.repo, env: envWithList(list), input });
  assertBlocked(result, /in remote ref at pushed ref #1/);
});

test("the installer is idempotent and preserves existing managed and unrelated hooks", async (t) => {
  const f = await fixture(t);
  const hooks = join(f.repo, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  const preCommit = join(hooks, "pre-commit");
  await writeFile(preCommit, "#!/bin/sh\nexit 0\n");
  await chmod(preCommit, 0o755);

  const first = install(f);
  assert.equal(first.status, 0, first.stderr);
  const prePush = join(hooks, "pre-push");
  const content = await readFile(prePush, "utf8");
  assert.match(content, /# owl-managed: pre-push-guard/);
  assert.notEqual((await stat(prePush)).mode & 0o111, 0);
  assert.equal(install(f).status, 0);
  assert.equal(await readFile(prePush, "utf8"), content);
  assert.equal(await readFile(preCommit, "utf8"), "#!/bin/sh\nexit 0\n");

  const other = await fixture(t);
  const otherHooks = join(other.repo, ".git", "hooks");
  const existingPrePush = join(otherHooks, "pre-push");
  const original = "#!/bin/sh\nexit 3\n";
  await writeFile(existingPrePush, original);
  await chmod(existingPrePush, 0o755);
  const existingPreCommit = join(otherHooks, "pre-commit");
  await writeFile(existingPreCommit, "#!/bin/sh\nexit 0\n");

  const refused = install(other);
  assert.equal(refused.status, 3, refused.stderr);
  assert.equal(await readFile(existingPrePush, "utf8"), original);
  assert.equal(await readFile(existingPreCommit, "utf8"), "#!/bin/sh\nexit 0\n");

  const notARepo = join(f.parent, "not-a-repository");
  await mkdir(notARepo);
  const noRepo = run("sh", [f.installPath, notARepo], { cwd: f.parent });
  assert.equal(noRepo.status, 2, noRepo.stderr);
});

test("core.hooksPath inside the worktree is refused; an external path requires and honors opt-in", async (t) => {
  const f = await fixture(t);
  const internal = join(f.repo, "checked-in-hooks");
  git(f.repo, "config", "core.hooksPath", internal);
  const internalResult = install(f);
  assert.equal(internalResult.status, 4, internalResult.stderr);
  assert.equal(git(f.repo, "config", "--get", "core.hooksPath"), internal);

  const external = join(f.parent, "shared-hooks");
  git(f.repo, "config", "core.hooksPath", external);
  const refused = install(f);
  assert.equal(refused.status, 4, refused.stderr);
  assert.equal(git(f.repo, "config", "--get", "core.hooksPath"), external);

  const accepted = install(f, "--use-hooks-path");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(git(f.repo, "config", "--get", "core.hooksPath"), external);
  assert.match(await readFile(join(external, "pre-push"), "utf8"), /# owl-managed: pre-push-guard/);
});

test("linked worktree pushes run the common pre-push hook", async (t) => {
  const f = await fixture(t);
  const list = await writeWordList(f);
  assert.equal(install(f).status, 0);
  const linked = join(f.parent, "linked-worktree");
  git(f.repo, "worktree", "add", "-b", "linked", linked, f.baseSha);
  await mkdir(linked, { recursive: true });
  await writeFile(join(linked, "linked.txt"), `${exampleWord}\n`);
  git(linked, "add", "linked.txt");
  git(linked, "commit", "-m", "linked change");

  const pushed = run("git", ["-C", linked, "push", "-u", "origin", "linked"], { cwd: linked, env: envWithList(list) });
  assertBlocked(pushed, /in added line at [a-f0-9]+ linked\.txt:1/);
});

test("an explicitly configured but unreadable word list fails closed", async (t) => {
  const f = await fixture(t);
  assert.equal(install(f).status, 0);
  await addCommit(f, "clean.txt", "ordinary text\n");
  const missing = join(f.parent, "missing-list.txt");
  const pushed = run("git", ["-C", f.repo, "push", "origin", "main"], { cwd: f.repo, env: envWithList(missing) });
  assert.equal(pushed.status, 1, pushed.stderr);
  assert.match(pushed.stderr, /owl-pre-push: blocked: OWL_PRIVATE_WORDS_FILE is set but the file cannot be read/);
  assert.doesNotMatch(pushed.stderr, /missing-list/);
});
