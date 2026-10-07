import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore, command as coreCommand } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const apiRoot = "/api/v1";
const token = "skill-api-owner-token";

const command = (payload, suffix = createUlid()) => coreCommand(payload, `idempotency-${suffix}`);

async function startServer(t, options = {}) {
  const { root, db, core: durableCore } = await createTestCore(t, {
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
      runCurator: async () => ({ ok: false, error: "curator_unavailable" }),
    },
    version: "test",
    ...(options.now ? { now: options.now } : {}),
  }, { prefix: "owl-api-skills-" });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('work-origin', 'owner:default', 'Release work', '', 'normal', 'ready', '[]', '[]', ?, ?)", now, now);
  });

  await durableCore.start();
  const core = new ExternalCoreAdapter(durableCore, db, root, join(root, "data"));
  const server = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root }, { token });
  if (!server) throw new Error("localhost listen is unavailable");

  const base = `${server.baseUrl}${apiRoot}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = (path, options = {}) => fetch(`${base}${path}`, { headers: options.auth === false ? {} : headers });
  const write = (method, path, payload, options = {}) => fetch(`${base}${path}`, {
    method,
    headers: options.auth === false ? { "content-type": "application/json" } : headers,
    body: JSON.stringify(command(payload, options.suffix)),
  });
  return { base, core, db, durableCore, get, write, root };
}

async function rawGet(host, port, path, authorization = `Bearer ${token}`) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ host, port, path, method: "GET", headers: { authorization } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end();
  });
}

function revisionInput(name, body, action = "create", sourceWorkId = "work-origin") {
  return {
    name,
    files: {
      "SKILL.md": `---\nname: ${name}\ndescription: Release guidance.\nscope: global\ntags: [release]\n---\n${body}\n`,
      "references/checklist.md": "Checklist content.\n",
      "scripts/check.sh": "#!/bin/sh\necho \"東京 🌱\"\n",
    },
    meta: { description: "Release guidance.", tags: ["release"], scope: "global" },
    actor: "user",
    action,
    reason: "Added through the Skill Box API test.",
    trial: true,
    ...(sourceWorkId ? { source_work_id: sourceWorkId } : {}),
  };
}

test("skill routes list, inspect, restore, update, and expose proposals and settings", async (t) => {
  const api = await startServer(t);
  const first = await api.durableCore.skillBox.applyRevision(revisionInput("release-procedure", "# Release v1"));
  await api.durableCore.skillBox.applyRevision(revisionInput("release-procedure", "# Release v2", "update"));
  const oldRevision = api.durableCore.skillBox.getRevision(first.revision_id);
  const timestamp = Date.now();
  await api.db.createWriteLane().transact((tx) => {
    const rows = [
      ["run-helpful", "helpful", "work-origin", "worker", "Helpful note.", new Date(timestamp - 2000).toISOString(), new Date(timestamp + 5000).toISOString()],
      ["run-misleading", "misleading", "work-origin", "reviewer", "Misleading note.", new Date(timestamp - 1000).toISOString(), new Date(timestamp - 5000).toISOString()],
      ["run-none", null, null, null, null, new Date(timestamp).toISOString(), new Date(timestamp - 10000).toISOString()],
    ];
    for (const [runId, verdict, workId, role, note, createdAt, updatedAt] of rows) {
      tx.run(
        `INSERT INTO skill_usages (agent_run_id, skill_name, work_id, project_id, role, revision, read_detected, verdict, note, created_at, updated_at)
         VALUES (?, 'release-procedure', ?, NULL, ?, 2, 1, ?, ?, ?, ?)`,
        runId,
        workId,
        role,
        verdict,
        note,
        createdAt,
        updatedAt,
      );
    }
  });

  const listResponse = await api.get("/skills?q=release&state=active&scope=global&trial=true");
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.equal(listBody.request_id.length > 0, true);
  assert.equal(listBody.data.length, 1);
  const listed = listBody.data[0];
  assert.equal(listed.name, "release-procedure");
  assert.deepEqual(listed.trial_progress, { evaluations: 2, misleading: 1 });
  assert.equal(listed.helpful_count, 1);
  assert.equal(listed.misleading_count, 1);
  assert.equal(listed.irrelevant_count, 0);
  assert.deepEqual(listed.originating_work, { id: "work-origin", title: "Release work" });
  assert.equal(listed.has_scripts, true);

  const detailResponse = await api.get("/skills/release-procedure");
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()).data;
  assert.equal(detail.skill.current_revision, 2);
  assert.match(detail.body, /# Release v2/u);
  assert.equal(detail.files["references/checklist.md"], "Checklist content.\n");
  assert.deepEqual(Object.keys(detail.file_sizes).sort(), Object.keys(detail.files).sort());
  for (const [path, content] of Object.entries(detail.files)) {
    assert.equal(detail.file_sizes[path], Buffer.byteLength(content, "utf8"), path);
  }
  assert.deepEqual(detail.recent_uses.map((usage) => usage.agent_run_id), ["run-none", "run-misleading", "run-helpful"]);
  assert.equal(detail.recent_uses[0].used_at > detail.recent_uses[1].used_at, true);
  assert.equal(detail.recent_uses[2].used_at, new Date(timestamp - 2000).toISOString());
  assert.equal(detail.recent_uses[0].role, null);
  assert.equal(detail.recent_uses[0].verdict, null);
  assert.equal(detail.recent_uses[0].note, null);
  assert.equal(detail.recent_uses[0].work_id, null);
  assert.equal(detail.recent_uses[0].work_title, null);
  // hardcode-check-allow whole-list-equal: 契約として固定された一覧の完全一致を確かめるため、現状の値を意図して比べている
  assert.deepEqual(
    Object.keys(detail.recent_uses[1]).sort(),
    ["agent_run_id", "role", "verdict", "note", "work_id", "work_title", "revision", "used_at"].sort(),
  );
  assert.equal(detail.recent_uses[1].work_title, "Release work");

  const fileResponse = await api.get("/skills/release-procedure/files/references/checklist.md");
  assert.equal(fileResponse.status, 200);
  assert.equal((await fileResponse.json()).data.content, "Checklist content.\n");

  const revisionsResponse = await api.get("/skills/release-procedure/revisions");
  assert.equal(revisionsResponse.status, 200);
  const revisions = (await revisionsResponse.json()).data;
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].source_work_id, "work-origin");
  assert.equal(revisions[0].source_work_title, "Release work");
  const revisionResponse = await api.get(`/skills/release-procedure/revisions/${oldRevision.id}`);
  assert.equal(revisionResponse.status, 200);
  const oldRevisionData = (await revisionResponse.json()).data;
  assert.equal(oldRevisionData.files["SKILL.md"].includes("# Release v1"), true);
  assert.equal(oldRevisionData.source_work_id, "work-origin");
  assert.equal(oldRevisionData.source_work_title, "Release work");

  const restoreResponse = await api.write("POST", "/skills/release-procedure/restore", { revision_id: first.revision_id });
  assert.equal(restoreResponse.status, 200);
  assert.equal((await restoreResponse.json()).data.revision, 3);
  assert.equal(api.durableCore.skillBox.getSkill("release-procedure").current_revision, 3);

  const patchResponse = await api.write("PATCH", "/skills/release-procedure", { state: "stale", scope: "global" });
  assert.equal(patchResponse.status, 200);
  assert.equal(api.durableCore.skillBox.getSkill("release-procedure").state, "stale");

  const now = new Date().toISOString();
  const prepared = {
    proposal_id: "proposal-approve",
    target_name: "approved-procedure",
    files: {
      "SKILL.md": "---\nname: approved-procedure\ndescription: Approved guidance.\nscope: global\ntags: []\n---\n# Approved\n",
    },
    meta: { description: "Approved guidance.", tags: [], scope: "global" },
    action: "create",
    archive: [],
    reason: "Approved proposal.",
    source_proposal_id: "proposal-approve",
    source_work_id: "work-origin",
    source_agent_run_id: null,
    project_id: null,
    relation: "different",
    target_revision: null,
    judgement: { reusable: 2, work_specific: 0, relation: "different", confidence: 0.85 },
  };
  await api.db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, source_work_id, project_id, status, decision_json, attempts, created_at, updated_at)
       VALUES ('proposal-approve', 'new', NULL, ?, 'work-origin', NULL, 'awaiting_approval', ?, 1, ?, ?)`,
      JSON.stringify({ kind: "new", target: null, summary: "Add reusable procedure", steps_or_diff: "Document the steps and checks in a reusable sequence for future work.", evidence: "Repeated in several Works." }),
      JSON.stringify(prepared),
      now,
      now,
    );
    tx.run(
      `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, status, decision_json, attempts, created_at, updated_at)
       VALUES ('proposal-reject', 'update', 'release-procedure', ?, 'awaiting_approval', ?, 1, ?, ?)`,
      JSON.stringify({ kind: "update", target: "release-procedure", summary: "Update release guide", steps_or_diff: "Add a verified check and keep the release guide consistent with the current workflow.", evidence: "The current guide omits the check." }),
      JSON.stringify({ needs_writing: true, judgement: { reusable: 2, confidence: 0.9, relation: "extends" }, reason: "Curator explanation." }),
      now,
      now,
    );
  });

  const proposalResponse = await api.get("/skill-proposals?status=awaiting_approval");
  assert.equal(proposalResponse.status, 200);
  const proposals = (await proposalResponse.json()).data;
  assert.equal(proposals.length, 2);
  const approval = proposals.find((proposal) => proposal.id === "proposal-approve");
  assert.equal(approval.written_content["SKILL.md"].includes("# Approved"), true);
  assert.equal(approval.current_content, null);
  assert.deepEqual(approval.judgement, { reusability: 2, confidence: 0.85, reason: "Approved proposal.", relation: "different" });
  const rejection = proposals.find((proposal) => proposal.id === "proposal-reject");
  assert.equal(rejection.current_content["SKILL.md"].includes("# Release v1"), true);
  assert.deepEqual(rejection.judgement, { reusability: 2, confidence: 0.9, reason: "Curator explanation.", relation: "extends" });

  const approveResponse = await api.write("POST", "/skill-proposals/proposal-approve/approve", {});
  assert.equal(approveResponse.status, 200);
  const approved = (await approveResponse.json()).data;
  const appliedRow = api.db.get("SELECT status, applied_revision_id FROM skill_proposals WHERE id = 'proposal-approve'");
  assert.equal(appliedRow.status, "applied");
  assert.deepEqual(approved, { proposal_id: "proposal-approve", status: "applied", applied_revision_id: appliedRow.applied_revision_id });
  assert.match(approved.applied_revision_id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  const reapproveResponse = await api.write("POST", "/skill-proposals/proposal-approve/approve", {});
  assert.equal(reapproveResponse.status, 409);
  assert.equal((await reapproveResponse.json()).error.code, "invalid_state_transition");
  const rejectResponse = await api.write("POST", "/skill-proposals/proposal-reject/reject", {});
  assert.equal(rejectResponse.status, 200);
  assert.deepEqual((await rejectResponse.json()).data, { proposal_id: "proposal-reject", status: "rejected", applied_revision_id: null });
  assert.equal(api.db.get("SELECT status FROM skill_proposals WHERE id = 'proposal-reject'").status, "rejected");

  const settings = {
    mode: "conservative",
    confidence_threshold: 0.7,
    stale_days: 45,
    archived_days: 20,
    max_items: 40,
    max_characters: 8000,
  };
  const putSettings = await api.write("PUT", "/settings/skills", settings);
  assert.equal(putSettings.status, 200);
  const getSettings = await api.get("/settings/skills");
  assert.equal(getSettings.status, 200);
  assert.deepEqual((await getSettings.json()).data, { ...settings, feedback_weights: { major_finding: 1, replan: 2, owner_correction: 3 } });

  const missingName = await api.get("/skills/unknown-procedure");
  assert.equal(missingName.status, 404);
  const missingProposal = await api.write("POST", "/skill-proposals/missing-proposal/approve", {});
  assert.equal(missingProposal.status, 404);
  const address = new URL(api.base);
  const traversal = await rawGet(address.hostname, Number(address.port), `${apiRoot}/skills/release-procedure/files/../SKILL.md`);
  assert.equal(traversal.status, 400);
  const unauthorized = await api.get("/skills", { auth: false });
  assert.equal(unauthorized.status, 401);
});

function insertProposal(db, id, decision, now = new Date().toISOString()) {
  return db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO skill_proposals (id, kind, target_skill, payload_json, status, decision_json, attempts, created_at, updated_at)
       VALUES (?, 'update', 'release-procedure', ?, 'awaiting_approval', ?, 0, ?, ?)`,
      id,
      JSON.stringify({ kind: "update", target: "release-procedure", summary: "Update release guide", steps_or_diff: "Add a verified check and keep the release guide consistent with the current workflow.", evidence: "The current guide omits the check." }),
      JSON.stringify(decision),
      now,
      now,
    );
  });
}

test("skill proposal approval reports conflicts and an unavailable Curator", async (t) => {
  const api = await startServer(t);
  await api.durableCore.skillBox.applyRevision(revisionInput("release-procedure", "# Release v1"));
  await api.durableCore.skillBox.applyRevision(revisionInput("release-procedure", "# Release v2", "update"));
  await insertProposal(api.db, "proposal-outdated", {
    proposal_id: "proposal-outdated",
    target_name: "release-procedure",
    files: { "SKILL.md": "---\nname: release-procedure\ndescription: Release guidance.\nscope: global\ntags: []\n---\n# Outdated\n" },
    meta: { description: "Release guidance.", tags: [], scope: "global" },
    action: "update",
    archive: [],
    reason: "Outdated proposal.",
    source_proposal_id: "proposal-outdated",
    source_work_id: null,
    source_agent_run_id: null,
    project_id: null,
    relation: "extends",
    target_revision: 1,
  });
  await insertProposal(api.db, "proposal-unwritten", { needs_writing: true, judgement: { reusable: 2, work_specific: 0, relation: "extends", confidence: 0.9 } });

  const conflict = await api.write("POST", "/skill-proposals/proposal-outdated/approve", {});
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.error.code, "invalid_state_transition");
  assert.match(conflictBody.error.message, /skill_changed_since_proposal/u);
  assert.equal(api.db.get("SELECT status FROM skill_proposals WHERE id = 'proposal-outdated'").status, "awaiting_approval");
  assert.equal(api.durableCore.skillBox.getSkill("release-procedure").current_revision, 2);

  const unavailable = await api.write("POST", "/skill-proposals/proposal-unwritten/approve", {});
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "dependency_unavailable");
});

test("skill activity counts content revisions and rollbacks within the injected clock window", async (t) => {
  const clock = "2026-03-10T12:00:00.000Z";
  const api = await startServer(t, { now: () => clock });
  const skillBox = api.durableCore.skillBox;
  const since = Date.parse(clock) - 7 * 24 * 60 * 60 * 1000;
  const inside = new Date(since + 1).toISOString();
  const outside = new Date(since - 1).toISOString();

  const created = await skillBox.applyRevision(revisionInput("release-procedure", "# Release v1"));
  await skillBox.applyRevision(revisionInput("release-procedure", "# Release v2", "update"));
  await skillBox.restore("release-procedure", created.revision_id, "user");
  await skillBox.setTrial("release-procedure", false);

  await skillBox.applyRevision(revisionInput("new-release-flow", "# New flow"));
  await api.db.createWriteLane().transact((tx) => {
    for (const id of ["misleading-1", "misleading-2"]) {
      tx.run(
        `INSERT INTO skill_usages (agent_run_id, skill_name, revision, verdict, note, created_at, updated_at)
         VALUES (?, 'new-release-flow', 1, 'misleading', 'The steps were wrong.', ?, ?)`,
        id,
        clock,
        clock,
      );
    }
  });
  await api.durableCore.skillCurator.evaluateLifecycle();
  assert.equal(skillBox.getSkill("new-release-flow").state, "archived");
  assert.equal(skillBox.listRevisions("new-release-flow")[0].action, "rollback");

  const patch = await api.write("PATCH", "/skills/release-procedure", { state: "stale" });
  assert.equal(patch.status, 200);
  await skillBox.setState("release-procedure", "archived", "curator", "Archived after merge into new-release-flow.");
  await skillBox.setState("release-procedure", "active", "user", "Updated by the Owner through the API.");

  let revision = api.db.get("SELECT MAX(revision) AS maximum FROM skill_revisions WHERE skill_name = 'release-procedure'").maximum;
  await api.db.createWriteLane().transact((tx) => {
    for (const [action, actor, createdAt] of [
      ["scope_change", "curator", clock],
      ["external_edit", "user", clock],
      ["merge", "curator", inside],
      ["rollback", "curator", outside],
      ["update", "curator", outside],
    ]) {
      revision += 1;
      tx.run(
        `INSERT INTO skill_revisions (id, skill_name, revision, actor, action, snapshot_json, content_hash, reason, created_at)
         VALUES (?, 'release-procedure', ?, ?, ?, NULL, 'hash', 'Recorded activity.', ?)`,
        createUlid(),
        revision,
        actor,
        action,
        createdAt,
      );
    }
    for (const [id, updatedAt] of [["proposal-rejected-inside", inside], ["proposal-rejected-outside", outside]]) {
      tx.run(
        `INSERT INTO skill_proposals (id, kind, payload_json, status, attempts, created_at, updated_at)
         VALUES (?, 'new', '{}', 'rejected', 0, ?, ?)`,
        id,
        updatedAt,
        updatedAt,
      );
    }
  });

  const expected = { days: 7, created: 2, revised: 4, rejected: 1, rolled_back: 1 };
  const response = await api.get("/skill-activity?days=7");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, expected);
  assert.deepEqual((await (await api.get("/skill-activity")).json()).data, expected);
  for (const invalid of ["0", "91", "1.5", "abc"]) {
    const invalidResponse = await api.get(`/skill-activity?days=${invalid}`);
    assert.equal(invalidResponse.status, 400, invalid);
  }
  assert.equal((await api.get("/skill-activity", { auth: false })).status, 401);
});

test("skill usage details are capped at the latest 50 rows", async (t) => {
  const api = await startServer(t);
  await api.durableCore.skillBox.applyRevision(revisionInput("release-procedure", "# Release v1"));
  await api.db.createWriteLane().transact((tx) => {
    for (let index = 0; index < 52; index += 1) {
      const usedAt = new Date(Date.now() - (51 - index) * 1000).toISOString();
      tx.run(
        `INSERT INTO skill_usages (agent_run_id, skill_name, work_id, project_id, role, revision, read_detected, verdict, note, created_at, updated_at)
         VALUES (?, 'release-procedure', NULL, NULL, NULL, 1, 1, NULL, NULL, ?, ?)`,
        `usage-${String(index).padStart(3, "0")}`,
        usedAt,
        usedAt,
      );
    }
  });
  const detail = (await (await api.get("/skills/release-procedure")).json()).data;
  assert.equal(detail.recent_uses.length, 50);
  assert.equal(detail.recent_uses[0].agent_run_id, "usage-051");
  assert.equal(detail.recent_uses.at(-1).agent_run_id, "usage-002");

  const withoutScripts = revisionInput("no-script-procedure", "# No scripts");
  delete withoutScripts.files["scripts/check.sh"];
  await api.durableCore.skillBox.applyRevision(withoutScripts);
  const skills = (await (await api.get("/skills")).json()).data;
  assert.equal(skills.find((skill) => skill.name === "no-script-procedure")?.has_scripts, false);
});

test("model settings API returns and accepts the Curator role", async (t) => {
  const api = await startServer(t);
  const initialResponse = await api.get("/settings/models");
  assert.equal(initialResponse.status, 200);
  const initial = (await initialResponse.json()).data.roles;
  assert.ok(initial.some((role) => role.role === "curator"));

  const updateResponse = await api.write("PUT", "/settings/models", {
    roles: initial.map(({ role, provider, model, effort }) => ({ role, provider, model, effort })),
  });
  assert.equal(updateResponse.status, 200);
  const savedResponse = await api.get("/settings/models");
  assert.equal(savedResponse.status, 200);
  assert.ok((await savedResponse.json()).data.roles.some((role) => role.role === "curator"));

  const withoutCurator = await api.write("PUT", "/settings/models", {
    roles: initial.filter(({ role }) => role !== "curator").map(({ role, provider, model, effort }) => ({ role, provider, model, effort })),
  });
  assert.equal(withoutCurator.status, 400);
  const withoutCuratorBody = await withoutCurator.json();
  assert.equal(withoutCuratorBody.error.code, "validation_error");
  assert.match(withoutCuratorBody.error.message, /8つのrole/u);
});

test("skill routes show broken skills and reject invalid requests", async (t) => {
  const api = await startServer(t);
  await api.durableCore.skillBox.applyRevision(revisionInput("release-procedure", "# Release v1"));
  await api.durableCore.skillBox.applyRevision(revisionInput("broken-procedure", "# Broken"));
  await api.write("PATCH", "/skills/release-procedure", { state: "stale" });
  const stateRevision = api.durableCore.skillBox.listRevisions("release-procedure").find((revision) => revision.snapshot_json === null);
  assert.ok(stateRevision);

  const noSnapshot = await api.write("POST", "/skills/release-procedure/restore", { revision_id: stateRevision.id });
  assert.equal(noSnapshot.status, 400);
  assert.equal((await noSnapshot.json()).error.code, "validation_error");
  const unknownRevision = await api.get(`/skills/release-procedure/revisions/${createUlid()}`);
  assert.equal(unknownRevision.status, 404);
  const missingFile = await api.get("/skills/release-procedure/files/references/missing.md");
  assert.equal(missingFile.status, 404);
  await mkdir(join(api.root, "skills", "release-procedure", "references", "nested"));
  const directoryFile = await api.get("/skills/release-procedure/files/references/nested");
  assert.equal(directoryFile.status, 404);
  assert.equal((await directoryFile.json()).error.code, "skill_file_not_found");

  const address = new URL(api.base);
  for (const path of ["references%2F..%2F..%2Fx", "%2e%2e/SKILL.md", "references/%2e%2e"]) {
    const response = await rawGet(address.hostname, Number(address.port), `${apiRoot}/skills/release-procedure/files/${path}`);
    assert.equal(response.status, 400, path);
  }

  for (const payload of [{ state: "deleted" }, { scope: "team" }, { state: "active", scope: "team" }]) {
    const response = await api.write("PATCH", "/skills/release-procedure", payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
  }
  assert.equal(api.durableCore.skillBox.getSkill("release-procedure").state, "stale");
  const badSettings = await api.write("PUT", "/settings/skills", { mode: "conservative" });
  assert.equal(badSettings.status, 400);

  const emptyTrial = await api.get("/skills?trial=");
  assert.equal(emptyTrial.status, 200);
  assert.equal((await emptyTrial.json()).data.length, 2);
  const wildcard = await api.get("/skills?q=%25");
  assert.equal(wildcard.status, 200);
  assert.equal((await wildcard.json()).data.length, 0);

  await rm(join(api.root, "skills", "broken-procedure"), { recursive: true, force: true });
  await api.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE skills SET broken_reason = 'skill_directory_missing' WHERE name = 'broken-procedure'");
  });
  const listed = (await (await api.get("/skills")).json()).data;
  assert.equal(listed.find((skill) => skill.name === "broken-procedure")?.broken_reason, "skill_directory_missing");
  const brokenDetail = await api.get("/skills/broken-procedure");
  assert.equal(brokenDetail.status, 200);
  const brokenData = (await brokenDetail.json()).data;
  assert.deepEqual(brokenData.files, {});
  assert.equal(brokenData.skill.broken_reason, "skill_directory_missing");
});

test("OpenAPI documents all skill and skill settings operations", () => {
  const openapi = readFileSync(resolve(process.cwd(), "contracts/openapi/owl-api-v1.yaml"), "utf8");
  for (const route of [
    "/api/v1/skills:",
    "/api/v1/skills/{name}:",
    "/api/v1/skills/{name}/files/{path}:",
    "/api/v1/skills/{name}/revisions:",
    "/api/v1/skills/{name}/revisions/{revision_id}:",
    "/api/v1/skills/{name}/restore:",
    "/api/v1/skill-activity:",
    "/api/v1/skill-proposals:",
    "/api/v1/skill-proposals/{proposal_id}/approve:",
    "/api/v1/skill-proposals/{proposal_id}/reject:",
    "/api/v1/settings/skills:",
  ]) assert.ok(openapi.includes(route), `OpenAPI includes ${route}`);
  for (const operationId of ["listSkills", "getSkill", "getSkillFile", "listSkillRevisions", "getSkillRevision", "restoreSkill", "getSkillActivity", "updateSkill", "listSkillProposals", "approveSkillProposal", "rejectSkillProposal", "getSkillSettings", "updateSkillSettings"]) {
    assert.ok(openapi.includes(operationId), `OpenAPI includes operation ${operationId}`);
  }
  for (const field of ["recent_uses", "file_sizes", "has_scripts", "source_work_title", "judgement", "reusability", "rolled_back"]) {
    assert.ok(openapi.includes(field), `OpenAPI includes field ${field}`);
  }
});
