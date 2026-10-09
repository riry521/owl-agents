import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { AdvisorSessionManager, AdvisorSessionRuntime } from "../../dist/index.js";
import { IndexInjector } from "../../dist/memory/index-injector.js";
import { MemoryIndex } from "../../dist/memory/memory-index.js";
import { parsePage, renderPage } from "../../dist/memory/page-format.js";
import { createUlid, openDatabase } from "../../../db/dist/index.js";

const migrations = resolve(process.cwd(), "packages/db/migrations");
const NOW = "2030-01-02T03:04:05.000Z";
const COMMON_SUMMARY = "Project をまたぐ決まりごと";
/** The common table of contents: the shared project-index sample re-rendered with the common scope. */
const COMMON_INDEX = (() => {
  const page = parsePage(readFileSync(new URL("./fixtures/pages/project-index.md", import.meta.url), "utf8"));
  const { project_id: _drop, ...frontmatter } = page.frontmatter;
  return renderPage({
    ...page,
    frontmatter: { ...frontmatter, id: page.frontmatter.id.replace(/\w$/u, "C"), scope: "common", title: "共通の目次", source_hash: "c0".repeat(32) },
    frontmatter_order: page.frontmatter_order.filter((k) => k !== "project_id"),
    title: "共通の目次",
    sections: page.sections.map((section) => (section.heading === "概要" ? { ...section, lines: [COMMON_SUMMARY] } : section)),
  });
})();

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-advisor-injection-"));
  const vault = join(root, "vault");
  mkdirSync(join(vault, "common"), { recursive: true });
  mkdirSync(join(root, "data"));
  writeFileSync(join(vault, "common", "_index.md"), COMMON_INDEX);
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir: join(root, "data"), storage, watch: false });
  await index.start();
  await index.rebuild("manual");
  const memoryInjector = new IndexInjector({ index, isAvailable: () => true, now: () => new Date(NOW), logger: { warn() {} } });

  const db = openDatabase(join(root, "owl.sqlite"));
  db.migrate(migrations);
  const ownerId = createUlid();
  const accountId = createUlid();
  const conversationId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", ownerId, NOW, NOW);
    tx.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", accountId, ownerId, `web:${ownerId}`, NOW);
    tx.run("INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)", conversationId, ownerId, NOW, NOW);
  });

  const sent = [];
  const script = { failSends: 0, eventsBefore: [] };
  const createSession = async () => {
    const queued = [];
    const waiters = [];
    const push = (e) => { const w = waiters.shift(); if (w) w({ value: e, done: false }); else queued.push(e); };
    return {
      pid: 1, provider_session_id: "p", exited: false,
      async send(turn) {
        if (script.failSends > 0) { script.failSends -= 1; throw new Error("send failed"); }
        sent.push(turn.text);
        for (const e of script.eventsBefore.splice(0)) push(e);
        setImmediate(() => push({ type: "turn.completed", turn_id: turn.turn_id, reply: "reply", usage: null }));
      },
      events() { return { [Symbol.asyncIterator]() { return { next() { const e = queued.shift(); return e ? Promise.resolve({ value: e, done: false }) : new Promise((r) => waiters.push(r)); } }; } }; },
      async stop() {},
    };
  };
  const runtime = new AdvisorSessionRuntime({
    db, sessionManager: new AdvisorSessionManager(db), memoryInjector,
    memorySaver: { saveCompactionSummary: async () => ({ path: null, captured: false }) },
    providerClient: { createSession }, owlRoot: root,
    git: { resolveAdvisorSessionDirectory: async () => ({ kind: "direct", cwd: root }) },
    getAdvisorSettings: () => ({ providerId: "anthropic", harnessId: "claude", model: "claude-test", systemPrompt: "Advisor" }),
    resolveAttachmentPaths: () => ({ paths: [], notes: [] }),
    isProviderPaused: () => false, onReply: async () => null, onError: async () => {},
  });
  t.after(async () => { await runtime.stop(); db.close(); await index.stop(); await rm(root, { recursive: true, force: true }); });
  let session = await runtime.ensureSession(ownerId, conversationId);
  const ask = async (text) => {
    const messageId = createUlid();
    await db.createWriteLane().transact((tx) => tx.run(
      `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
       VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`, messageId, conversationId, accountId, `web-user:${messageId}`, text, NOW, NOW));
    const before = sent.length;
    const turnId = await runtime.enqueueTurn(session.id, conversationId, messageId, { turn_id: "", text, origin: { channel: "web" } });
    await waitUntil(() => ["completed", "failed"].includes(db.get("SELECT status FROM advisor_turns WHERE id = ?", turnId).status), "turn");
    session = db.get("SELECT id FROM advisor_sessions WHERE status = 'running' ORDER BY created_at DESC LIMIT 1") ?? session;
    return sent[before] ?? null;
  };
  return { ask, script };
}

test("the index is injected at the session start and not injected again on the 2nd turn", async (t) => {
  const { ask } = await harness(t);
  const first = await ask("hello");
  assert.match(first, /<owl-memory scope="advisor"/u);
  assert.match(first, new RegExp(COMMON_SUMMARY, "u"));
  const second = await ask("hello again");
  assert.doesNotMatch(second, /<owl-memory/u);
  assert.doesNotMatch(second, new RegExp(COMMON_SUMMARY, "u"));
});

test("a failed delta send resent on a fresh session carries the start index", async (t) => {
  const { ask, script } = await harness(t);
  await ask("hello");
  script.failSends = 1;
  const resent = await ask("hello again");
  assert.match(resent, /<owl-memory scope="advisor"/u);
  assert.match(resent, new RegExp(COMMON_SUMMARY, "u"));
});

test("the start index is injected again after compaction", async (t) => {
  const { ask, script } = await harness(t);
  await ask("hello");
  script.eventsBefore.push({ type: "session.compacted", cause: "auto", pre_tokens: 1, summary: "s", transcript_path: null });
  await ask("hello again");
  const after = await ask("hello once more");
  assert.match(after, /<owl-memory scope="advisor"/u);
  assert.match(after, new RegExp(COMMON_SUMMARY, "u"));
});
