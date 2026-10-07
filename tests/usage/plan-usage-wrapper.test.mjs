import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createExternalAgentRunner } from "../../apps/server/dist/agent-runner.js";
import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const fixedReset = 1_900_000_000;

async function createFixture(t) {
  const envKeys = [
    "OWL_PROVIDER", "OWL_PROVIDER_ID", "OWL_PROVIDER_ADAPTER", "OWL_PROVIDER_MODEL",
    "OWL_PROVIDER_EXECUTABLE", "OWL_CLAUDE_EXECUTABLE", "OWL_CODEX_EXECUTABLE", "OWL_DATA_DIR",
    "HOME", "PATH",
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  // Registered before the temporary directory so it runs first: stop the Core, close the database, restore the
  // environment, then the directory is removed.
  let core;
  let db;
  t.after(async () => {
    await core?.stop({ force: true });
    db?.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const root = await tempDir(t, "owl-plan-usage-wrapper-");
  const hookDir = join(root, "apps/server/dist");
  await mkdir(hookDir, { recursive: true });
  await symlink(join(repoRoot, "apps/server/dist/permission-hook.js"), join(hookDir, "permission-hook.js"));
  db = createTestDatabase(root);
  const executable = join(root, "fake-provider-cli");
  const claudeRateLimit = {
    type: "rate_limit_event",
    rate_limit_info: {
      rateLimitType: "five_hour",
      status: "allowed_warning",
      utilization: 0.82,
      resetsAt: fixedReset,
    },
  };
  const codexRateLimits = {
    primary: { used_percent: 73, window_minutes: 300, resets_at: fixedReset },
    secondary: { used_percent: 48, window_minutes: 10080, resets_at: fixedReset },
    plan_type: "plus",
  };
  const cli = `#!/usr/bin/env node
const readline = require("node:readline");
const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const claudeRateLimit = ${JSON.stringify(claudeRateLimit)};
const codexRateLimits = ${JSON.stringify(codexRateLimits)};
if (args.includes("app-server")) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") emit({ jsonrpc: "2.0", id: request.id, result: {} });
    if (request.method === "thread/start") {
      emit({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "codex-session" } } });
      emit({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: { rateLimits: codexRateLimits } });
    }
    if (request.method === "turn/start") emit({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "codex-turn" } } });
  });
} else if (args.includes("--input-format") && args.includes("stream-json")) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (JSON.parse(line).type !== "user") return;
    emit({ type: "system", subtype: "init", session_id: "claude-session" });
    emit(claudeRateLimit);
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ready" }] } });
    emit({ type: "result", subtype: "success", result: "ready" });
  });
} else {
  const schemaFlag = args.includes("--json-schema") ? "--json-schema" : "--output-schema";
  const schemaIndex = args.indexOf(schemaFlag);
  const schema = schemaIndex < 0 ? null : schemaFlag === "--json-schema"
    ? JSON.parse(args[schemaIndex + 1])
    : JSON.parse(require("node:fs").readFileSync(args[schemaIndex + 1], "utf8"));
  const output = schema?.properties?.results ? { results: [] }
    : schema?.properties?.items ? { items: [] }
    : { reply: "rate usage observed" };
  process.stdin.resume();
  process.stdin.on("end", () => {
    if (args[0] === "exec") {
      emit({ type: "event_msg", payload: { type: "token_count", rate_limits: codexRateLimits } });
      emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } });
    } else {
      emit(claudeRateLimit);
      emit({ type: "result", subtype: "success", result: JSON.stringify(output) });
    }
  });
}
`;
  await writeFile(executable, cli, "utf8");
  await chmod(executable, 0o755);

  Object.assign(process.env, {
    OWL_PROVIDER: "real",
    OWL_PROVIDER_ID: "claude",
    OWL_PROVIDER_ADAPTER: "claude-cli/v1",
    OWL_PROVIDER_MODEL: "plan-usage-wrapper-test",
    OWL_CLAUDE_EXECUTABLE: executable,
    OWL_CODEX_EXECUTABLE: executable,
    OWL_DATA_DIR: join(root, "server-data"),
    HOME: root,
    PATH: process.env.PATH ?? "",
  });
  const runner = await createExternalAgentRunner(root, false);
  ({ core } = await createTestCore(t, {
    db,
    agentRunner: runner,
    version: "plan-usage-wrapper-test",
    owlRoot: root,
    planUsageSources: {
      claude: {
        harness: "claude",
        origin: "claude_usage_api",
        fetch: async () => ({ status: "unauthorized", detail: "http_401", snapshot: null }),
      },
    },
  }));

  return { root, db, runner, core };
}

test("Core's external runner wrapper forwards plan usage observations from single runs into the API fallback", async (t) => {
  const { db, runner, core } = await createFixture(t);
  await core.refreshPlanUsage();
  const claudeResult = await runner.runKeywordExtraction({ items: [] });
  assert.equal(claudeResult.ok, true, claudeResult.error);
  const codexResult = await runner.runCurator({
    proposals: [], candidates: [], usages: [], with_judgement: true, provider: "codex",
  });
  assert.equal(codexResult.ok, true, codexResult.error);
  await db.createWriteLane().drain();

  const rows = db.all("SELECT harness, origin FROM plan_usage_snapshots WHERE origin IN ('claude_rate_limit_event', 'codex_live') ORDER BY harness");
  assert.deepEqual(rows, [
    { harness: "claude", origin: "claude_rate_limit_event" },
    { harness: "codex", origin: "codex_live" },
  ]);
  const view = await core.getPlanUsage();
  assert.equal(view.claude.status, "unauthorized");
  assert.equal(view.claude.fallback, true);
  assert.equal(view.claude.display_origin, "claude_rate_limit_event");
  assert.equal(view.claude.display.windows[0].used_percent, 82);
  assert.equal(view.codex.display_origin, "codex_live");
  assert.equal(view.codex.display.windows[0].used_percent, 73);
});

test("Core's external runner wrapper forwards persistent Claude and Codex Advisor session output", async (t) => {
  const { db, root, runner, core } = await createFixture(t);
  const provider = await runner.getProvider();
  assert.equal(typeof provider?.createSession, "function");

  for (const harness of ["claude", "codex"]) {
    const session = await provider.createSession({
      adapter: harness === "claude" ? "claude-cli/v1" : "codex",
      role: "advisor",
      model: "plan-usage-wrapper-test",
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        OWL_ROOT: repoRoot,
        OWL_CLAUDE_EXECUTABLE: process.env.OWL_CLAUDE_EXECUTABLE,
        OWL_CODEX_EXECUTABLE: process.env.OWL_CODEX_EXECUTABLE,
      },
      system_prompt: "test only",
    });
    try {
      if (harness === "claude") {
        await session.send({ turn_id: "claude-turn", text: "observe usage" });
        for await (const event of session.events()) {
          if (event.type === "turn.completed") break;
        }
      } else {
        await session.send({ turn_id: "codex-turn-local", text: "observe usage" });
      }
    } finally {
      await session.stop("test_complete", 100);
    }
  }
  await db.createWriteLane().drain();

  const rows = db.all("SELECT harness, origin FROM plan_usage_snapshots WHERE origin IN ('claude_rate_limit_event', 'codex_live') ORDER BY harness");
  assert.deepEqual(rows, [
    { harness: "claude", origin: "claude_rate_limit_event" },
    { harness: "codex", origin: "codex_live" },
  ]);
  assert.equal((await core.getPlanUsage()).claude.display_origin, "claude_rate_limit_event");
});
