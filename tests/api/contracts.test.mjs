import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { validateContractArtifacts } from "../../apps/server/dist/contracts.js";
import { repoRoot } from "../helpers/paths.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const openapi = readFileSync(join(repoRoot, "contracts/openapi/owl-api-v1.yaml"), "utf8");

/** Return the indented YAML block that starts at `header` (exclusive of following siblings). */
function yamlBlock(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === header);
  assert.notEqual(start, -1, `missing OpenAPI block ${header.trim()}`);
  const indent = header.length - header.trimStart().length;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length > 0 && line.length - line.trimStart().length <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

test("contract manifest stores no digests and loading computes them from each artifact", async () => {
  const raw = readJson("contracts/contract-manifest-v1.json");
  for (const entry of raw.artifacts) assert.equal("sha256" in entry, false, entry.path);
  const manifest = await validateContractArtifacts(repoRoot);
  for (const artifact of manifest.artifacts) {
    const text = readFileSync(join(repoRoot, artifact.path), "utf8");
    assert.equal(artifact.sha256, createHash("sha256").update(text, "utf8").digest("hex"), artifact.path);
  }
  assert.ok(manifest.artifacts.some((artifact) => artifact.path === "contracts/jsonschema/owl-v1/decision.json"));
  assert.ok(manifest.artifacts.some((artifact) => artifact.path === "contracts/jsonschema/owl-v1/websocket-server-frame.json"));
  for (const path of [
    "contracts/jsonschema/owl-v1/work-design.json",
    "contracts/jsonschema/owl-v1/work-design-list.json",
    "contracts/jsonschema/owl-v1/work-design-summary.json",
  ]) assert.ok(manifest.artifacts.some((artifact) => artifact.path === path));
});

test("design document schemas keep their response fields strict", () => {
  const list = readJson("contracts/jsonschema/owl-v1/work-design-list.json");
  const summary = readJson("contracts/jsonschema/owl-v1/work-design-summary.json");
  const detail = readJson("contracts/jsonschema/owl-v1/work-design.json");
  assert.deepEqual(list.required, ["designs"]);
  assert.equal(list.additionalProperties, false);
  assert.deepEqual(summary.required, ["task_id", "title", "updated_at", "size_bytes"]);
  assert.equal(summary.additionalProperties, false);
  assert.deepEqual(detail.required, ["task_id", "title", "markdown", "updated_at"]);
  assert.equal(detail.additionalProperties, false);
});

test("Decision contracts allow the allow_free_text field the server returns", () => {
  const schema = readJson("contracts/jsonschema/owl-v1/decision.json");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.allow_free_text, { type: "boolean" });
  assert.ok(schema.required.includes("allow_free_text"));
  const decision = yamlBlock(openapi, "    Decision:");
  assert.match(decision, /\n        - allow_free_text\n/u);
  assert.match(decision, /\n        allow_free_text:\n          type: boolean\n/u);
  for (const field of ["question", "current_state", "tried"]) {
    assert.deepEqual(schema.properties[field], { type: "string" }, field);
    assert.ok(schema.required.includes(field), field);
  }
  // A real server Decision must now have only documented keys.
  const serverDecision = {
    id: "01J00000000000000000000000", work_id: "01J00000000000000000000001", scope: "task", status: "open",
    reason: "r", question: "q", current_state: "s", tried: "t",
    options: [], recommended: null, allow_free_text: true, blocked_task_ids: [], state_version: 1,
  };
  assert.deepEqual(Object.keys(serverDecision).filter((key) => !(key in schema.properties)), []);
});

test("WebSocket event frames document work/task/agent ids and created_at", () => {
  const schema = readJson("contracts/jsonschema/owl-v1/websocket-server-frame.json");
  const eventFrame = schema.oneOf.find((variant) => variant.properties?.kind?.const === "event");
  assert.ok(eventFrame);
  assert.equal(eventFrame.additionalProperties, false);
  for (const key of ["work_id", "task_id", "agent_run_id"]) {
    assert.deepEqual(eventFrame.properties[key], { anyOf: [{ $ref: "common.json#/$defs/ULID" }, { type: "null" }] }, key);
  }
  assert.ok(eventFrame.properties.created_at);
  // A canonical frame as produced by packages/core validates against the documented key set.
  const canonical = {
    kind: "event", event_id: "01J00000000000000000000000", sequence: 1, cursor: "1", type: "system.alert",
    schema_version: "1.0.0", work_id: null, task_id: null, agent_run_id: null, created_at: "2026-09-22T03:07:48.709Z", payload: {},
  };
  assert.deepEqual(Object.keys(canonical).filter((key) => !(key in eventFrame.properties)), []);
});

test("OpenAPI documents SystemStatusResponse.data_dir and the per-provider integration routes", () => {
  const status = yamlBlock(openapi, "    SystemStatusResponse:");
  assert.match(status, /\n        data_dir:\n          type: string\n/u);
  assert.match(status, /\n        - data_dir\n/u);

  const collection = yamlBlock(openapi, "  /api/v1/settings/integrations:");
  assert.doesNotMatch(collection, /\n    put:/u, "PUT is served per provider, not on the collection");
  const provider = yamlBlock(openapi, "  /api/v1/settings/integrations/{provider}:");
  assert.match(provider, /\n    put:\n/u);
  assert.match(provider, /\n    delete:\n/u);
  assert.match(provider, /- slack\n\s+- discord/u);
});

test("Work contracts expose positive nullable display numbers", () => {
  for (const path of [
    "contracts/jsonschema/owl-v1/work-summary.json",
    "contracts/jsonschema/owl-v1/work-detail.json",
  ]) {
    const schema = readJson(path);
    assert.ok(schema.required.includes("display_number"), path);
    assert.deepEqual(schema.properties.display_number, { type: ["integer", "null"], minimum: 1 }, path);
  }

  for (const header of ["    WorkSummary:", "    WorkDetail:"]) {
    const schema = yamlBlock(openapi, header);
    assert.match(schema, /\n        - display_number\n/u, header);
    assert.match(schema, /\n        display_number:\n          anyOf:\n            - type: integer\n              minimum: 1\n            - type: 'null'\n/u, header);
  }
});
