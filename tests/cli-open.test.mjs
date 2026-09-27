import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runOpen(dataDir, extraArgs = []) {
  return spawnSync(process.execPath, ["apps/server/dist/cli.js", "open", ...extraArgs], {
    cwd: root,
    // An empty PATH makes the browser launcher unavailable, so the CLI must fall back to printing the URL.
    env: { ...process.env, PATH: "", OWL_DATA_DIR: dataDir, OWL_LANG: "en" },
    encoding: "utf8",
  });
}

test("owl open prints the Web UI URL of the running server when no browser can be launched", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "owl-open-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeFileSync(join(dataDir, "owl-server.json"), JSON.stringify({ pid: process.pid, bind: "127.0.0.1", port: 45123 }));
  const result = runOpen(dataDir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Could not open a browser\. Open this URL: http:\/\/127\.0\.0\.1:45123\/owl\//u);
});

test("owl open rejects extra arguments", () => {
  const result = runOpen(tmpdir(), ["--foo"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid open arguments: --foo/u);
});
