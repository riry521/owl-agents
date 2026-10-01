import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GitWorktreeGateway } from "../packages/core/dist/git-gateway.js";
import { coreWorkDecisionBrief } from "../packages/core/dist/decision-brief.js";
import { buildReviewerPrompt, reviewerPromptInput } from "../packages/agent-runtime/dist/reviewer.js";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Run `body` with the user's git config replaced by the given global config text. */
async function withGlobalConfig(configText, body) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "owl-isolation-home-")));
  await writeFile(join(home, ".gitconfig"), configText);
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    await body(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function fixture({ tracked = {}, attributes = null, localConfig = [] } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "owl-isolation-")));
  const project = join(parent, "repo");
  await mkdir(project, { recursive: true });
  git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "README.md"), "base\n");
  for (const [path, contents] of Object.entries(tracked)) {
    await mkdir(join(project, path, ".."), { recursive: true });
    await writeFile(join(project, path), contents);
  }
  if (attributes !== null) await writeFile(join(project, ".gitattributes"), attributes);
  for (const [key, value] of localConfig) git(project, "config", key, value);
  git(project, "add", "--all", "--force");
  git(project, "-c", "commit.gpgsign=false", "-c", "user.name=Setup", "-c", "user.email=setup@example.invalid", "commit", "-m", "initial");
  const db = {
    get(sql) {
      if (sql.includes("SELECT project_id FROM works")) return { project_id: "project-1" };
      if (sql.includes("SELECT state, state_version FROM works")) return { state: "running", state_version: 1, title: null };
      if (sql.includes("SELECT title FROM works")) return { title: "Landed Work" };
      if (sql.includes("FROM projects")) {
        return { canonical_path: project, base_branch: "main", allowed_roots_json: JSON.stringify([parent]), verification_plan_json: "[]" };
      }
      return undefined;
    },
  };
  return { parent, project, gateway: new GitWorktreeGateway(db, join(parent, "owl")) };
}

async function integrate(gateway, files, workId = "W") {
  const task = await gateway.prepareWorktree({ work_id: workId, task_id: "T1" });
  assert.equal(task.ok, true, task.message);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(task.worktree_path, path, ".."), { recursive: true });
    await writeFile(join(task.worktree_path, path), contents);
  }
  return { task, result: await gateway.integrateTask({ work_id: workId, task_id: "T1", worktree_path: task.worktree_path }) };
}

const author = (cwd, ref) => git(cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>", ref);

test("repository hooks and the user's global git config do not affect Owl's git operations", async () => {
  await withGlobalConfig(
    "[commit]\n\tgpgsign = true\n[core]\n\thooksPath = /nonexistent/hooks\n\texcludesFile = /nonexistent/excludes\n[gpg]\n\tprogram = /nonexistent/gpg\n",
    async () => {
      const { project, gateway } = await fixture();
      const marker = join(project, "post-commit-ran");
      for (const name of ["post-commit", "pre-commit", "post-merge"]) {
        const hook = join(project, ".git", "hooks", name);
        await writeFile(hook, `#!/bin/sh\ntouch '${marker}-${name}'\n`);
        await chmod(hook, 0o755);
      }
      const { result } = await integrate(gateway, { "feature.txt": "feature\n" });
      assert.equal(result.merged, true, result.message);
      const landed = await gateway.mergeWorkIntoBase({ work_id: "W" });
      assert.equal(landed.kind, "merged", landed.message);
      for (const name of ["post-commit", "pre-commit", "post-merge"]) await assert.rejects(access(`${marker}-${name}`));
      assert.equal(author(project, "main"), "Owl Agent <owl-agent@localhost>|Owl Agent <owl-agent@localhost>");
    },
  );
});

test("the Work's landing commit is authored by the Owner's configured identity", async () => {
  await withGlobalConfig("[user]\n\tname = Owner Person\n\temail = owner@example.invalid\n", async () => {
    const { project, gateway } = await fixture();
    const { result } = await integrate(gateway, { "feature.txt": "feature\n" });
    assert.equal(result.merged, true, result.message);
    const landed = await gateway.mergeWorkIntoBase({ work_id: "W" });
    assert.equal(landed.kind, "merged", landed.message);
    assert.equal(author(project, "main"), "Owner Person <owner@example.invalid>|Owner Person <owner@example.invalid>");
  });
});

test("Owl's exclude list keeps tool output out of Task commits but not tracked files", async () => {
  await withGlobalConfig("", async () => {
    const { project, gateway } = await fixture({ tracked: { ".serena/project.yml": "name: a\n" } });
    const { result } = await integrate(gateway, {
      "feature.txt": "feature\n",
      ".code-review-graph/x.log": "log\n",
      "__pycache__/a.pyc": "bytecode\n",
      ".serena/project.yml": "name: b\n",
    });
    assert.equal(result.merged, true, result.message);
    const files = git(project, "ls-tree", "-r", "--name-only", "owl/work/W/work").split("\n");
    assert.ok(files.includes("feature.txt"));
    assert.ok(files.includes(".serena/project.yml"));
    assert.equal(files.some((file) => file.startsWith(".code-review-graph/") || file.endsWith(".pyc")), false, files.join(","));
    assert.equal(git(project, "show", "owl/work/W/work:.serena/project.yml"), "name: b");
  });
});

test("a dirty integration worktree is reported with its files, path and the way to fix it", async () => {
  await withGlobalConfig("", async () => {
    const { parent, gateway } = await fixture();
    const { result } = await integrate(gateway, { "feature.txt": "feature\n" });
    assert.equal(result.merged, true, result.message);
    const integration = join(parent, "owl", ".owl-workspaces", "W", "__work__");
    await writeFile(join(integration, "stray-output.log"), "x\n");

    const merge = await gateway.mergeWorkIntoBase({ work_id: "W" });
    assert.equal(merge.kind, "error");
    assert.deepEqual(merge.dirty_files, ["stray-output.log"]);

    const payload = {
      kind: "work_merge_failed",
      merge_kind: merge.kind,
      message: merge.message,
      merge_message: merge.message,
      dirty_files: merge.dirty_files,
      integration_worktree: merge.worktree_path,
    };
    const english = coreWorkDecisionBrief(payload, "en");
    const japanese = coreWorkDecisionBrief(payload, "ja");
    for (const brief of [english, japanese]) {
      assert.match(brief.reason, /stray-output\.log/);
      assert.ok(brief.reason.includes(integration));
      assert.ok(brief.tried.includes(".gitignore"));
    }
    assert.match(english.tried, /commit them on the Work branch|commit them/);
    assert.match(japanese.tried, /コミット/);
  });
});

test("the Reviewer input lists new files the Worker's report does not mention", () => {
  const report = { kind: "report", changes: [{ file: "src/a.ts", action: "added" }] };
  const request = {
    task: { type: "code" },
    report,
    added_files: ["src/a.ts", "notes/extra.md"],
  };
  const input = reviewerPromptInput(request);
  assert.deepEqual(input.unreported_new_files, ["notes/extra.md"]);
  assert.deepEqual(reviewerPromptInput({ ...request, added_files: [] }).unreported_new_files, []);
  assert.equal(reviewerPromptInput({ task: request.task, report }).unreported_new_files, null);
  assert.match(buildReviewerPrompt(request), /unreported_new_files/);
});

test("the user's content filters and trusted directories are carried into Owl's git config", async () => {
  await withGlobalConfig(
    "[filter \"upper\"]\n\tclean = sed -e 's/^>//'\n\tsmudge = sed -e 's/^/>/'\n\trequired = true\n[safe]\n\tdirectory = /nonexistent/trusted\n[user]\n\tname = Owner\n\temail = o@example.invalid\n",
    async () => {
      const { parent, project, gateway } = await fixture({ tracked: { "doc.txt": "hello\n" }, attributes: "*.txt filter=upper\n" });
      const { result } = await integrate(gateway, { "feature.txt": "feature\n" });
      assert.equal(result.merged, true, result.message);
      // The smudge filter ran when the integration worktree was checked out.
      assert.equal(await readFile(join(parent, "owl", ".owl-workspaces", "W", "__work__", "doc.txt"), "utf8"), ">hello\n");
      assert.equal(git(project, "status", "--porcelain"), "");
      const landed = await gateway.mergeWorkIntoBase({ work_id: "W" });
      assert.equal(landed.kind, "merged", landed.message);
    },
  );
});

test("a repository's own core.excludesFile still applies alongside Owl's list", async () => {
  await withGlobalConfig("", async () => {
    const { parent, project, gateway } = await fixture({});
    await writeFile(join(parent, "repo-excludes"), "*.generated\n");
    git(project, "config", "core.excludesFile", join(parent, "repo-excludes"));
    const { result } = await integrate(gateway, { "keep.txt": "k\n", "x.generated": "g\n", ".serena/tool.json": "{}\n" });
    assert.equal(result.merged, true, result.message);
    const files = git(project, "ls-tree", "-r", "--name-only", "owl/work/W/work").split("\n");
    assert.ok(files.includes("keep.txt"));
    assert.equal(files.includes("x.generated"), false);
    assert.equal(files.includes(".serena/tool.json"), false);
  });
});

test("dirty files are listed from NUL-separated status: renames give the destination, names keep spaces and non-ASCII", async () => {
  await withGlobalConfig("", async () => {
    const { parent, gateway } = await fixture({ tracked: { "old name.txt": "content\n" } });
    const { result } = await integrate(gateway, { "feature.txt": "feature\n" });
    assert.equal(result.merged, true, result.message);
    const integration = join(parent, "owl", ".owl-workspaces", "W", "__work__");
    git(integration, "mv", "old name.txt", "新しい 名前.txt");
    await writeFile(join(integration, "メモ 1.log"), "x\n");
    const merge = await gateway.mergeWorkIntoBase({ work_id: "W" });
    assert.equal(merge.kind, "error");
    assert.deepEqual([...merge.dirty_files].sort(), ["メモ 1.log", "新しい 名前.txt"].sort());
  });
});

test("an absolute path in the report counts as reported; design Tasks get no unreported list", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "owl-reviewer-")));
  const link = `${dir}-link`;
  await symlink(dir, link);
  const base = { task: { type: "code" }, worktree: link, added_files: ["src/a.ts", "src/b.ts"] };
  const report = { kind: "report", changes: [{ file: join(dir, "src", "a.ts"), action: "added" }, { file: "./src/b.ts", action: "added" }] };
  assert.deepEqual(reviewerPromptInput({ ...base, report }).unreported_new_files, []);
  assert.equal(reviewerPromptInput({ ...base, task: { type: "design" }, report }).unreported_new_files, null);
});
