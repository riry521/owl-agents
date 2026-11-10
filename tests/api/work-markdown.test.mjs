import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const token = "work-markdown-token";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "pipe" });
const put = async (root, rel, body) => {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), body);
};

/** A Core behind the production adapter and HTTP server, a real git Project, and a materials folder. */
async function setup(t, coreOptions = {}) {
  const { root, db, core } = await createTestCore(t, coreOptions, { prefix: "owl-work-markdown-" });
  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root }, { token });
  if (!api) return null;
  // A secret-looking folder above the Project must not block its files: secrets are judged on the path below the root.
  const project = join(await tempDir(t, "owl-work-markdown-project-"), "credentials-work", "project");
  await mkdir(project, { recursive: true });
  const outside = await tempDir(t, "owl-work-markdown-outside-");
  const materials = join(root, "knowledge", "materials");
  await mkdir(materials, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  const now = new Date().toISOString();
  const projectId = createUlid();
  const owner = "owner:default";
  const works = {};
  db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES (?, 'Owner', ?, ?)", owner, now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json, verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES (?, ?, 'P', ?, 'main', '[]', '{}', '[]', ?, ?)`,
      projectId, owner, project, now, now,
    );
    for (const [key, state, withProject] of [["running", "running", true], ["completed", "completed", true], ["cancelled", "cancelled", true], ["bare", "running", false]]) {
      const id = createUlid();
      works[key] = id;
      tx.run(
        `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, 'W', '', 'normal', ?, '[]', '[]', ?, ?)`,
        id, owner, withProject ? projectId : null, state, now, now,
      );
    }
  });
  const get = async (workId, path, { auth = true } = {}) => {
    const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
    const response = await fetch(`${api.baseUrl}/api/v1/works/${workId}/markdown${query}`, auth ? { headers: { authorization: `Bearer ${token}` } } : {});
    return { status: response.status, body: await response.json() };
  };
  return { root, db, api, project, outside, materials, works, get };
}

const code = (res) => res.body.error?.code;

test("reads a Markdown file by relative path, absolute path and materials paths, and says where it came from", async (t) => {
  const s = await setup(t);
  if (!s) return t.skip("localhost listen is unavailable");
  await put(s.project, "docs/design.md", "# 設計\n");
  await put(s.project, "materials/shared.md", "project copy");
  await put(s.materials, "shared.md", "materials copy");
  await put(s.materials, "projects/only.md", "materials only");
  git(s.project, "add", "-A");
  git(s.project, "commit", "-q", "-m", "init");

  const rel = await s.get(s.works.running, "docs/design.md");
  assert.equal(rel.status, 200);
  assert.deepEqual(rel.body.data, { path: "docs/design.md", name: "design.md", source: "project", markdown: "# 設計\n", size_bytes: Buffer.byteLength("# 設計\n") });
  const abs = await s.get(s.works.running, join(s.project, "docs", "design.md"));
  assert.equal(abs.status, 200);
  assert.equal(abs.body.data.path, "docs/design.md");

  const viaPrefix = await s.get(s.works.running, "materials/projects/only.md");
  assert.equal(viaPrefix.status, 200);
  assert.deepEqual([viaPrefix.body.data.source, viaPrefix.body.data.path, viaPrefix.body.data.markdown], ["materials", "materials/projects/only.md", "materials only"]);
  const viaAbs = await s.get(s.works.bare, join(s.materials, "projects", "only.md"));
  assert.equal(viaAbs.status, 200);
  assert.equal(viaAbs.body.data.source, "materials");
  assert.equal(viaAbs.body.data.path, "materials/projects/only.md");

  const both = await s.get(s.works.running, "materials/shared.md");
  assert.deepEqual([both.body.data.source, both.body.data.markdown], ["project", "project copy"]);
  const materialsOnly = await s.get(s.works.bare, "materials/shared.md");
  assert.equal(materialsOnly.body.data.markdown, "materials copy");
});

test("reads from the Work branch, the base branch and the working tree according to the Work's state", async (t) => {
  const s = await setup(t);
  if (!s) return t.skip("localhost listen is unavailable");
  await put(s.project, "README.md", "base readme");
  await put(s.project, "docs/base-only.md", "base only");
  git(s.project, "add", "-A");
  git(s.project, "commit", "-q", "-m", "base");
  git(s.project, "checkout", "-q", "-b", `owl/work/${s.works.running}/work`);
  git(s.project, "rm", "-q", "docs/base-only.md");
  await put(s.project, "docs/branch-only.md", "branch only");
  git(s.project, "add", "-A");
  git(s.project, "commit", "-q", "-m", "branch");
  // The Work branch is also checked out, so the working tree has neither base-only.md nor anything uncommitted yet.
  await put(s.project, "docs/untracked.md", "untracked");

  const branch = await s.get(s.works.running, "docs/branch-only.md");
  assert.deepEqual([branch.status, branch.body.data.source, branch.body.data.markdown], [200, "work_branch", "branch only"]);

  const base = await s.get(s.works.completed, "docs/base-only.md");
  assert.deepEqual([base.status, base.body.data.source, base.body.data.markdown], [200, "project", "base only"]);
  assert.equal((await s.get(s.works.running, "docs/base-only.md")).body.data.source, "project");

  const untracked = await s.get(s.works.running, "docs/untracked.md");
  assert.deepEqual([untracked.status, untracked.body.data.source], [200, "project"]);

  const missing = await s.get(s.works.running, "docs/nowhere.md");
  assert.deepEqual([missing.status, code(missing)], [404, "markdown_not_integrated"]);
  const missingDone = await s.get(s.works.completed, "docs/nowhere.md");
  assert.deepEqual([missingDone.status, code(missingDone)], [404, "markdown_not_found"]);
  assert.equal(code(await s.get(s.works.running, "materials/nowhere.md")), "markdown_not_integrated");
  assert.equal(code(await s.get(s.works.bare, "materials/nowhere.md")), "markdown_not_found");
});

test("a cancelled Work reads its own Work branch, and a missing file is not_found rather than not_integrated", async (t) => {
  const s = await setup(t);
  if (!s) return t.skip("localhost listen is unavailable");
  await put(s.project, "README.md", "base");
  git(s.project, "add", "-A");
  git(s.project, "commit", "-q", "-m", "base");
  git(s.project, "branch", `owl/work/${s.works.cancelled}/work`);
  git(s.project, "checkout", "-q", `owl/work/${s.works.cancelled}/work`);
  await put(s.project, "docs/made.md", "made");
  git(s.project, "add", "-A");
  git(s.project, "commit", "-q", "-m", "made");
  git(s.project, "checkout", "-q", "main");
  const found = await s.get(s.works.cancelled, "docs/made.md");
  assert.deepEqual([found.status, found.body.data.source], [200, "work_branch"]);
  assert.equal(code(await s.get(s.works.cancelled, "docs/none.md")), "markdown_not_found");
});

test("refuses paths outside the Project and materials with the same answer whether or not the file exists", async (t) => {
  const s = await setup(t);
  if (!s) return t.skip("localhost listen is unavailable");
  await put(s.outside, "real.md", "outside");
  await put(s.root, "knowledge/notes/vault.md", "vault");
  const existing = await s.get(s.works.running, join(s.outside, "real.md"));
  const absent = await s.get(s.works.running, join(s.outside, "absent.md"));
  assert.deepEqual([existing.status, code(existing), existing.body.error.details], [403, "markdown_path_denied", { reason: "outside" }]);
  assert.deepEqual([absent.status, code(absent), absent.body.error.details], [403, "markdown_path_denied", { reason: "outside" }]);
  assert.equal(existing.body.error.message, absent.body.error.message);
  const vault = await s.get(s.works.running, join(s.root, "knowledge", "notes", "vault.md"));
  assert.deepEqual([vault.status, vault.body.error.details], [403, { reason: "outside" }]);
  const bare = await s.get(s.works.bare, "docs/x.md");
  assert.deepEqual([bare.status, bare.body.error.details], [403, { reason: "outside" }]);
});

test("refuses symlinks that leave the root, follows ones that stay inside, and judges the real file", async (t) => {
  const s = await setup(t);
  if (!s) return t.skip("localhost listen is unavailable");
  await put(s.outside, "real.md", "outside");
  await put(s.outside, "dir/deep.md", "deep");
  await put(s.project, "inside.md", "inside");
  await put(s.project, "config.yaml", "a: 1");
  await put(s.project, ".env.md", "SECRET=1");
  await symlink(join(s.outside, "real.md"), join(s.project, "escape.md"));
  await symlink(s.outside, join(s.project, "linked-dir"));
  await symlink(join(s.project, "inside.md"), join(s.project, "ok.md"));
  await symlink(join(s.project, "config.yaml"), join(s.project, "as-md.md"));
  await symlink(join(s.project, ".env.md"), join(s.project, "plain.md"));
  const reason = async (path) => (await s.get(s.works.running, path)).body.error?.details?.reason;
  assert.equal(await reason("escape.md"), "symlink_escape");
  assert.equal(await reason("linked-dir/dir/deep.md"), "symlink_escape");
  const ok = await s.get(s.works.running, "ok.md");
  assert.deepEqual([ok.status, ok.body.data.markdown], [200, "inside"]);
  assert.equal(await reason("as-md.md"), "not_markdown");
  assert.equal(await reason("plain.md"), "secret");
});

test("refuses .. paths, secret files and non-Markdown files without reading them", async (t) => {
  const s = await setup(t);
  if (!s) return t.skip("localhost listen is unavailable");
  await put(s.project, "docs/a.md", "a");
  await put(s.project, "a.txt", "text");
  await put(s.project, "a.md.bak", "bak");
  const reason = async (path) => {
    const res = await s.get(s.works.running, path);
    assert.equal(res.status, 403, path);
    assert.equal(code(res), "markdown_path_denied", path);
    return res.body.error.details.reason;
  };
  for (const path of ["../x.md", "docs/../a.md", "../../etc/passwd.md"]) assert.equal(await reason(path), "traversal", path);
  const raw = await fetch(`${s.api.baseUrl}/api/v1/works/${s.works.running}/markdown?path=%2e%2e%2fx.md`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await raw.json()).error.details.reason, "traversal");
  for (const path of [".env.md", "credentials.md", ".ssh/a.md", ".git/a.md"]) assert.equal(await reason(path), "secret", path);
  for (const path of ["a.txt", "a.md.bak", "docs"]) assert.equal(await reason(path), "not_markdown", path);
});

test("does not return the target of a symlink blob as the body", async (t) => {
  const s = await setup(t);
  if (!s) return t.skip("localhost listen is unavailable");
  await put(s.project, "target.md", "real body");
  await symlink("target.md", join(s.project, "link.md"));
  git(s.project, "add", "-A");
  git(s.project, "commit", "-q", "-m", "link");
  const res = await s.get(s.works.running, "link.md");
  assert.equal(res.status, 200);
  assert.equal(res.body.data.markdown, "real body");
});

test("rejects oversized, non-UTF-8 and malformed requests, unknown Works and unauthenticated calls", async (t) => {
  const s = await setup(t);
  if (!s) return t.skip("localhost listen is unavailable");
  const limit = 2 * 1024 * 1024;
  await put(s.project, "exact.md", "a".repeat(limit));
  await put(s.project, "big.md", "a".repeat(limit + 1));
  await put(s.project, "bin.md", Buffer.from([0xff, 0xfe, 0x41]));
  await put(s.project, "bom.md", "﻿text");
  assert.equal((await s.get(s.works.running, "exact.md")).status, 200);
  const big = await s.get(s.works.running, "big.md");
  assert.deepEqual([big.status, code(big), big.body.error.details], [413, "markdown_too_large", { size_bytes: limit + 1, limit_bytes: limit }]);
  const bin = await s.get(s.works.running, "bin.md");
  assert.deepEqual([bin.status, code(bin)], [422, "markdown_unreadable"]);
  assert.equal((await s.get(s.works.running, "bom.md")).body.data.markdown, "text");

  for (const path of [undefined, "", "a\u0000.md", "a\n.md", "x".repeat(4097)]) {
    const res = await s.get(s.works.running, path);
    assert.deepEqual([res.status, code(res), res.body.error.details.field], [400, "validation_error", "path"], JSON.stringify(path)?.slice(0, 20));
  }
  const unknown = await s.get(createUlid(), "a.md");
  assert.deepEqual([unknown.status, code(unknown)], [404, "work_not_found"]);
  const anonymous = await s.get(s.works.running, "docs/a.md", { auth: false });
  assert.deepEqual([anonymous.status, code(anonymous)], [401, "unauthorized"]);
});

test("a materials path answers 503 knowledge_storage_unavailable while the storage cannot be used", async (t) => {
  const s = await setup(t, { knowledgeStorage: { read: () => "not-an-absolute-path", write() {} } });
  if (!s) return t.skip("localhost listen is unavailable");
  const res = await s.get(s.works.bare, "materials/a.md");
  assert.deepEqual([res.status, code(res)], [503, "knowledge_storage_unavailable"]);
});

test("answers 503 dependency_unavailable when the loaded Core cannot read Markdown", async (t) => {
  const { root, db, core } = await createTestCore(t, {}, { prefix: "owl-work-markdown-503-" });
  const limited = Object.create(core, { readWorkMarkdown: { value: undefined } });
  const adapter = new ExternalCoreAdapter(limited, db, root, join(root, "data"));
  t.after(() => adapter.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const api = await startTestHttpServer(t, { core: adapter, db, webOut: root, owlRoot: root }, { token });
  if (!api) return t.skip("localhost listen is unavailable");
  const res = await api.request("GET", `/api/v1/works/${createUlid()}/markdown?path=a.md`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "dependency_unavailable");
});
