import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

function requestBody(payload) {
  return { request_id: "request", idempotency_key: "capture-key", expected_version: 0, payload };
}

test("research capture accepts Work agent tokens and validates the payload boundary", async (t) => {
  const root = await tempDir(t, "owl-api-research-");
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  const calls = [];
  const core = {
    ready: true,
    recordAgentResearch: async (agent, capture) => {
      calls.push({ agent, capture });
      return { accepted: true };
    },
  };
  const server = await startTestHttpServer(t, { core, webOut: root, owlRoot: root, guardTokens }, { token: "test-owner-api-token" });
  if (!server) {
    t.skip("localhost listen is unavailable");
    return;
  }
  t.after(() => guardTokens.clear());

  const apiBase = server.baseUrl;
  const leases = [];
  const tokenFor = (role, agent_run_id = `run-${role}`) => {
    const lease = guardTokens.issue({ agent_run_id, role });
    leases.push(lease);
    return readFile(lease.file, "utf8").then((token) => token.trim());
  };
  const payload = {
    tool_name: "WebFetch",
    tool_input: { url: "https://example.com/guide", prompt: "summarize" },
    tool_response: { code: 200, result: "This is a sufficiently detailed page result for recording." },
  };
  const post = (authorization, body = requestBody(payload)) => fetch(`${apiBase}/api/v1/research/capture`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });

  const workerToken = await tokenFor("worker", "run-worker-1");
  const accepted = await post(`Bearer ${workerToken}`);
  assert.equal(accepted.status, 202);
  assert.deepEqual((await accepted.json()).data, { accepted: true });
  assert.deepEqual(calls[0].agent, { agent_run_id: "run-worker-1", role: "worker" });
  assert.equal(calls[0].capture.tool, "WebFetch");
  assert.equal(calls[0].capture.url, "https://example.com/guide");

  const authFlag = await post(`Bearer ${workerToken}`, requestBody({ ...payload, auth_form_detected: true }));
  assert.equal(authFlag.status, 202);
  assert.equal(calls[1].capture.auth_form_detected, true);

  for (const role of ["advisor", "curator"]) {
    const token = await tokenFor(role);
    const response = await post(`Bearer ${token}`);
    assert.equal(response.status, 403, role);
    assert.equal((await response.json()).error.code, "agent_scope_denied");
  }
  const owner = await post("Bearer test-owner-api-token");
  assert.equal(owner.status, 403);
  assert.equal((await owner.json()).error.code, "agent_scope_denied");
  const invalid = await post("Bearer invalid-token");
  assert.equal(invalid.status, 401);

  const extraKey = await post(`Bearer ${workerToken}`, requestBody({ ...payload, unexpected: true }));
  assert.equal(extraKey.status, 400);
  const invalidAuthFlag = await post(`Bearer ${workerToken}`, requestBody({ ...payload, auth_form_detected: false }));
  assert.equal(invalidAuthFlag.status, 400);
  const bashTool = await post(`Bearer ${workerToken}`, requestBody({ ...payload, tool_name: "Bash" }));
  assert.equal(bashTool.status, 400);
  assert.equal(calls.length, 2);
  for (const lease of leases) lease.release();
});
