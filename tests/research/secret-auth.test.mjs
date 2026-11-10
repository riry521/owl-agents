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

test("each caller's secret rule set masks the same kinds of secret as before", async () => {
  const { findSecretPatterns, maskSecrets, redactWithRules, ADVISOR_REDACT_RULES, ERROR_DISPLAY_REDACT_RULES } = await import("../../packages/shared/dist/index.js");
  const key = `sk-${"a".repeat(24)}`;
  // Pages name sk-, xox[bp]-, ghp_ and AKIA, and nothing else.
  assert.deepEqual(findSecretPatterns(`${key} xoxb-1234567890 ghp_${"b".repeat(20)} AKIA${"C".repeat(16)}`), ["sk-", "xox[bp]-", "ghp_", "AKIA"]);
  assert.deepEqual(findSecretPatterns(`xapp-1234567890 gho_${"b".repeat(20)}`), []);
  assert.equal(maskSecrets(key), "[secret:sk-]");
  // Advisor output also covers xoxp, gho and underscore separators; error text does not.
  assert.equal(redactWithRules("gho_abc xoxp-abc github_pat_abc", ADVISOR_REDACT_RULES), "[redacted] [redacted] [redacted]");
  assert.equal(redactWithRules("gho_abc xoxp-abc github_pat_abc", ERROR_DISPLAY_REDACT_RULES), "gho_abc xoxp-abc github_pat_abc");
  // A quote ends the value for advisor output only.
  assert.equal(redactWithRules('api_key: abc"def', ADVISOR_REDACT_RULES), 'api_key: [redacted]"def');
  assert.equal(redactWithRules('api_key: abc"def', ERROR_DISPLAY_REDACT_RULES), "api_key: [redacted]");
  // Research text names more shapes than pages.
  assert.equal(redactResearchText("npm_abcdefghij1234 and glpat-abcdefghij").text, "[REDACTED] and [REDACTED]");
});
