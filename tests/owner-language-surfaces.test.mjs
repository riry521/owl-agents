import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { formatProviderError, formatRuntimeError } from "../packages/agent-runtime/dist/index.js";
import { sendNotification } from "../packages/connector-slack/dist/index.js";
import { Core } from "../packages/core/dist/index.js";
import { EMPTY_ADVISOR_REPLY_NOTICE, parseAdvisorTurnReply } from "../packages/core/dist/advisor-runtime.js";
import { formatRuntimeFailure } from "../packages/core/dist/error-display.js";
import { openDatabase } from "../packages/db/dist/index.js";
import { classifyIntent, connectorText, formatIntegrationError, formatStatusResponse } from "../packages/plugin-sdk/dist/index.js";
import { workSummaryInstruction, workSummarySkeleton } from "../packages/shared/dist/index.js";
import { workSummarySkeleton as webSkeleton } from "../apps/web/lib/work-summary.mjs";

// Everything Owl itself says to the Owner (connector replies, status,
// notifications, Advisor notices, runtime failures, the Work summary
// template) follows the one language setting. "ja" output stays as it was.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JAPANESE = /[぀-ヿ一-鿿]/u;

test("connector replies and status follow the language", async () => {
  const none = classifyIntent({ text: "answer: yes" }, [], undefined, "en");
  assert.equal(none.kind, "decision_clarification");
  assert.equal(none.text, "No Decision is waiting for an answer.");
  assert.equal(classifyIntent({ text: "answer: yes" }, [], undefined, "ja").text, "回答待ちの判断はありません。");

  const pending = ["AAAAAA", "BBBBBB"].map((suffix, index) => ({
    id: `01ARZ3NDEKTSV4RRFFQ6${suffix}`,
    question: `Q${index}`,
    options: [{ key: "a", label: "A" }],
  }));
  const ambiguous = classifyIntent({ text: "answer: A" }, pending, undefined, "en");
  assert.equal(ambiguous.kind, "decision_clarification");
  assert.doesNotMatch(ambiguous.text, JAPANESE);

  const client = { language: async () => "en", request: async () => [] };
  assert.equal(await formatStatusResponse(client), "No Work is in progress right now.", "asks Core for the language");
  assert.equal(await formatStatusResponse(client, "ja"), "現在、進行中のWorkはありません。");

  const en = connectorText("en");
  for (const text of [en.answeredWith("Approve"), en.answerAccepted("ABC123"), en.decisionGone, en.workSuffix("abc"), en.nextActions]) {
    assert.doesNotMatch(text, JAPANESE, text);
  }
  assert.doesNotMatch(formatIntegrationError("Slack", new Error("401 unauthorized"), "en"), JAPANESE);
});

test("Slack notifications are written in the language they are given", async () => {
  const posts = [];
  const client = { chat: { postMessage: async (message) => posts.push(message) } };
  const event = (type, payload) => ({ kind: "event", event_id: `event-${type}`, sequence: 1, cursor: "1", type, schema_version: "1.0.0", payload });

  await sendNotification(client, event("work.completed", { title: "Archive" }), [{ channelId: "C" }], { language: "en" });
  await sendNotification(client, event("system.alert", { message: "Core stopped.", remediation: "Resume it." }), [{ channelId: "C" }], { language: "en" });
  assert.equal(posts.length, 2);
  for (const post of posts) assert.doesNotMatch(post.text, JAPANESE, post.text);

  posts.length = 0;
  await sendNotification(client, event("work.completed", { title: "Archive" }), [{ channelId: "C" }]);
  assert.equal(posts[0].text, "完了しました: Archive", "without a language the old Japanese text is kept");
});

test("runtime and Provider failures are explained in the language", () => {
  const cases = [new Error("HTTP 401 unauthorized"), new Error("429 rate limit"), new Error("ECONNRESET"), new Error("something odd"), ""];
  for (const error of cases) {
    assert.doesNotMatch(formatRuntimeFailure(error, "Worker", "en"), JAPANESE, String(error));
    assert.match(formatRuntimeFailure(error, "Worker"), JAPANESE, "the default stays Japanese");
  }
  assert.doesNotMatch(formatProviderError("claude", new Error("503 service unavailable"), {}, "en"), JAPANESE);
  assert.match(formatProviderError("claude", new Error("exit"), { exitCode: 2 }, "en"), /exit code 2/u);
  assert.equal(formatRuntimeError(null, undefined, "en"), "The agent failed. Check the settings and logs.");
  assert.equal(formatRuntimeError(null), "Agent処理に失敗しました。設定とログを確認してください。");
});

test("runtime failure classification reads HTTP status codes only as whole numbers", () => {
  const conflict = new Error("Task 01M3FA5381RE3K7297QJPDEH3BのWorktree準備に失敗しました。原因: Task worktree conflicts with the Work branch");
  assert.match(formatRuntimeFailure(conflict, "Workflow", "en"), /Cause: .*conflicts with the Work branch/u);
  assert.match(formatRuntimeFailure(new Error("HTTP 503 from upstream"), "Worker", "en"), /failed on its side/u);
  assert.match(formatRuntimeFailure(new Error("status 429"), "Worker", "en"), /rate limit/u);
});

test("the Work summary template uses the labels of the language", () => {
  assert.equal(workSummarySkeleton("en"), webSkeleton("en"));
  assert.equal(workSummarySkeleton(), webSkeleton("ja"));
  const english = workSummaryInstruction("en");
  assert.ok(english.includes('"Request:"') && english.includes('"Acceptance:"'), english);
  assert.doesNotMatch(english, JAPANESE);
  assert.ok(workSummaryInstruction().includes('"依頼:"'));
});

test("the Advisor is told to reply in the language, and Owl's Advisor notices follow it", async (t) => {
  assert.equal(parseAdvisorTurnReply("web", "  ").reply, EMPTY_ADVISOR_REPLY_NOTICE);
  assert.doesNotMatch(parseAdvisorTurnReply("web", "  ", "en").reply, JAPANESE);

  const root = await mkdtemp(join(tmpdir(), "owl-language-surfaces-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const core = new Core({
    db,
    agentRunner: { runManagerPlan: async () => ({ outcome: "failed" }), runWorker: async () => ({ outcome: "failed" }), runReviewer: async () => ({ outcome: "failed" }), runAdvisor: async () => ({ reply: "" }) },
    version: "test",
    owlRoot: root,
    dispatcher: { tick_interval_ms: 25 },
  });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
  });
  await core.start();

  const japanese = core.buildAdvisorSystemPrompt();
  assert.match(japanese, /reply to the operator in Japanese/u);
  assert.ok(japanese.includes('"依頼:"'));

  await core.setLanguage("en");
  const english = core.buildAdvisorSystemPrompt();
  assert.match(english, /reply to the operator in English and write every Work title and summary in English/u);
  assert.ok(english.includes('"Request:"') && english.includes("Request: Correct the requested label."));
  assert.doesNotMatch(english, /依頼|受け入れ条件/u);

  const { notices } = await core.dispatchAdvisorWorkActions("missing-conversation", "turn-1", [{ type: "create_work", payload: { title: "" } }]);
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0], JAPANESE, notices[0]);
});
