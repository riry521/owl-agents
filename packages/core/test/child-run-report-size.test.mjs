import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createChildRunScheduler } from "../dist/child-run-scheduler.js";
import { CHILD_RUN_LIMITS, DEFAULT_CHILD_RUN_SETTINGS } from "../../shared/dist/index.js";
import { createUlid, openDatabase } from "../../db/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const title = "日".repeat(120);
const fakeClaude = [
  "#!/usr/bin/env node",
  "const { readFileSync } = require('node:fs');",
  "const prompt = readFileSync(0, 'utf8');",
  "const summary = prompt.match(/CHILD_REPORT_SUMMARY:([^\\r\\n]*)/u)?.[1] ?? '';",
  "const fence = String.fromCharCode(96).repeat(3);",
  "const report = fence + 'owl-child-report\\n' + JSON.stringify({ result: 'succeeded', summary, changed_files: [], checks: [], remaining_issues: [] }) + '\\n' + fence;",
  "setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: report })), 25);",
].join("\n");

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "owl-child-report-size-"));
  const bin = join(root, "bin");
  const guards = join(root, "guards");
  await Promise.all([mkdir(bin), mkdir(guards)]);
  const claude = join(bin, "claude");
  await writeFile(claude, fakeClaude);
  await chmod(claude, 0o755);
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const ids = { work: createUlid(), task: createUlid(), parent: createUlid() };
  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES (?, 'owner:default', 'Report size test', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      ids.work, now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES (?, ?, 'Report size test', 'code', 'running', 'normal', '', '', ?, ?)`,
      ids.task, ids.work, now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, 'worker', 'codex', 'gpt-5.6-terra', 'running', ?, ?)`,
      ids.parent, ids.work, ids.task, now, now,
    );
  });
  const scheduler = createChildRunScheduler({
    db,
    executorRuntime: () => ({
      owlRoot: repoRoot,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: root },
      executables: { claude, codex: claude },
      guardToken: ({ agent_run_id }) => {
        const file = join(guards, agent_run_id);
        writeFileSync(file, "fake-child-token");
        return { file, release() {} };
      },
    }),
    settings: () => ({ ...DEFAULT_CHILD_RUN_SETTINGS }),
    onParentActivity() {},
  });
  scheduler.registerParent({
    agent_run_id: ids.parent, work_id: ids.work, task_id: ids.task,
    harness: "codex",
    workspace_dir: root, worktree: root,
    task: { title: "test", acceptance: "", context: "", rules: "", owner_guidance: [] },
  });
  t.after(async () => {
    await scheduler.stop();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { db, ids, scheduler };
}

test("wait keeps its complete UTF-8 response within 16 KiB at and above the boundary", async (t) => {
  const { db, ids, scheduler } = await setup(t);
  const childIds = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const child = await scheduler.dispatch(ids.parent, {
      title,
      instruction: `CHILD_REPORT_SUMMARY:${"a".repeat(351)}`,
      write_paths: [`src/child-${index}.ts`],
    }, `report-size-${index}`);
    return child.child_id;
  }));
  const signal = new AbortController().signal;

  const completed = await scheduler.wait(ids.parent, { child_ids: childIds, timeout_seconds: 60 }, signal);
  assert.equal(completed.done, true);
  await db.createWriteLane().transact((tx) => {
    for (const id of childIds) {
      const stored = db.get("SELECT summary_json FROM child_runs WHERE id = ?", id);
      const value = JSON.parse(stored.summary_json);
      value.duration_seconds = 0;
      tx.run("UPDATE child_runs SET summary_json = ? WHERE id = ?", JSON.stringify(value), id);
    }
  });
  const atBoundary = await scheduler.wait(ids.parent, { child_ids: childIds }, signal);
  assert.equal(Buffer.byteLength(JSON.stringify(atBoundary), "utf8"), 16_364);
  assert.equal(atBoundary.truncated, false);

  await db.createWriteLane().transact((tx) => {
    for (const [index, id] of childIds.entries()) {
      const stored = db.get("SELECT summary_json FROM child_runs WHERE id = ?", id);
      const value = JSON.parse(stored.summary_json);
      value.summary += "a".repeat(index < 10 ? 1 : 2);
      tx.run("UPDATE child_runs SET summary_json = ? WHERE id = ?", JSON.stringify(value), id);
    }
  });
  const justOverBoundary = await scheduler.wait(ids.parent, { child_ids: childIds }, signal);
  assert.equal(Buffer.byteLength(JSON.stringify(justOverBoundary), "utf8") <= CHILD_RUN_LIMITS.wait_response_max_bytes, true);
  assert.equal(justOverBoundary.truncated, true);

  const first = db.get("SELECT summary_json FROM child_runs WHERE id = ?", childIds[0]);
  const japanese = JSON.parse(first.summary_json);
  japanese.summary = "日".repeat(397);
  await db.createWriteLane().transact((tx) => {
    tx.run("UPDATE child_runs SET summary_json = ? WHERE id = ?", JSON.stringify(japanese), childIds[0]);
  });
  const multibyte = await scheduler.wait(ids.parent, { child_ids: childIds }, signal);
  assert.equal(Buffer.byteLength(JSON.stringify(multibyte), "utf8") <= CHILD_RUN_LIMITS.wait_response_max_bytes, true);
  assert.equal(multibyte.truncated, true);
});
