import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { GuardTokenRegistry } from "../apps/server/dist/guard-tokens.js";

function requestBody(payload) {
  return { request_id: "request", idempotency_key: "capture-key", expected_version: 0, payload };
}

test("research capture accepts Work agent tokens and validates the payload boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-api-research-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  const calls = [];
  const core = {
    ready: true,
    recordAgentResearch: async (agent, capture) => {
      calls.push({ agent, capture });
      return { accepted: true };
    },
  };
  const http = createOwlHttpServer({
    core,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    guardTokens,
  });
  const priorApiToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "test-owner-api-token";
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is unavailable");
      return;
    }
    throw error;
  }
  t.after(async () => {
    if (http.server.listening) await http.close();
    guardTokens.clear();
    if (priorApiToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = priorApiToken;
  });

  const apiBase = `http://127.0.0.1:${http.server.address().port}`;
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
