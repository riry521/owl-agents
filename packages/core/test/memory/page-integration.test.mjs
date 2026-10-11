import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { newLinesOf } from "../../dist/memory/page-integration.js";

const text = readFileSync(new URL("./fixtures/pages/theme.md", import.meta.url), "utf8");

test("newLinesOf lists owl:new lines per section with their source label", () => {
  const withNew = text.replace("- 乱数のテスト", "- 新しい落とし穴 <!-- owl:new 2026-10-04 W820 -->\n- 乱数のテスト");
  assert.deepEqual(newLinesOf(withNew), [{ section: "落とし穴", text: "- 新しい落とし穴", work_label: "W820" }]);
  assert.deepEqual(newLinesOf(text), []);
});
