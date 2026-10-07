import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { sendNotification as sendDiscordNotification } from "../../packages/connector-discord/dist/index.js";
import { sendNotification as sendSlackNotification } from "../../packages/connector-slack/dist/index.js";
import { createTestCore, command } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { waitFor as waitForCondition } from "../helpers/wait.mjs";

const exampleWord = "PRIVATE_WORD_EXAMPLE";

function commandEnvelope(payload, suffix, expectedVersion = 0) {
  return command(payload, `test:${suffix}:${createUlid()}`, expectedVersion);
}

function workerReport(invocationId) {
  return {
    kind: "report",
    schema_version: "1.0.0",
    invocation_id: invocationId,
    result: "success",
    work_done: "Done.",
    changes: [],
    verification: { passed: true, method: "Checked the result." },
    remaining_issues: [],
    next_action: "none",
    needs_replanning: false,
    question_for_manager: null,
  };
}

function managerComplete(request) {
  return {
    outcome: "success",
    report_valid: true,
    report: {
      tasks: request.tasks ?? [],
      event: null,
      verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] },
    },
  };
}

function waitUntil(read) {
  return waitForCondition(read, { timeoutMs: 15_000, intervalMs: 25 });
}

async function startSmallWork(core, projectId, suffix) {
  const created = await core.createWork(commandEnvelope({
    title: `Auto push ${suffix}`,
    summary: "Write the requested output file.",
    size: "small",
    project_id: projectId,
  }, `${suffix}-create`));
  await core.startWork(created.data.work_id, commandEnvelope({ mode: "small" }, `${suffix}-start`, created.version));
  return created.data.work_id;
}

async function waitForCompletion(db, workId) {
  const state = await waitUntil(() => {
    const current = db.get("SELECT state FROM works WHERE id = ?", workId)?.state;
    return current === "completed" || current === "judgement_waiting" ? current : null;
  });
  assert.equal(state, "completed", `Work ${workId} completed: ${JSON.stringify({
    alerts: db.all("SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert'", workId),
    tasks: db.all("SELECT status, last_error_key FROM tasks WHERE work_id = ?", workId),
    decisions: db.all("SELECT status, reason FROM decisions WHERE work_id = ?", workId),
  })}`);
}

function coreEvent(row, workId) {
  return {
    kind: "event",
    event_id: row.id,
    sequence: row.sequence,
    cursor: String(row.sequence),
    type: "system.alert",
    schema_version: "1.0.0",
    payload: JSON.parse(row.payload_json),
    work_id: workId,
  };
}

test("Work auto-push uses the installed pre-push guard and notifies on rejection or missing upstream", async (t) => {
  let workerContent = "first feature\n";
  const agentRunner = {
    runManagerPlan: async (request) => request.mode === "finalize"
      ? managerComplete(request)
      : { outcome: "failed", message: `Unexpected Manager mode: ${request.mode}` },
    runWorker: async (request) => {
      await writeFile(join(request.context.worktree, "feature.mjs"), `// ${workerContent}export {};\n`);
      return { outcome: "success", report_valid: true, report: workerReport(request.invocation_id) };
    },
    runReviewer: async (request) => ({
      outcome: "success",
      report_valid: true,
      report: { kind: "review", invocation_id: request.invocation_id },
      review: { verdict: "pass", findings: [], tests: {} },
    }),
    runAdvisor: async () => ({ reply: "" }),
  };
  const { root, db, core } = await createTestCore(t, {
    agentRunner,
    dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 },
  }, { prefix: "owl-auto-push-hook-" });
  const originalWordList = process.env.OWL_PRIVATE_WORDS_FILE;
  t.after(() => {
    if (originalWordList === undefined) delete process.env.OWL_PRIVATE_WORDS_FILE;
    else process.env.OWL_PRIVATE_WORDS_FILE = originalWordList;
  });

  const canonical = join(root, "canonical");
  const remote = join(root, "remote.git");
  const wordList = join(root, "private-words.txt");
  await mkdir(canonical);
  await writeFile(wordList, `${exampleWord}\n`);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(canonical, "init", "--initial-branch=main");
  git(canonical, "config", "user.name", "Test User");
  git(canonical, "config", "user.email", "test@example.invalid");
  await writeFile(join(canonical, "README.md"), "base\n");
  git(canonical, "add", "README.md");
  git(canonical, "commit", "-m", "initial");
  git(canonical, "remote", "add", "origin", remote);
  git(canonical, "push", "--porcelain", "-u", "origin", "main");

  const install = execFileSync("sh", [join(repoRoot, "scripts/git-hooks/install.sh"), canonical], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(install, /installed pre-push guard/u);
  process.env.OWL_PRIVATE_WORDS_FILE = wordList;

  await core.start();
  const registered = await core.createProject(commandEnvelope({
    name: "Auto push hook integration",
    canonical_path: canonical,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, "project"));
  const projectId = registered.data.id;
  const setAutoPush = async (enabled) => db.createWriteLane().transact((tx) => {
    tx.run("UPDATE projects SET auto_push = ? WHERE id = ?", enabled ? 1 : 0, projectId);
    return null;
  });

  await setAutoPush(true);
  const pushedWork = await startSmallWork(core, projectId, "enabled");
  await waitForCompletion(db, pushedWork);
  const pushedEvent = await waitUntil(() => db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.pushed'", pushedWork));
  assert.ok(pushedEvent, "the enabled Project records a successful push");
  const remoteAfterPush = git(remote, "rev-parse", "refs/heads/main");
  const canonicalMerge = git(canonical, "rev-parse", "refs/heads/main");
  assert.equal(remoteAfterPush, canonicalMerge, "the bare remote points at the canonical merge commit");
  assert.equal(git(canonical, "rev-list", "--parents", "-n", "1", canonicalMerge).split(" ").length, 2,
    "the pushed base commit is the Work's single commit");

  await setAutoPush(false);
  const remoteBeforeDisabled = git(remote, "rev-parse", "refs/heads/main");
  workerContent = "disabled feature\n";
  const disabledWork = await startSmallWork(core, projectId, "disabled");
  await waitForCompletion(db, disabledWork);
  assert.ok(await waitUntil(() => db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.branches_deleted'", disabledWork)));
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), remoteBeforeDisabled,
    "the remote stays unchanged when automatic push is disabled");

  await setAutoPush(true);
  workerContent = `contains ${exampleWord}\n`;
  const blockedWork = await startSmallWork(core, projectId, "blocked-by-hook");
  await waitForCompletion(db, blockedWork);
  const blockedRow = await waitUntil(() => db.get(
    "SELECT id, sequence, payload_json FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_push_blocked_by_hook'",
    blockedWork,
  ));
  assert.ok(blockedRow, "the installed guard rejection becomes a system.alert");
  assert.equal(db.get("SELECT state FROM works WHERE id = ?", blockedWork).state, "completed");
  const blockedAlert = JSON.parse(blockedRow.payload_json);
  assert.match(blockedAlert.message, /owl-pre-push: blocked:/u);
  assert.doesNotMatch(blockedAlert.message, new RegExp(exampleWord));
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), remoteBeforeDisabled,
    "a guard rejection does not update the bare remote");

  const alertEvent = coreEvent(blockedRow, blockedWork);
  const slackPosts = [];
  await sendSlackNotification({ chat: { postMessage: async (message) => {
    slackPosts.push(message);
    return { ok: true, ts: "1700000000.001" };
  } } }, alertEvent, [{ channelId: "C-TEST" }]);
  assert.equal(slackPosts.length, 1);
  assert.ok(slackPosts[0].text.includes(blockedAlert.message.split("\n")[0]));
  const slackBody = slackPosts[0].attachments[0].blocks.map((block) => block.text?.text ?? "").join("\n");
  assert.match(slackBody, /owl-pre-push: blocked:/u);
  assert.doesNotMatch(slackBody, new RegExp(exampleWord));

  const discordSends = [];
  await sendDiscordNotification({ channels: { fetch: async () => ({
    isTextBased: () => true,
    send: async (message) => {
      discordSends.push(message);
      return { id: "M1" };
    },
  }) } }, alertEvent, "D-TEST");
  assert.equal(discordSends.length, 1);
  const embed = discordSends[0].embeds[0];
  const embedData = typeof embed.toJSON === "function" ? embed.toJSON() : embed.data;
  assert.ok(embedData.description.includes(blockedAlert.message.split("\n")[0]));
  assert.match(embedData.description, /owl-pre-push: blocked:/u);
  assert.doesNotMatch(embedData.description, new RegExp(exampleWord));

  git(canonical, "branch", "--unset-upstream");
  workerContent = "no upstream feature\n";
  const noUpstreamWork = await startSmallWork(core, projectId, "no-upstream");
  await waitForCompletion(db, noUpstreamWork);
  const skippedRow = await waitUntil(() => db.get(
    "SELECT payload_json FROM events WHERE work_id = ? AND type = 'system.alert' AND json_extract(payload_json, '$.kind') = 'work_push_skipped_no_upstream'",
    noUpstreamWork,
  ));
  assert.ok(skippedRow, "the missing upstream is reported as a system.alert");
  assert.match(JSON.parse(skippedRow.payload_json).message, /upstream|上流/u);
});
