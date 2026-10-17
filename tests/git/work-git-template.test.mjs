import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { clearWorkGitTemplates, prepareWorkGitTemplate, removeWorkGitTemplate } from "../../packages/core/dist/work-git-template.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { waitFor } from "../helpers/wait.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("Work Git templates mark new init and clone repositories, preserve user templates, and leave re-init alone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-work-git-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userTemplate = join(root, "user-template");
  await mkdir(join(userTemplate, "hooks"), { recursive: true });
  await writeFile(join(userTemplate, "hooks", "pre-commit.sample"), "user hook\n");
  const originalConfig = join(userTemplate, "owner-config");
  const originalConfigText = "[user]\n\tname = Owner Template\n";
  await writeFile(originalConfig, originalConfigText);
  await symlink(originalConfig, join(userTemplate, "config"));
  const dataDir = join(root, "data");
  const templateDir = await prepareWorkGitTemplate({
    userTemplateDir: async () => userTemplate,
    setTemplateConfig: async (file, key, value) => git(root, "config", "--file", file, key, value),
  }, { dataDir, agentRunId: "run-one", workId: "work-one" });
  assert.equal((await stat(templateDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(templateDir, "config"))).isSymbolicLink(), false);
  assert.equal(await readFile(originalConfig, "utf8"), originalConfigText);

  const initialized = join(root, "initialized");
  await mkdir(initialized);
  git(initialized, "init", "--template", templateDir);
  assert.equal(git(initialized, "config", "--local", "--get", "owl.createdByWork"), "work-one");
  assert.equal(git(initialized, "config", "--local", "--get", "user.name"), "Owner Template");
  assert.equal(await readFile(join(initialized, ".git", "hooks", "pre-commit.sample"), "utf8"), "user hook\n");

  const source = join(root, "source");
  await mkdir(source);
  git(source, "init", "--initial-branch=main");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "source");
  const clone = join(root, "clone");
  execFileSync("git", ["clone", "--template", templateDir, source, clone], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(git(clone, "config", "--local", "--get", "owl.createdByWork"), "work-one");

  const preexisting = join(root, "preexisting");
  await mkdir(preexisting);
  git(preexisting, "init");
  git(preexisting, "init", "--template", templateDir);
  assert.throws(() => git(preexisting, "config", "--local", "--get", "owl.createdByWork"));

  git(initialized, "config", "--local", "owl.createdByWork", "owner-value");
  git(initialized, "init", "--template", templateDir);
  assert.equal(git(initialized, "config", "--local", "--get", "owl.createdByWork"), "owner-value");
  await removeWorkGitTemplate(templateDir);
  assert.equal(await clearWorkGitTemplates(dataDir), 0);
});

test("clearing Work Git templates removes leftovers under the data directory", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "owl-work-git-template-cleanup-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const stale = join(dataDir, "git-templates", "stale-run");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "config"), "stale\n");
  assert.equal(await clearWorkGitTemplates(dataDir), 1);
  assert.equal(await clearWorkGitTemplates(dataDir), 0);
});

test("a Project-less Worker receives a temporary template and startup clears stale templates", async (t) => {
  const requests = [];
  const templateConfigs = [];
  const agentRunner = {
    runManagerPlan: async () => ({ outcome: "failed", message: "unexpected" }),
    runWorker: async (value) => {
      requests.push(value);
      if (value.git_template_dir) templateConfigs.push(await readFile(join(value.git_template_dir, "config"), "utf8"));
      return { outcome: "failed", message: "stop after checking the request" };
    },
    runReviewer: async () => ({ outcome: "failed" }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { root, core } = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-work-template-core-" });
  const dataDir = join(root, "data");
  const stale = join(dataDir, "git-templates", "interrupted-run");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "config"), "stale\n");
  await core.start();
  assert.equal(await readFile(join(stale, "config"), "utf8").catch(() => null), null);

  const created = await core.createWork(command({ title: "Template", summary: "x", size: "small", project_id: null }, "template-work"));
  await core.startWork(created.data.work_id, command({ mode: "small" }, "template-start", created.version));
  await waitFor(() => templateConfigs.length > 0 ? true : null, { timeoutMs: 15_000, intervalMs: 25, message: "Worker request with its template config read" });
  const firstRequest = requests[0];
  assert.ok(firstRequest.git_template_dir);
  assert.match(templateConfigs[0], new RegExp(created.data.work_id));
  await core.workflowEngine().drainPipelines();
  assert.equal(await readFile(join(firstRequest.git_template_dir, "config"), "utf8").catch(() => null), null);

  core.gitGateway().setTemplateConfig = async () => { throw new Error("template setup failed"); };
  const second = await core.createWork(command({ title: "Template failure", summary: "x", size: "small", project_id: null }, "template-failure-work"));
  await core.startWork(second.data.work_id, command({ mode: "small" }, "template-failure-start", second.version));
  await waitFor(() => requests.some((value) => value.work_id === second.data.work_id) ? true : null, { timeoutMs: 15_000, intervalMs: 25, message: "Worker request after template preparation failure" });
  const secondRequest = requests.find((value) => value.work_id === second.data.work_id);
  assert.equal(secondRequest.git_template_dir, undefined);
  await core.workflowEngine().drainPipelines();
});
