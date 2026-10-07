import assert from "node:assert/strict";
import { test } from "node:test";

import { redactResearchText } from "../../packages/core/dist/research-filter.js";

test("redacts short credential values with or without quotes and Bearer", () => {
  const result = redactResearchText('token: abc password=1234 "secret": "x" Authorization: Bearer y');
  assert.equal(result.text, "token: [REDACTED] password=[REDACTED] \"secret\": [REDACTED] Authorization: [REDACTED]");
  assert.equal(result.redactions, 4);
  assert.equal(result.redacted_chars, 3 + 4 + 1 + 1);
});

test("does not redact ordinary uses of credential key words without a separator", () => {
  const text = "The token field is optional; the password guidance explains safe storage.";
  assert.deepEqual(redactResearchText(text), { text, redactions: 0, redacted_chars: 0 });
});
