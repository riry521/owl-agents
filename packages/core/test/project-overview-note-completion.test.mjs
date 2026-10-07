import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core } from "../dist/index.js";
import { createUlid, openDatabase } from "../../db/dist/index.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
const envelope = (payload, key, version = 0) => ({ request_id: createUlid(), idempotency_key: `t:${key}:${createUlid()}`, expected_version: version, payload });

const agentRunner = {
  runManagerPlan: async (request) => request.mode === "finalize"
    ? { outcome: "success", report_valid: true, report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Done.", missing: [], lessons: [] } } }
    : { outcome: "failed", message: `unexpected manager ${request.mode}` },
  runWorker: async (request) => {
    await writeFile(join(request.context.worktree, "feature.test.mjs"), "export {};\n");
    return {
      outcome: "success", report_valid: true,
      report: {
        kind: "report", schema_version: "1.1.0", invocation_id: request.invocation_id, result: "success", work_done: "Done.",
        delegation: { decomposition: "Kept as one part.", delegated: [], retained: [{ part: "feature.test.mjs", reason: "Small." }] },
        changes: [],
        verification: { status: "passed", method: "Checked.", acceptance: [{ criterion_id: "AC1", criterion: "c", status: "passed", evidence: "e" }], checks: [], integration_check: null },
        remaining_issues: [], next_action: "none", needs_replanning: false, question_for_manager: null, skills_used: [], skill_proposals: [], pending_process: null,
      },
    };
  },
  runReviewer: async () => {
    const review = { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } };
    return { outcome: "success", report_valid: true, report: review, review };
  },
  runAdvisor: async () => ({ reply: "" }),
};

// Each read of README.md returns a new text, so a refresh changes the note.
function stubReader() {
  const state = { reads: 0, fail: false };
  return {
    state,
    listFiles: async () => ["README.md"],
    readFile: async () => {
      state.reads += 1;
      if (state.fail) throw new Error("reader boom");
      return `# Demo\n\nデモ版 ${state.reads}\n`;
    },
    changedPaths: async () => [],
  };
}

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owl-overview-completion-")));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const reader = stubReader();
  const core = new Core({ db, agentRunner, version: "t", owlRoot: root, projectSourceReader: reader, dispatcher: { tick_interval_ms: 25, manager_retry_delay_ms: 1 } });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await core.start();
  return { db, root, core, reader };
}

async function registerProject(core, root) {
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "user.email", "t@example.invalid");
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  return (await core.createProject(envelope({ name: "demo", canonical_path: repo, base_branch: "main", allowed_roots: [root], verification_plan: [] }, "project"))).data.id;
}

async function completeWork(core, db, projectId) {
  const created = await core.createWork(envelope({ title: "Add feature", summary: "Write feature.txt.", size: "small", project_id: projectId }, "create"));
  const workId = created.data.work_id;
  await core.startWork(workId, envelope({ mode: "small" }, "start", created.version));
  for (let i = 0; i < 600; i += 1) {
    const state = db.get("SELECT state FROM works WHERE id = ?", workId)?.state;
    if (state === "completed" || state === "judgement_waiting") return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  return "timeout";
}

// The overview lives in each project's "プロジェクトの構成" page under knowledge/.
async function overviews(root, dir = join(root, "knowledge")) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await overviews(root, path));
    else if (entry.name === "プロジェクトの構成.md") found.push(path);
  }
  return found;
}
const waitFor = async (read) => {
  for (let i = 0; i < 400; i += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
};

test("Work completion refreshes the overview note of its project", async (t) => {
  const { db, root, core, reader } = await setup(t);
  const projectId = await registerProject(core, root);
  const file = await waitFor(() => overviews(root).then((l) => l[0] ?? null));
  assert.ok(file, "registration creates the note");
  const before = await readFile(file, "utf8");
  const readsBefore = reader.state.reads;

  assert.equal(await completeWork(core, db, projectId), "completed");
  assert.ok(await waitFor(async () => (await readFile(file, "utf8")) !== before), "the note changed after completion");
  assert.ok(reader.state.reads > readsBefore);
  assert.deepEqual(await overviews(root), [file]);
});

test("a failing overview update does not stop Work completion", async (t) => {
  const { db, root, core, reader } = await setup(t);
  const projectId = await registerProject(core, root);
  await waitFor(() => overviews(root).then((l) => l.length === 1));
  reader.state.fail = true;
  const readsBefore = reader.state.reads;

  assert.equal(await completeWork(core, db, projectId), "completed");
  assert.ok(await waitFor(() => reader.state.reads > readsBefore), "the update was attempted");
});

test("a Work without a project does not touch overview notes", async (t) => {
  const { db, root, core, reader } = await setup(t);
  assert.equal(await completeWork(core, db, null), "completed");
  await core.stop({ force: true });
  assert.equal(reader.state.reads, 0);
  assert.deepEqual(await overviews(root), []);
});
