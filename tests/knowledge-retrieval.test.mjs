import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_KNOWLEDGE_LIMITS,
  KnowledgeRetriever,
  estimateTokens,
  normalizeKnowledgeLimits,
} from "../packages/core/dist/knowledge-retrieval.js";

const NOTES = [
  note("note-01", "Git worktree cleanup", ["git", "worktree"], "2026-09-10", "Remove task worktrees after integration.", [
    claim("a", "pitfall", "Keep the Work branch outside the task worktree.", ["work-a", "work-b"]),
    claim("b", "fact", "Task worktrees isolate changes.", ["work-a"]),
  ], ["work-a", "work-b"]),
  note("note-02", "Git worktree isolation", ["git", "worktree"], "2026-09-12", "Use a separate worktree for each task.", [
    claim("c", "fact", "Separate worktrees avoid file conflicts.", ["work-a", "work-b", "work-c"]),
    claim("d", "decision", "Keep one branch per Work.", ["work-a"]),
  ], ["work-a", "work-b", "work-c"]),
  note("note-03", "SQLite transaction retry", ["sqlite", "retry"], "2026-09-11", "Retry transient database failures.", [
    claim("e", "fact", "Use bounded retries for SQLite busy errors.", ["work-c", "work-d"]),
  ], ["work-c", "work-d"]),
  note("note-04", "SQLite retry policy", ["sqlite", "retry"], "2026-09-13", "Retry only transient transaction errors.", [
    claim("f", "pitfall", "Do not retry validation failures.", ["work-c"]),
    claim("g", "decision", "Use three attempts for transient errors.", ["work-c", "work-d", "work-e"]),
  ], ["work-c", "work-d", "work-e"]),
  note("note-05", "日本語設計レビュー", ["日本語設計レビュー"], "2026-09-09", "日本語設計レビュー では前提を確認する。", [
    claim("h", "decision", "受け入れ条件を先に確認する。", ["work-jp"]),
  ], ["work-jp"]),
  note("note-06", "Git worktree migration", ["git", "worktree", "migration"], "2026-09-14", "Migrate worktree metadata before cleanup.", [
    claim("i", "fact", "Preserve worktree identifiers during migration.", ["work-a", "work-b"]),
  ], ["work-a", "work-b"]),
  note("note-07", "Python logging", ["python", "logging"], "2026-09-08", "Keep diagnostic logs concise.", [
    claim("j", "pitfall", "Do not log secrets.", ["work-f"]),
  ], ["work-f"]),
  note("note-08", "日本語要件整理", ["要件", "整理"], "2026-09-07", "要件を短い文章で整理する。", [
    claim("k", "fact", "曖昧な条件は明文化する。", ["work-jp"]),
  ], ["work-jp"]),
  note("note-09", "SQLite recovery", ["sqlite", "recovery"], "2026-09-06", "Recover from interrupted transactions.", [
    claim("l", "pitfall", "Check transaction state before retry.", ["work-c", "work-d"]),
  ], ["work-c", "work-d"]),
  note("note-10", "CSS layout", ["css", "layout"], "2026-09-05", "Prefer simple responsive layouts.", [
    claim("m", "fact", "Use grid for two-dimensional layouts.", ["work-g"]),
  ], ["work-g"], ["project-css"]),
];

const QUERIES = [
  {
    query: { work_title: "Git worktree migration", task_title: "Cleanup worktree", task_text: "git worktree integration", project_id: null },
    ids: ["note-06", "note-01", "note-02"],
    tokens: 144,
    characters: 573,
  },
  {
    query: { work_title: "SQLite retry", task_title: "transaction recovery", project_id: null },
    ids: ["note-03", "note-04", "note-09"],
    tokens: 129,
    characters: 514,
  },
  {
    query: { work_title: "日本語設計レビュー", task_title: "受け入れ条件", project_id: null },
    ids: ["note-05"],
    tokens: 57,
    characters: 102,
  },
];

function note(id, title, tags, updated, summary, claims, sources, project_ids = []) {
  return {
    id, title, slug: id, tags, updated, summary, claims, sources, links: [], project_ids,
    created: updated, promotions: [],
  };
}

function claim(fingerprint, kind, text, sources) {
  return { fingerprint, kind, text, sources };
}

function noteStore(list = NOTES) {
  return { list: async () => list };
}

function limits(overrides = {}) {
  return { max_notes: 3, max_tokens: 1000, per_note_tokens: 400, max_characters: 3000, min_score: 3, ...overrides };
}

test("select and render return the fixed notes, token counts, and character counts for three queries", async () => {
  const retriever = new KnowledgeRetriever(noteStore());
  for (const fixture of QUERIES) {
    const selected = await retriever.select(fixture.query, limits());
    assert.deepEqual(selected.map(({ note: selectedNote }) => selectedNote.id), fixture.ids);

    const result = await retriever.render(fixture.query, limits());
    assert.ok(result);
    assert.deepEqual({
      ids: [...result.text.matchAll(/^- \[([^\]]+)\]/gmu)].map((match) => match[1]),
      tokens: result.tokens,
      characters: result.characters,
    }, { ids: fixture.ids, tokens: fixture.tokens, characters: fixture.characters });
    assert.equal(result.tokens, estimateTokens(result.text));
    assert.equal(result.characters, result.text.length);
    assert.ok(result.notes <= limits().max_notes);
    assert.ok(result.tokens <= limits().max_tokens);
    assert.ok(result.characters <= limits().max_characters);
    for (const block of result.text.split("\n\n")) assert.ok(estimateTokens(block) <= limits().per_note_tokens);
  }
});

test("render spends its budget on higher-ranked notes, then drops weaker claims, then truncates summary", async () => {
  const retriever = new KnowledgeRetriever(noteStore());
  const query = QUERIES[0].query;
  const selected = await retriever.select(query, limits());
  assert.deepEqual(selected.map(({ note: selectedNote }) => selectedNote.id), ["note-06", "note-01", "note-02"]);

  const complete = await retriever.render(query, limits());
  assert.ok(complete);
  const topRankedNote = complete.text.split("\n\n")[0];
  const oneNoteBudget = await retriever.render(query, limits({
    max_tokens: estimateTokens(topRankedNote), max_characters: topRankedNote.length,
  }));
  assert.ok(oneNoteBudget);
  assert.equal(oneNoteBudget.notes, 1);
  assert.match(oneNoteBudget.text, /\[note-06\]/u);
  assert.doesNotMatch(oneNoteBudget.text, /\[note-01\]/u);
  assert.equal(oneNoteBudget.text, topRankedNote);

  const claimBudget = await retriever.render({ work_title: "SQLite policy", task_title: "validation failures attempts", project_id: null }, limits({ max_notes: 1, max_tokens: 1000, per_note_tokens: 50, max_characters: 1000 }));
  assert.ok(claimBudget);
  assert.match(claimBudget.text, /three attempts for transient errors/u);
  assert.doesNotMatch(claimBudget.text, /Do not retry validation failures/u);
  assert.ok(estimateTokens(claimBudget.text) <= 50);

  const summaryBudget = await retriever.render(QUERIES[2].query, limits({ max_notes: 1, max_tokens: 1000, per_note_tokens: 38, max_characters: 1000 }));
  assert.ok(summaryBudget);
  assert.match(summaryBudget.text, /Summary: .*…/u);
  assert.doesNotMatch(summaryBudget.text, /受け入れ条件を先に確認する/u);
  assert.ok(summaryBudget.tokens <= 38);
});

test("select adds the project match bonus", async () => {
  const retriever = new KnowledgeRetriever(noteStore());
  const query = { work_title: "layout", project_id: "project-css" };
  assert.deepEqual((await retriever.select(query, limits())).map(({ note }) => note.id), ["note-10"]);
  assert.deepEqual((await retriever.select({ ...query, project_id: null }, limits())), []);
});

test("estimateTokens uses normalized ASCII quarters and one token per non-ASCII code point", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("あいう"), 3);
  assert.equal(estimateTokens("AあBCい"), 3);
  assert.equal(estimateTokens("ＡＢＣＤ"), 1);
});

test("knowledge limits default and clamp settings above the design ceilings", () => {
  assert.deepEqual(DEFAULT_KNOWLEDGE_LIMITS, {
    max_notes: 3, max_tokens: 1500, per_note_tokens: 600, max_characters: 4000, min_score: 3,
  });
  assert.deepEqual(normalizeKnowledgeLimits({ max_notes: 99, max_tokens: 5000, per_note_tokens: 1600, max_characters: 12001 }), {
    ...DEFAULT_KNOWLEDGE_LIMITS, max_notes: 10, max_tokens: 4000, per_note_tokens: 1500, max_characters: 12000,
  });
});

test("render returns null when there are no notes or reading notes fails", async () => {
  const query = QUERIES[0].query;
  assert.equal(await new KnowledgeRetriever(noteStore([])).render(query, limits()), null);
  assert.equal(await new KnowledgeRetriever({ list: async () => { throw new Error("read failed"); } }).render(query, limits()), null);
});
