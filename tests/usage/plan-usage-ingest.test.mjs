import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createAgentRunner } from "../../packages/agent-runtime/dist/index.js";
import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore } from "../helpers/core.mjs";
import { createTestDatabase } from "../helpers/db.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const tokenCanary = "plan-usage-ingest-token-canary";
const observedAt = new Date("2026-10-03T10:00:00.000Z");

test("raw Claude and Codex output is ingested through Core, persisted, and exposed by the adapter API", async (t) => {
  // Registered before the temporary directory so it runs first: stop the Core, close the database, then remove the directory.
  let core;
  let db;
  const logs = [];
  const priorConsole = { log: console.log, warn: console.warn, error: console.error };
  t.after(async () => {
    await core?.stop({ force: true });
    db?.close();
    console.log = priorConsole.log;
    console.warn = priorConsole.warn;
    console.error = priorConsole.error;
  });
  const root = await tempDir(t, "owl-plan-usage-ingest-");
  db = createTestDatabase(root);
  const claudeLine = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      rateLimitType: "five_hour",
      status: "allowed_warning",
      utilization: 0.82,
      resetsAt: 1791043200,
      unifiedWindows: { seven_day: { utilization: 0.56, resetsAt: 1791561600 } },
    },
    ignored_token: tokenCanary,
  });
  const codexLine = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: 73, window_minutes: 300, resets_at: 1791043200 },
        secondary: { used_percent: 48, window_minutes: 10080, resets_at: 1791561600 },
        plan_type: "plus",
        ignored_token: tokenCanary,
      },
    },
  });
  const executable = join(root, "fake-agent-cli");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const schemaFlag = args.includes("--json-schema") ? "--json-schema" : "--output-schema";
const schemaIndex = args.indexOf(schemaFlag);
const schema = schemaIndex < 0 ? null : schemaFlag === "--json-schema"
  ? JSON.parse(args[schemaIndex + 1])
  : JSON.parse(fs.readFileSync(args[schemaIndex + 1], "utf8"));
const output = schema?.properties?.results ? { results: [] }
  : schema?.properties?.items ? { items: [] }
  : { reply: "rate usage was observed" };
process.stdin.resume();
process.stdin.on("end", () => {
  const line = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  if (args[0] !== "exec") {
    line(${claudeLine});
    line({ type: "result", subtype: "success", result: JSON.stringify(output) });
  } else {
    line(${codexLine});
    line({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } });
  }
});
`);
  await chmod(executable, 0o755);
  const agentRunner = createAgentRunner({
    adapter: "claude-cli/v1",
    executablePath: executable,
    model: "plan-usage-ingest-test",
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: root },
    outputLogDir: null,
    now: () => observedAt.toISOString(),
  });
  ({ core } = await createTestCore(t, {
    db,
    agentRunner,
    version: "plan-usage-ingest-test",
    owlRoot: root,
    planUsageSources: {
      claude: {
        harness: "claude",
        origin: "claude_usage_api",
        fetch: async () => ({ status: "unauthorized", detail: "http_401", snapshot: null }),
      },
    },
  }));
  console.log = (...values) => logs.push(values.join(" "));
  console.warn = (...values) => logs.push(values.join(" "));
  console.error = (...values) => logs.push(values.join(" "));

  await core.refreshPlanUsage();
  assert.equal((await agentRunner.runCurator({
    proposals: [], skill_index: [], candidates: [], usages: [], with_judgement: true,
    provider: "codex",
  })).ok, true);
  await db.createWriteLane().drain();
  assert.equal(db.all("SELECT origin FROM plan_usage_snapshots WHERE origin = 'codex_live'").length, 1);
  assert.equal(db.all("SELECT origin FROM plan_usage_snapshots WHERE origin = 'claude_rate_limit_event'").length, 0);

  assert.equal((await agentRunner.runKeywordExtraction({ items: [] })).ok, true);
  await db.createWriteLane().drain();
  assert.equal(db.all("SELECT origin FROM plan_usage_snapshots WHERE origin = 'claude_rate_limit_event'").length, 1);
  await agentRunner.runAdvisor({
    conversation_id: "claude-observation",
    invocation_id: "claude-observation",
    provider: "claude",
    messages: [{ source: "owner", body: "check usage" }],
  });
  await agentRunner.runAdvisor({
    conversation_id: "codex-observation",
    invocation_id: "codex-observation",
    provider: "codex",
    messages: [{ source: "owner", body: "check usage" }],
  });
  await db.createWriteLane().drain();

  const rows = db.all("SELECT harness, origin, status, snapshot_json FROM plan_usage_snapshots ORDER BY harness, origin");
  assert.equal(rows.some((row) => row.origin === "claude_rate_limit_event"), true);
  assert.equal(rows.some((row) => row.origin === "codex_live"), true);
  assert.equal(JSON.stringify(rows).includes(tokenCanary), false);

  const view = await core.getPlanUsage();
  assert.equal(view.claude.status, "unauthorized");
  assert.equal(view.claude.fallback, true);
  assert.equal(view.claude.display_origin, "claude_rate_limit_event");
  assert.deepEqual(view.claude.display.windows.map(({ id, state, used_percent, resets_at }) => ({ id, state, used_percent, resets_at })), [
    { id: "five_hour", state: "warning", used_percent: 82, resets_at: "2026-10-03T16:00:00.000Z" },
    { id: "seven_day", state: null, used_percent: 56, resets_at: "2026-10-09T16:00:00.000Z" },
  ]);
  assert.equal(view.codex.status, "ok");
  assert.equal(view.codex.display_origin, "codex_live");
  assert.equal(JSON.stringify(view).includes(tokenCanary), false);

  const adapter = new ExternalCoreAdapter(core, db, root, join(root, "data"));
  const api = await startTestHttpServer(t, { core: adapter, webOut: root, owlRoot: root }, { token: "plan-usage-ingest-http-test-token" });
  if (!api) return t.skip("localhost listen is unavailable");
  const response = await api.request("GET", "/api/v1/plan-usage");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes(tokenCanary), false);
  assert.equal(logs.join("\n").includes(tokenCanary), false);
  const data = JSON.parse(body).data;
  assert.equal(data.claude.display_origin, "claude_rate_limit_event");
  assert.equal(data.codex.display_origin, "codex_live");
});

test("persistent Claude and Codex Advisor session output is ingested into PlanUsageService", async (t) => {
  for (const harness of ["claude", "codex"]) {
    // Registered before the temporary directory so it runs first: stop the session and Core, close the database, then remove the directory.
    let session;
    let core;
    let db;
    t.after(async () => {
      await session?.stop("test_complete", 100).catch(() => {});
      await core?.stop({ force: true });
      db?.close();
    });
    const root = await tempDir(t, `owl-plan-usage-session-${harness}-`);
    db = createTestDatabase(root);
    const executable = join(root, "fake-session-cli");
    const rateLine = harness === "claude"
      ? JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { rateLimitType: "five_hour", status: "rejected", utilization: 1, resetsAt: 1791043200 },
          ignored_token: tokenCanary,
        })
      : JSON.stringify({
          jsonrpc: "2.0",
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              primary: { used_percent: 77, window_minutes: 300, resets_at: 1791043200 },
              plan_type: "plus",
              ignored_token: tokenCanary,
            },
          },
        });
    const sessionScript = harness === "claude" ? `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type !== "user") return;
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  emit({ type: "system", subtype: "init", session_id: "claude-session" });
  emit(${JSON.stringify(JSON.parse(rateLine))});
  emit({ type: "assistant", message: { content: [{ type: "text", text: "ready" }] } });
  emit({ type: "result", subtype: "success", result: "ready" });
});
` : `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") emit({ jsonrpc: "2.0", id: request.id, result: {} });
  if (request.method === "thread/start") {
    emit({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "codex-session" } } });
    emit(${JSON.stringify(JSON.parse(rateLine))});
  }
  if (request.method === "turn/start") emit({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "codex-turn" } } });
});
`;
    await writeFile(executable, sessionScript, "utf8");
    await chmod(executable, 0o755);
    const agentRunner = createAgentRunner({
      adapter: "claude-cli/v1",
      executablePath: executable,
      model: "plan-usage-session-test",
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        OWL_ROOT: repoRoot,
        OWL_CLAUDE_EXECUTABLE: executable,
        OWL_CODEX_EXECUTABLE: executable,
      },
      outputLogDir: null,
      now: () => observedAt.toISOString(),
    });
    ({ core } = await createTestCore(t, {
      db,
      agentRunner,
      providerClient: agentRunner.provider,
      version: "plan-usage-session-test",
      owlRoot: root,
    }));

    session = await agentRunner.provider.createSession({
      adapter: harness === "claude" ? "claude-cli/v1" : "codex",
      role: "advisor",
      model: "plan-usage-session-test",
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        OWL_ROOT: repoRoot,
        OWL_CLAUDE_EXECUTABLE: executable,
        OWL_CODEX_EXECUTABLE: executable,
      },
      system_prompt: "test only",
    });
    if (harness === "claude") {
      await session.send({ turn_id: "claude-turn", text: "observe usage" });
      for await (const event of session.events()) {
        if (event.type === "turn.completed") break;
      }
    } else {
      await session.send({ turn_id: "codex-turn-local", text: "observe usage" });
    }
    await db.createWriteLane().drain();
    const rows = db.all("SELECT harness, origin, snapshot_json FROM plan_usage_snapshots ORDER BY harness, origin");
    assert.equal(rows.some((row) => row.harness === harness), true, `${harness} session should save a usage observation`);
    assert.equal(JSON.stringify(rows).includes(tokenCanary), false);
    const expectedOrigin = harness === "claude" ? "claude_rate_limit_event" : "codex_live";
    assert.equal(rows.some((row) => row.origin === expectedOrigin), true);
  }
});
