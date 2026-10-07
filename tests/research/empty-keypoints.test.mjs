import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../helpers/temp.mjs";

import { KnowledgeBase, ResearchRecorder } from "../../packages/core/dist/index.js";

async function setup(t) {
  const root = await tempDir(t, "owl-research-empty-keypoints-");
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  const recorder = new ResearchRecorder({
    knowledge,
    isEnabled: () => true,
    language: () => "en",
    now: () => new Date("2026-09-28T01:02:03.000Z"),
  });
  return { knowledge, recorder };
}

function webFetch(title, content) {
  return {
    tool: "WebFetch", url: "https://docs.example.test/guide", query: null, prompt: null,
    title, content, links: [], http_status: 200, is_error: false,
  };
}

async function noteText(knowledge, result) {
  return readFile(join(knowledge.knowledgeDir, result.path), "utf8");
}

test("uses the safe title as a key point when WebFetch content contains only a heading", async (t) => {
  const { recorder, knowledge } = await setup(t);
  const title = "A Safe Guide Title";
  const content = `# ${"Some Heading Title ".repeat(3)}`;

  const result = await recorder.record(webFetch(title, content), { role: "worker" });

  assert.equal(result.status, "saved");
  const note = await noteText(knowledge, result);
  assert.match(note, new RegExp(`## 要点\\n- ${title}`, "u"));
  assert.doesNotMatch(note, /## 要点\n\s*(?:##|$)/u);
});

test("does not create a WebFetch note when heading-only content has no safe title", async (t) => {
  const { recorder, knowledge } = await setup(t);
  const result = await recorder.record(webFetch("", `# ${"Some Heading Title ".repeat(3)}`), { role: "worker" });

  assert.deepEqual(result, { status: "skipped", reason: "empty_content" });
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "research")), []);
});

test("masks a token in the title before using it as a key point", async (t) => {
  const { recorder, knowledge } = await setup(t);
  const dummyToken = ["sk", "ant", "test".repeat(4)].join("-");
  const result = await recorder.record(
    webFetch(`Public guide ${dummyToken}`, `# ${"Some Heading Title ".repeat(3)}`),
    { role: "worker" },
  );

  assert.equal(result.status, "saved");
  const note = await noteText(knowledge, result);
  assert.match(note, /## 要点\n- Public guide \[REDACTED\]/u);
  assert.doesNotMatch(note, new RegExp(dummyToken, "u"));
});

test("WebSearch fallback points prevent empty key points sections for every result shape", async (t) => {
  const { recorder, knowledge } = await setup(t);
  const noExcerpt = await recorder.record({
    tool: "WebSearch", url: null, query: "public guide", prompt: null, title: null,
    content: "# Heading only",
    links: [{ title: "Public guide", url: "https://example.test/guide" }],
    http_status: null, is_error: false,
  }, { role: "advisor" });
  const emptyTitle = await recorder.record({
    tool: "WebSearch", url: null, query: "untitled result", prompt: null, title: null,
    content: "# Heading only",
    links: [{ title: "", url: "https://example.test/untitled" }],
    http_status: null, is_error: false,
  }, { role: "advisor" });
  const noLinks = await recorder.record({
    tool: "WebSearch", url: null, query: "no result links", prompt: null, title: null,
    content: "# Heading only", links: [],
    http_status: null, is_error: false,
  }, { role: "advisor" });

  for (const result of [noExcerpt, emptyTitle, noLinks]) assert.equal(result.status, "saved");
  const files = await readdir(join(knowledge.knowledgeDir, "research"));
  assert.equal(files.length, 3);
  for (const file of files) {
    const note = await readFile(join(knowledge.knowledgeDir, "research", file), "utf8");
    assert.match(note, /## 要点\n- .+/u);
    assert.doesNotMatch(note, /## 要点\n\s*(?:##|$)/u);
  }
});
