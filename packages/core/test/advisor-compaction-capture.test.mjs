import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  readClaudeCompactionSummaries,
  readCodexCompactionSummaries,
  waitForCompactionSummary,
} from "../../agent-runtime/dist/compaction-summary.js";
import { KnowledgeBase } from "../dist/knowledge-base.js";
import { MemorySaver } from "../dist/memory-saver.js";

const EMPTY_SHA1 = "da39a3ee";
const CLAUDE_SUMMARY =
  "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request and Intent:\n   Fix the compaction capture.";
const CODEX_SUMMARY = "Another language model started to solve this problem and produced a summary of its thinking process.\n\n- Fixed the capture.";

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Shapes copied from real transcripts written by Claude Code (projects/<cwd>/<session>.jsonl).
async function writeClaudeTranscript(configDir, cwd, sessionId, summary) {
  const dir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"));
  await mkdir(dir, { recursive: true });
  const records = [
    { type: "user", message: { role: "user", content: "hello" } },
    { type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 168382 } },
    { type: "user", message: { role: "user", content: [{ type: "text", text: summary }] }, isVisibleInTranscriptOnly: true, isCompactSummary: true },
  ];
  await writeFile(join(dir, `${sessionId}.jsonl`), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

// Shapes copied from real rollouts written by Codex (sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl).
async function writeCodexRollout(codexHome, threadId, message) {
  const dir = join(codexHome, "sessions", "2026", "10", "03");
  await mkdir(dir, { recursive: true });
  const records = [
    { type: "event_msg", payload: { type: "item_completed", item: { type: "ContextCompaction", id: "x" } } },
    { type: "compacted", payload: { message, replacement_history: [{ type: "compaction", encrypted_content: "..." }] } },
  ];
  await writeFile(join(dir, `rollout-2026-10-03T05-07-14-${threadId}.jsonl`), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

async function saveCompaction(t, summary) {
  const root = await tempDir(t, "owl-compaction-capture-");
  const knowledge = new KnowledgeBase(root);
  const result = await new MemorySaver(knowledge).saveCompactionSummary("session-1", {
    conversationId: "conversation-1",
    cause: "auto",
    preTokens: null,
    summary,
    provider: "test-provider",
    model: "test-model",
    index: 1,
    transcriptPath: null,
  });
  return { knowledge, result };
}

async function savedSummary(knowledge, path) {
  const text = await readFile(join(knowledge.knowledgeDir, path), "utf8");
  return text.split(/^# .*\n\n/mu)[1].replace(/\n$/u, "");
}

test("Claude transcript summary is captured and saved verbatim", async (t) => {
  const configDir = await tempDir(t, "owl-claude-config-");
  await writeClaudeTranscript(configDir, "/work/space.x/task", "sess-1", CLAUDE_SUMMARY);
  const { summary, path } = await waitForCompactionSummary(
    () => readClaudeCompactionSummaries(configDir, "/work/space.x/task", "sess-1"), 1, 1,
  );
  assert.equal(summary, CLAUDE_SUMMARY);
  assert.match(path, /sess-1\.jsonl$/u);

  const { knowledge, result } = await saveCompaction(t, summary);
  assert.equal(result.captured, true);
  assert.ok(!result.path.includes(EMPTY_SHA1), result.path);
  assert.equal(await savedSummary(knowledge, result.path), CLAUDE_SUMMARY);
});

test("Codex rollout summary is captured and saved verbatim", async (t) => {
  const codexHome = await tempDir(t, "owl-codex-home-");
  await writeCodexRollout(codexHome, "thread-1", CODEX_SUMMARY);
  const { summary } = await waitForCompactionSummary(() => readCodexCompactionSummaries(codexHome, "thread-1"), 1, 1);
  assert.equal(summary, CODEX_SUMMARY);

  const { knowledge, result } = await saveCompaction(t, summary);
  assert.equal(result.captured, true);
  assert.ok(!result.path.includes(EMPTY_SHA1), result.path);
  assert.equal(await savedSummary(knowledge, result.path), CODEX_SUMMARY);
});

test("an empty Codex summary stays uncaptured and no file is written", async (t) => {
  const codexHome = await tempDir(t, "owl-codex-home-");
  await writeCodexRollout(codexHome, "thread-2", "");
  const { summary } = await waitForCompactionSummary(() => readCodexCompactionSummaries(codexHome, "thread-2"), 1, 1);
  assert.equal(summary, null);

  for (const empty of [summary, "", "  \n"]) {
    const { knowledge, result } = await saveCompaction(t, empty);
    assert.deepEqual(result, { path: null, captured: false });
    const files = await readdir(join(knowledge.knowledgeDir, "advisor", "sessions")).catch(() => []);
    assert.deepEqual(files, []);
  }
});

test("streamed read keeps every summary in order and skips blank, malformed and partial lines", async (t) => {
  const configDir = await tempDir(t, "owl-claude-config-");
  const dir = join(configDir, "projects", "-work-x");
  await mkdir(dir, { recursive: true });
  const summary = (text) => JSON.stringify({ type: "user", isCompactSummary: true, message: { content: text } });
  const lines = [summary("first"), "", "not json", JSON.stringify({ type: "user", message: { content: "plain" } }), summary("second"), '{"type":"user","isCompa'];
  await writeFile(join(dir, "s.jsonl"), lines.join("\n"));
  const found = await readClaudeCompactionSummaries(configDir, "/work/x", "s");
  assert.deepEqual(found.summaries, ["first", "second"]);
});

test("a missing transcript yields no summary", async (t) => {
  const configDir = await tempDir(t, "owl-claude-config-");
  const found = await waitForCompactionSummary(() => readClaudeCompactionSummaries(configDir, "/nowhere", "none"), 1, 2, 1);
  assert.deepEqual(found, { summary: null, path: null });
});

test("Claude driver delivers the compaction summary even when a protocol failure ends a running turn", async (t) => {
  const configDir = await tempDir(t, "owl-claude-config-");
  const { AdvisorSessionDriver } = await import("../../agent-runtime/dist/advisor-session-driver.js");
  const driver = Object.create(AdvisorSessionDriver.prototype);
  Object.assign(driver, {
    eventQueue: [], eventResolvers: [], heldEvents: [], pendingCompactions: 0, endRequested: false, done: false,
    exitHandled: false, childClosed: true, currentTurnId: "turn-1", turnTextParts: [], unsolicitedTextParts: [],
    transcriptLocation: { configDir, cwd: "/work/space.x/task" }, _providerSessionId: "sess-9", markUnusable() {}, stderrTail: () => "",
  });
  const iterator = driver.events()[Symbol.asyncIterator]();
  const compaction = driver.emitCompaction("auto", null, 1);
  assert.deepEqual(driver.protocolFailureEvents(), []);
  await writeClaudeTranscript(configDir, "/work/space.x/task", "sess-9", CLAUDE_SUMMARY);
  await compaction;

  const first = await iterator.next();
  assert.equal(first.value.type, "session.compacted");
  assert.equal(first.value.summary, CLAUDE_SUMMARY);
  assert.equal((await iterator.next()).value.type, "session.exited");
  assert.equal((await iterator.next()).value.type, "turn.failed");
  assert.equal((await iterator.next()).done, true);
});

test("Codex driver delivers the compaction summary even when the thread closes while it is being read", async (t) => {
  const codexHome = await tempDir(t, "owl-codex-home-");
  const { CodexSessionDriver } = await import("../../agent-runtime/dist/codex-session-driver.js");
  const driver = Object.create(CodexSessionDriver.prototype);
  Object.assign(driver, {
    eventQueue: [], eventResolvers: [], heldEvents: [], pendingRpcRequests: new Map(), localTurnIds: new Map(),
    pendingCompactions: 0, endRequested: false, done: false, sessionExitEmitted: false, exitHandled: false,
    currentTurnId: null, codexHome, _providerSessionId: "thread-3", compactionCount: 1,
  });
  const iterator = driver.events()[Symbol.asyncIterator]();
  const compaction = driver.emitCompaction(1);
  driver.handleThreadClosed(); // closes while the rollout is still being polled
  await writeCodexRollout(codexHome, "thread-3", CODEX_SUMMARY);
  await compaction;

  const first = await iterator.next();
  assert.equal(first.value.type, "session.compacted");
  assert.equal(first.value.summary, CODEX_SUMMARY);
  assert.equal((await iterator.next()).value.type, "session.exited");
  assert.equal((await iterator.next()).done, true);
});
