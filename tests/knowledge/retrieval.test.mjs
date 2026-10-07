import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_KNOWLEDGE_LIMITS,
  PROJECT_OVERVIEW_BUDGET,
  estimateTokens,
  normalizeKnowledgeLimits,
  renderProjectOverview,
} from "../../packages/core/dist/knowledge-retrieval.js";

function note(summary, claims = []) {
  return { id: "overview-a", title: "プロジェクト概要: A", slug: "overview-a", tags: [], updated: "2026-09-10", summary, claims, sources: [], links: [], project_ids: ["p"], created: "2026-09-10", promotions: [] };
}

test("renderProjectOverview renders the title, summary and claims in order", () => {
  const text = renderProjectOverview(note("Alpha summary", [{ fingerprint: "a", kind: "fact", text: "alpha purpose", sources: [] }]));
  assert.match(text, /プロジェクト概要: A/u);
  assert.ok(text.indexOf("Alpha summary") < text.indexOf("alpha purpose"));
});

test("renderProjectOverview stays within the overview budget", () => {
  const long = "overview text ".repeat(300);
  const text = renderProjectOverview(note(long, Array.from({ length: 10 }, (_, index) => ({ fingerprint: `c${index}`, kind: "fact", text: long, sources: [] }))));
  assert.ok(estimateTokens(text) <= PROJECT_OVERVIEW_BUDGET.tokens && text.length <= PROJECT_OVERVIEW_BUDGET.characters);
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
