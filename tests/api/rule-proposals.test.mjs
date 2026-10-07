import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { KnowledgeBase } from "../../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../../packages/core/dist/knowledge-notes.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore, command as coreCommand } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { seedNote } from "../helpers/seed-knowledge.mjs";

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

test("rule proposal routes require Owner access, create from notes, approve, reject, and preserve exact rule text", async (t) => {
  const api = await startServer(t);
  const notes = new KnowledgeNotes(new KnowledgeBase(api.root));
  const text = `Preserve "quoted" values, 'single quotes', # comments, C:\\rules:entry.`;
  const source = await seedNote(notes, {
    topic: "Rule proposal API quote handling",
    kind: "fact",
    text,
    work_id: createUlid(),
    project_id: null,
    tags: ["rules"],
  });

  const notePath = (await new KnowledgeBase(api.root).list("notes"))[0].path;
  const noteResponse = await api.get(`/knowledge/${encodeURIComponent(notePath)}`);
  assert.equal(noteResponse.status, 200);
  const noteEntry = (await noteResponse.json()).data;
  assert.equal(noteEntry.note_id, source.note_id);
  assert.match(noteEntry.path, /^notes\/[a-z0-9-]+\.md$/u, "notes are stored with slug filenames");

  const unauthenticated = await api.get("/rule-proposals", { auth: false });
  assert.equal(unauthenticated.status, 403);

  const createResponse = await api.write("POST", "/rule-proposals", {
    note_id: source.note_id,
    claim_fingerprint: (await notes.get(source.note_id)).claims[0].fingerprint,
    level: "system",
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).data;
  assert.equal(created.status, "awaiting_approval");
  const createdEvent = api.db.get(
    "SELECT status FROM events WHERE type = ? AND json_extract(payload_json, '$.proposal_id') = ?",
    "rule_proposal.awaiting_approval",
    created.proposal_id,
  );
  assert.equal(createdEvent?.status, "handled", "proposal creation dispatches its pending event");

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

  const rejectedSource = await seedNote(notes, {
    topic: "Rule proposal API rejection",
    kind: "pitfall",
    text: "Keep the rejection available for review.",
    work_id: createUlid(),
    project_id: null,
    tags: ["rules"],
  });
  const rejectedCreateResponse = await api.write("POST", "/rule-proposals", {
    note_id: rejectedSource.note_id,
    claim_fingerprint: (await notes.get(rejectedSource.note_id)).claims[0].fingerprint,
    level: "role",
    role: "worker",
  });
  assert.equal(rejectedCreateResponse.status, 201);
  const rejectedProposal = (await rejectedCreateResponse.json()).data;
  const rejectResponse = await api.write("POST", `/rule-proposals/${rejectedProposal.proposal_id}/reject`, {});
  assert.equal(rejectResponse.status, 200);
  assert.equal((await rejectResponse.json()).data.status, "rejected");

  const rejectAgain = await api.write("POST", `/rule-proposals/${rejectedProposal.proposal_id}/reject`, {}, { suffix: "reject-again" });
  assert.equal(rejectAgain.status, 409);
  assert.equal((await notes.get(source.note_id)).promotions[0].status, "applied");
  assert.equal((await notes.get(rejectedSource.note_id)).promotions.at(-1).status, "rejected");

  const legacyNote = await new KnowledgeBase(api.root).create({
    folder: "notes",
    filename: "legacy-note-without-id",
    tags: [],
    body: "No note frontmatter id.",
  });
  const legacyResponse = await api.get(`/knowledge/${encodeURIComponent(legacyNote.path)}`);
  assert.equal(legacyResponse.status, 200);
  assert.equal(Object.hasOwn((await legacyResponse.json()).data, "note_id"), false);
});
