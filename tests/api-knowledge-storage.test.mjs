import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AppSettingsStore } from "../apps/server/dist/app-settings-store.js";
import { ExternalCoreAdapter, knowledgeStorageOptions } from "../apps/server/dist/core.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { Core, KnowledgeLocation } from "../packages/core/dist/index.js";
import { createUlid, openDatabase } from "../packages/db/dist/index.js";

const migrations = join(process.cwd(), "packages/db/migrations");
const sha = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-api-knowledge-storage-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(root, "web"), { recursive: true });
  const makeCore = () => {
    const db = openDatabase(join(dataDir, "owl.db"));
    db.migrate(migrations);
    const appSettings = new AppSettingsStore(root, dataDir);
    const core = new Core({ db, agentRunner: {}, version: "t", owlRoot: root, dataDir, knowledgeStorage: knowledgeStorageOptions(appSettings) });
    return { db, appSettings, core };
  };
  const first = makeCore();
  const previousToken = process.env.OWL_API_TOKEN;
  const token = randomBytes(32).toString("hex");
  process.env.OWL_API_TOKEN = token;
  let http;
  t.after(async () => {
    if (http?.server.listening) await http.close().catch(() => undefined);
    await first.core.stop({ force: true }).catch(() => undefined);
    first.db.close();
    await rm(root, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
  });
  await first.core.start();
  http = createOwlHttpServer({
    core: new ExternalCoreAdapter(first.core, first.db, root, dataDir),
    db: first.db, webOut: join(root, "web"), bind: "127.0.0.1", port: 0,
    contract: { contract_version: "1.0.0" }, owlRoot: root, dataDir,
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("localhost listen is not permitted"); return null; }
    throw error;
  }
  const base = `http://127.0.0.1:${http.server.address().port}/api/v1`;
  const request = (path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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
  const note = await first.core.knowledge.create({ folder: "global", filename: "a.md", tags: ["x"], body: "hello" });
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

  const created = await request("/knowledge", { method: "POST", body: { folder: "global", filename: "later.md", tags: [], body: "after move" } });
  assert.ok(created.status < 300, `POST /knowledge ${created.status}`);
  assert.ok((await readdir(join(target, "global"))).includes("later.md"));

  await first.core.stop({ force: true });
  first.db.close();
  const second = makeCore();
  t.after(async () => { await second.core.stop({ force: true }).catch(() => undefined); second.db.close(); });
  await second.core.start();
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
  const base = await mkdtemp(join(tmpdir(), "owl-api-ks-fs-"));
  t.after(() => rm(base, { recursive: true, force: true }));
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
