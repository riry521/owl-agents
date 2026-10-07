import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAdvisorTurnReply } from "../../packages/core/dist/advisor-runtime.js";

const body = "背景：「Slack 経路」で Work が作られない。\n- 原因は\"}}]\"という末尾の崩れ！\n\n詳細は「調査メモ」を参照。";
const action = { type: "create_work", description: "Create Work", payload: { title: "Actions Work", summary: "s", size: "small", project_id: null } };
const fence = (info, json) => `${body}\n\`\`\`${info}\n${json}\n\`\`\``;
const quiet = (t) => {
  const original = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = original; });
};

for (const kind of ["slack", "web", "discord"]) {
  test(`${kind}: the body is returned unchanged and only the owl-actions fence is read as actions`, () => {
    for (const info of ["owl-actions", "owl-actions json"]) {
      const parsed = parseAdvisorTurnReply(kind, fence(info, JSON.stringify([action])), "ja");
      assert.equal(parsed.reply, body);
      assert.equal(parsed.malformed, undefined);
      assert.deepEqual(parsed.suggested_actions, [action]);
    }
  });

  test(`${kind}: a malformed or loosely named fence is not adopted and is hidden from the body`, (t) => {
    quiet(t);
    const cases = [
      fence("owl-actions", JSON.stringify([action]).replace(/\}\]$/u, "}}]")),
      fence("owl-actions", JSON.stringify([{ type: "", description: "x" }])),
      fence("owl-actions yaml", JSON.stringify([action])),
      fence("owl-actions\tjson", JSON.stringify([action])),
    ];
    for (const text of cases) {
      const parsed = parseAdvisorTurnReply(kind, text, "ja");
      assert.equal(parsed.malformed, true, text.slice(-30));
      assert.deepEqual(parsed.suggested_actions, []);
      assert.equal(parsed.reply, body);
    }
  });
}

test("leading spaces and inner blank lines of the body are kept; only the fence and its edge breaks go", () => {
  const text = `  indented start\n\n\nmiddle  \n\`\`\`owl-actions json\n${JSON.stringify([action])}\n\`\`\`\n`;
  const parsed = parseAdvisorTurnReply("web", text, "ja");
  assert.equal(parsed.reply, "  indented start\n\n\nmiddle  ");
  assert.deepEqual(parsed.suggested_actions, [action]);
});
