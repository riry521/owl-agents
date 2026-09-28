import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase, ResearchRecorder } from "../packages/core/dist/index.js";
import { extractWebResearchCapture, WEB_RESEARCH_MAX_CONTENT_CHARS } from "../packages/shared/dist/web-research.js";

function longArticle(suffix) {
  const length = WEB_RESEARCH_MAX_CONTENT_CHARS + 128;
  const heading = "# Public guide\n\n";
  const text = "This public article documents stable behavior for readers. ";
  const fillerLength = length - heading.length - suffix.length;
  return `${heading}${text.repeat(Math.ceil(fillerLength / text.length)).slice(0, fillerLength)}${suffix}`;
}

test("does not save long WebFetch results with password forms after the content cap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-research-auth-truncation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  const recorder = new ResearchRecorder({
    knowledge,
    isEnabled: () => true,
    language: () => "en",
    now: () => new Date("2026-09-28T01:02:03.000Z"),
  });

  const forms = [
    '<input type="password">',
    '<input autocomplete="current-password">',
  ];
  const originalLength = WEB_RESEARCH_MAX_CONTENT_CHARS + 128;
  for (const [index, form] of forms.entries()) {
    const content = longArticle(form);
    assert.equal(content.length, originalLength);
    const capture = index === 0
      ? extractWebResearchCapture("WebFetch", { url: `https://example.test/account-${index}` }, { result: content })
      : extractWebResearchCapture("WebFetch", { url: `https://example.test/account-${index}` }, undefined, { contentText: content });
    assert.ok(capture);
    assert.ok(capture.content.length > WEB_RESEARCH_MAX_CONTENT_CHARS);
    assert.equal(capture.content.includes(form), false);
    assert.equal(capture.auth_form_detected, true);
    assert.deepEqual(await recorder.record(capture, { role: "advisor" }), { status: "skipped", reason: "auth_page" });
  }
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "research")), []);

  const ordinaryContent = longArticle(" ".repeat(forms[0].length));
  assert.equal(ordinaryContent.length, originalLength);
  const ordinary = extractWebResearchCapture("WebFetch", { url: "https://example.test/guide" }, { result: ordinaryContent });
  assert.ok(ordinary);
  assert.equal(ordinary.auth_form_detected, undefined);
  const saved = await recorder.record(ordinary, { role: "advisor" });
  assert.equal(saved.status, "saved");
  if (saved.status === "saved") assert.equal(saved.created, true);
  assert.equal((await readdir(join(knowledge.knowledgeDir, "research"))).length, 1);
});
