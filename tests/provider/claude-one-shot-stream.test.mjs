import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const searchPath = process.env.PATH || `${dirname(process.execPath)}:/usr/bin:/bin`;
import { test } from "node:test";
import { createCliProvider } from "../../packages/agent-runtime/dist/provider.js";
import { tempDir } from "../helpers/temp.mjs";

test("Claude one-shot streams progress and returns only the result object", async (t) => {
  const root = await tempDir(t, "owl-claude-stream-");
  const capture = join(root, "argv.json");
  const executable = join(root, "claude");
  await writeFile(executable, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
  const line = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  line({ type: "system", subtype: "init", session_id: "session-1" });
  line({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
  line({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(5 * 1024 * 1024) }] } });
  line({ type: "result", subtype: "success", result: "done", session_id: "session-1" });
});
`);
  await chmod(executable, 0o755);
  let outputs = 0;
  const provider = createCliProvider({ adapter: "claude-cli/v1", executablePath: executable, model: "test-model", env: { PATH: searchPath, HOME: root } });
  const response = await provider.execute({
    adapter: "claude-cli/v1", role: "worker", model: "test-model", prompt: "work", invocation_id: "run-1", cwd: root,
    env: { PATH: searchPath, HOME: root, ARGV_CAPTURE: capture },
    on_output: () => { outputs += 1; },
  });
  const args = JSON.parse(await readFile(capture, "utf8"));
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"));
  assert.deepEqual(JSON.parse(response.stdout), { type: "result", subtype: "success", result: "done", session_id: "session-1" });
  assert.equal(response.provider_session_id, "session-1");
  assert.ok(outputs > 0);
});
