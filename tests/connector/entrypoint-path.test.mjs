import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(join(tmpdir(), "owl-entry-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Copies (not symlinks): node resolves a symlinked main script to its real path,
// which would hide the space/non-ASCII directory this test is about.
const base = join(tmp, "owl テスト dir", "packages");
for (const pkg of ["shared", "connector-slack", "connector-discord"]) {
  mkdirSync(join(base, pkg), { recursive: true });
  cpSync(join(root, "packages", pkg, "dist"), join(base, pkg, "dist"), { recursive: true });
  symlinkSync(join(root, "packages", pkg, "node_modules"), join(base, pkg, "node_modules"));
}

const env = { PATH: process.env.PATH, HOME: tmp };
const required = {
  slack: /SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required/,
  discord: /DISCORD_BOT_TOKEN is required/,
};

for (const [name, message] of Object.entries(required)) {
  const entry = join(base, `connector-${name}`, "dist", "index.js");

  test(`${name} connector runs its entrypoint when launched from a path with spaces and non-ASCII`, () => {
    const result = spawnSync(process.execPath, [entry], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  });

  test(`${name} connector does not start when imported`, () => {
    const code = `await import(${JSON.stringify(pathToFileURL(entry).href)})`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: tmp, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  });
}
