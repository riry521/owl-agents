import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildProjectInvestigationPrompt, createAgentRunner, parseProjectInvestigationResponse } from "../../packages/agent-runtime/dist/index.js";
import { DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS } from "../../packages/shared/dist/project-investigation-settings.js";
import { GitProjectSourceReader, collectFacts } from "../../packages/core/dist/project-overview-note.js";
import { RuleStore } from "../../packages/core/dist/rule-store.js";
import { createTestRepo, git } from "../helpers/git.mjs";
import { tempDir } from "../helpers/temp.mjs";

const item = (text, paths = ["README.md"]) => ({ text, evidence_paths: paths });
const GOOD = {
  purpose: item("Owl は複数のエージェントを管理するシステムである。"),
  architecture_flow: item("HTTP は apps/server から core に渡る。", ["apps/server/src/http.ts"]),
  entry_points: item("入口は apps/server/src/index.ts である。", ["apps/server/src/index.ts"]),
  run_and_test: item("pnpm build と node --test で確認する。", ["package.json"]),
  cautions: [item("pnpm build を先に通すこと。", ["package.json"])],
};
const baseRequest = (repo_path) => ({
  project: { id: "p1", name: "demo", base_branch: "main", commit: null },
  repo_path,
  known_facts: { tech: [], commands: [], structure: [], cautions: [] },
  recent_works: [],
  model: "claude-opus-5",
});

function runnerWith(execute) {
  return createAgentRunner({ adapter: "claude-cli/v1", outputLogDir: null, provider: { execute } });
}
const reply = (value) => async () => ({
  adapter: "claude-cli/v1",
  stdout: JSON.stringify({ type: "result", result: typeof value === "string" ? value : JSON.stringify(value) }),
  stderr: "",
  exit_code: 0,
  signal: null,
  format: "provider-json",
});

test("the prompt carries the prohibitions and every output field", () => {
  const prompt = buildProjectInvestigationPrompt(baseRequest("/tmp/repo"));
  for (const word of ["Prohibited", ".env", "secrets.json", ".ssh/", "purpose", "architecture_flow", "entry_points", "run_and_test", "cautions", "evidence_paths"]) {
    assert.ok(prompt.includes(word), `prompt includes ${word}`);
  }
});

test("a valid structured output is returned and runs as the librarian in the repository", async (t) => {
  const repo = await tempDir(t, "owl-investigation-");
  const seen = [];
  const runner = runnerWith(async (request) => { seen.push(request); return reply(GOOD)(); });
  const result = await runner.runProjectInvestigation(baseRequest(repo));
  assert.equal(result.ok, true);
  assert.equal(result.investigation.purpose.evidence_paths[0], "README.md");
  assert.equal(seen[0].role, "librarian");
  assert.equal(seen[0].cwd, repo);
  assert.equal(seen[0].env.OWL_AGENT_ROLE, "librarian");
});

test("project investigations forward provider stdout to plan usage observation", async (t) => {
  const repo = await tempDir(t, "owl-investigation-plan-usage-");
  const observations = [];
  const event = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.82, resetsAt: 1_900_000_000 },
  });
  const runner = createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    now: () => "2026-01-01T00:00:00.000Z",
    provider: {
      execute: async (request) => {
        request.on_stdout_line?.(event);
        return reply(GOOD)();
      },
    },
  });
  runner.setPlanUsageObserver((observation) => observations.push(observation));

  const result = await runner.runProjectInvestigation(baseRequest(repo));

  assert.equal(result.ok, true);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].origin, "claude_rate_limit_event");
  assert.equal(observations[0].windows[0].used_percent, 82);
});

test("invalid output, timeout, exceptions and a bad repo path return ok:false without throwing", async (t) => {
  const repo = await tempDir(t, "owl-investigation-");
  const invalid = await runnerWith(reply({ purpose: item("x") })).runProjectInvestigation(baseRequest(repo));
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /^invalid_output:/u);

  const { AgentRuntimeError } = await import("../../packages/agent-runtime/dist/index.js");
  const timeout = await runnerWith(async () => { throw new AgentRuntimeError("provider_failed", "m", "provider_timeout"); })
    .runProjectInvestigation(baseRequest(repo));
  assert.deepEqual([timeout.ok, timeout.error], [false, "timeout"]);

  const boom = await runnerWith(async () => { throw new Error("boom"); }).runProjectInvestigation(baseRequest(repo));
  assert.deepEqual([boom.ok, boom.error], [false, "provider_failed:boom"]);

  const missing = await runnerWith(reply(GOOD)).runProjectInvestigation(baseRequest(path.join(repo, "nope")));
  assert.deepEqual([missing.ok, missing.error], [false, "repo_path_invalid"]);
});

test("git show rev:path is denied when the path is a symlink in the commit but a regular file in the working tree", async (t) => {
  const root = await tempDir(t, "owl-librarian-commit-link-");
  git(root, "init", "-q");
  await writeFile(path.join(root, "plain.txt"), "x");
  await symlink(".env", path.join(root, "alias.txt"));
  git(root, "add", "plain.txt", "alias.txt");
  git(root, "commit", "-q", "-m", "x");
  await rm(path.join(root, "alias.txt"));
  await writeFile(path.join(root, "alias.txt"), "regular now");
  const store = new RuleStore(root);
  await store.load();
  const check = (command) => store.checkGuard({ role: "librarian", toolName: "Bash", toolInput: { command }, cwd: root, home: os.homedir() }).allowed;
  const flags = "--no-ext-diff --no-textconv";
  assert.equal(check(`git show ${flags} HEAD:alias.txt`), false);
  assert.equal(check(`git show ${flags} HEAD:plain.txt`), true);
  assert.equal(check(`git show ${flags} HEAD:alias.txt -- plain.txt`), false);
  assert.equal(check(`git show ${flags} HEAD:plain.txt HEAD:alias.txt`), false);
  assert.equal(check(`git show ${flags} HEAD:plain.txt HEAD`), false);
  assert.equal(check("git show HEAD:alias.txt"), false);
});

test("the librarian guard denies writes and secret reads and allows reading", async (t) => {
  const root = await tempDir(t, "owl-librarian-guard-");
  const store = new RuleStore(root);
  await store.load();
  const check = (toolName, toolInput) => store.checkGuard({ role: "librarian", toolName, toolInput, cwd: root, home: os.homedir() });

  assert.equal(check("Read", { file_path: path.join(root, "src/index.ts") }).allowed, true);
  await writeFile(path.join(root, "a.txt"), "x");
  await writeFile(path.join(root, "README.md"), "x");
  assert.equal(check("Grep", { pattern: "foo", path: path.join(root, "a.txt") }).allowed, true);
  assert.equal(check("Bash", { command: "git log --oneline -5" }).allowed, true);

  assert.equal(check("Write", { file_path: path.join(root, "a.txt"), content: "x" }).allowed, false);
  assert.equal(check("Edit", { file_path: path.join(root, "a.txt"), old_string: "a", new_string: "b" }).allowed, false);
  assert.equal(check("NotebookEdit", { notebook_path: path.join(root, "a.ipynb"), new_source: "x" }).allowed, false);
  assert.equal(check("Read", { file_path: path.join(root, ".env") }).allowed, false);
  assert.equal(check("Read", { file_path: path.join(os.homedir(), ".ssh", "id_rsa") }).allowed, false);
  assert.equal(check("Bash", { command: "cat .env" }).allowed, false);
  assert.equal(check("Bash", { command: "echo hi > out.txt" }).allowed, false);
  assert.equal(check("Bash", { command: "rm -rf src" }).allowed, false);
  assert.equal(check("Bash", { command: "git commit -m x" }).allowed, false);
  assert.equal(check("WebFetch", { url: "https://example.com" }).allowed, false);
  for (const command of [
    "sort .env", "jq . .env", "nl .env", "cat .env", "git show HEAD:.env", "grep -R foo .", "grep -r foo", "rg foo",
    'sed -n "w out.txt" README.md', "sed -i p README.md", 'git -c core.pager="touch out.txt" log', "git show --ext-diff HEAD",
    "git log --output=out.txt", "cat .*", "cat *", "git show HEAD", "git diff", "git show --no-ext-diff --no-textconv HEAD",
    "git diff --ext-diff", "git log -p", "grep -R foo . --exclude=.envNO --exclude=secrets.jsonNO", "grep -R foo . --exclude=.env",
    "file -C", "file -m x a", "git help -w log", "git help log", "git cat-file -p HEAD", "git status -v", "git status -vv", "git status --verbose", "git remote -v", "git remote", "sort -o out.txt a.txt", "find . -delete", "tee out.txt", "xargs rm", "awk 1 README.md",
  ]) assert.equal(check("Bash", { command }).allowed, false, command);
  assert.equal(check("Grep", { pattern: "TOKEN", path: "." }).allowed, false);
  assert.equal(check("Grep", { pattern: "TOKEN" }).allowed, false);
  for (const command of [
    "git diff --no-ext-diff --no-textconv -- . :!.env :!secrets.json :!a/.env :!a/secrets.json",
    "git log ../outside", "git show --stat ../outside", "git diff ../outside", "git log /etc/passwd",
    "grep -R foo . --exclude=.env --exclude=secrets.json", "grep -rn foo src --exclude=.env --exclude=secrets.json",
    "git diff --no-ext-diff --no-textconv -- src", "git show HEAD:b/secrets.json", "cat a/b/.env.local", "cat ~/.ssh/id_rsa",
    "cat ~/.aws/credentials", "cat ~/.config/gh/hosts.yml",
  ]) assert.equal(check("Bash", { command }).allowed, false, command);
  assert.equal(check("Grep", { pattern: "x", path: "src" }).allowed, false);
  assert.equal(check("Read", { file_path: "deep/dir/secrets.json" }).allowed, false);
  assert.equal(check("Read", { file_path: ".env.local" }).allowed, false);
  assert.equal(check("Read", { file_path: "README.md" }).allowed, true);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/index.ts"), "x");
  for (const command of ["git log --oneline -20", "git log --stat -5", "git show --stat HEAD", "git ls-files", "git status --short", "git status --porcelain", "ls -la", "ls -lah", "ls src", "cat README.md", "head -n 20 README.md", "head -5 README.md", "tail -n 5 README.md", "wc -l README.md", "wc -w -c README.md", "git diff --no-ext-diff --no-textconv HEAD~1 -- src/index.ts"]) assert.equal(check("Bash", { command }).allowed, true, command);
  for (const command of ["git log -L 1,5:README.md", "git show --stat HEAD:README.md", "git log -p --full-diff --no-ext-diff --no-textconv -- README.md", "git ls-remote https://example.com/repo", "git log -pm", "git log -pc", "git log -mp", "git log -up", "git show --no-ext-diff --no-textconv HEAD:src"]) assert.equal(check("Bash", { command }).allowed, false, command);
  for (const command of ["git log --format=%H%x09%s -10"]) assert.equal(check("Bash", { command }).allowed, true, command);
  assert.equal(check("Read", { file_path: "src/index.ts" }).allowed, true);
  const gitFlags = "--no-ext-diff --no-textconv";
  for (const command of [
    "git log --remerge-diff -- README.md", "git log --diff-merges=on -p", "git log --output=/tmp/x", "git rev-parse --show-toplevel", "git version --build-options",
    `git -C src diff ${gitFlags} -- src/index.ts`, `git --work-tree=src diff ${gitFlags} -- src/index.ts`, `git -c diff.external=x diff ${gitFlags} -- src/index.ts`,
    "GIT_DIR=/tmp git log --oneline", "cat *", "cat $(echo .env)",
  ]) assert.equal(check("Bash", { command }).allowed, false, command);
  const outside = await tempDir(t, "owl-librarian-outside-");
  await mkdir(path.join(outside, "ssh"), { recursive: true });
  await writeFile(path.join(outside, "dummy.env"), "X=1");
  await writeFile(path.join(outside, "ssh", "id_rsa"), "k");
  await writeFile(path.join(root, ".env"), "X=1");
  await symlink(path.join(root, ".env"), path.join(root, "alias.txt"));
  await symlink(path.join(outside, "ssh"), path.join(root, "linkdir"));
  await symlink(path.join(outside, "dummy.env"), path.join(root, "outside.txt"));
  assert.equal(check("Read", { file_path: "alias.txt" }).allowed, false);
  assert.equal(check("Grep", { pattern: "X", path: "alias.txt" }).allowed, false);
  assert.equal(check("Read", { file_path: "outside.txt" }).allowed, false);
  for (const command of ["cat alias.txt", "git ls-files alias.txt", `git diff ${gitFlags} HEAD -- alias.txt`, "git show HEAD:alias.txt", "cat linkdir/id_rsa"]) assert.equal(check("Bash", { command }).allowed, false, command);
  for (const name of ["--no-ext-diff", "--no-textconv", "flagfree.txt"]) await writeFile(path.join(root, name), "x");
  for (const command of [
    "git diff HEAD -- --no-ext-diff --no-textconv flagfree.txt", "git show HEAD -- --no-ext-diff --no-textconv flagfree.txt",
    "grep -f alias.txt flagfree.txt", "grep --file=alias.txt flagfree.txt", "grep -if alias.txt flagfree.txt",
    "wc --files0-from=alias.txt", "git config --file alias.txt --list", "git config --file=alias.txt --list",
  ]) assert.equal(check("Bash", { command }).allowed, false, command);
  await link(path.join(root, "src/index.ts"), path.join(root, "hard.txt"));
  assert.equal(check("Read", { file_path: "hard.txt" }).allowed, false);
  assert.equal(check("Read", { file_path: "src" }).allowed, false);
  assert.equal(check("Read", { file_path: path.join(root, "src") }).allowed, false);
  assert.equal(check("Read", { path: "." }).allowed, false);
  assert.equal(check("Read", { filename: "." }).allowed, false);
  await writeFile(path.join(root, "plain.txt"), "x");
  await writeFile(path.join(root, "plain~name.txt"), "x");
  await link(path.join(root, "plain.txt"), path.join(root, "plain-hard.txt"));
  await symlink(path.join(root, "plain.txt"), path.join(root, "nlink2.txt"));
  assert.equal(check("Read", { file_path: "nlink2.txt" }).allowed, false);
  assert.equal(check("Grep", { pattern: "x", path: "nlink2.txt" }).allowed, false);
  for (const command of [
    "cat nlink2.txt", "git diff HEAD -- --stat plain.txt", "git show HEAD -- --name-only plain.txt", "git blame plain.txt",
    `git show ${gitFlags} HEAD:missing.txt`, `git log ${gitFlags} -- plain.txt`,
  ]) assert.equal(check("Bash", { command }).allowed, false, command);
  assert.equal(check("Glob", { glob_pattern: ".env" }).allowed, true);
  assert.equal(check("Glob", { pattern: ".env" }).allowed, true);
  assert.equal(check("Glob", { glob_pattern: "**/*.ts" }).allowed, true);
  for (const command of [
    "grep -eDUMMY alias.txt", "grep --regexp=DUMMY alias.txt", "egrep -eDUMMY alias.txt", "fgrep --regexp=DUMMY alias.txt", "grep foo plain.txt",
    "jq -f alias.txt plain.txt", "jq --from-file=alias.txt plain.txt", "jq . plain.txt", 'grep "$HOME" plain.txt', 'jq "$FILTER" plain.txt',
    "grep * plain.txt", "ls *", "du *", "du -sh .", "find . -name x", "sed -n 1p alias.txt", "sed -n 1,5p README.md", "cat 'a*'",
    "head -n 5 alias.txt", "wc -l alias.txt", "ls alias.txt", "cat plain.txt; cat alias.txt", "cat plain.txt | cat", "cat plain.txt > out.txt",
    "cat plain~name.txt", "cat 'plain~name.txt'", "head -n README.md plain.txt", "tail -n 5 alias.txt", "tail -5 alias.txt", "wc -l -x README.md", "ls -alx",
    "cat -n README.md", "head -c 5 README.md", "head -n 5 -- README.md", "wc --files0-from=README.md README.md", "cat", "ls --color=always", "pwd -P", "FOO=1 cat README.md",
  ]) assert.equal(check("Bash", { command }).allowed, false, command);
  for (const [index, char] of ["*", "?", "[", "]", "{", "}", "$", "`", "~", ";", "|", "&", "<", ">", "(", ")"].entries()) {
    const name = `meta${index}${char}name.txt`;
    await writeFile(path.join(root, name), "x");
    assert.equal(check("Bash", { command: `cat '${name}'` }).allowed, false, `shell metacharacter ${JSON.stringify(char)}`);
  }
  assert.equal(check("Bash", { command: "cat plain.txt\n" }).allowed, false, "newline in command");
  // Other roles are unaffected.
  assert.equal(store.checkGuard({ role: "worker", toolName: "Write", toolInput: { file_path: path.join(root, "a.txt"), content: "x" }, cwd: root, home: os.homedir() }).allowed, true);
});

test("a schema violation resumes the same session for the output only and accepts the corrected answer", async (t) => {
  const repo = await tempDir(t, "owl-investigation-");
  const calls = [];
  const withSession = (value) => async () => ({ ...(await reply(value)()), provider_session_id: "session-X" });
  const answers = [withSession({ purpose: item("x") }), withSession(GOOD)];
  const result = await runnerWith(async (request) => { calls.push(request); return answers[calls.length - 1](); }).runProjectInvestigation(baseRequest(repo));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].provider_session_id, "session-X");
});

test("an investigation with no cautions is accepted without a resubmit", async (t) => {
  const repo = await tempDir(t, "owl-investigation-");
  const calls = [];
  const result = await runnerWith(async (request) => { calls.push(request); return reply({ ...GOOD, cautions: [] })(); }).runProjectInvestigation(baseRequest(repo));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.investigation.cautions, []);
});

test("secret names and absolute paths in a text are format violations", () => {
  const stdout = (purpose) => JSON.stringify({ type: "result", result: JSON.stringify({ ...GOOD, purpose: item(purpose) }) });
  const parse = (purpose) => parseProjectInvestigationResponse({ adapter: "claude-cli/v1", stdout: stdout(purpose), format: "provider-json" });
  for (const text of ["設定ファイルはsecrets.json.", "(secrets.json) を使う", "`.env` に書く", "~/.ssh/id_rsa。", "SECRETS.JSON を置く", "鍵は.aws/credentialsにある", "鍵は ghp_abcdefghijklmnopqrstuvwxyz0123456789 である。", "/Users/me/repo を使う。"]) {
    assert.match(parse(`タスク管理を行う。${text}`).error ?? "", /forbidden pattern/u, text);
  }
  assert.ok(parse("environment 変数を使う。README.md を読む。").investigation);
});

test("a value that breaks the output settings is resubmitted, and the settings limits are read from the request", async (t) => {
  const repo = await tempDir(t, "owl-investigation-");
  const calls = [];
  const withSession = (value) => async () => ({ ...(await reply(value)()), provider_session_id: "session-Y" });
  const bad = { ...GOOD, cautions: [item("see /Users/someone/secret.txt", ["package.json"])] };
  const answers = [withSession({ ...GOOD, purpose: item("English only text.") }), withSession(bad), withSession(GOOD)];
  const result = await runnerWith(async (request) => { calls.push(request); return answers[calls.length - 1](); }).runProjectInvestigation(baseRequest(repo));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.investigation, GOOD);

  const limits = { ...DEFAULT_PROJECT_INVESTIGATION_OUTPUT_SETTINGS, max_cautions: 1 };
  const tooMany = { ...GOOD, cautions: [GOOD.cautions[0], GOOD.cautions[0]] };
  const resubmits = [];
  const strict = await runnerWith(async (request) => { resubmits.push(request); return reply(tooMany)(); }).runProjectInvestigation({ ...baseRequest(repo), output_settings: limits });
  assert.equal(strict.ok, false);
  assert.match(strict.error, /^invalid_output:cautions: must have at most 1 items/u);
  assert.match(buildProjectInvestigationPrompt({ ...baseRequest(repo), output_settings: limits }), /0 to 1 items/u);
});

test("overview facts are collected even when package.json holds JSON null", async () => {
  const files = { "package.json": "null", "README.md": "# Demo\n" };
  const reader = {
    listFiles: async () => Object.keys(files),
    readFile: async (_repo, _ref, filePath) => files[filePath] ?? null,
    changedPaths: async () => [],
  };
  const project = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "Demo", canonical_path: "/repo", base_branch: "main" };
  const facts = await collectFacts(project, reader, "main");
  assert.ok(facts.tech.includes("Node.js"));
});

test("a repository whose file list is over 1 MiB is still listed, capped at 5000 paths", async (t) => {
  const repo = await createTestRepo(t, { prefix: "owl-overview-big-" });
  const blob = git(repo, "rev-parse", "HEAD:README.md");
  // Index entries only (no working-tree files), so the large tree is cheap to build.
  const entries = Array.from({ length: 6000 }, (_, index) => `100644 ${blob}\tsrc/${"a".repeat(200)}-${index}.md\n`).join("");
  execFileSync("git", ["-C", repo, "update-index", "--add", "--index-info"], { input: entries });
  git(repo, "commit", "-q", "-m", "many files");
  const listed = await new GitProjectSourceReader().listFiles(repo, "main");
  assert.equal(listed?.length, 5000);
});
