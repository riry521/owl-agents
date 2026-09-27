import test from "node:test";
import assert from "node:assert/strict";
import { designDocumentPath } from "../packages/shared/dist/index.js";

test("design document paths stay under the data directory and use work/task ids", () => {
  assert.equal(
    designDocumentPath("/var/lib/owl/data", "01WORK", "01TASK"),
    "/var/lib/owl/data/designs/01WORK/01TASK.md",
  );
  assert.equal(designDocumentPath("/var/lib/owl/data", "../escape", "01TASK"), "/var/lib/owl/data/designs/___escape/01TASK.md");
  assert.equal(designDocumentPath("/var/lib/owl/data", "01WORK"), "/var/lib/owl/data/designs/01WORK");
});
