import assert from "node:assert/strict";
import test from "node:test";
import {
  PAGE_INTEGRATION_OUTPUT_SCHEMA,
  buildPageIntegrationPrompt,
  pageIntegrationProviderSchema,
  parsePageIntegrationResponse,
} from "../dist/page-integration.js";

const model = { provider: "claude", model: "claude-haiku-4-5-20251001", effort: "low" };
const response = (value) => ({ adapter: "claude", format: "plain-json", stdout: JSON.stringify(value) });

test("integration prompt carries page, new lines, siblings and rules", () => {
  const prompt = buildPageIntegrationPrompt({
    run_id: "r1", reason: "owl_new", rules: "RULES-MARKER", model, max_output_tokens: 3500,
    page: { path: "p.md", title: "題名", scope: "common", project_id: null, body: "## 概要\nBODY-MARKER", tokens: 10 },
    new_lines: [{ section: "落とし穴", text: "- NEW-MARKER", work_label: "W1" }],
    siblings: [{ title: "SIBLING-MARKER", summary: "s" }],
  });
  for (const marker of ["RULES-MARKER", "BODY-MARKER", "NEW-MARKER", "SIBLING-MARKER", "3500"]) assert.match(prompt, new RegExp(marker));
});

test("output schemas are closed and survive providerSchema", () => {
  for (const schema of [PAGE_INTEGRATION_OUTPUT_SCHEMA]) assert.equal(schema.additionalProperties, false);
  assert.equal(typeof pageIntegrationProviderSchema(), "object");
});

test("parse accepts valid output and rejects schema violations", () => {
  const ok = { op: "noop", pages: [], history_line: "", star_changes: [], link_updates: [], reason: "x" };
  assert.deepEqual(parsePageIntegrationResponse(response(ok)), { output: ok });
  assert.match(parsePageIntegrationResponse(response({ ...ok, op: "delete" })).error, /^page_integration_output_schema:/);
  assert.ok("error" in parsePageIntegrationResponse({ adapter: "claude", format: "plain-json", stdout: "not json" }));

});

test("integration prompt lists referrers only when given", () => {
  const base = {
    run_id: "r1", reason: "owl_split", rules: "R", model, max_output_tokens: 3500,
    page: { path: "p.md", title: "題名", scope: "common", project_id: null, body: "B", tokens: 10 },
    new_lines: [], siblings: [],
  };
  assert.match(buildPageIntegrationPrompt({ ...base, referrers: [{ path: "themes/REFERRER-MARKER.md", heading: "HEADING-MARKER" }] }), /REFERRER-MARKER[\s\S]*HEADING-MARKER/);
  assert.doesNotMatch(buildPageIntegrationPrompt({ ...base, referrers: [] }), /Referrers/);
  assert.doesNotMatch(buildPageIntegrationPrompt(base), /Referrers/);
});

test("a ```json fence around the claude result is accepted for librarian output, not for strict roles", async () => {
  const { extractRoleOutputObject } = await import("../dist/role-contract.js");
  const cls = { op: "noop", pages: [], history_line: "", star_changes: [], link_updates: [], reason: "x" };
  const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + JSON.stringify(cls, null, 2) + "\n```" });
  assert.deepEqual(parsePageIntegrationResponse({ adapter: "claude", format: "provider-json", stdout }), { output: cls });
  const withProse = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Here is the result:\n```json\n" + JSON.stringify(cls) + "\n```" });
  assert.deepEqual(parsePageIntegrationResponse({ adapter: "claude", format: "provider-json", stdout: withProse }), { output: cls });
  assert.throws(() => extractRoleOutputObject({ adapter: "claude", format: "provider-json", stdout }, "r"), { code: "report_invalid" });
  const bad = parsePageIntegrationResponse({ adapter: "claude", format: "provider-json", stdout: stdout.replace("history_line", "oops") });
  assert.match(bad.error, /^page_integration_output_schema:/);
});

test("integration prompt shows the link_updates output shape and the parser accepts a fenced reply in that shape", () => {
  const prompt = buildPageIntegrationPrompt({
    run_id: "r1", reason: "owl_split", rules: "R", model, max_output_tokens: 3500,
    page: { path: "p.md", title: "題名", scope: "common", project_id: null, body: "B", tokens: 10 },
    new_lines: [], siblings: [], referrers: [{ path: "themes/a.md", heading: "H" }],
  });
  for (const key of Object.keys(PAGE_INTEGRATION_OUTPUT_SCHEMA.properties)) assert.match(prompt, new RegExp(key));
  const out = { op: "split", pages: [], history_line: "", star_changes: [], link_updates: ["themes/a.md"], reason: "x" };
  const result = "```json\n" + JSON.stringify(out) + "\n```";
  const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, result });
  assert.deepEqual(parsePageIntegrationResponse({ adapter: "claude", format: "provider-json", stdout }), { output: out });
});

test("runLibrarianOperations reports the failure cause, not the generic provider sentence, and leaks no secrets", async () => {
  const { createAgentRunner } = await import("../dist/index.js");
  const { providerFailed } = await import("../dist/errors.js");
  const run = async (error) => createAgentRunner({
    adapter: "claude-cli/v1",
    outputLogDir: null,
    provider: { execute: async () => { throw error; } },
  }).runLibrarianOperations({ run_id: "r1", model, max_output_tokens: 3500, rules: "R", pages: [], new_lines: [] });
  const exited = await run(providerFailed("provider_exit:1", { stderr: "sk-ant-SECRET" }));
  assert.equal(exited.ok, false);
  assert.equal(exited.error, "provider_failed:provider_exit:1");
  assert.doesNotMatch(exited.error, /could not complete|SECRET/);
  assert.equal((await run(providerFailed("provider_timeout", { stderr: "sk-ant-SECRET" }))).error, "timeout");
  const plain = await run(new Error("401 key sk-ant-SECRET rejected"));
  assert.equal(plain.error, "librarian_operations_failed");
  const freeText = await run(providerFailed("bad key sk-ant-SECRET", {}));
  assert.doesNotMatch(freeText.error, /SECRET/);
  assert.match(freeText.error, /^provider_failed/);
  for (const reason of ["sk-ant-SECRET", "token:SECRET", "provider_exit:SECRET"]) {
    assert.equal((await run(providerFailed(reason, {}))).error, "provider_failed");
  }
});
