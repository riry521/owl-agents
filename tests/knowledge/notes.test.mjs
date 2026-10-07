import assert from "node:assert/strict";
import { test } from "node:test";

import { KnowledgeBase } from "../../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../../packages/core/dist/knowledge-notes.js";
import { tempDir } from "../helpers/temp.mjs";

const WORK_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORK_B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const WORK_C = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

async function setup(t, options = {}) {
  const root = await tempDir(t, "owl-knowledge-notes-");
  const notes = new KnowledgeNotes(new KnowledgeBase(root), options);
  return { root, notes };
}

test("parse(render(note)) preserves the full note including Rule promotion", async (t) => {
  const { notes } = await setup(t);
  const note = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    title: "SQLite retry policy",
    slug: "sqlite-retry-policy",
    tags: ["database", "retry"],
    sources: [WORK_A],
    links: ["01ARZ3NDEKTSV4RRFFQ69G5FBA"],
    project_ids: [PROJECT],
    created: "2026-09-26T09:00:00.000Z",
    updated: "2026-09-26T10:30:00.000Z",
    summary: "Retry database operations with bounded backoff.",
    claims: [{
      fingerprint: "9f86d081884c7d65",
      kind: "fact",
      text: "test",
      sources: [WORK_A],
    }],
    promotions: [{
      date: "2026-09-26",
      proposal_id: "01ARZ3NDEKTSV4RRFFQ69G5FBB",
      status: "applied",
      path: "rules/system/retry.yaml#owl-01ARZ3NDEKTSV4RRFFQ69G5FBB",
    }],
  };

  assert.deepEqual(notes.parse(notes.render(note)), note);
});
