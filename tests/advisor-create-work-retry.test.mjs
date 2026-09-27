import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createCore } from "../packages/core/dist/index.js";
import { openDatabase, createUlid } from "../packages/db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function createWorkAction(title) {
  return {
    type: "create_work",
    description: `Create ${title}`,
    payload: {
      title,
      summary: `Create and verify ${title}.`,
      size: "small",
      project_id: null,
    },
  };
}

test("a retried Advisor turn recovers an already-created Work instead of failing on a payload mismatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-create-work-retry-"));
  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(join(repoRoot, "packages/db/migrations"));

  const agentRunner = {
    runManagerPlan: async () => { throw new Error("small Advisor-created Works should skip Manager planning"); },
    runWorker: async () => ({
      outcome: "failed",
      failure_class: "deterministic",
      error_key: "advisor_create_work_retry_test",
      retry_allowed: false,
      message: "Test stops after verifying the Work was dispatched.",
    }),
    runReviewer: async () => { throw new Error("Reviewer should not run in this regression test."); },
    runAdvisor: async () => { throw new Error("This regression test drives persistAdvisorReply directly."); },
  };

  const core = createCore({ db, agentRunner, version: "advisor-create-work-retry-test", owlRoot: root, dataDir: root });
  t.after(() => db.close());

  const conversation = await core.getActiveConversation();
  const conversationId = conversation.conversation_id;
  const turnId = createUlid();
  const firstTitle = "First-attempt regression Work";
  const secondTitle = "Second-attempt regression Work";

  // Simulate the first attempt's startWork failing after createWork already
  // succeeded, leaving the Work created but not started.
  const realStartWork = core.startWork.bind(core);
  let startWorkCalls = 0;
  core.startWork = async (...args) => {
    startWorkCalls += 1;
    if (startWorkCalls === 1) throw new Error("Simulated startWork failure on the first attempt.");
    return realStartWork(...args);
  };

  const firstMessageId = await core.persistAdvisorReply(
    conversationId,
    "",
    turnId,
    { channel: "web" },
    [createWorkAction(firstTitle)],
  );
  assert.ok(firstMessageId, "the first attempt should still persist a reply message");

  const firstWork = db.get("SELECT id, title, state, state_version FROM works WHERE title = ?", firstTitle);
  assert.ok(firstWork, "createWork should have run before the simulated startWork failure");
  assert.equal(firstWork.state, "memo", "the Work should still be unstarted after startWork failed");

  const firstBody = db.get(
    "SELECT body FROM messages WHERE id = ?",
    firstMessageId,
  ).body;
  assert.match(firstBody, /開始できませんでした/u, "the first attempt should report that the Work could not be started");

  // A turn retry re-runs the same turn (same turnId, same action index) but
  // the AI produced a different title this time.
  const secondMessageId = await core.persistAdvisorReply(
    conversationId,
    "",
    turnId,
    { channel: "web" },
    [createWorkAction(secondTitle)],
  );
  assert.ok(secondMessageId);
  const secondBody = db.get("SELECT body FROM messages WHERE id = ?", secondMessageId).body;

  assert.doesNotMatch(secondBody, /起票に失敗しました/u, "the retry must not report a fresh creation failure for a Work that already exists");
  assert.match(secondBody, /前回の試行で起票済みだったため、開始しました/u, "the retry should report that the earlier Work was recovered and started");

  assert.equal(
    db.get("SELECT COUNT(*) AS count FROM works WHERE title = ?", firstTitle).count,
    1,
    "only the Work from the first attempt should exist",
  );
  assert.equal(
    db.get("SELECT COUNT(*) AS count FROM works WHERE title = ?", secondTitle).count,
    0,
    "the retry's different title must not create a second Work",
  );

  const recoveredWork = db.get("SELECT id, state FROM works WHERE title = ?", firstTitle);
  assert.equal(recoveredWork.id, firstWork.id);
  assert.notEqual(recoveredWork.state, "memo", "the recovered Work should have been started on the retry");

  await rm(root, { recursive: true, force: true });
});
