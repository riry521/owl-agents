import assert from "node:assert/strict";
import test from "node:test";
import { parseSlackAdvisorResponse } from "../../packages/shared/dist/index.js";

function detailFor(body) {
  const seen = [];
  parseSlackAdvisorResponse("x\n```owl-actions\n" + body + "\n```\n", (reason, detail) => seen.push({ reason, detail }));
  assert.equal(seen[0].reason, "invalid_fence_json");
  return seen[0].detail;
}

test("incomplete JSON reports position and excerpt", () => {
  const d = detailFor("[");
  assert.equal(d.position, 1);
  assert.equal(d.before, '"["');
  assert.equal(d.after, '""');
});

test("invalid leading token reports position and excerpt without echoing the message fragment", () => {
  const d = detailFor("not json");
  assert.equal(d.position, 0);
  assert.equal(d.after, '"not json"');
  assert.doesNotMatch(d.error, /not json/);
  assert.match(d.error, /^SyntaxError: /);
});

test("a secret spanning the excerpt boundary is masked", () => {
  const secret = "sk-" + "A1b2C3d4E5".repeat(10);
  const d = detailFor(`[{"type":"create_work","description":"${secret}\nx"}]`);
  for (const part of [d.before, d.after, d.error]) assert.doesNotMatch(part, /sk-|A1b2C3d4/);
  assert.match(d.before + d.after, /\[redacted\]/);
});

test("quoted invalid JSON containing a token never leaks it in any field", () => {
  for (const body of ['sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', '{"a":"sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"} "x" \'y\'', '["sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA" "z"]', "'sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA'"]) {
    const d = detailFor(body);
    assert.doesNotMatch(JSON.stringify(d), /sk-AAAA/, body);
  }
});
