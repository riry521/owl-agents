import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAdvisorReply } from "../packages/plugin-sdk/dist/shared/index.js";

test("formatAdvisorReply appends suggested_actions as a rendered list", () => {
  const text = formatAdvisorReply(
    "返信を受け取りました。",
    [{ type: "work", description: "この変更をWorkに登録する" }],
    "ja",
  );
  assert.equal(text, "返信を受け取りました。\n\n次のアクション案:\n• work: この変更をWorkに登録する");
});

test("formatAdvisorReply renders in English when the language is en", () => {
  const text = formatAdvisorReply(
    "Got it.",
    [{ type: "work", description: "Register this change as a Work" }],
    "en",
  );
  assert.equal(text, "Got it.\n\nSuggested next actions:\n• work: Register this change as a Work");
});

test("formatAdvisorReply returns the reply unchanged when there are no suggested_actions", () => {
  assert.equal(formatAdvisorReply("plain reply", undefined, "ja"), "plain reply");
  assert.equal(formatAdvisorReply("plain reply", [], "ja"), "plain reply");
  assert.equal(formatAdvisorReply("plain reply", "not an array", "ja"), "plain reply");
});

test("formatAdvisorReply skips malformed action entries and keeps well-formed ones", () => {
  const text = formatAdvisorReply(
    "reply",
    [
      { type: "", description: "missing type is skipped" },
      { type: "work", description: "" },
      { type: "work", description: "kept" },
      "not an object",
      null,
    ],
    "ja",
  );
  assert.equal(text, "reply\n\n次のアクション案:\n• work: kept");
});
