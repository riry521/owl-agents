import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTestCore } from "../helpers/core.mjs";

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

async function fixture(t, { researchAutosave = true, withAdvisor = false } = {}) {
  const { root, db, core } = await createTestCore(t, {
    agentRunner,
    version: "research-test",
    ...(withAdvisor ? { providerClient: { createSession: async () => ({}) } } : {}),
  }, { prefix: "owl-core-research-" });
  const writeLane = db.createWriteLane();
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W1', 'owner:default', NULL, 'Research Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES ('T1', 'W1', 'Research Task', 'research', 'running', 'normal', '', '', ?, ?)`,
      now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES ('run-worker-1', 'W1', 'T1', 'worker', 'claude', 'test-model', 'running', ?, ?)`,
      now, now,
    );
    if (!researchAutosave) {
      tx.run(
        `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at)
         VALUES ('knowledge_automation', 'owner:default', '1.0.0', ?, ?)`,
        JSON.stringify({ librarian_times: ["03:00", "15:00"], research_autosave: false }),
        now,
      );
    }
    if (withAdvisor) {
      tx.run(
        `INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at)
         VALUES ('C1', 'owner:default', 'W1', 'web', 1, ?, ?), ('C2', 'owner:default', NULL, 'web', 0, ?, ?)`,
        now, now, now, now,
      );
    }
  });
  return { root, db, core };
}

function capture(content = "This is a sufficiently detailed result about the requested page.") {
  return {
    tool: "WebFetch",
    url: "https://example.com/guide",
    query: null,
    prompt: "Find the most useful facts",
    title: "Example Research Title",
    content,
    links: [],
    http_status: 200,
    is_error: false,
  };
}

test("Core records Work attribution and source metadata in a research note", async (t) => {
  const state = await fixture(t);
  const result = await state.core.recordAgentResearch({ agent_run_id: "run-worker-1", role: "worker" }, capture());
  assert.deepEqual(result, { accepted: true });
  await state.core.researchRecorder.idle();

  const [note] = await state.core.knowledge.list("research");
  assert.ok(note);
  const markdown = await readFile(join(state.root, "knowledge", note.path), "utf8");
  assert.match(markdown, /^work_id: W1$/mu);
  assert.match(markdown, /^task_id: T1$/mu);
  assert.match(markdown, /^agent_role: worker$/mu);
  assert.match(markdown, /^url: https:\/\/example\.com\/guide$/mu);
  assert.match(markdown, /^title: Example Research Title$/mu);
  assert.match(markdown, /^work_title: Research Work$/mu);
  assert.match(markdown, /^researched_at: \d{4}-\d{2}-\d{2}T/mu);
  assert.match(markdown, /^# Example Research Title$/mu);
});

test("Advisor research includes Work attribution only for Work-linked conversations", async (t) => {
  const state = await fixture(t, { withAdvisor: true });
  const onWebResearch = state.core.advisorRuntime.config.onWebResearch;
  onWebResearch(capture(), { conversation_id: "C1", turn_id: "turn-1" });
  onWebResearch({ ...capture(), url: "https://example.com/other" }, { conversation_id: "C2", turn_id: "turn-2" });
  await state.core.researchRecorder.idle();

  const notes = await state.core.knowledge.list("research");
  assert.equal(notes.length, 2);
  const linked = await readFile(join(state.root, "knowledge", notes.find((note) => note.path.includes("guide"))?.path), "utf8");
  const unlinked = await readFile(join(state.root, "knowledge", notes.find((note) => note.path.includes("other"))?.path), "utf8");
  assert.match(linked, /^work_id: W1$/mu);
  assert.match(linked, /^work_title: Research Work$/mu);
  assert.match(unlinked, /^work_id: ""$/mu);
  assert.match(unlinked, /^work_title: ""$/mu);
});

test("Core updates the existing research note when the same URL is recorded again", async (t) => {
  const state = await fixture(t);
  await state.core.recordAgentResearch({ agent_run_id: "run-worker-1", role: "worker" }, capture("First result has enough detail for a useful note."));
  await state.core.researchRecorder.idle();
  await state.core.recordAgentResearch({ agent_run_id: "run-worker-1", role: "worker" }, capture("Updated result has different details and replaces the previous excerpt."));
  await state.core.researchRecorder.idle();

  const notes = await state.core.knowledge.list("research");
  assert.equal(notes.length, 1);
  const markdown = await readFile(join(state.root, "knowledge", notes[0].path), "utf8");
  assert.match(markdown, /Updated result has different details/u);
  assert.doesNotMatch(markdown, /First result has enough detail/u);
});

test("Core updates one WebSearch note by normalized query when result links change", async (t) => {
  const state = await fixture(t);
  const first = await state.core.recordAgentResearch(
    { agent_run_id: "run-worker-1", role: "worker" },
    {
      tool: "WebSearch", url: null, query: "Public Guide", prompt: null, title: null,
      content: "Initial result explains stable public behavior for readers.",
      links: [{ title: "First guide", url: "https://example.com/first" }],
      http_status: null, is_error: false,
    },
  );
  await state.core.researchRecorder.idle();
  const updated = await state.core.recordAgentResearch(
    { agent_run_id: "run-worker-1", role: "worker" },
    {
      tool: "WebSearch", url: null, query: "  public   guide ", prompt: null, title: null,
      content: "Updated result describes newer public behavior for readers.",
      links: [{ title: "Second guide", url: "https://example.com/second" }],
      http_status: null, is_error: false,
    },
  );
  await state.core.researchRecorder.idle();

  assert.deepEqual(first, { accepted: true });
  assert.deepEqual(updated, { accepted: true });
  const notes = await state.core.knowledge.list("research");
  assert.equal(notes.length, 1);
  const markdown = await readFile(join(state.root, "knowledge", notes[0].path), "utf8");
  assert.match(markdown, /^research_key: search:public guide$/mu);
  assert.match(markdown, /^query: public guide$/mu);
  assert.match(markdown, /^work_id: W1$/mu);
  assert.match(markdown, /^work_title: Research Work$/mu);
  assert.match(markdown, /Updated result describes newer public behavior/u);
  assert.match(markdown, /\[Second guide\]\(https:\/\/example\.com\/second\)/u);
  assert.doesNotMatch(markdown, /Initial result|First guide/u);
});

test("Core skips research capture when autosave is disabled", async (t) => {
  const state = await fixture(t, { researchAutosave: false });
  const result = await state.core.recordAgentResearch({ agent_run_id: "run-worker-1", role: "worker" }, capture());
  assert.deepEqual(result, { accepted: false, reason: "disabled" });
  await state.core.researchRecorder.idle();
  assert.deepEqual(await state.core.knowledge.list("research"), []);
});

test("Core can save a capture when its Agent run row is unavailable", async (t) => {
  const state = await fixture(t);
  const result = await state.core.recordAgentResearch({ agent_run_id: "not-in-db", role: "reviewer" }, capture());
  assert.deepEqual(result, { accepted: true });
  await state.core.researchRecorder.idle();
  const [note] = await state.core.knowledge.list("research");
  const markdown = await readFile(join(state.root, "knowledge", note.path), "utf8");
  assert.match(markdown, /^work_id: ""$/mu);
  assert.match(markdown, /^task_id: ""$/mu);
  assert.match(markdown, /^agent_role: reviewer$/mu);
});

test("Core logs a failed research save and records a system.alert on the Work", async (t) => {
  const state = await fixture(t);
  state.core.knowledge.create = async () => { throw new Error("disk full", { cause: "ENOSPC" }); };
  const warnings = [];
  t.mock.method(console, "warn", (...args) => { warnings.push(args.map(String).join(" ")); });

  await state.core.recordAgentResearch({ agent_run_id: "run-worker-1", role: "worker" }, capture());
  await state.core.researchRecorder.idle();
  await state.core.writeLane.transact(() => null); // the alert is written in the background

  assert.ok(warnings.some((line) => line.includes("write_failed")), "the recorder logs the failure");
  assert.ok(warnings.some((line) => line.includes("disk full") && line.includes("ENOSPC")), "the log keeps the message and cause");
  const alert = state.db.all("SELECT work_id, task_id, payload_json FROM events WHERE type = 'system.alert'")
    .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }))
    .find((row) => row.payload.kind === "research_record_failed");
  assert.ok(alert, "an Owner-visible event is recorded");
  assert.equal(alert.work_id, "W1");
  assert.equal(alert.task_id, "T1");
  assert.equal(alert.payload.message, "disk full");
  assert.equal(alert.payload.cause, "ENOSPC");
});

test("Core records a system.alert on the Work when an Advisor web research result could not be read", async (t) => {
  const state = await fixture(t, { withAdvisor: true });
  t.mock.method(console, "warn", () => {});

  state.core.advisorRuntime.config.onWebResearchFailed("bad result", { conversation_id: "C1", turn_id: "turn-1" });
  await state.core.writeLane.transact(() => null); // the alert is written in the background

  const alert = state.db.all("SELECT work_id, payload_json FROM events WHERE type = 'system.alert'")
    .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }))
    .find((row) => row.payload.kind === "advisor_web_research_failed");
  assert.ok(alert, "an Owner-visible event is recorded");
  assert.equal(alert.work_id, "W1");
  assert.equal(alert.payload.message, "bad result");
  assert.equal(alert.payload.conversation_id, "C1");
});
