#!/usr/bin/env node
// Starts the built server on a free port with a /tmp vault copy and temp OWL_DATA_DIR, runs `codex exec`
// so the agent calls owl-memory search/expand/recall/health, and checks each succeeded. Only kills its own server.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const src = process.argv[2] || process.env.OWL_VAULT;
const prodRoot = process.env.OWL_PROD_ROOT;
if (!src || !prodRoot) {
  console.error("Usage: OWL_PROD_ROOT=/path/to/owl OWL_VAULT=/path/to/vault node scripts/memory-codex-check.mjs [vault-dir]");
  process.exit(2);
}
const tmp = mkdtempSync(join(tmpdir(), "memory-codex-"));
const root = join(tmp, "root"), vault = join(tmp, "vault"), data = join(root, "data"), tokenFile = join(tmp, "token");
mkdirSync(root, { recursive: true });
for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
  if (["knowledge", "data", ".git"].includes(entry.name) || entry.name.startsWith(".env")) continue;
  symlinkSync(join(projectRoot, entry.name), join(root, entry.name));
}
cpSync(join(prodRoot, "knowledge"), join(root, "knowledge"), { recursive: true });
cpSync(src, vault, { recursive: true });
mkdirSync(data, { recursive: true });
// The real vault's notes still lack type/summary/status, so none are searchable; seed one valid note in the copy.
writeFileSync(join(vault, "notes", "codex-check.md"), "---\ntype: decision\nsummary: 決定の例: テスト用の記憶ノート\nstatus: active\n---\n\n# 決定の例\n\nこれは確認用の決定ノートです。\n");
writeFileSync(join(data, "app-settings.json"), JSON.stringify({ knowledge_dir: vault }));
const sandbox = join(tmp, "deny-prod-writes.sb");
writeFileSync(sandbox, `(version 1)\n(allow default)\n(deny file-write* (subpath "${resolve(src)}") (subpath "${resolve(prodRoot, "data")}") (subpath "${resolve(prodRoot, "knowledge")}"))\n`);
const token = `t${Math.random().toString(36).slice(2)}${Date.now()}`;
writeFileSync(tokenFile, token, { mode: 0o600 });
const port = await new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const base = `http://127.0.0.1:${port}`;
const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !["OWL_ROOT", "OWL_DATA_DIR", "OWL_PORT", "OWL_BIND", "OWL_API_BASE", "OWL_API_TOKEN", "OWL_GUARD_API_BASE", "OWL_GUARD_TOKEN_FILE"].includes(key) && !key.startsWith("OWL_MEMORY_")));
const server = spawn("sandbox-exec", ["-f", sandbox, "node", join(projectRoot, "apps/server/dist/server.js")], {
  cwd: root, stdio: "ignore",
  env: { ...isolatedEnv, OWL_ROOT: root, OWL_DATA_DIR: data, OWL_PORT: String(port), OWL_API_TOKEN: token, OWL_BIND: "127.0.0.1" },
});
let ok = false;
try {
  for (let i = 0; i < 60 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ok = await fetch(`${base}/api/v1/memory/health`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.ok, () => false);
  }
  if (!ok) throw new Error("server did not become healthy");
  const mcp = (k, v) => ["-c", `mcp_servers.owl-memory.${k}=${v}`];
  const r = spawnSync("sandbox-exec", ["-f", sandbox, "codex", "exec", "--skip-git-repo-check", "--ephemeral", "--json", "-C", tmp,
    ...mcp("command", '"node"'), ...mcp("args", JSON.stringify([join(root, "apps/server/dist/memory-mcp.js")])),
    ...mcp("env", `{ OWL_GUARD_API_BASE = "${base}", OWL_GUARD_TOKEN_FILE = "${tokenFile}" }`),
    ...mcp("default_tools_approval_mode", '"approve"'),
    "owl-memory MCP の search(query:'決定'), expand(search結果の最初のノートID/パス), recall(topic:'決定'), health の4ツールを各1回ずつ呼び、結果を一行で報告して。",
  ], { encoding: "utf8", timeout: 600_000, env: isolatedEnv });
  const calls = r.stdout.split("\n").flatMap((l) => { try { const e = JSON.parse(l); return e.type === "item.completed" && e.item?.type === "mcp_tool_call" ? [e.item] : []; } catch { return []; } });
  const result = Object.fromEntries(["search", "expand", "recall", "health"].map((t) => [t, calls.some((c) => c.tool === t && c.status === "completed" && !c.error)]));
  console.log(JSON.stringify(result));
  process.exitCode = Object.values(result).every(Boolean) ? 0 : 1;
  if (process.exitCode) console.error(r.stdout.slice(-1500), r.stderr.slice(-500));
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => server.once("close", resolve)), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }
  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await new Promise((resolve) => server.once("close", resolve));
  }
  rmSync(tmp, { recursive: true, force: true });
}
