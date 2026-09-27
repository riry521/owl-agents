import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../packages/db/dist/index.js";
import { detectSkillReads, SkillBox } from "../packages/core/dist/skill-box.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";

const migrations = join(process.cwd(), "packages/db/migrations");

test("detectSkillReads finds skill paths in file tools, shell segments, and MCP path fields", () => {
  const owlRoot = "/srv/owl";
  assert.deepEqual(detectSkillReads({
    owlRoot,
    tool_name: "Read",
    tool_input: { file_path: "/srv/owl/skills/release-procedure/SKILL.md" },
    cwd: "/tmp/work",
    normalized_segments: [],
  }), ["release-procedure"]);
  assert.deepEqual(detectSkillReads({
    owlRoot,
    tool_name: "bash",
    tool_input: { command: "cat skills/release-procedure/SKILL.md" },
    cwd: "/srv/owl",
    normalized_segments: [["cat", "skills/release-procedure/SKILL.md"]],
  }), ["release-procedure"]);
  assert.deepEqual(detectSkillReads({
    owlRoot,
    tool_name: "mcp__filesystem__read_file",
    tool_input: { path: "skills/release-procedure/references/release.md" },
    cwd: "/srv/owl",
    normalized_segments: [],
  }), ["release-procedure"]);
  assert.deepEqual(detectSkillReads({
    owlRoot,
    tool_name: "read",
    tool_input: { path: "/srv/owl/src/app.ts" },
    cwd: "/tmp/work",
    normalized_segments: [],
  }), []);
  assert.deepEqual(detectSkillReads({
    owlRoot,
    tool_name: "read",
    tool_input: { path: "/srv/owl/skills/Release/SKILL.md" },
    cwd: "/tmp/work",
    normalized_segments: [],
  }), []);
});

test("detectSkillReads ignores tools the guard treats as writes", () => {
  const owlRoot = "/srv/owl";
  const path = "/srv/owl/skills/release-procedure/SKILL.md";
  for (const [tool_name, tool_input] of [
    ["Edit", { file_path: path, old_string: "a", new_string: "b" }],
    ["mcp__filesystem__write_file", { path }],
    ["mcp__filesystem__move_file", { source_path: path, destination_path: "/tmp/x" }],
    ["mcp__notes__store", { path, content: "text" }],
  ]) {
    assert.deepEqual(detectSkillReads({ owlRoot, tool_name, tool_input, cwd: "/tmp/work", normalized_segments: [] }), [], tool_name);
  }
});

test("read records UPSERT once per run and ignores unknown agent runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-skill-usage-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(migrations);
  const box = new SkillBox({ db, owlRoot: root, logger: { warn() {}, error() {} } });
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

  const now = new Date().toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run("INSERT INTO works (id, owner_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at) VALUES ('work-1', 'owner:default', 'Work', '', 'normal', 'ready', '[]', '[]', ?, ?)", now, now);
    tx.run("INSERT INTO agent_runs (id, work_id, role, provider, model, status, created_at, updated_at) VALUES ('run-1', 'work-1', 'worker', 'test', 'test', 'running', ?, ?)", now, now);
  });
  await box.applyRevision({
    name: "release-procedure",
    files: { "SKILL.md": "---\nname: release-procedure\ndescription: Release steps.\nscope: global\ntags: []\n---\n# Release\n" },
    meta: { description: "Release steps.", tags: [], scope: "global" },
    actor: "user",
    action: "create",
    reason: "initial",
    trial: false,
  });

  await box.recordRead("missing-run", ["release-procedure"]);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM skill_usages").count, 0);
  await box.recordRead("run-1", ["release-procedure", "release-procedure", "missing-skill"]);
  await box.recordRead("run-1", ["release-procedure"]);
  const usage = db.get("SELECT * FROM skill_usages WHERE agent_run_id = 'run-1' AND skill_name = 'release-procedure'");
  assert.equal(usage.read_detected, 1);
  assert.equal(usage.revision, 1);
  assert.equal(db.get("SELECT use_count FROM skills WHERE name = 'release-procedure'").use_count, 1);
});

test("guard response is unchanged when read recording fails; owner checks and denied calls are not recorded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-skill-guard-"));
  const previousToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "owner-token";
  const recorded = [];
  let decision = { allowed: true, rule_id: null, scope: null, message: "" };
  const core = {
    recordSkillReads: async (input) => {
      recorded.push(input);
      throw new Error("recording failed");
    },
  };
  const guardTokens = { verify: (token) => token === "agent-token" ? { agent_run_id: "run-1", role: "worker" } : null };
  const server = createOwlHttpServer({
    core,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    guardTokens,
    ruleStore: { checkGuard: () => decision },
  });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = previousToken;
  });
  try {
    await server.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("localhost listen is unavailable");
    throw error;
  }

  const url = `http://127.0.0.1:${server.server.address().port}/api/v1/guard/check`;
  const call = async (token) => fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      request_id: "guard-1",
      idempotency_key: "guard-1",
      expected_version: 0,
      payload: { role: "worker", tool_name: "read", tool_input: { path: "/srv/owl/skills/release-procedure/SKILL.md" }, cwd: resolve(root) },
    }),
  });
  const agentResponse = await call("agent-token");
  assert.equal(agentResponse.status, 200);
  assert.deepEqual((await agentResponse.json()).data, decision);
  const ownerResponse = await call("owner-token");
  assert.equal(ownerResponse.status, 200);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].agent_run_id, "run-1");

  decision = { allowed: false, rule_id: "rule-1", scope: "global", message: "blocked" };
  const deniedResponse = await call("agent-token");
  assert.deepEqual((await deniedResponse.json()).data, decision);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(recorded.length, 1, "a denied call is not recorded as a read");
});
