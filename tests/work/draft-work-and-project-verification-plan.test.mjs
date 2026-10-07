import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createCore } from "../../packages/core/dist/index.js";
import { ADVISOR_TEXT } from "../../packages/core/dist/advisor-text.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { openTestDatabase } from "../helpers/db.mjs";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

function action(title, draft) {
  const payload = { title, summary: `Do ${title}.`, size: "small", project_id: null };
  if (draft !== undefined) payload.draft = draft;
  return { type: "create_work", description: title, payload };
}

async function setup(t) {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-draft-work-" });
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("unexpected"); },
    runWorker: async () => ({ outcome: "failed", failure_class: "deterministic", error_key: "draft_test", retry_allowed: false, message: "stop" }),
    runReviewer: async () => { throw new Error("unexpected"); },
    runAdvisor: async () => { throw new Error("unexpected"); },
  };
  const core = createCore({ db, agentRunner, version: "draft-test", owlRoot: root, dataDir: root });
  const { conversation_id } = await core.getActiveConversation();
  const send = async (a) => {
    const id = await core.persistAdvisorReply(conversation_id, "", createUlid(), { channel: "web" }, [a]);
    return db.get("SELECT body FROM messages WHERE id = ?", id).body;
  };
  return { db, send };
}

const startedCount = (db, workId) =>
  db.get("SELECT COUNT(*) AS n FROM events WHERE work_id = ? AND type = 'work.started'", workId).n;

test("draft:true creates a memo Work without starting it and says so", async (t) => {
  const { db, send } = await setup(t);
  const body = await send(action("Draft work", true));
  const work = db.get("SELECT id, state FROM works WHERE title = ?", "Draft work");
  assert.equal(work.state, "memo");
  assert.equal(startedCount(db, work.id), 0);
  assert.equal(body, ADVISOR_TEXT.ja.createdDraft("Draft work", work.id));
  assert.match(ADVISOR_TEXT.en.createdDraft("Draft work", work.id), /draft.*not been started/u);
  assert.match(ADVISOR_TEXT.ja.createdDraft("Draft work", work.id), /下書き.*開始していません/u);
});

test("draft omitted or false still starts the Work", async (t) => {
  const { db, send } = await setup(t);
  await send(action("Omitted", undefined));
  await send(action("Explicit false", false));
  for (const title of ["Omitted", "Explicit false"]) {
    const work = db.get("SELECT id, state FROM works WHERE title = ?", title);
    assert.equal(work.state, "running", title);
    assert.equal(startedCount(db, work.id), 1, title);
  }
});

test("a non-boolean draft is rejected and no Work is created", async (t) => {
  const { db, send } = await setup(t);
  const before = db.get("SELECT COUNT(*) AS n FROM works").n;
  await send(action("Bad draft", "yes"));
  await send(action("Null draft", null));
  assert.equal(db.get("SELECT COUNT(*) AS n FROM works").n, before);
});

async function projectApi(t) {
  const { randomBytes, randomUUID } = await import("node:crypto");
  const { ExternalCoreAdapter } = await import("../../apps/server/dist/core.js");
  const { root, db, core } = await createTestCore(t, { version: "vp-test", dispatcher: { tick_interval_ms: 25 } }, { prefix: "owl-project-vp-" });
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const api = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir }, { token });
  if (!api) { t.skip("localhost listen is unavailable"); return null; }
  const request = (path, { method = "GET", body } = {}) => api.request(method, `/api/v1${path}`, body);
  const path = await realpath(root);
  const project = (await core.createProject({
    request_id: randomUUID(), idempotency_key: `vp:${randomUUID()}`, expected_version: 0,
    payload: { name: "VP", canonical_path: path, base_branch: "main", allowed_roots: [path], verification_plan: [] },
  })).data;
  const patch = (payload) => request(`/projects/${project.id}`, {
    method: "PATCH",
    body: { request_id: randomUUID(), idempotency_key: `vp-patch:${randomUUID()}`, expected_version: 0, payload },
  });
  const plan = async () => (await (await request("/projects")).json()).data.find((item) => item.id === project.id).verification_plan;
  return { patch, plan };
}

test("PATCH saves verification_plan, rejects invalid ones, and leaves it alone otherwise", async (t) => {
  const api = await projectApi(t);
  if (!api) return;
  const cmd = { command_id: "build", argv: ["pnpm", "build"], cwd: ".", env_allowlist: [], timeout_seconds: 600, stdout_limit: 1000, stderr_limit: 1000, expected_exit_codes: [0], executor: "core" };
  const good = [cmd];
  const saved = await api.patch({ verification_plan: good });
  assert.equal(saved.status, 200);
  assert.deepEqual(await api.plan(), good);

  for (const bad of ["pnpm build", [{ ...cmd, argv: [] }], [{ ...cmd, extra: 1 }], null]) {
    const res = await api.patch({ verification_plan: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await api.plan(), good);
  }

  const renamed = await api.patch({ name: "Renamed", auto_push: true });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await api.plan(), good);
});
