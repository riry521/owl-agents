import assert from "node:assert/strict";
import { test } from "node:test";

import { AdvisorSessionRuntime } from "../packages/core/dist/index.js";

test("Advisor runtime forwards research with conversation context and ignores recorder errors", async () => {
  const capture = {
    tool: "WebFetch",
    url: "https://example.com/page",
    query: null,
    prompt: null,
    title: "Page",
    content: "# Page\nBody",
    links: [],
    http_status: 200,
    is_error: false,
  };
  const received = [];
  let turnCompleted = false;
  const config = {
    db: {
      createWriteLane: () => ({ write: async () => undefined }),
      get: () => undefined,
    },
    sessionManager: { recordActivity: async () => undefined },
    memorySaver: {},
    providerClient: {},
    owlRoot: "/owl",
    getAdvisorSettings: () => ({ providerId: "anthropic", harnessId: "claude", model: "test", systemPrompt: "test" }),
    resolveAttachmentPaths: () => ({ paths: [], notes: [] }),
    onWebResearch: (seenCapture, context) => {
      received.push([seenCapture, context]);
      throw new Error("recorder unavailable");
    },
    onReply: async () => null,
    onError: async () => undefined,
  };
  const runtime = new AdvisorSessionRuntime(config);
  runtime.includeWorkspaceNotice = async (_conversationId, _sessionId, reply) => reply;
  runtime.recordUsageIfPresent = async () => null;
  runtime.markTurnCompleted = async () => { turnCompleted = true; };
  const turn = {
    id: "turn-1",
    session_id: "session-1",
    conversation_id: "conversation-from-turn",
    user_message_id: "message-1",
    reply_message_id: null,
    status: "running",
    origin_channel: "web",
    origin_channel_id: null,
    origin_ref: null,
    retry_count: 0,
    usage_json: null,
    error: null,
    queued_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
  };
  const driver = {
    events: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "tool.web_research", turn_id: "provider-turn-id", capture };
        yield { type: "turn.completed", turn_id: "turn-1", reply: "Done.", usage: null };
      },
    }),
  };

  await runtime.consumeUntilTurnSettles("session-1", turn, driver);

  assert.deepEqual(received, [[capture, { conversation_id: "conversation-from-turn", turn_id: "provider-turn-id" }]]);
  assert.equal(turnCompleted, true);
});
