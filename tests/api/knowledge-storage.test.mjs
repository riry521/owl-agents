import { clip } from "../helpers/seed-knowledge.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { AppSettingsStore } from "../../apps/server/dist/app-settings-store.js";
import { ExternalCoreAdapter, knowledgeStorageOptions } from "../../apps/server/dist/core.js";
import { KnowledgeLocation } from "../../packages/core/dist/index.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const sha = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

async function setup(t) {
  const root = await tempDir(t, "owl-api-knowledge-storage-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(root, "web"), { recursive: true });
  // A Core on <dataDir>/owl.db; the DB is closed after the Core stops. Called again for the restart.
  const makeCore = async (start = false) => {
    const db = createTestDatabase(dataDir);
    const appSettings = new AppSettingsStore(root, dataDir);
    const { core } = await createTestCore(
      t,
      { db, owlRoot: root, dataDir, version: "t", knowledgeStorage: knowledgeStorageOptions(appSettings) },
      { start },
    );
    t.after(() => db.close());
    return { db, appSettings, core };
  };
  const first = await makeCore(true);
  const token = randomBytes(32).toString("hex");
  const api = await startTestHttpServer(
    t,
    { core: new ExternalCoreAdapter(first.core, first.db, root, dataDir), db: first.db, webOut: join(root, "web"), owlRoot: root, dataDir },
    { token },
  );
  if (!api) {
    t.skip("localhost listen is not permitted");
    return null;
  }
  const request = (path, { method = "GET", body } = {}) => api.request(method, `/api/v1${path}`, body);
  const put = (payload) => request("/settings/knowledge-storage", {
    method: "PUT",
    body: { request_id: createUlid(), idempotency_key: `ks:${createUlid()}`, expected_version: 0, payload },
  });
  return { root, dataDir, first, request, put, makeCore };
}

test("PUT moves knowledge, later saves go to the new place, and the setting survives a Core restart", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { root, dataDir, first, request, put, makeCore } = env;
  const note = await first.core.knowledge.create({ folder: "global", filename: "a.md", tags: ["x"], ...clip("hello") });
  const source = join(root, "knowledge");
  const before = await sha(join(source, note.path));
  const target = join(root, "elsewhere");

  const response = await put({ path: target });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status.path, target);
  assert.equal(await sha(join(target, note.path)), before);
  await assert.rejects(stat(join(source, note.path)), { code: "ENOENT" });

  const get = await (await request("/settings/knowledge-storage")).json();
  assert.equal(get.data.path, target);
  assert.equal(get.data.state, "available");

  const created = await request("/knowledge", { method: "POST", body: { folder: "global", filename: "later.md", tags: [], ...clip("after move") } });
  assert.ok(created.status < 300, `POST /knowledge ${created.status}`);
  assert.ok((await readdir(join(target, "global"))).includes("later.md"));

  await first.core.stop({ force: true });
  first.db.close();
  const second = await makeCore(true);
  assert.equal(JSON.parse(await readFile(join(dataDir, "app-settings.json"), "utf8")).knowledge_dir, target);
  assert.equal(second.core.getKnowledgeStorage().path, target);
  assert.ok((await second.core.knowledge.list()).some((entry) => entry.path === note.path));
});

test("PUT rejects relative and NUL paths with 422 and leaves the setting alone", async (t) => {
  const env = await setup(t);
  if (!env) return;
  for (const path of ["relative/knowledge", "/tmp/a\0b"]) {
    const response = await env.put({ path });
    assert.equal(response.status, 422, path);
  }
  assert.equal(env.first.appSettings.getKnowledgeDir(), "");
  assert.throws(() => env.first.appSettings.setKnowledgeDir("relative"));
  assert.throws(() => env.first.appSettings.setKnowledgeDir("/a\0b"));
});

test("moves with the persisted setting survive EXDEV, and failures keep source data and setting", async (t) => {
  const real = await import("node:fs/promises");
  const base = await tempDir(t, "owl-api-ks-fs-");
  const root = join(base, "root");
  const dataDir = join(base, "data");
  const source = join(root, "knowledge");
  await mkdir(join(source, "global"), { recursive: true });
  await writeFile(join(source, "global", "a.md"), "alpha");
  await writeFile(join(source, "global", "b.md"), "beta");
  const appSettings = new AppSettingsStore(root, dataDir);
  let mode = "exdev";
  const calls = [];
  const fs = {
    ...real,
    rename: async (...args) => { calls.push(args[0]); throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); },
    copyFile: async (src, dst, flags) => {
      if (mode === "copy") throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      await real.copyFile(src, dst, flags);
      if (mode === "verify") await real.writeFile(dst, "tampered");
    },
  };
  const location = new KnowledgeLocation({ owlRoot: root, dataDir, persistence: knowledgeStorageOptions(appSettings), fs });
  await location.initialize();
  t.after(() => location.stop());
  const unchanged = async () => {
    assert.equal(appSettings.getKnowledgeDir(), "");
    assert.equal(location.activeDir(), source);
    assert.equal(await readFile(join(source, "global", "a.md"), "utf8"), "alpha");
    assert.equal(await readFile(join(source, "global", "b.md"), "utf8"), "beta");
  };

  for (const m of ["copy", "verify"]) {
    mode = m;
    await assert.rejects(location.move({ path: join(base, `t-${m}`), mode: "move" }), (e) => e.code === "knowledge_move_failed");
    await unchanged();
  }

  // The settings file cannot be written: the switch fails and nothing changes.
  mode = "exdev";
  await mkdir(join(dataDir, "app-settings.json.tmp"));
  await assert.rejects(location.move({ path: join(base, "t-settings"), mode: "move" }), (e) => e.code === "knowledge_move_failed");
  await unchanged();
  await rm(join(dataDir, "app-settings.json.tmp"), { recursive: true });

  const target = join(base, "t-ok");
  const result = await location.move({ path: target, mode: "move" });
  assert.equal(result.moved.files, 2);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(join(target, "global", "a.md"), "utf8"), "alpha");
  assert.equal(new AppSettingsStore(root, dataDir).getKnowledgeDir(), target);
  await assert.rejects(stat(join(source, "global", "a.md")), { code: "ENOENT" });
});

test("GET /memory/pages/pending reports the librarian backlog through the adapter-wrapped Core", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const file = join(env.root, "knowledge", "conversations", "2026-10", "2026-10-04-1.md");
  await mkdir(join(env.root, "knowledge", "conversations", "2026-10"), { recursive: true });
  await writeFile(file, [
    "---", `id: ${createUlid()}`, "type: conversation-log", "title: 会話 2026-10-04-1", `conversation_id: ${createUlid()}`, `session_id: ${createUlid()}`,
    "compaction_index: 1", "cause: owl", "summary_source: provider", "extraction: pending", "created: 2026-10-04", "---", "# 会話 2026-10-04-1", "",
    "## 話したこと", "- （司書待ち）", "", "## 決まったこと", "- （司書待ち）", "", "## 学んだこと", "- （司書待ち）", "", "## 反映先", "- （司書待ち）", "", "## 原文", "要約", "",
  ].join("\n"));
  const old = new Date(Date.now() - 3_600_000);
  await utimes(file, old, old);

  const response = await env.request("/memory/pages/pending");
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.pending_conversations, 1);
  assert.equal(data.unused_clippings, 0);
  assert.ok(data.oldest_pending_age_seconds >= 3600 && data.oldest_pending_age_seconds < 3700, String(data.oldest_pending_age_seconds));
});
