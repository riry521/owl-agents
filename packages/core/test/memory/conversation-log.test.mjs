import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AdvisorSessionManager, AdvisorSessionRuntime } from "../../dist/index.js";
import { ConversationLogWriter } from "../../dist/memory/conversation-log-writer.js";
import { CONVERSATION_COMPACT_INSTRUCTIONS, parseConversationSummary } from "../../dist/memory/conversation-log.js";
import { IndexInjector } from "../../dist/memory/index-injector.js";
import { MemoryIndex } from "../../dist/memory/memory-index.js";
import { buildIntegrationRequest } from "../../dist/memory/page-integration.js";
import { assertValidPage, parsePage } from "../../dist/memory/page-format.js";
import { PageRouter } from "../../dist/memory/page-router.js";

const NOW = new Date("2030-01-02T03:04:05.000Z");
const PROJECT_INDEX = readFileSync(new URL("./fixtures/pages/project-index.md", import.meta.url), "utf8");
const PROJECT_ID = /^project_id: (\w+)$/mu.exec(readFileSync(new URL("./fixtures/pages/theme.md", import.meta.url), "utf8"))[1];

const FIELD_SUMMARY = [
  "# 題名は捨てる", "", "## 話したこと", "- 圧縮の要約の扱い", "- 継続中: 想起の閾値", "",
  "## 決まったこと", "- 会話の記録は conversations/ に置く（会話2030-01-01-1）", "",
  "## 学んだこと", "- [落とし穴] 要約の指示は自動圧縮に効かない", "- [事実] Codex の要約は読めない", "- [手順] 司書へ回す", "",
  "## 反映先", "- なし",
].join("\n");
const DEFAULT_SUMMARY = "This session is being continued.\n\n## Primary Request\n- something\n\n## Pending\n- more";

function vaultOf(t) {
  const root = mkdtempSync(join(tmpdir(), "owl-conversation-log-"));
  const vault = join(root, "vault");
  mkdirSync(vault, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const withWrite = async (fn) => fn();
  const router = new PageRouter({ knowledgeDir: () => vault, withWrite, now: () => NOW });
  // A fake model that fails when called: the writer must not depend on any AI.
  const model = { calls: 0, call() { this.calls += 1; throw new Error("the model must not be called"); } };
  const writer = new ConversationLogWriter({ knowledgeDir: () => vault, withWrite, router, project: () => null, now: () => NOW });
  const write = (summary) => writer.write({
    sessionId: "s1", conversationId: "c1", cause: "auto", summary, transcriptPath: null, provider: "anthropic", model: "m", index: 1,
  });
  return { root, vault, write, model };
}

const files = (dir) => readdirSync(dir, { recursive: true }).map(String).sort();

test("a 4-field summary becomes a conversation-log page and its decisions and learnings go to a theme page with owl:new", async (t) => {
  const { vault, write, model } = vaultOf(t);
  const result = await write(FIELD_SUMMARY);
  assert.equal(result.path, "conversations/2030-01/2030-01-02-1.md");
  assert.equal(result.extraction, "program");
  assert.equal(model.calls, 0);
  const text = readFileSync(join(vault, result.path), "utf8");
  assertValidPage(text);
  const page = parsePage(text);
  assert.equal(page.frontmatter.type, "conversation-log");
  assert.equal(page.frontmatter.extraction, "program");
  assert.deepEqual(page.sections.map((s) => s.heading), ["話したこと", "決まったこと", "学んだこと", "反映先"]);
  assert.ok(page.sections[2].lines.includes("- [手順] 司書へ回す"), "the log keeps every line as written");
  assert.ok(page.sections[3].lines.some((l) => l.includes("反映なし: 手順は司書へ")));

  const theme = readFileSync(join(vault, "common", "その他の注意.md"), "utf8");
  assert.match(theme, /- 会話の記録は conversations\/ に置く（会話2030-01-02-1） <!-- owl:new 2030-01-02 会話2030-01-02-1 -->/u);
  assert.match(theme, /- 要約の指示は自動圧縮に効かない（会話2030-01-02-1） <!-- owl:new /u);
  assert.match(theme, /- Codex の要約は読めない（会話2030-01-02-1） <!-- owl:new /u);
  assert.ok(!theme.includes("司書へ回す"), "procedure marks are not sent");
  assert.equal(result.routed.length, 3);
  assert.ok(page.sections[3].lines.filter((l) => l.startsWith("- [[")).length === 3);
});

test("a second log on the same day gets -2, and a repeated item only adds its source", async (t) => {
  const { vault, write } = vaultOf(t);
  await write(FIELD_SUMMARY);
  const second = await write(FIELD_SUMMARY);
  assert.equal(second.path, "conversations/2030-01/2030-01-02-2.md");
  assert.ok(second.routed.every((r) => r.status === "duplicate"));
  const theme = readFileSync(join(vault, "common", "その他の注意.md"), "utf8");
  assert.match(theme, /（会話2030-01-02-1, 会話2030-01-02-2）/u);
});

test("a summary that is not in the 4-field shape is stored as-is, marked for the nightly librarian, and no theme page changes", async (t) => {
  const { vault, write } = vaultOf(t);
  for (const summary of [DEFAULT_SUMMARY, FIELD_SUMMARY.replace("## 決まったこと", "## 決まったことX")]) {
    const result = await write(summary);
    assert.equal(result.extraction, "pending");
    assert.deepEqual(result.routed, []);
    const text = readFileSync(join(vault, result.path), "utf8");
    assertValidPage(text);
    const page = parsePage(text);
    assert.equal(page.frontmatter.extraction, "pending");
    assert.ok(page.sections.at(-1).heading === "原文");
    assert.ok(page.sections.at(-1).lines.some((l) => l.includes("something") || l.includes("司書へ回す")));
    assert.ok(page.sections[0].lines.includes("- （司書待ち）"));
  }
  assert.ok(files(vault).every((f) => f.startsWith("conversations")), files(vault).join());
});

test("empty and blank summaries write nothing", async (t) => {
  const { vault, write } = vaultOf(t);
  for (const summary of [null, "", "  \n "]) assert.equal((await write(summary)).path, null);
  assert.deepEqual(files(vault), []);
});

test("field-cutting rules: order, duplicates, extra headings, fences, empty items", () => {
  assert.equal(parseConversationSummary("## 決まったこと\n- a\n## 話したこと\n- b\n## 学んだこと\n- c"), null);
  assert.equal(parseConversationSummary(`${FIELD_SUMMARY}\n## 学んだこと\n- x`), null);
  assert.equal(parseConversationSummary(`${FIELD_SUMMARY}\n## おまけ\n- x`), null);
  const fenced = parseConversationSummary("## 話したこと\n```\n## 余分\n```\n## 決まったこと\n- なし\n## 学んだこと\n- 特になし");
  assert.deepEqual(fenced?.items, []);
  const parsed = parseConversationSummary(FIELD_SUMMARY);
  assert.deepEqual(parsed.items.map((i) => i.kind), ["decision", "pitfall", "fact"]);
  assert.equal(parsed.items[0].text, "会話の記録は conversations/ に置く");
});

test("list items inside code fences are not sent to the theme pages", () => {
  const parsed = parseConversationSummary("## 話したこと\n- a\n## 決まったこと\n- 採用する\n```\n- 危険な設定を採用\n```\n## 学んだこと\n- [事実] 本物\n```\n- [事実] 例\n```");
  assert.deepEqual(parsed.items.map((i) => i.text), ["採用する", "本物"]);
});

test("the integration request reads a conversation source from the owl:new mark", () => {
  const text = "---\nid: x\ntype: theme\ntitle: t\n---\n# t\n\n## 概要\n- 事実（会話2030-01-02-1） <!-- owl:new 2030-01-02 会話2030-01-02-1 -->\n";
  const request = buildIntegrationRequest({ run_id: "r", reason: "size", page: { path: "common/t.md", title: "t", page_scope: "common", project_id: null, token_estimate: 10 }, text, siblings: [], model: {} });
  assert.equal(request.new_lines[0]?.work_label, "会話2030-01-02-1");
});

test("conversation logs stay out of the catalog and the injected text of every role", async (t) => {
  const { vault, write } = vaultOf(t);
  mkdirSync(join(vault, "projects", "p"), { recursive: true });
  writeFileSync(join(vault, "projects", "p", "_index.md"), PROJECT_INDEX);
  const result = await write(FIELD_SUMMARY);
  const root = mkdtempSync(join(tmpdir(), "owl-conversation-log-index-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "data"));
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir: join(root, "data"), storage, watch: false });
  await index.start();
  await index.rebuild("manual");
  t.after(() => index.stop());
  assert.equal(index.listPages({ types: ["conversation-log"] }).length, 1, "the log is indexed, only as its own type");
  const injector = new IndexInjector({ index, isAvailable: () => true, now: () => NOW, logger: { warn() {} } });
  for (const role of ["advisor", "manager", "designer", "worker", "reviewer"]) {
    const text = await injector.compose({ role, query: [], project_id: PROJECT_ID, session_id: `s-${role}` });
    assert.ok(text && !text.includes("会話 2030") && !text.includes("conversations/") && !text.includes("圧縮の要約の扱い"), role);
  }
  assert.ok(result.path);
});

function runtimeWith(canInstruct) {
  const requests = [];
  const root = mkdtempSync(join(tmpdir(), "owl-conversation-log-rt-"));
  const db = { get: () => undefined, all: () => [], run() {}, createWriteLane: () => ({ transact: async () => undefined }) };
  const runtime = new AdvisorSessionRuntime({
    db, sessionManager: new AdvisorSessionManager({ ...db }), memorySaver: {}, owlRoot: root,
    providerClient: { createSession: async (request) => { requests.push(request); throw new Error("stop after capture"); } },
    git: { prepareAdvisorWorkspace: async () => ({ ok: true, worktree_path: root }) },
    getAdvisorSettings: () => ({ providerId: "p", harnessId: "claude", model: "m", systemPrompt: "Advisor" }),
    canInstructCompaction: canInstruct,
    resolveAttachmentPaths: () => ({ paths: [], notes: [] }), onReply: async () => null, onError: async () => {},
  });
  return { runtime, requests, root };
}

test("launching a session passes the summary-format instruction only to providers that can be told", async (t) => {
  for (const [canInstruct, expected] of [[() => true, CONVERSATION_COMPACT_INSTRUCTIONS], [() => false, undefined], [undefined, undefined]]) {
    const { runtime, requests, root } = runtimeWith(canInstruct);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const session = { id: "s", conversation_id: "c", status: "starting" };
    await runtime.launchSession(session, runtime.config.getAdvisorSettings(), root).catch(() => {});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].compact_instructions, expected);
  }
});
