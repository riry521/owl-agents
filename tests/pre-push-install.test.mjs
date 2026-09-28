import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceHooks = join(root, "scripts", "git-hooks");

function run(command, args, options = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...options.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  return spawnSync(command, args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function git(cwd, ...args) {
  const result = run("git", ["-C", cwd, ...args], { cwd });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "owl-pre-push-install-"));
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
  await chmod(join(hookDir, "pre-push"), 0o755);

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
    repo,
    installPath: join(hookDir, "install.sh"),
    marker: (await readFile(join(sourceHooks, "install.sh"), "utf8")).match(/# owl-managed: [^\r\n]+/)?.[0],
  };
}

function install(f, ...args) {
  return run("sh", [f.installPath, ...args, f.repo], { cwd: f.parent });
}

test("a different pre-push containing the management marker is refused unchanged with chaining guidance", async (t) => {
  const f = await fixture(t);
  assert.ok(f.marker, "the installer management marker is present");
  const hooks = join(f.repo, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  const prePush = join(hooks, "pre-push");
  const original = `#!/bin/sh\n${f.marker}\nprintf '%s\\n' 'existing hook' >&2\n`;
  await writeFile(prePush, original);
  await chmod(prePush, 0o755);

  const result = install(f);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /chain the guard from the existing hook/);
  assert.equal(await readFile(prePush, "utf8"), original);
});

test("an identical installed pre-push succeeds on rerun without replacing the file", async (t) => {
  const f = await fixture(t);
  assert.equal(install(f).status, 0);
  const prePush = join(f.repo, ".git", "hooks", "pre-push");
  const original = await readFile(prePush, "utf8");
  const originalStat = await stat(prePush, { bigint: true });

  const result = install(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(prePush, "utf8"), original);
  const rerunStat = await stat(prePush, { bigint: true });
  assert.equal(rerunStat.ino, originalStat.ino);
  assert.equal(rerunStat.mtimeNs, originalStat.mtimeNs);
});

test("an identical non-executable pre-push is enabled and blocks a matching push", async (t) => {
  const f = await fixture(t);
  assert.equal(install(f).status, 0);
  const prePush = join(f.repo, ".git", "hooks", "pre-push");
  await chmod(prePush, 0o644);

  const result = install(f);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual((await stat(prePush)).mode & 0o111, 0, "the matching hook is executable");

  const word = "sample-only-term";
  const wordList = join(f.parent, "private-words.txt");
  await writeFile(wordList, `${word}\n`);
  await writeFile(join(f.repo, "README.md"), `base\ncontains ${word}\n`);
  git(f.repo, "add", "README.md");
  git(f.repo, "commit", "-m", "add sample content");

  const push = run("git", ["-C", f.repo, "push", "origin", "main"], {
    cwd: f.repo,
    env: { OWL_PRIVATE_WORDS_FILE: wordList },
  });
  assert.equal(push.status, 1, push.stderr);
  assert.match(push.stderr, /owl-pre-push: blocked: private word #1 \(list line 1\) in added line/);
  assert.doesNotMatch(push.stderr, new RegExp(word));
});

test("a different hook in a shared core.hooksPath is refused unchanged", async (t) => {
  const f = await fixture(t);
  const sharedHooks = join(f.parent, "shared-hooks");
  await mkdir(sharedHooks);
  git(f.repo, "config", "core.hooksPath", sharedHooks);
  const prePush = join(sharedHooks, "pre-push");
  const original = "#!/bin/sh\n# shared hook\nexit 7\n";
  await writeFile(prePush, original);
  await chmod(prePush, 0o755);

  const result = install(f, "--use-hooks-path");
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /chain the guard from the existing hook/);
  assert.equal(await readFile(prePush, "utf8"), original);
});
