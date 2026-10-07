import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { Core, KnowledgeNotes, ProjectOverviewService } from "../dist/index.js";
import { createUlid, openDatabase } from "../../db/dist/index.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

function stubReader(overrides = {}) {
  const reads = [];
  const files = [".env", ".env.local", "secrets.json", "README.md", "package.json", "CLAUDE.md", "src/a.ts", "apps/web/x.ts"];
  return {
    reads,
    listFiles: async () => files,
    readFile: async (_repo, _ref, path) => {
      reads.push(path);
      if (path === "README.md") return "# Demo\n\n![badge](x)\n\nデモ用のサンプルアプリです。\n";
      if (path === "package.json") return JSON.stringify({ name: "demo", scripts: { build: "tsc", test: "node --test" }, dependencies: { next: "1" }, devDependencies: { typescript: "5" } });
      if (path === "CLAUDE.md") return "# Rules\n- 必ず pnpm build を通すこと\n- token ghp_abcdefghijklmnopqrstuvwxyz0123456789 を書くな\n";
      return "SECRET=hunter2-should-never-appear";
    },
    changedPaths: async () => ["apps/server/a.ts", "apps/server/b.ts", "packages/core/c.ts", ".env"],
    ...overrides,
  };
}

async function setup(t, reader) {
  const root = await mkdtemp(join(tmpdir(), "owl-overview-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const core = new Core({ db, agentRunner, version: "t", owlRoot: root, projectSourceReader: reader });
  t.after(async () => {
    await core.stop({ force: true });
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, root, core };
}

const request = (payload, key) => ({ request_id: `r-${key}`, idempotency_key: `i-${key}`, expected_version: 0, payload });
const register = (core, root, name) => core.createProject(request({
  name, canonical_path: join(root, name), base_branch: "main", allowed_roots: [root], verification_plan: [],
}, name));
const overviews = async (root) => (await readdir(join(root, "knowledge/notes")).catch(() => [])).filter((f) => f.startsWith("project-overview-"));
// The overview of a registered Project is written into its 構成 page; read every page of the vault.
async function vaultText(dir) {
  let out = "";
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out += await vaultText(path);
    else if (entry.name.endsWith(".md")) out += await readFile(path, "utf8").catch(() => "");
  }
  return out;
}

test("createProject creates one Japanese overview note without reading secret files", async (t) => {
  const reader = stubReader();
  const { core, root } = await setup(t, reader);
  const project = (await register(core, root, "demo")).data;
  await core.stop({ force: true });

  assert.deepEqual(await overviews(root), [], "no fixed note is written");
  const text = await vaultText(join(root, "knowledge"));
  assert.ok(text.includes("デモ用のサンプルアプリです。"));
  assert.ok(!text.includes("hunter2") && !text.includes("ghp_") && !text.includes(".env") && !text.includes("secrets.json"));
  assert.deepEqual(reader.reads.filter((p) => p.startsWith(".env") || p === "secrets.json"), []);
});

test("generation failures never fail registration or scheduling", async (t) => {
  const failing = stubReader({ listFiles: async () => { throw new Error("boom"); } });
  const { core, root } = await setup(t, failing);
  const response = await register(core, root, "broken");
  assert.ok(response.data.id);
  await core.stop({ force: true });
  assert.deepEqual(await overviews(root), []);

  const logged = [];
  const service = new ProjectOverviewService({
    notes: new KnowledgeNotes({ knowledgeDir: join(root, "knowledge") }),
    withWrite: (fn) => fn(),
    getProject: () => ({ id: response.data.id, name: "x", canonical_path: root, base_branch: "main" }),
    reader: failing,
    log: (message) => logged.push(message),
  });
  service.schedule(response.data.id, { kind: "project_created" });
  await service.idle();
  assert.equal(logged.length, 1);
  await mkdir(root, { recursive: true });
});
