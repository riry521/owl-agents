import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { MemoryIndex } from "../../packages/core/dist/memory/memory-index.js";
import { parsePage, validatePage } from "../../packages/core/dist/memory/page-format.js";
import { createTestCore } from "../helpers/core.mjs";

const NOW = "2026-01-01T00:00:00.000Z";
const OTHER_ULID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const SUMMARY = { title: "Deploy plan", talked: ["Talked about the deploy plan"], decided: ["Ship on Friday"], undecided: ["Who owns rollback"] };

async function setup(t, summarize) {
  const requests = [];
  const agentRunner = {
    runConversationSummary: async (request) => {
      requests.push(request);
      return summarize(request);
    },
  };
  const { core, db, root } = await createTestCore(t, { agentRunner }, { prefix: "owl-conversation-summary-" });
  const ownerId = createUlid();
  const accountId = createUlid();
  const conversationId = createUlid();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", ownerId, NOW, NOW);
    tx.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', ?, ?)", accountId, ownerId, `web:${ownerId}`, NOW);
    tx.run("INSERT INTO conversations (id, owner_id, channel, is_active, created_at, updated_at) VALUES (?, ?, 'web', 1, ?, ?)", conversationId, ownerId, NOW, NOW);
  });
  let counter = 0;
  const addMessages = (count, firstBody = (n) => `secret-body-${n}`) =>
    db.createWriteLane().transact((tx) => {
      for (let i = 0; i < count; i += 1) {
        counter += 1;
        const id = `01MSG${String(counter).padStart(21, "0")}`;
        tx.run(
          `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at)
           VALUES (?, ?, 'web', ?, ?, ?, '[]', ?, ?)`,
          id, conversationId, accountId, `web-user:${id}`, counter === 1 ? firstBody(counter) : `secret-body-${counter}`, NOW, NOW,
        );
      }
    });
  const dir = join(root, "knowledge", "conversations", new Date().toISOString().slice(0, 7));
  return { core, conversationId, requests, addMessages, dir };
}

const ok = () => ({ ok: true, output: SUMMARY });

test("the saved file holds the summary under the conversation-log headings, not the messages", async (t) => {
  const { core, conversationId, addMessages, dir } = await setup(t, ok);
  await addMessages(3);

  const { path } = await core.ingestConversation(conversationId);
  const text = await readFile(join(dir, path.split("/").pop()), "utf8");

  for (const heading of ["## 話したこと", "## 決まったこと", "## 学んだこと", "## 反映先"]) assert.ok(text.includes(heading), heading);
  for (const line of ["Talked about the deploy plan", "Ship on Friday", "Who owns rollback"]) assert.ok(text.includes(line), line);
  assert.doesNotMatch(text, /secret-body/u);
});

test("the saved file is a conversation-log page, not a legacy note, and nothing is written under advisor/conversations", async (t) => {
  const { core, conversationId, addMessages, dir } = await setup(t, ok);
  await addMessages(2);

  const { path } = await core.ingestConversation(conversationId);
  const text = await readFile(join(dir, path.split("/").pop()), "utf8");
  const page = parsePage(text);

  assert.match(path, /^conversations\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}-\d+\.md$/u);
  assert.equal(page.frontmatter.type, "conversation-log");
  assert.equal(page.frontmatter.conversation_id, conversationId);
  assert.equal(validatePage(page, { writer: "owner" }).ok, true);
  assert.deepEqual(await readdir(join(dir, "..", "..", "advisor", "conversations")).catch(() => []), []);

  const vault = join(dir, "..", "..");
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir: join(vault, "..", "index-data"), storage, watch: false });
  await index.start();
  try {
    await index.rebuild("manual");
    assert.equal(index.getPageColumns(path)?.page_type, "conversation-log");
  } finally {
    await index.stop();
  }
});

test("only messages after the previous save are summarised, from the first message on the first save", async (t) => {
  const { core, conversationId, requests, addMessages, dir } = await setup(t, ok);
  await addMessages(60);
  await core.ingestConversation(conversationId);
  assert.equal(requests[0].messages.length, 60);
  assert.ok(requests[0].messages[0].includes("secret-body-1"));

  await addMessages(3);
  await core.ingestConversation(conversationId);
  assert.equal(requests[1].messages.length, 3);
  assert.ok(requests[1].messages[0].includes("secret-body-61"));
  assert.equal((await readdir(dir)).length, 2);
});

test("a failed summary creates no file and raises an error", async (t) => {
  const { core, conversationId, addMessages, dir } = await setup(t, () => ({ ok: false, error: "boom" }));
  await addMessages(2);

  await assert.rejects(core.ingestConversation(conversationId), /could not be made/u);
  assert.deepEqual(await readdir(dir).catch(() => []), []);
});
