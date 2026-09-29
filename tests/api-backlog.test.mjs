import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase, createUlid } from "../packages/db/dist/index.js";
import { Core, registerReviewBacklogInTransaction } from "../packages/core/dist/index.js";
import { ExternalCoreAdapter } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";

const migrations = join(process.cwd(), "packages/db/migrations");
const apiRoot = "/api/v1";
const token = "backlog-api-owner-token";

function command(payload, suffix = createUlid()) {
  return {
    request_id: `request-${suffix}`,
    idempotency_key: `idempotency-${suffix}`,
    expected_version: 0,
    payload,
  };
}

async function startServer(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-backlog-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
  });

  const durableCore = new Core({
    db,
    agentRunner: {
      runManagerPlan: async () => ({ outcome: "failed" }),
      runWorker: async () => ({ outcome: "failed" }),
      runReviewer: async () => ({ outcome: "failed" }),
      runAdvisor: async () => ({ reply: "" }),
      runCurator: async () => ({ ok: false, error: "curator_unavailable" }),
    },
    version: "test",
    owlRoot: root,
    dataDir: root,
  });
  await durableCore.start();
  const core = new ExternalCoreAdapter(durableCore, db, root, root);
  const http = createOwlHttpServer({
    core,
    db,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  const previousToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = token;
  t.after(async () => {
    await http.close().catch(() => undefined);
    await durableCore.stop({ force: true }).catch(() => undefined);
    db.close();
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  });
  await http.listen();

  const base = `http://127.0.0.1:${http.server.address().port}${apiRoot}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = (path, options = {}) => fetch(`${base}${path}`, { headers: options.auth === false ? {} : headers });
  const write = (method, path, payload, options = {}) => fetch(`${base}${path}`, {
    method,
    headers: options.auth === false ? { "content-type": "application/json" } : headers,
    body: JSON.stringify(command(payload, options.suffix)),
  });
  return { core, db, durableCore, get, write, root };
}

async function createProject(root, core, suffix) {
  const canonicalPath = join(root, `project-${suffix}`);
  await mkdir(canonicalPath, { recursive: true });
  return (await core.createProject(command({
    name: `Project ${suffix}`,
    canonical_path: canonicalPath,
    base_branch: "main",
    allowed_roots: [root],
    verification_plan: [],
  }, `project:${suffix}`))).data.id;
}

async function createWork(core, suffix, projectId) {
  return (await core.createWork(command({
    title: `Source ${suffix}`,
    summary: "",
    size: "small",
    project_id: projectId,
  }, `work:${suffix}`))).data.work_id;
}

async function registerFindings(db, workId, findings) {
  const taskId = createUlid();
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, created_at, updated_at)
       VALUES (?, ?, 'Backlog API test task', 'code', 'completed', 'normal', '', '', '/repo', ?, ?)`,
      taskId, workId, now, now,
    );
    tx.run(
      `INSERT INTO reviews (id, task_id, round, verdict, findings_json, verification_report_json, created_at)
       VALUES (?, ?, 0, 'pass', ?, '{}', ?)`,
      createUlid(), taskId, JSON.stringify(findings), now,
    );
  });
  await db.createWriteLane().transact((tx) => registerReviewBacklogInTransaction(tx, taskId, now));
}

test("backlog API lists and filters items, issues and dismisses them, and validates requests", async (t) => {
  const api = await startServer(t);
  const projectA = await createProject(api.root, api.durableCore, "a");
  const projectB = await createProject(api.root, api.durableCore, "b");
  const workA = await createWork(api.durableCore, "a", projectA);
  const workB = await createWork(api.durableCore, "b", projectB);
  const workC = await createWork(api.durableCore, "c", projectA);
  await registerFindings(api.db, workA, [
    { severity: "minor", pre_existing: false, file: "src/a.ts", problem: "Issue A", reason: "Reason A", fix: "Fix A" },
    { severity: "minor", pre_existing: false, file: "src/b.ts", problem: "Issue B" },
  ]);
  await registerFindings(api.db, workB, [{ severity: "minor", pre_existing: false, file: "src/c.ts", problem: "Issue C" }]);
  await registerFindings(api.db, workC, [{ severity: "minor", pre_existing: false, file: "src/d.ts", problem: "Issue D" }]);

  const allResponse = await api.get("/backlog");
  assert.equal(allResponse.status, 200);
  const all = (await allResponse.json()).data;
  assert.equal(all.length, 4);
  const itemsForWorkA = all.filter((item) => item.work_id === workA);
  const itemsForProjectA = all.filter((item) => item.project_id === projectA);
  const itemForProjectB = all.find((item) => item.project_id === projectB);
  assert.equal(itemsForWorkA.length, 2);
  assert.equal(itemsForProjectA.length, 3);
  assert.ok(itemForProjectB);

  const projectFilter = await api.get(`/backlog?project_id=${projectA}&status=open`);
  assert.equal(projectFilter.status, 200);
  assert.equal((await projectFilter.json()).data.length, 3);
  const statusFilter = await api.get("/backlog?status=open");
  assert.equal((await statusFilter.json()).data.length, 4);
  const workResponse = await api.get(`/works/${workA}/backlog`);
  assert.equal(workResponse.status, 200);
  assert.deepEqual((await workResponse.json()).data.map((item) => item.id).sort(), itemsForWorkA.map((item) => item.id).sort());
  for (const invalid of ["not-a-ulid"]) {
    const invalidProject = await api.get(`/backlog?project_id=${invalid}`);
    assert.equal(invalidProject.status, 400);
    assert.equal((await invalidProject.json()).error.code, "validation_error");
    const invalidWork = await api.get(`/works/${invalid}/backlog`);
    assert.equal(invalidWork.status, 400);
  }
  const missingWork = await api.get(`/works/${createUlid()}/backlog`);
  assert.equal(missingWork.status, 404);
  assert.equal((await missingWork.json()).error.code, "work_not_found");

  const emptyIds = await api.write("POST", "/backlog/dismiss", { item_ids: [] });
  assert.equal(emptyIds.status, 400);
  assert.equal((await emptyIds.json()).error.code, "validation_error");
  const missingItem = await api.write("POST", "/backlog/dismiss", { item_ids: [createUlid()] });
  assert.equal(missingItem.status, 404);
  assert.equal((await missingItem.json()).error.code, "backlog_item_not_found");
  const duplicateIds = await api.write("POST", "/backlog/dismiss", { item_ids: [itemsForWorkA[0].id, itemsForWorkA[0].id] });
  assert.equal(duplicateIds.status, 400);

  const mixedProjects = await api.write("POST", "/backlog/issue-work", {
    item_ids: [itemsForWorkA[0].id, itemForProjectB.id], title: "Mixed", summary: "", size: "small",
  });
  assert.equal(mixedProjects.status, 400);
  assert.equal((await mixedProjects.json()).error.code, "validation_error");

  const issuedItem = itemsForWorkA[0];
  const issueResponse = await api.write("POST", "/backlog/issue-work", {
    item_ids: [issuedItem.id], title: "Fix a review finding", summary: "", size: "small",
  });
  assert.equal(issueResponse.status, 201);
  const issued = (await issueResponse.json()).data;
  assert.match(issued.work_id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.deepEqual(issued.item_ids, [issuedItem.id]);
  assert.equal(issued.status, "in_progress");
  assert.deepEqual(issued.items.map((item) => [item.id, item.status, item.issued_work_id]), [[issuedItem.id, "in_progress", issued.work_id]]);
  const afterIssue = await api.get(`/works/${workA}/backlog`);
  const doneItem = (await afterIssue.json()).data.find((item) => item.id === issuedItem.id);
  assert.equal(doneItem.status, "in_progress");
  assert.equal(doneItem.issued_work_id, issued.work_id);
  const byIssuedWork = (await (await api.get(`/backlog?issued_work_id=${issued.work_id}`)).json()).data;
  assert.deepEqual(byIssuedWork.map((entry) => entry.id), [issuedItem.id]);
  assert.equal((await api.get("/backlog?issued_work_id=bad%")).status, 400);
  const doneFilter = await api.get(`/backlog?project_id=${projectA}`);
  assert.equal((await doneFilter.json()).data.some((item) => item.id === issuedItem.id), true);
  const issueDoneAgain = await api.write("POST", "/backlog/issue-work", {
    item_ids: [issuedItem.id], title: "Issue again", summary: "", size: "small",
  });
  assert.equal(issueDoneAgain.status, 409);
  assert.equal((await issueDoneAgain.json()).error.code, "invalid_state_transition");

  const dismissedItem = itemsForWorkA[1];
  const dismissResponse = await api.write("POST", "/backlog/dismiss", { item_ids: [dismissedItem.id] });
  assert.equal(dismissResponse.status, 200);
  assert.equal((await dismissResponse.json()).data.items[0].status, "dismissed");
  const dismissedFilter = await api.get(`/backlog?status=dismissed&project_id=${projectA}`);
  assert.equal((await dismissedFilter.json()).data.some((item) => item.id === dismissedItem.id), true);
  const dismissAgain = await api.write("POST", "/backlog/dismiss", { item_ids: [dismissedItem.id] });
  assert.equal(dismissAgain.status, 409);
  assert.equal((await dismissAgain.json()).error.code, "invalid_state_transition");
});

test("work backlog API paginates items and validates pagination values", async (t) => {
  const api = await startServer(t);
  const project = await createProject(api.root, api.durableCore, "pagination");
  const work = await createWork(api.durableCore, "pagination", project);
  await registerFindings(api.db, work, [
    { severity: "minor", pre_existing: false, file: "src/page-a.ts", problem: "Page A" },
    { severity: "minor", pre_existing: false, file: "src/page-b.ts", problem: "Page B" },
    { severity: "minor", pre_existing: false, file: "src/page-c.ts", problem: "Page C" },
  ]);

  const items = [];
  let offset = 0;
  while (true) {
    const response = await api.get(`/works/${work}/backlog?limit=1&offset=${offset}`);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.data.length, 1);
    items.push(...page.data);
    if (page.next_offset === null) break;
    assert.equal(page.next_offset, offset + 1);
    offset = page.next_offset;
  }
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map((item) => item.id)).size, 3);

  for (const query of ["limit=0", "limit=501", "offset=invalid"]) {
    const response = await api.get(`/works/${work}/backlog?${query}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "validation_error");
  }
});

test("all backlog routes require Owner authorization", async (t) => {
  const api = await startServer(t);
  const project = await createProject(api.root, api.durableCore, "auth");
  const work = await createWork(api.durableCore, "auth", project);
  await registerFindings(api.db, work, [
    { severity: "minor", pre_existing: false, file: "src/auth-a.ts", problem: "Unauthorized dismiss target" },
    { severity: "minor", pre_existing: false, file: "src/auth-b.ts", problem: "Unauthorized issue target" },
  ]);
  const items = (await (await api.get("/backlog")).json()).data;
  assert.equal(items.length, 2);

  for (const path of ["/backlog", `/works/${work}/backlog`]) {
    const response = await api.get(path, { auth: false });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "unauthorized");
  }
  const unauthorizedDismiss = await api.write("POST", "/backlog/dismiss", { item_ids: [items[0].id] }, { auth: false });
  assert.equal(unauthorizedDismiss.status, 401);
  assert.equal((await unauthorizedDismiss.json()).error.code, "unauthorized");
  const unauthorizedIssue = await api.write("POST", "/backlog/issue-work", {
    item_ids: [items[1].id], title: "Should not issue", summary: "", size: "small",
  }, { auth: false });
  assert.equal(unauthorizedIssue.status, 401);
  assert.equal((await unauthorizedIssue.json()).error.code, "unauthorized");

  const stillOpen = (await (await api.get("/backlog?status=open")).json()).data;
  assert.deepEqual(stillOpen.map((item) => item.id).sort(), items.map((item) => item.id).sort());
});

test("link API sets in_progress or done by Work state, rejects invalid cases, and status=in_progress filters", async (t) => {
  const api = await startServer(t);
  const projectA = await createProject(api.root, api.durableCore, "link-a");
  const projectB = await createProject(api.root, api.durableCore, "link-b");
  const source = await createWork(api.durableCore, "link-source", projectA);
  const otherSource = await createWork(api.durableCore, "link-other", projectB);
  const running = await createWork(api.durableCore, "link-running", projectA);
  const finished = await createWork(api.durableCore, "link-finished", projectA);
  const cancelled = await createWork(api.durableCore, "link-cancelled", projectA);
  const setState = (id, state) => api.db.createWriteLane().transact((tx) => {
    tx.run("UPDATE works SET state = ? WHERE id = ?", state, id);
  });
  await setState(running, "running");
  await setState(finished, "completed");
  await setState(cancelled, "cancelled");
  await registerFindings(api.db, source, ["a", "b", "c", "d"].map((name) => (
    { severity: "minor", pre_existing: false, file: `src/${name}.ts`, problem: `Issue ${name}` }
  )));
  await registerFindings(api.db, otherSource, [{ severity: "minor", pre_existing: false, file: "src/x.ts", problem: "Issue x" }]);
  const items = (await (await api.get(`/works/${source}/backlog`)).json()).data;
  const [i1, i2, i3, i4] = items.map((item) => item.id);
  const foreign = (await (await api.get(`/works/${otherSource}/backlog`)).json()).data[0].id;

  const link = (workId, ids) => api.write("POST", `/works/${workId}/backlog/link`, { item_ids: ids });

  const linkRunning = await link(running, [i1]);
  assert.equal(linkRunning.status, 200);
  const runningData = (await linkRunning.json()).data;
  assert.equal(runningData.status, "in_progress");
  assert.equal(runningData.items[0].status, "in_progress");
  assert.equal(runningData.items[0].issued_work_id, running);

  const linkFinished = await link(finished, [i2]);
  assert.equal(linkFinished.status, 200);
  const finishedData = (await linkFinished.json()).data;
  assert.equal(finishedData.status, "done");
  assert.equal(finishedData.items[0].status, "done");

  const filtered = await api.get("/backlog?status=in_progress");
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).data.map((item) => item.id), [i1]);

  const notOpen = await link(running, [i1]);
  assert.equal(notOpen.status, 409);
  assert.equal((await notOpen.json()).error.code, "invalid_state_transition");
  const toCancelled = await link(cancelled, [i3]);
  assert.equal(toCancelled.status, 409);
  assert.equal((await toCancelled.json()).error.code, "invalid_state_transition");
  const otherProject = await link(running, [foreign]);
  assert.equal(otherProject.status, 400);
  assert.equal((await otherProject.json()).error.code, "validation_error");
  const missingWork = await link(createUlid(), [i3]);
  assert.equal(missingWork.status, 404);
  assert.equal((await missingWork.json()).error.code, "work_not_found");
  const missingItem = await link(running, [createUlid()]);
  assert.equal(missingItem.status, 404);
  assert.equal((await missingItem.json()).error.code, "backlog_item_not_found");
  const empty = await link(running, []);
  assert.equal(empty.status, 400);
  const unauthorized = await api.write("POST", `/works/${running}/backlog/link`, { item_ids: [i4] }, { auth: false });
  assert.equal(unauthorized.status, 401);
  const invalidStatus = await api.get("/backlog?status=bogus");
  assert.equal(invalidStatus.status, 400);
});
