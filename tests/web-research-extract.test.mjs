import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WEB_RESEARCH_MAX_CONTENT_CHARS,
  extractWebResearchCapture,
} from "../packages/shared/dist/web-research.js";

test("extracts WebFetch fields from the PostToolUse hook shape", () => {
  const capture = extractWebResearchCapture(
    "WebFetch",
    { url: " https://example.test/docs ", prompt: "Find the API" },
    { bytes: 120, code: 200, codeText: "OK", result: "# API guide\n\nUseful reference text.", durationMs: 4, url: "https://cdn.example.test/docs" },
  );

  assert.deepEqual(capture, {
    tool: "WebFetch",
    url: "https://example.test/docs",
    query: null,
    prompt: "Find the API",
    title: "API guide",
    content: "# API guide\n\nUseful reference text.",
    links: [],
    http_status: 200,
    is_error: false,
  });
});

test("extracts mixed WebSearch result shapes and deduplicates links", () => {
  const capture = extractWebResearchCapture("WebSearch", { query: "  owl docs " }, {
    query: "owl docs",
    results: [
      "A short result excerpt.",
      { tool_use_id: "tool-1", content: [{ title: "Docs", url: "https://docs.example.test" }, { title: "Duplicate", url: "https://docs.example.test" }] },
    ],
    durationSeconds: 0.2,
  });

  assert.equal(capture?.query, "owl docs");
  assert.equal(capture?.content, "A short result excerpt.");
  assert.deepEqual(capture?.links, [{ title: "Docs", url: "https://docs.example.test" }]);
});

test("uses stream-json result text and parses its Links block", () => {
  const fallback = extractWebResearchCapture("WebFetch", { url: "https://example.test" }, undefined, {
    contentText: "# Stream title\n\nText from tool_result",
  });
  const search = extractWebResearchCapture("WebSearch", { query: "stream result" }, undefined, {
    contentText: 'Summary text\nLinks: [{"title":"Guide","url":"https://docs.example.test/guide"}]\nMore text',
  });

  assert.equal(fallback?.title, "Stream title");
  assert.equal(fallback?.content, "# Stream title\n\nText from tool_result");
  assert.equal(search?.content, "Summary text\nMore text");
  assert.deepEqual(search?.links, [{ title: "Guide", url: "https://docs.example.test/guide" }]);
});

test("returns null for malformed or unsupported tool calls", () => {
  assert.equal(extractWebResearchCapture("Bash", {}, "result"), null);
  assert.equal(extractWebResearchCapture("WebFetch", null, "result"), null);
  assert.equal(extractWebResearchCapture("WebFetch", { url: " " }, "result"), null);
  assert.equal(extractWebResearchCapture("WebSearch", { query: " " }, "result"), null);
});

test("caps result content and marks tool errors", () => {
  const capture = extractWebResearchCapture("WebFetch", { url: "https://example.test" }, { result: "x".repeat(WEB_RESEARCH_MAX_CONTENT_CHARS + 50), is_error: true });

  assert.ok(capture.content.length > WEB_RESEARCH_MAX_CONTENT_CHARS);
  assert.ok(capture.content.startsWith("x".repeat(WEB_RESEARCH_MAX_CONTENT_CHARS)));
  assert.ok(capture.content.endsWith("\n…[truncated]"));
  assert.equal(capture.is_error, true);
});
