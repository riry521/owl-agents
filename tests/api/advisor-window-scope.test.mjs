import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";

const ownerId = "owner:default";
const now = "2026-09-30T00:00:00.000Z";

test("an Advisor token from a Project window can only create Works and issue backlog Works for that Project", async (t) => {
  const { root, db, core } = await createTestCore(t, { version: "api-advisor-window-scope-test", dispatcher: { tick_interval_ms: 60_000 } }, { prefix: "owl-api-advisor-window-scope-" });
  await core.getActiveConversation();
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, { core: new ExternalCoreAdapter(core, db, root, dataDir), db, webOut: root, owlRoot: root, dataDir, guardTokens }, { token: "test-owner-api-token" });
  if (!api) return t.skip("localhost listen is not permitted in this environment");

  const addProject = async (name) => {
    const id = createUlid();
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO projects
         (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
          verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', '[]', '{}', '[]', ?, ?)`,
      id, ownerId, name, `/tmp/${id}`, now, now,
    ));
    return id;
  };
  const alpha = await addProject("Alpha");
  const beta = await addProject("Beta");

  // One Advisor session per window: the token's agent_run_id is the session id, as the runtime sets OWL_AGENT_RUN_ID.
  const tokenFor = async (windowKey) => {
    const window = await core.ensureAdvisorWindow(ownerId, windowKey);
    const sessionId = createUlid();
    await db.createWriteLane().transact((tx) => tx.run(
      "INSERT INTO advisor_sessions (id, status, conversation_id, window_id, last_activity_at, created_at, updated_at) VALUES (?, 'running', ?, ?, ?, ?, ?)",
      sessionId, window.conversation_id, window.window_id, now, now, now,
    ));
    return (await readFile(guardTokens.issue({ agent_run_id: sessionId, role: "advisor" }).file, "utf8")).trim();
  };
  const alphaToken = await tokenFor(alpha);
  const generalToken = await tokenFor("general");
  const call = (token, path, payload) => fetch(`${api.baseUrl}/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ request_id: createUlid(), idempotency_key: createUlid(), expected_version: 0, payload }),
  });
  const work = (title, extra) => ({ title, summary: "", size: "small", ...extra });
  const projectOf = (id) => db.get("SELECT project_id FROM works WHERE id = ?", id).project_id;

  const unset = await call(alphaToken, "/works", work("unset"));
  assert.equal(unset.status, 201);
  assert.equal(projectOf((await unset.json()).data.work_id), alpha);
  const sameProject = await call(alphaToken, "/works", work("same", { project_id: alpha }));
  assert.equal(sameProject.status, 201);
  const mismatch = await call(alphaToken, "/works", work("other", { project_id: beta }));
  assert.equal(mismatch.status, 403);
  const error = (await mismatch.json()).error;
  assert.equal(error.code, "window_scope_mismatch");
  assert.deepEqual([error.details.window_project_id, error.details.requested_project_id], [alpha, beta]);
  const toGeneral = await call(alphaToken, "/works", work("to-null", { project_id: null }));
  assert.equal(toGeneral.status, 201);
  assert.equal(projectOf((await toGeneral.json()).data.work_id), alpha);
  assert.equal(db.get("SELECT id FROM works WHERE title = 'other'"), undefined);

  // The general window keeps choosing the Project itself.
  const general = await call(generalToken, "/works", work("general-beta", { project_id: beta }));
  assert.equal(general.status, 201);
  assert.equal(projectOf((await general.json()).data.work_id), beta);

  const addItem = async (projectId, key) => {
    const [workId, taskId, reviewId, itemId] = [createUlid(), createUlid(), createUlid(), createUlid()];
    await db.createWriteLane().transact((tx) => {
      tx.run("INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES (?, ?, ?, 'src', '', 'small', 'completed', '[]', '[]', ?, ?)", workId, ownerId, projectId, now, now);
      tx.run("INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at) VALUES (?, ?, 'T', 'code', 'completed', 'normal', '', '', ?, ?)", taskId, workId, now, now);
      tx.run("INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at) VALUES (?, ?, 0, 'pass', '[]', '{}', ?)", reviewId, taskId, now);
      tx.run(
        `INSERT INTO backlog_items (id, work_id, task_id, project_id, review_id, review_round, file, line, problem, reason, suggestion, status, issued_work_id, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 'f.ts', 0, 'p', '', '', 'open', NULL, ?, ?, ?)`,
        itemId, workId, taskId, projectId, reviewId, key, now, now,
      );
    });
    return itemId;
  };
  const issue = (token, itemId) => call(token, "/backlog/issue-work", { item_ids: [itemId], title: "from backlog", summary: "", size: "small" });
  const betaItem = await addItem(beta, "b");
  const refused = await issue(alphaToken, betaItem);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, "window_scope_mismatch");
  assert.equal(db.get("SELECT status FROM backlog_items WHERE id = ?", betaItem).status, "open");
  const nullItem = await addItem(null, "n");
  assert.equal((await issue(alphaToken, nullItem)).status, 403);
  const alphaItem = await addItem(alpha, "a");
  const issued = await issue(alphaToken, alphaItem);
  assert.equal(issued.status, 201);
  assert.equal(projectOf((await issued.json()).data.work_id), alpha);
});
