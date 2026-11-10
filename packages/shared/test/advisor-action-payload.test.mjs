import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdvisorResponse } from "../dist/index.js";

function reply(actions) {
  return ["Issuing it.", "```owl-actions", JSON.stringify(actions), "```"].join("\n");
}

test("create_work keys written beside payload are moved into payload", () => {
  const parsed = parseAdvisorResponse(reply([{
    type: "create_work",
    description: "d",
    payload: { title: "T", summary: "S" },
    size: "normal",
    project_id: "P1",
  }]));
  assert.deepEqual(parsed.suggested_actions[0].payload, { title: "T", summary: "S", size: "normal", project_id: "P1" });
});

test("a key already inside payload is kept over the one beside it", () => {
  const parsed = parseAdvisorResponse(reply([{
    type: "create_work",
    description: "d",
    payload: { title: "T", summary: "S", size: "small", project_id: null },
    size: "large",
    project_id: "P2",
  }]));
  assert.deepEqual(parsed.suggested_actions[0].payload, { title: "T", summary: "S", size: "small", project_id: null });
});

test("create_work with every key beside payload gets a payload", () => {
  const parsed = parseAdvisorResponse(reply([{ type: "create_work", description: "d", title: "T", summary: "S", size: "small" }]));
  assert.deepEqual(parsed.suggested_actions[0].payload, { title: "T", summary: "S", size: "small" });
});

test("other action types keep their payload as written", () => {
  const parsed = parseAdvisorResponse(reply([{ type: "pause_work", description: "d", payload: { work_id: "W" }, reason: "r" }]));
  assert.deepEqual(parsed.suggested_actions[0].payload, { work_id: "W" });
});
