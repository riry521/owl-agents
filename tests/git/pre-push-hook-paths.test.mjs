import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";


const exampleWord = "PRIVATE_WORD_EXAMPLE";

function run(command, args, cwd, env = process.env) {
  const cleanEnv = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete cleanEnv[key];
  return spawnSync(command, args, { cwd, env: cleanEnv, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

const git = (cwd, ...args) => { // helpers-exempt: hermetic git (no global config, GIT_* cleared) for hook tests
  const result = run("git", ["-C", cwd, ...args], cwd);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
};

async function addCommit(repo, path, contents, message) {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), contents);
  git(repo, "add", "--", path);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

test("matching added lines redact existing and new private-word paths", async (t) => {
  const parent = await tempDir(t, "owl-pre-push-paths-");

  const hookSource = join(repoRoot, "scripts", "git-hooks");
  const owlHookDir = join(parent, "owl", "scripts", "git-hooks");
  await mkdir(owlHookDir, { recursive: true });
  for (const file of ["pre-push", "install.sh"]) await copyFile(join(hookSource, file), join(owlHookDir, file));
  await chmod(join(owlHookDir, "pre-push"), 0o755);

  const repo = join(parent, "repo");
  const remote = join(parent, "remote.git");
  await mkdir(repo);
  git(parent, "init", "--bare", remote);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.invalid");
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");

  const existingPath = `notes/${exampleWord}.txt`;
  const tabPath = `notes/${exampleWord}\twith-tab.txt`;
  await addCommit(repo, existingPath, "safe baseline\n", "add private-named file");
  await addCommit(repo, tabPath, "safe baseline\n", "add tab-named file");
  const publishedSha = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "origin", "main");

  const install = run("sh", [join(owlHookDir, "install.sh"), repo], parent);
  assert.equal(install.status, 0, install.stderr);
  const list = join(parent, "private-words.txt");
  await writeFile(list, `${exampleWord}\n`);
  const guardedEnv = { ...process.env, OWL_PRIVATE_WORDS_FILE: list };

  await writeFile(join(repo, existingPath), `safe baseline\ncontains ${exampleWord}\n`);
  git(repo, "add", "--", existingPath);
  git(repo, "commit", "-m", "update private-named file");
  const existingResult = run("git", ["-C", repo, "push", "origin", "main"], repo, guardedEnv);
  assert.equal(existingResult.status, 1, existingResult.stderr);
  assert.match(existingResult.stderr, /owl-pre-push: blocked: private word #1 \(list line 1\) in added line/);
  assert.match(existingResult.stderr, /\(path hidden\):2/);
  assert.doesNotMatch(existingResult.stderr, new RegExp(exampleWord));

  git(repo, "checkout", "-b", "new-file", publishedSha);
  await addCommit(repo, `notes/${exampleWord}-new.txt`, `contains ${exampleWord}\n`, "add private-named file");
  const newFileResult = run("git", ["-C", repo, "push", "origin", "new-file"], repo, guardedEnv);
  assert.equal(newFileResult.status, 1, newFileResult.stderr);
  assert.match(newFileResult.stderr, /in file path at [a-f0-9]+ \(path hidden\)/);
  assert.match(newFileResult.stderr, /in added line at [a-f0-9]+ \(path hidden\):1/);
  assert.doesNotMatch(newFileResult.stderr, new RegExp(exampleWord));

  git(repo, "checkout", "-b", "tab-path", publishedSha);
  await writeFile(join(repo, tabPath), `safe baseline\ncontains ${exampleWord}\n`);
  git(repo, "add", "--", tabPath);
  git(repo, "commit", "-m", "update tab-named file");
  const tabResult = run("git", ["-C", repo, "push", "origin", "tab-path"], repo, guardedEnv);
  assert.equal(tabResult.status, 1, tabResult.stderr);
  assert.match(tabResult.stderr, /in added line at [a-f0-9]+ \(path hidden\):2/);
  assert.doesNotMatch(tabResult.stderr, new RegExp(exampleWord));

  git(repo, "checkout", "-b", "newline-path", publishedSha);
  const newlinePath = `notes/${exampleWord}\nwith-newline.txt`;
  await addCommit(repo, newlinePath, `contains ${exampleWord}\n`, "add newline-named file");
  const newlineResult = run("git", ["-C", repo, "push", "origin", "newline-path"], repo, guardedEnv);
  assert.equal(newlineResult.status, 1, newlineResult.stderr);
  assert.match(newlineResult.stderr, /in added line at [a-f0-9]+ \(path hidden\):1/);
  assert.doesNotMatch(newlineResult.stderr, new RegExp(exampleWord));
});
