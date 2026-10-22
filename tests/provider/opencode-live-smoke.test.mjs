// Minimal check against a real opencode v2: one session, one send, then stop. Runs only when
// OWL_OPENCODE_SMOKE_MODEL (providerID/modelID) is set, so the full suite never calls a model.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { OpencodeSessionDriver } from "../../packages/agent-runtime/dist/index.js";
import { OPENCODE_EXECUTABLE_ENV } from "../../packages/shared/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

const model = process.env.OWL_OPENCODE_SMOKE_MODEL;
const TURN_TIMEOUT_MS = 180_000;

/** Reads events until one of `types` arrives; `seen` gets every event type on the way. */
async function nextEvent(iterator, types, seen = []) {
  const deadline = AbortSignal.timeout(TURN_TIMEOUT_MS);
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => deadline.addEventListener("abort", () => reject(new Error(`timed out waiting for ${types}`)))),
    ]);
    assert.ok(!next.done, `event stream ended before ${types}`);
    seen.push(next.value.type);
    if (types.includes(next.value.type)) return next.value;
  }
}

test("opencode v2 smoke: start, reply, finish, stop", { skip: model ? false : "OWL_OPENCODE_SMOKE_MODEL is not set" }, async (t) => {
  const root = await tempDir(t, "owl-opencode-smoke-");
  const cwd = join(root, "cwd");
  const owlRoot = join(root, "owl");
  mkdirSync(cwd);
  mkdirSync(owlRoot);
  // An OWL_ROOT without built MCP servers makes owlMcpServers return nothing; the base URL and key env are left out.
  const env = { ...process.env, OWL_ROOT: owlRoot };
  delete env.OWL_OPENCODE_BASE_URL;
  delete env.OWL_OPENCODE_API_KEY_ENV;
  const lines = [];
  let driver;
  let pid = 0;
  const report = { ready: "fail", delta: "fail", completed: "fail", stopped: "fail" };
  try {
    driver = await OpencodeSessionDriver.create({
      adapter: "opencode-serve/v1",
      role: "advisor",
      model,
      cwd,
      env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")),
      system_prompt: "You answer briefly.",
      on_stdout_line: (line) => lines.push(line),
    });
    const iterator = driver.events()[Symbol.asyncIterator]();
    const ready = await nextEvent(iterator, ["session.ready"]);
    assert.ok(ready.provider_session_id);
    assert.ok(Number.isInteger(ready.pid) && ready.pid > 0);
    pid = ready.pid;
    report.ready = "pass";

    await driver.send({ turn_id: "smoke-1", text: "Reply with one short sentence. Do not use any tool." });
    const seen = [];
    const final = await nextEvent(iterator, ["turn.completed", "turn.failed"], seen);
    const deltas = seen.filter((type) => type === "turn.delta").length;
    const resultLine = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((row) => row?.type === "opencode.result");
    const version = resultLine?.version;
    const failure = final.type === "turn.failed" ? { error: final.error, rate_limit: final.rate_limit, type: resultLine?.error?.type } : null;
    assert.equal(failure, null, `turn.failed: ${JSON.stringify(failure)} (opencode ${version})`);
    assert.ok(deltas >= 1, "no turn.delta");
    report.delta = "pass";
    assert.ok(final.reply.length > 0, "reply is empty");
    assert.ok(typeof final.usage.input_tokens === "number" && typeof final.usage.output_tokens === "number", `usage: ${JSON.stringify(final.usage)}`);
    report.completed = "pass";
    t.diagnostic(`serve version ${version}, reply length ${final.reply.length}, usage ${JSON.stringify(final.usage)}`);
  } finally {
    if (driver) await driver.stop("smoke done");
    t.diagnostic(`stages ${JSON.stringify(report)}`);
  }
  assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
  const runs = join(owlRoot, "data", "opencode-runs");
  assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], []);
  const rest = [];
  for await (const event of driver.events()) rest.push(event.type);
  assert.ok(rest.includes("session.exited"), `events after stop: ${rest.join(",")}`);
  report.stopped = "pass";
  t.diagnostic(`stages ${JSON.stringify(report)}`);
});
