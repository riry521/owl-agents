import assert from "node:assert/strict";
import { test } from "node:test";

import { createCore } from "../../packages/core/dist/index.js";
import { ADVISOR_TEXT } from "../../packages/core/dist/advisor-text.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { openTestDatabase } from "../helpers/db.mjs";

async function setup(t) {
  const { root, db } = await openTestDatabase(t, { prefix: "owl-advisor-prereq-" });
  const agentRunner = {
    runManagerPlan: async () => { throw new Error("unexpected"); },
    runWorker: async () => ({ outcome: "failed", failure_class: "deterministic", error_key: "prereq_test", retry_allowed: false, message: "stop" }),
    runReviewer: async () => { throw new Error("unexpected"); },
    runAdvisor: async () => { throw new Error("unexpected"); },
  };
  const core = createCore({ db, agentRunner, version: "prereq-test", owlRoot: root, dataDir: root });
  const { conversation_id } = await core.getActiveConversation();
  const send = async (title, extra) => {
    const a = { type: "create_work", description: title, payload: { title, summary: `Do ${title}.`, size: "small", project_id: null, ...extra } };
    const id = await core.persistAdvisorReply(conversation_id, "", createUlid(), { channel: "web" }, [a]);
    return db.get("SELECT body FROM messages WHERE id = ?", id).body;
  };
  return { db, send };
}

const workByTitle = (db, title) => db.get("SELECT id, state FROM works WHERE title = ?", title);
const prerequisitesOf = (db, id) =>
  db.all("SELECT prerequisite_work_id FROM work_prerequisites WHERE work_id = ?", id).map((row) => row.prerequisite_work_id);

test("create_work with prerequisite_work_ids waits as ready and says so", async (t) => {
  const { db, send } = await setup(t);
  await send("Base");
  const base = workByTitle(db, "Base");
  const body = await send("After base", { prerequisite_work_ids: [base.id] });
  const work = workByTitle(db, "After base");
  assert.equal(work.state, "ready");
  assert.deepEqual(prerequisitesOf(db, work.id), [base.id]);
  assert.equal(body, ADVISOR_TEXT.ja.createdWaiting("After base", work.id));
});

test("a draft create_work keeps the prerequisites as a memo", async (t) => {
  const { db, send } = await setup(t);
  await send("Base");
  const base = workByTitle(db, "Base");
  await send("Draft after base", { draft: true, prerequisite_work_ids: [base.id] });
  const work = workByTitle(db, "Draft after base");
  assert.equal(work.state, "memo");
  assert.deepEqual(prerequisitesOf(db, work.id), [base.id]);
});

test("a missing prerequisite Work fails the creation", async (t) => {
  const { db, send } = await setup(t);
  const missing = createUlid();
  const body = await send("Orphan", { prerequisite_work_ids: [missing] });
  assert.equal(workByTitle(db, "Orphan"), undefined);
  assert.equal(body, ADVISOR_TEXT.ja.createFailed(`Prerequisite Work ${missing} was not found.`));
});

test("the Advisor system prompt documents prerequisite_work_ids", async (t) => {
  const { ADVISOR_CURATION_INSTRUCTION } = await import("../../packages/shared/dist/index.js");
  assert.match(ADVISOR_CURATION_INSTRUCTION, /prerequisite_work_ids/u);
});
