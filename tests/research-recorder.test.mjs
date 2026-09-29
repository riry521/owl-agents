import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeBase, ResearchRecorder, extractResearchKeyPoints } from "../packages/core/dist/index.js";

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "owl-research-recorder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knowledge = new KnowledgeBase(root);
  await knowledge.ensureDirectories();
  let currentTime = new Date("2026-09-28T01:02:03.000Z");
  const recorder = new ResearchRecorder({
    knowledge,
    isEnabled: options.isEnabled ?? (() => true),
    language: options.language ?? (() => "ja"),
    now: options.now ?? (() => currentTime),
    ...(options.maxQueue === undefined ? {} : { maxQueue: options.maxQueue }),
  });
  return { knowledge, recorder, setNow: (time) => { currentTime = new Date(time); } };
}

function capture(url = "https://docs.example.test/guide", content = "# Guide\n\n- This is a sufficiently long key point for the research note.\n\nThe reference explains useful behavior for callers.") {
  return { tool: "WebFetch", url, query: null, prompt: "Explain the guide", title: "Guide", content, links: [], http_status: 200, is_error: false };
}

test("records source attribution and extracted key points", async (t) => {
  const { recorder, knowledge } = await setup(t);

  const result = await recorder.record(capture(), { role: "worker", work_id: "work-7", work_title: "Research: \"quoted\"\npassword: fake-password-value", task_id: "task-2", agent_run_id: "run-3" });

  assert.equal(result.status, "saved");
  assert.equal(result.created, true);
  assert.match(result.path, /^research\/docs-example-test-guide-[a-f0-9]{8}\.md$/u);
  const note = await readFile(join(knowledge.knowledgeDir, result.path), "utf8");
  for (const field of ["url: https://docs.example.test/guide", "title: \"Guide\"", "summary:", "researched_at: 2026-09-28T01:02:03.000Z", "first_researched_at: 2026-09-28T01:02:03.000Z", "agent_role: worker", "work_id: work-7", "work_title: \"Research: \\\"quoted\\\" password: [REDACTED]\"", "task_id: task-2", "status: active"]) {
    assert.ok(note.includes(field), `missing ${field}`);
  }
  assert.match(note, /query: ""/u);
  assert.match(note, /conversation_id: ""/u);
  assert.match(note, /## 要点\n- This is a sufficiently long key point/u);
  assert.match(note, /- Work: work-7 — Research: "quoted" password: \[REDACTED\]/u);
  assert.doesNotMatch(note, /fake-password-value/u);
  assert.match(note, /- 調査ロール: worker/u);
  assert.match(note, /- 調査日: 2026-09-28T01:02:03\.000Z/u);
  assert.deepEqual(extractResearchKeyPoints("A regular sentence that should lose to extracted bullets.\n# H\n```\n- ignored code item long enough\n```\n- This bullet has enough useful content."), ["This bullet has enough useful content."]);
  assert.deepEqual(extractResearchKeyPoints("The first sentence has more than twenty useful characters. The second sentence also contains enough useful characters. The third sentence is another sufficiently useful point. A fourth sentence should be ignored."), [
    "The first sentence has more than twenty useful characters.",
    "The second sentence also contains enough useful characters.",
    "The third sentence is another sufficiently useful point.",
  ]);
  const clippedPoint = extractResearchKeyPoints(`- ${"x".repeat(220)}`)[0];
  assert.equal(Array.from(clippedPoint).length, 200);
  assert.ok(clippedPoint.endsWith("…"));
});

test("updates one note for equivalent URLs and preserves first research time", async (t) => {
  const { recorder, knowledge, setNow } = await setup(t);
  const first = await recorder.record(capture(), { role: "advisor", conversation_id: "conversation-1", work_id: "old-work" });
  const createdLine = (await readFile(join(knowledge.knowledgeDir, first.path), "utf8")).match(/^created: .*$/mu)[0];
  await knowledge.update(first.path, { metadata: { status: "stale_flagged" } });
  setNow("2026-09-29T02:03:04.000Z");

  const second = await recorder.record(capture("http://docs.example.test/guide/?utm_source=mail#start", "# New guide\n\n- This updated point remains long enough for inclusion in the research note."), { role: "manager", work_id: "new-work" });

  assert.equal(second.status, "saved");
  assert.equal(second.created, false);
  assert.equal(second.path, first.path);
  assert.equal((await readdir(join(knowledge.knowledgeDir, "research"))).length, 1);
  const note = await readFile(join(knowledge.knowledgeDir, first.path), "utf8");
  assert.match(note, /first_researched_at: 2026-09-28T01:02:03\.000Z/u);
  assert.ok(note.includes(createdLine));
  assert.match(note, /researched_at: 2026-09-29T02:03:04\.000Z/u);
  assert.match(note, /work_id: new-work/u);
  assert.match(note, /status: active/u);
});

test("filters unsafe and secret-heavy captures without persisting them", async (t) => {
  const { recorder, knowledge } = await setup(t);
  const unsafe = await recorder.record(capture("https://localhost/private"), { role: "worker" });
  const login = await recorder.record(capture("https://docs.example.test/login"), { role: "worker" });
  const secrets = await recorder.record(capture(undefined, "password: fake-password-value\n".repeat(6)), { role: "worker" });

  assert.deepEqual(unsafe, { status: "skipped", reason: "private_host" });
  assert.deepEqual(login, { status: "skipped", reason: "auth_page" });
  assert.deepEqual(secrets, { status: "skipped", reason: "secret_heavy" });
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "research")), []);
});

test("redacts isolated secrets and rejects captures dominated by secret values", async (t) => {
  const { recorder, knowledge } = await setup(t);
  const safeContent = `This guide contains password: fake-password-value in an example. ${"It documents public API behavior for callers. ".repeat(8)}`;
  const saved = await recorder.record(capture(undefined, safeContent), { role: "worker" });
  const note = await readFile(join(knowledge.knowledgeDir, saved.path), "utf8");

  assert.equal(saved.status, "saved");
  assert.doesNotMatch(note, /fake-password-value/u);
  assert.match(note, /\[REDACTED\]/u);
  assert.deepEqual(await recorder.record(capture(undefined, "password: fake-password-value and little else"), { role: "worker" }), {
    status: "skipped", reason: "secret_heavy",
  });
});

test("skips tool errors, HTTP errors, redirects, and short content", async (t) => {
  const { recorder, knowledge } = await setup(t);
  assert.deepEqual(await recorder.record({ ...capture(), is_error: true }, { role: "worker" }), { status: "skipped", reason: "tool_error" });
  assert.deepEqual(await recorder.record({ ...capture(), http_status: 404 }, { role: "worker" }), { status: "skipped", reason: "http_error" });
  assert.deepEqual(await recorder.record(capture(undefined, `REDIRECT DETECTED ${"page content ".repeat(8)}`), { role: "worker" }), { status: "skipped", reason: "redirect" });
  assert.deepEqual(await recorder.record(capture(undefined, "Too short."), { role: "worker" }), { status: "skipped", reason: "empty_content" });
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "research")), []);
});

test("bounds queued writes and serializes them", async (t) => {
  const { recorder, knowledge } = await setup(t, { maxQueue: 1 });
  let release;
  let markEntered;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const get = knowledge.get.bind(knowledge);
  knowledge.get = async (...args) => {
    markEntered();
    await gate;
    return get(...args);
  };

  const first = recorder.record(capture(), { role: "worker" });
  await entered;
  const full = await recorder.record(capture("https://docs.example.test/other"), { role: "worker" });
  release();

  assert.deepEqual(full, { status: "skipped", reason: "queue_full" });
  assert.equal((await first).created, true);
  await recorder.idle();
  assert.equal((await readdir(join(knowledge.knowledgeDir, "research"))).length, 1);
});

test("returns disabled without writing when autosave is off", async (t) => {
  const { recorder, knowledge } = await setup(t, { isEnabled: () => false });

  assert.deepEqual(await recorder.record(capture(), { role: "worker" }), { status: "skipped", reason: "disabled" });
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "research")), []);
});

test("reports write failures without rejecting", async (t) => {
  const { recorder, knowledge } = await setup(t);
  await rm(join(knowledge.knowledgeDir, "research"), { recursive: true, force: true });
  await writeFile(join(knowledge.knowledgeDir, "research"), "blocks the directory");
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await recorder.record(capture(), { role: "worker" });
    assert.equal(result.status, "failed");
    assert.doesNotMatch(result.error, /docs\.example|Guide/u);
  } finally {
    console.warn = originalWarn;
  }
});

test("writes search notes with only public result links", async (t) => {
  const { recorder, knowledge } = await setup(t, { language: () => "en" });
  const result = await recorder.record({
    tool: "WebSearch", url: null, query: "  Owl   Guides ", prompt: null, title: null,
    content: [
      "Search overview provides enough context to make this result useful to readers.",
      "Public guide https://example.test/guide describes useful public behavior for readers.",
      "Local page http://localhost/private contains PRIVATE_LOCAL_MARKER and must never be saved.",
    ].join("\n\n"),
    links: [{ title: "Public guide", url: "https://example.test/guide" }, { title: "Local", url: "http://localhost/private" }],
    http_status: null, is_error: false,
  }, { role: "reviewer" });

  assert.equal(result.status, "saved");
  const note = await readFile(join(knowledge.knowledgeDir, result.path), "utf8");
  assert.match(note, /^url: ""$/mu);
  assert.match(note, /^research_key: search:owl guides$/mu);
  assert.match(note, /query: "Owl Guides"/u);
  assert.match(note, /## Key points\n- Search overview provides enough context/u);
  assert.match(note, /## Search results\n- \[Public guide\]\(https:\/\/example\.test\/guide\)/u);
  assert.match(note, /Public guide https:\/\/example\.test\/guide describes useful public behavior/u);
  assert.doesNotMatch(note, /localhost|192\.168|PRIVATE_LOCAL_MARKER|Local page/u);
});

test("uses the safe WebSearch title as a key point when the body has no extractable points", async (t) => {
  const { recorder, knowledge } = await setup(t, { language: () => "en" });
  const result = await recorder.record({
    tool: "WebSearch", url: null, query: "public guide", prompt: null, title: "Public guide title",
    content: "# Heading only",
    links: [{ title: "Public guide", url: "https://example.test/guide" }],
    http_status: null, is_error: false,
  }, { role: "reviewer" });

  assert.equal(result.status, "saved");
  const note = await readFile(join(knowledge.knowledgeDir, result.path), "utf8");
  assert.match(note, /## Key points\n- Public guide title/u);
});

test("updates one WebSearch note per normalized query regardless of result URL", async (t) => {
  const { recorder, knowledge, setNow } = await setup(t, { language: () => "en" });
  const first = await recorder.record({
    tool: "WebSearch", url: null, query: "first query", prompt: null, title: null,
    content: "Initial search result describes stable behavior for readers.",
    links: [{ title: "First guide", url: "https://example.test/first" }],
    http_status: null, is_error: false,
  }, { role: "advisor", work_id: "W1", work_title: "Research Work" });
  setNow("2026-09-29T02:03:04.000Z");

  const second = await recorder.record({
    tool: "WebSearch", url: null, query: "  FIRST   query ", prompt: null, title: null,
    content: "Updated search result contains different details and remains useful for readers.",
    links: [{ title: "Second guide", url: "https://example.test/second" }],
    http_status: null, is_error: false,
  }, { role: "worker", work_id: "W2", work_title: "Another Work" });
  const differentQuery = await recorder.record({
    tool: "WebSearch", url: null, query: "another query", prompt: null, title: null,
    content: "Another search result has different useful behavior for readers.",
    links: [{ title: "Second guide", url: "https://example.test/second" }],
    http_status: null, is_error: false,
  }, { role: "worker" });

  assert.equal(first.status, "saved");
  assert.equal(second.status, "saved");
  assert.equal(second.created, false);
  assert.equal(second.path, first.path);
  assert.equal(differentQuery.status, "saved");
  assert.equal(differentQuery.created, true);
  assert.notEqual(differentQuery.path, first.path);
  assert.equal((await readdir(join(knowledge.knowledgeDir, "research"))).length, 2);
  const note = await readFile(join(knowledge.knowledgeDir, first.path), "utf8");
  assert.match(note, /^research_key: search:first query$/mu);
  assert.match(note, /^query: "FIRST query"$/mu);
  assert.match(note, /^url: ""$/mu);
  assert.match(note, /researched_at: 2026-09-29T02:03:04\.000Z/u);
  assert.match(note, /Updated search result contains different details/u);
  assert.doesNotMatch(note, /Initial search result|First guide|stable behavior for readers/u);
  assert.match(note, /\[Second guide\]\(https:\/\/example\.test\/second\)/u);
});

test("WebSearch omits private source links and paragraphs containing private URLs", async (t) => {
  const { recorder, knowledge } = await setup(t, { language: () => "en" });
  const result = await recorder.record({
    tool: "WebSearch", url: null, query: "public research", prompt: null, title: null,
    content: [
      "Local result http://localhost/admin contains PRIVATE_LOCAL_MARKER and must never be saved.",
      "Private result https://192.168.1.25/secret contains PRIVATE_IP_MARKER and must never be saved.",
      "Public guide https://example.test/guide describes useful public behavior for readers.",
    ].join("\n\n"),
    links: [
      { title: "Local page", url: "http://localhost/admin" },
      { title: "Private page", url: "https://192.168.1.25/secret" },
      { title: "Public guide", url: "https://example.test/guide" },
    ],
    http_status: null, is_error: false,
  }, { role: "reviewer" });

  assert.equal(result.status, "saved");
  const note = await readFile(join(knowledge.knowledgeDir, result.path), "utf8");
  assert.match(note, /Public guide https:\/\/example\.test\/guide/u);
  assert.doesNotMatch(note, /localhost|192\.168|PRIVATE_LOCAL_MARKER|PRIVATE_IP_MARKER|Local page|Private page/u);
  assert.equal((await readdir(join(knowledge.knowledgeDir, "research"))).length, 1);
});

test("does not create a WebSearch note when all source URLs are private", async (t) => {
  const { recorder, knowledge } = await setup(t);
  const result = await recorder.record({
    tool: "WebSearch", url: null, query: "private search", prompt: null, title: null,
    content: "Local result http://localhost/admin contains only private information.",
    links: [{ title: "Local result", url: "http://localhost/admin" }],
    http_status: null, is_error: false,
  }, { role: "advisor" });

  assert.deepEqual(result, { status: "skipped", reason: "empty_content" });
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "research")), []);
});

test("saves WebSearch body points even when there are no result links", async (t) => {
  const { recorder, knowledge } = await setup(t, { language: () => "en" });
  const result = await recorder.record({
    tool: "WebSearch", url: null, query: "body only search", prompt: null, title: null,
    content: "This body-only result contains enough useful detail to save for later research.", links: [],
    http_status: null, is_error: false,
  }, { role: "advisor" });

  assert.equal(result.status, "saved");
  const note = await readFile(join(knowledge.knowledgeDir, result.path), "utf8");
  assert.match(note, /^research_key: search:body only search$/mu);
  assert.match(note, /## Key points\n- This body-only result contains enough useful detail/u);
  assert.match(note, /## Excerpt\nThis body-only result/u);
  assert.doesNotMatch(note, /## Key points\n\s*(?:##|$)/u);
});

test("saves safe WebSearch links when the body is too short to extract points", async (t) => {
  const { recorder, knowledge } = await setup(t, { language: () => "en" });
  const result = await recorder.record({
    tool: "WebSearch", url: null, query: "link only search", prompt: null, title: null,
    content: "Short.", links: [{ title: "Public guide", url: "https://example.test/guide" }],
    http_status: null, is_error: false,
  }, { role: "advisor" });

  assert.equal(result.status, "saved");
  const note = await readFile(join(knowledge.knowledgeDir, result.path), "utf8");
  assert.match(note, /## Key points\n- link only search/u);
  assert.match(note, /\[Public guide\]\(https:\/\/example\.test\/guide\)/u);
});

test("does not save a WebSearch result whose matching excerpt is an authentication page", async (t) => {
  const { recorder, knowledge } = await setup(t);
  const result = await recorder.record({
    tool: "WebSearch", url: null, query: "account help", prompt: null, title: null,
    content: "Account help: Please sign in with your password. PRIVATE_AUTH_MARKER",
    links: [{ title: "Account help", url: "https://example.test/help" }],
    http_status: null, is_error: false,
  }, { role: "advisor" });

  assert.deepEqual(result, { status: "skipped", reason: "empty_content" });
  assert.deepEqual(await readdir(join(knowledge.knowledgeDir, "research")), []);
});
