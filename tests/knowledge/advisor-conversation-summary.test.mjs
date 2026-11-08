import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
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
  const dir = join(root, "knowledge", "advisor", "conversations");
  return { core, conversationId, requests, addMessages, dir };
}

const ok = () => ({ ok: true, output: SUMMARY });

test("the saved file holds the summary under three headings, not the messages", async (t) => {
  const { core, conversationId, addMessages, dir } = await setup(t, ok);
  await addMessages(3);

  const { path } = await core.ingestConversation(conversationId);
  const text = await readFile(join(dir, path.split("/").pop()), "utf8");

  for (const heading of ["## 話したこと", "## 決まったこと", "## 未決のこと"]) assert.ok(text.includes(heading), heading);
  for (const line of ["Talked about the deploy plan", "Ship on Friday", "Who owns rollback"]) assert.ok(text.includes(line), line);
  assert.doesNotMatch(text, /secret-body/u);
});

test("the file name starts with the conversation_id even when the first message starts with another ULID", async (t) => {
  const { core, conversationId, addMessages, dir } = await setup(t, ok);
  await addMessages(2, () => `${OTHER_ULID} please look at this`);

  await core.ingestConversation(conversationId);
  const [name] = await readdir(dir);
  const text = await readFile(join(dir, name), "utf8");

  assert.match(text, new RegExp(`^conversation_id: ${conversationId}$`, "mu"));
  assert.ok(name.startsWith(`${conversationId}-deploy-plan`), name);
  assert.ok(!name.toLowerCase().includes(OTHER_ULID.toLowerCase()), name);
});

test("saving a long conversation again names the new file from the new title and leaves the old file alone", async (t) => {
  const { core, conversationId, addMessages, dir } = await setup(t, ok);
  await mkdir(dir, { recursive: true });
  const oldName = `${conversationId}-old-title.md`;
  const oldText = `---\nconversation_id: ${conversationId}\nlast_message_id: 01MSG000000000000000000000\n---\n\n# Old title\n`;
  await writeFile(join(dir, oldName), oldText);
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  await addMessages(60);

  await core.ingestConversation(conversationId);
  const names = (await readdir(dir)).filter((name) => name !== oldName);

  assert.equal(names.length, 1);
  assert.ok(names[0].includes("deploy-plan") && !names[0].includes("old-title"), names[0]);
  assert.equal(hash(await readFile(join(dir, oldName), "utf8")), hash(oldText));
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
