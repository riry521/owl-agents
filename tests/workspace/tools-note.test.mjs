import test from "node:test";
import assert from "node:assert/strict";
import { renderWorkspaceToolsNote } from "../../packages/shared/dist/index.js";

test("renderWorkspaceToolsNote names the worktree and covers tool preference and stale-index guidance", () => {
  const lines = renderWorkspaceToolsNote("/Users/owner/owl-wt-feature");
  assert.ok(lines);
  assert.match(lines[0], /git worktree \/Users\/owner\/owl-wt-feature/);
  assert.match(lines[0], /MCP servers and project skills/);
  assert.match(lines[1], /semantic search, reference search and impact-analysis tools/);
  assert.match(lines[2], /missing or stale/);
  assert.match(lines[2], /Never treat empty results from an unbuilt index/);
});

test("renderWorkspaceToolsNote returns null without a usable absolute path", () => {
  assert.equal(renderWorkspaceToolsNote(null), null);
  assert.equal(renderWorkspaceToolsNote(undefined), null);
  assert.equal(renderWorkspaceToolsNote(""), null);
  assert.equal(renderWorkspaceToolsNote("   "), null);
  assert.equal(renderWorkspaceToolsNote("relative/path"), null);
});
