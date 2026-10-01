import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const migrations = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "packages/db/migrations");

test("031 adds messages.metadata_json: existing rows are NULL and invalid JSON is rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-message-metadata-"));
  const db = openDatabase(join(root, "owl.db"));
  t.after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
  const before = files.filter((name) => name < "031");
  assert.ok(files.includes("031_message_metadata.sql"));

  // Apply everything before 031 from a scratch directory view of the same files.
  const { mkdir, copyFile } = await import("node:fs/promises");
  const early = join(root, "early");
  await mkdir(early);
  for (const name of before) await copyFile(join(migrations, name), join(early, name));
  db.migrate(early);

  const now = new Date().toISOString();
  const ids = { owner: createUlid(), account: createUlid(), conversation: createUlid(), message: createUlid() };
  const insertMessage = (tx, id, metadata) => tx.run(
    `INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at${metadata === undefined ? "" : ", metadata_json"})
     VALUES (?, ?, 'web', ?, ?, 'hi', '[]', ?, ?${metadata === undefined ? "" : ", ?"})`,
    ...[id, ids.conversation, ids.account, `s:${id}`, now, now, ...(metadata === undefined ? [] : [metadata])],
  );
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'o', ?, ?)", ids.owner, now, now);
    tx.run("INSERT INTO connector_accounts (id, owner_id, provider, external_account_id, created_at) VALUES (?, ?, 'web', 'x', ?)", ids.account, ids.owner, now);
    tx.run("INSERT INTO conversations (id, owner_id, work_id, channel, is_active, created_at, updated_at) VALUES (?, ?, NULL, 'web', 1, ?, ?)", ids.conversation, ids.owner, now, now);
    insertMessage(tx, ids.message);
    return null;
  });

  db.migrate(migrations);
  assert.equal(db.get("SELECT metadata_json AS m FROM messages WHERE id = ?", ids.message).m, null);

  await db.createWriteLane().transact((tx) => {
    insertMessage(tx, createUlid(), '{"kind":"instruction_reply"}');
    return null;
  });
  await assert.rejects(
    db.createWriteLane().transact((tx) => {
      insertMessage(tx, createUlid(), "{not json");
      return null;
    }),
    /CHECK constraint failed/,
  );
});
