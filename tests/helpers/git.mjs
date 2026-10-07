import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { tempDir } from "./temp.mjs";

/**
 * Run git in cwd with a fixed test identity and return trimmed stdout.
 * @param {string} cwd
 * @param {...string} args
 * @returns {string}
 */
export function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Owl Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Create a temp git repo on branch main with one commit ("initial").
 * @param {import("node:test").TestContext} t
 * @param {{ prefix?: string, files?: Record<string, string> }} [options]
 * @returns {Promise<string>} repository path
 */
export async function createTestRepo(t, { prefix = "owl-repo-", files = { "README.md": "# test\n" } } = {}) {
  const repo = await tempDir(t, prefix);
  git(repo, "init", "--initial-branch=main");
  for (const [name, content] of Object.entries(files)) {
    const path = join(repo, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  return repo;
}
