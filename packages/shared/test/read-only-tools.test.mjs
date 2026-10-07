import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyAgentRole, readOnlyToolAllowed } from "../../../packages/shared/dist/index.js";

test("the librarian is read-only but may deliver its --json-schema answer through StructuredOutput", () => {
  assert.equal(isReadOnlyAgentRole("librarian"), true);
  assert.equal(readOnlyToolAllowed("StructuredOutput"), true);
  for (const tool of ["Write", "Edit", "WebFetch"]) assert.equal(readOnlyToolAllowed(tool), false, tool);
});
