import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";

function runOpen(dataDir, extraArgs = []) {
  return spawnSync(process.execPath, ["apps/server/dist/cli.js", "open", ...extraArgs], {
    cwd: repoRoot,
    // An empty PATH makes the browser launcher unavailable, so the CLI must fall back to printing the URL.
    env: { ...process.env, PATH: "", OWL_DATA_DIR: dataDir, OWL_LANG: "en" },
    encoding: "utf8",
  });
}

test("owl open prints the Web UI URL of the running server when no browser can be launched", async (t) => {
  const dataDir = await tempDir(t, "owl-open-");
  writeFileSync(join(dataDir, "owl-server.json"), JSON.stringify({ pid: process.pid, bind: "127.0.0.1", port: 45123 }));
  const result = runOpen(dataDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Could not open a browser\. Open this URL: http:\/\/127\.0\.0\.1:45123\/owl\//u);
});

test("owl stop reports a failed entry and logs the error when pgrep cannot run", async () => {
  const { stopManagedAuxiliaryProcesses } = await import("../../apps/server/dist/lifecycle-stop.js");
  const previousPath = process.env.PATH;
  const original = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };
  process.env.PATH = "";
  try {
    const results = await stopManagedAuxiliaryProcesses(repoRoot, { force: false, timeoutSeconds: 1 });
    assert.deepEqual(results.map((entry) => [entry.name, entry.status]), [["supervisor", "failed"], ["connectors", "failed"]]);
  } finally {
    process.env.PATH = previousPath;
    console.error = original;
  }
  assert.ok(logged.some((args) => /pgrep failed/u.test(String(args[0])) && args[1] instanceof Error));
});

test("owl open rejects extra arguments", () => {
  const result = runOpen(tmpdir(), ["--foo"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid open arguments: --foo/u);
});
