import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMemoryNote } from "../../dist/memory/memory-note-reader.js";

test("a project-scoped page is indexed under its project_id so a project search can find it", () => {
  const id = "01HZZZZZZZZZZZZZZZZZZZZZZP";
  const text = `---\ntype: theme\ntitle: テーマ\nscope: project\nproject_id: ${id}\n---\n# テーマ\n`;
  const { row } = parseMemoryNote("projects/demo/テーマ.md", text, { mtimeMs: 0 });
  assert.equal(row.scope, "project");
  assert.deepEqual(row.project_ids, [id]);
});
