import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore, command as coreCommand } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const apiRoot = "/api/v1";
const token = "rule-proposal-api-owner-token";

const command = (payload, suffix = createUlid()) => coreCommand(payload, `idempotency-${suffix}`);

async function startServer(t) {
  const { root, db, core: durableCore } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
      runCurator: async () => ({ ok: false, error: "curator_unavailable" }),
    },
    version: "test",
  }, { prefix: "owl-api-rule-proposals-", start: true });
  const webOut = join(root, ".web.out");
  await mkdir(join(webOut, "rules"), { recursive: true });
  await writeFile(join(webOut, "index.html"), "Owl home");
  await writeFile(join(webOut, "rules", "approvals.html"), "Rule approvals page");
  const core = new ExternalCoreAdapter(durableCore, db, root, join(root, "data"));
  const server = await startTestHttpServer(t, { core, db, webOut, owlRoot: root }, { token });
  if (!server) throw new Error("localhost listen is unavailable");

  const origin = server.baseUrl;
  const base = `${origin}${apiRoot}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = (path, options = {}) => fetch(`${base}${path}`, { headers: options.auth === false ? {} : headers });
  const write = (method, path, payload, options = {}) => fetch(`${base}${path}`, {
    method,
    headers: options.auth === false ? { "content-type": "application/json" } : headers,
    body: JSON.stringify(command(payload, options.suffix)),
  });
  return { durableCore, get, write, root, db, origin };
}

test("extensionless static pages resolve when the web output path contains a dot", async (t) => {
  const api = await startServer(t);
  const response = await fetch(`${api.origin}/owl/rules/approvals`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Rule approvals page");
});


test("rule proposal routes require Owner access, list, approve, reject, and preserve exact rule text", async (t) => {
  const api = await startServer(t);
  const text = `Preserve "quoted" values, 'single quotes', # comments, C:\\rules:entry.`;
  const propose = (ref, level, role) => api.durableCore.ruleProposals.create({
    origin: "legacy_policy",
    source: { kind: "legacy_policy", ref },
    level,
    ...(role ? { role } : {}),
    text,
    rationale: "Seeded for the API test.",
    applies_to: "api test",
    project_id: null,
  });

  const unauthenticated = await api.get("/rule-proposals", { auth: false });
  assert.equal(unauthenticated.status, 403);

  await propose("policies/a.md#1", "system");
  const created = await propose("policies/a.md#2", "system");
  assert.equal(created.status, "awaiting_approval");

  const listedResponse = await api.get("/rule-proposals?status=awaiting_approval");
  assert.equal(listedResponse.status, 200);
  assert.equal((await listedResponse.json()).data.some((proposal) => proposal.id === created.proposal_id), true);

  const approveResponse = await api.write("POST", `/rule-proposals/${created.proposal_id}/approve`, {});
  assert.equal(approveResponse.status, 200);
  const approved = (await approveResponse.json()).data;
  assert.equal(approved.status, "applied");
  assert.equal(approved.applied_rule_id, `owl-${created.proposal_id.toLowerCase()}`);
  assert.deepEqual(api.durableCore.ruleStore.getInstructionsForRole("worker"), [`[system] ${text}`]);

  const invalidTransition = await api.write("POST", `/rule-proposals/${created.proposal_id}/approve`, {}, { suffix: "again" });
  assert.equal(invalidTransition.status, 409);

  await propose("policies/b.md#1", "role", "worker");
  const rejectedProposal = await propose("policies/b.md#2", "role", "worker");
  const rejectResponse = await api.write("POST", `/rule-proposals/${rejectedProposal.proposal_id}/reject`, {});
  assert.equal(rejectResponse.status, 200);
  assert.equal((await rejectResponse.json()).data.status, "rejected");

  const rejectAgain = await api.write("POST", `/rule-proposals/${rejectedProposal.proposal_id}/reject`, {}, { suffix: "reject-again" });
  assert.equal(rejectAgain.status, 409);
});
