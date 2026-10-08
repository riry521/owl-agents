import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { RELAY_STATE_FILE_ENV } from "../../packages/shared/dist/token-relay.js";
import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

const hookPath = path.join(repoRoot, "apps/server/dist/relay-hook.js");

function runHook(input, stateFile) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env[RELAY_STATE_FILE_ENV];
    if (stateFile !== undefined) env[RELAY_STATE_FILE_ENV] = stateFile;
    const child = spawn(process.execPath, [hookPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

const postToolUse = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } };

test("relay hook blocks compaction with exit 2", async () => {
  for (const trigger of ["auto", "manual"]) {
    const result = await runHook({ hook_event_name: "PreCompact", trigger });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /owl-child-handoff/);
    assert.equal(result.stdout, "");
  }
});

test("relay hook passes the handoff message to the child once the state is handoff", async (t) => {
  const dir = await tempDir(t, "owl-relay-hook-");
  const stateFile = path.join(dir, "state.json");
  await writeFile(stateFile, JSON.stringify({ phase: "handoff", message: "Owl: hand off now." }));
  const result = await runHook(postToolUse, stateFile);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { decision: "block", reason: "Owl: hand off now." });
});

test("relay hook stays silent when the state file is missing, broken, or still running", async (t) => {
  const dir = await tempDir(t, "owl-relay-hook-quiet-");
  const running = path.join(dir, "running.json");
  const broken = path.join(dir, "broken.json");
  const noMessage = path.join(dir, "no-message.json");
  await writeFile(running, JSON.stringify({ phase: "running" }));
  await writeFile(broken, "{\"phase\":\"hand");
  await writeFile(noMessage, JSON.stringify({ phase: "handoff" }));
  for (const stateFile of [undefined, path.join(dir, "missing.json"), broken, running, noMessage]) {
    const result = await runHook(postToolUse, stateFile);
    assert.equal(result.code, 0, String(stateFile));
    assert.equal(result.stdout, "", String(stateFile));
  }
  const unparsable = await runHook("not json", running);
  assert.deepEqual([unparsable.code, unparsable.stdout], [0, ""]);
});
