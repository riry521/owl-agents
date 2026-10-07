import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildWorkerPrompt } from "../../packages/agent-runtime/dist/worker.js";
import { promptFingerprint } from "../../packages/agent-runtime/dist/prompt-fingerprint.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { ownerGuidance } from "../../packages/core/dist/owner-guidance.js";
import { MemoryIndex } from "../../packages/core/dist/memory/memory-index.js";
import { MemorySearch } from "../../packages/core/dist/memory/memory-search.js";
import { SkillBox } from "../../packages/core/dist/skill-box.js";
import { renderSkillMd } from "../../packages/core/dist/skill-files.js";
import { dependencyContext } from "../../packages/core/dist/task-context.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { openTestDatabase } from "../helpers/db.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};
const NAMES = ["delta", "alpha", "charlie", "bravo"];
const NOTES = ["n1", "n2", "n3", "n4", "n5", "n6"];

async function skillBoxWith(t, names, { tie = false } = {}) {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-prompt-stability-skills-" });
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now,
  ));
  const skillBox = new SkillBox({ db, owlRoot: root, logger: { warn() {}, error() {} } });
  for (const name of names) {
    const meta = { description: `${name} procedure.`, scope: "global", tags: [] };
    await skillBox.applyRevision({ name, files: { "SKILL.md": renderSkillMd({ name, ...meta }, `# ${name}`) }, meta, actor: "user", action: "create", reason: "test", trial: false });
  }
  // Equal relevance (same scope, state, use count and update time): only the tie-break can choose.
  if (tie) await db.createWriteLane().transact((tx) => tx.run("UPDATE skills SET updated_at = ?", now));
  return { skillBox, root };
}

async function dependencyInput(t, order) {
  const { db, core } = await createTestCore(t, { agentRunner }, { prefix: "owl-prompt-stability-deps-", start: true });
  const workId = (await core.createWork(command({ title: "W", summary: "", size: "small", project_id: null }, "stability:work"))).data.work_id;
  const ids = ["01TASKAAAAAAAAAAAAAAAAAAAA", "01TASKBBBBBBBBBBBBBBBBBBBB", "01TASKCCCCCCCCCCCCCCCCCCCC", "01TASKDDDDDDDDDDDDDDDDDDDD"];
  const now = "2026-09-27T00:00:00.000Z";
  await db.createWriteLane().transact((tx) => {
    for (const [position, index] of order.entries()) {
      tx.run(
        `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, worktree_path, created_at, updated_at)
         VALUES (?, ?, ?, 'code', ?, 'normal', '', '', '/repo', ?, ?)`,
        ids[index], workId, `T${index}`, index === 3 ? "waiting" : "completed", `2026-09-27T00:00:0${position}.000Z`, now,
      );
    }
    for (const index of order.filter((i) => i !== 3)) {
      tx.run("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)", ids[3], ids[index]);
      for (const path of [`z-${index % 2}.txt`, "a.txt"]) {
        tx.run("INSERT INTO artifacts (id, work_id, task_id, path, kind, deliverable, sha256, bytes, mime, version_no, created_at) VALUES (?, ?, ?, ?, 'generated', 1, ?, 1, 'text/plain', 1, ?)", createUlid(), workId, ids[index], path, "a".repeat(64), now);
      }
    }
  });
  return { dependencies: dependencyContext(db, ids[3], "/data"), guidance: ownerGuidance(db, workId, ids[3]) };
}

/** Equal-relevance notes written in the given order; returns what a knowledge search selects with a limit below the tie size. */
async function knowledgeText(order) {
  const root = mkdtempSync(join(tmpdir(), "owl-prompt-stability-vault-"));
  try {
    const vault = join(root, "vault");
    const dataDir = join(root, "data");
    mkdirSync(join(vault, "global"), { recursive: true });
    mkdirSync(dataDir);
    const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
    const index = new MemoryIndex({ dataDir, storage, watch: false });
    await index.start();
    for (const name of order) {
      writeFileSync(join(vault, "global", `${name}.md`), `---\ntitle: Same ${name}\n---\nretry worker handles failures\n`);
      await index.rebuild("manual");
    }
    const { hits } = await new MemorySearch({ index, embedder: { enabled: false } }).search({ query: "retry worker", limit: 3 });
    await index.stop();
    return hits.map((hit) => hit.row.path).join("\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The whole Worker prompt (rules, knowledge, skills, dependencies, artifacts, guidance) built from one ordering of the inputs. */
async function workerPrompt(t, { names, tasks, notes }) {
  const { skillBox, root } = await skillBoxWith(t, names);
  const { dependencies, guidance } = await dependencyInput(t, tasks);
  const skills = skillBox.renderIndex(null, { max_items: 10 }).replaceAll(root, "<root>");
  return buildWorkerPrompt({
    task: { title: "T", acceptance: "A", context: "" },
    context: {
      rules: "[system] rule one\n[system] rule two",
      knowledge: await knowledgeText(notes),
      skills,
      dependency_reports: dependencies.dependency_reports,
      artifact_paths: dependencies.artifact_paths,
      owner_guidance: guidance,
    },
  });
}

test("the same input builds a byte-identical Worker prompt", async (t) => {
  const input = { names: NAMES, tasks: [0, 1, 2, 3], notes: NOTES };
  const first = await workerPrompt(t, input);
  assert.ok(first.includes("alpha procedure.") && first.includes("a.txt") && first.includes("n1.md"));
  assert.equal(await workerPrompt(t, input), first);
});

test("the Worker prompt does not depend on the order rows were inserted", async (t) => {
  const forward = await workerPrompt(t, { names: NAMES, tasks: [0, 1, 2, 3], notes: NOTES });
  const reversed = await workerPrompt(t, { names: [...NAMES].reverse(), tasks: [3, 2, 1, 0], notes: [...NOTES].reverse() });
  assert.equal(reversed, forward);
});

test("skill selection of equal-relevance candidates is stable under a count cap", async (t) => {
  const pick = async (names) => (await skillBoxWith(t, names, { tie: true })).skillBox.renderIndex(null, { max_items: 2 }).split("\n").map((line) => line.split(":")[0]);
  assert.deepEqual(await pick(NAMES), ["- alpha", "- bravo"]);
  assert.deepEqual(await pick([...NAMES].reverse()), ["- alpha", "- bravo"]);
});

test("a character cap keeps the most relevant skills, then renders them by name", async (t) => {
  // Newest first is the relevance order, so mike and zulu outrank alpha although alpha sorts first.
  const { skillBox } = await skillBoxWith(t, ["alpha", "zulu", "mike"]);
  const [, mike, zulu] = skillBox.renderIndex(null, { max_items: 10 }).split("\n");
  const capped = skillBox.renderIndex(null, { max_items: 10, max_characters: mike.length + zulu.length + 1 }).split("\n");
  assert.deepEqual(capped, [mike, zulu]);
});

test("knowledge selection of equal-relevance notes below the candidate cap is stable", async () => {
  const forward = await knowledgeText(NOTES);
  assert.equal(forward, "global/n1.md\nglobal/n2.md\nglobal/n3.md");
  assert.equal(await knowledgeText([...NOTES].reverse()), forward);
});

test("vector search keeps the same equal-distance notes when more than the candidate cap tie", async (t) => {
  const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))("better-sqlite3");
  const { CHUNKS_DDL, embedPending, knn, loadVec } = await import("../../packages/core/dist/memory/memory-vectors.js");
  const profile = { chunkChars: 1000, maxChunks: 1, prefix: false, headVec: 0, ftsHead: 0, content: false, maxTokens: 64 };
  const embedder = { model: "fake", embed: async (_kind, texts) => texts.map(() => new Float32Array([1, 0, 0])) };
  const makePaths = (n) => Array.from({ length: n }, (_, i) => `n${String(i).padStart(4, "0")}.md`);
  const select = async (t, order, { each = false, reembed = 0 } = {}) => {
    const db = new Database(":memory:");
    if (loadVec(db) !== null) { t.skip("sqlite-vec is not available"); db.close(); return null; }
    db.exec(`CREATE TABLE notes (path TEXT, title TEXT, summary TEXT, body TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); ${CHUNKS_DDL}`);
    for (const path of order) {
      db.prepare("INSERT INTO notes VALUES (?, 't', 's', 'b')").run(path);
      if (each) await embedPending(db, embedder, profile, {}, () => {});
    }
    await embedPending(db, embedder, profile, {}, () => {});
    for (const path of order.slice(0, reembed)) {
      const { rowid } = db.prepare("SELECT rowid FROM notes WHERE path = ?").get(path);
      db.prepare("DELETE FROM notes_vec WHERE rowid IN (SELECT chunk_id FROM note_chunks WHERE note_rowid = ?)").run(rowid);
      db.prepare("DELETE FROM note_chunks WHERE note_rowid = ?").run(rowid);
    }
    if (reembed) await embedPending(db, embedder, profile, {}, () => {});
    const { body } = knn(db, new Float32Array([1, 0, 0]));
    const picked = body.map((rowid) => db.prepare("SELECT path FROM notes WHERE rowid = ?").get(rowid).path).sort();
    db.close();
    return { picked, prompt: promptWith(picked.join("\n")) };
  };
  const promptWith = (knowledge) => buildWorkerPrompt({
    task: { title: "T", acceptance: "A", context: "" },
    context: { rules: "", knowledge, skills: null, dependency_reports: [], artifact_paths: [], owner_guidance: [] },
  });
  const paths = makePaths(201);
  const forward = await select(t, paths, { each: true });
  if (forward === null) return;
  assert.equal(forward.picked.length, 200);
  assert.deepEqual(await select(t, [...paths].reverse(), { each: true }), forward);
  assert.deepEqual(await select(t, [...paths].reverse(), { reembed: 100 }), forward);
  // More tied chunks than any single vec0 query can return.
  const many = makePaths(4100);
  const bulk = await select(t, many);
  assert.deepEqual(bulk.picked, many.slice(0, 200));
  assert.deepEqual(await select(t, [...many].reverse(), { reembed: 100 }), bulk);
});

test("owner guidance asks for a decision id tie-break", () => {
  let sql = "";
  ownerGuidance({ all: (query) => { sql = query; return []; } }, "w");
  assert.match(sql, /received_at DESC, decision_answers\.decision_id DESC/);
});

test("storage-unavailable notice keeps its wording and takes its time from the stored index page", async () => {
  const { IndexInjector } = await import("../../packages/core/dist/memory/index-injector.js");
  const row = { path: "p.md", title: "P の目次", page_type: "project-index", body: "## 概要\nx", body_sha256: "h", integrated_hash: null, source_hash: "s", updated: "2026-01-02T03:04:05.000Z" };
  const db = { prepare: (sql) => ({ get: () => (sql.includes("count(*)") ? { n: 1 } : row) }) };
  const index = { db: () => db, getProjectIndex: () => ({ path: "p.md" }), listPages: () => [], status: () => ({}) };
  const compose = (now) => new IndexInjector({ index, isAvailable: () => false, now: () => now }).compose({ role: "worker", query: [], project_id: "p" });
  const first = await compose(new Date("2030-01-01T00:00:00Z"));
  assert.match(first, /保管庫未接続：2026-01-02T03:04:05\.000Z 時点の目次/);
  assert.equal(await compose(new Date("2031-01-01T00:00:00Z")), first);
});

test("fingerprint: only the Reviewer findings change the dynamic hash, and the same input hashes the same", () => {
  const build = (reviewer_findings) => buildWorkerPrompt({
    task: { id: "t1", title: "T", acceptance: "A", context: "" },
    context: { rules: "[system] r", knowledge: "k", skills: "s", dependency_reports: [], artifact_paths: [], reviewer_findings },
  });
  const a = promptFingerprint(build([{ severity: "major", target: "deliverable", subject: "other", file: "a", line: 1, problem: "first", reason: "r", fix: "f" }]));
  const b = promptFingerprint(build([{ severity: "major", target: "deliverable", subject: "other", file: "a", line: 1, problem: "second", reason: "r", fix: "f" }]));
  assert.deepEqual(promptFingerprint(build([{ severity: "major", target: "deliverable", subject: "other", file: "a", line: 1, problem: "first", reason: "r", fix: "f" }])), a);
  for (const key of ["header", "project", "task"]) {
    assert.match(a[key], /^[0-9a-f]{64}$/);
    assert.equal(a[key], b[key], key);
  }
  assert.notEqual(a.dynamic, b.dynamic);
});
