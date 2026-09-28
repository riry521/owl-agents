import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Core } from "../packages/core/dist/core.js";
import { openDatabase } from "../packages/db/dist/index.js";
import { createOwlHttpServer } from "../apps/server/dist/http.js";
import { GuardTokenRegistry } from "../apps/server/dist/guard-tokens.js";
import { GUARD_TOKEN_FILE_ENV } from "../packages/shared/dist/guard-token.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = join(repoRoot, "apps/server/dist/research-hook.js");
const LONG_RESULT_LENGTH = 262_144 + 64;

const agentRunner = {
  runManagerPlan: async () => ({ outcome: "failed", message: "unused" }),
  runWorker: async () => ({ outcome: "failed" }),
  runReviewer: async () => ({ outcome: "failed" }),
  runAdvisor: async () => ({ reply: "" }),
};

function longArticle(suffix) {
  const heading = "# Public guide\n\n";
  const sentence = "This public article documents stable behavior for readers. ";
  const fillerLength = LONG_RESULT_LENGTH - heading.length - suffix.length;
  return `${heading}${sentence.repeat(Math.ceil(fillerLength / sentence.length)).slice(0, fillerLength)}${suffix}`;
}

function runHook(input, { apiBase, tokenFile }) {
  return new Promise((resolvePromise, reject) => {
    const env = {
      ...process.env,
      OWL_AGENT_ROLE: "worker",
      OWL_GUARD_API_BASE: apiBase,
      [GUARD_TOKEN_FILE_ENV]: tokenFile,
    };
    const child = spawn(process.execPath, [hookPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("research hook carries auth detection across truncation through capture and recorder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-research-hook-auth-truncation-"));
  const db = openDatabase(join(root, "owl.db"));
  db.migrate(join(repoRoot, "packages/db/migrations"));
  const writeLane = db.createWriteLane();
  const now = new Date().toISOString();
  await writeLane.transact((tx) => {
    tx.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?)", now, now);
    tx.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W1', 'owner:default', NULL, 'Research Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      now, now,
    );
    tx.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES ('T1', 'W1', 'Research Task', 'research', 'running', 'normal', '', '', ?, ?)`,
      now, now,
    );
    tx.run(
      `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
       VALUES ('run-worker-1', 'W1', 'T1', 'worker', 'claude', 'test-model', 'running', ?, ?)`,
      now, now,
    );
  });

  const core = new Core({ db, agentRunner, version: "research-hook-auth-test", owlRoot: root });
  const guardTokens = GuardTokenRegistry.open(join(root, "guard-tokens"));
  const lease = guardTokens.issue({ agent_run_id: "run-worker-1", role: "worker" });
  const http = createOwlHttpServer({
    core,
    db,
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
    guardTokens,
  });
  const priorApiToken = process.env.OWL_API_TOKEN;
  process.env.OWL_API_TOKEN = "test-owner-api-token";
  try {
    try {
      await http.listen();
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("localhost listen is unavailable");
        return;
      }
      throw error;
    }

    const apiBase = `http://127.0.0.1:${http.server.address().port}`;
    const inputFor = (url, result) => ({
      hook_event_name: "PostToolUse",
      tool_name: "WebFetch",
      tool_input: { url },
      tool_response: { code: 200, result },
    });
    for (const [index, form] of [
      '<input type="password">',
      '<input autocomplete="current-password">',
    ].entries()) {
      const result = await runHook(inputFor(`https://example.test/account-${index}`, longArticle(form)), {
        apiBase,
        tokenFile: lease.file,
      });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
    }

    const ordinary = await runHook(inputFor(
      "https://example.test/guide",
      longArticle(" ".repeat('<input type="password">'.length)),
    ), { apiBase, tokenFile: lease.file });
    assert.equal(ordinary.code, 0);
    assert.equal(ordinary.stderr, "");

    await core.researchRecorder.idle();
    const notes = await core.knowledge.list("research");
    assert.equal(notes.length, 1);
    const markdown = await readFile(join(root, "knowledge", notes[0].path), "utf8");
    assert.match(markdown, /^url: https:\/\/example\.test\/guide$/mu);
    assert.match(markdown, /^title: "Public guide"$/mu);
    assert.doesNotMatch(markdown, /account-[01]/u);
  } finally {
    if (http.server.listening) await http.close();
    lease.release();
    guardTokens.clear();
    await core.stop().catch(() => {});
    db.close();
    if (priorApiToken === undefined) delete process.env.OWL_API_TOKEN;
    else process.env.OWL_API_TOKEN = priorApiToken;
    await rm(root, { recursive: true, force: true });
  }
});
