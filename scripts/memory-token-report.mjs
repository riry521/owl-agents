#!/usr/bin/env node
// Measures what each role pays on every run in memory_mode "pages" (design §8, "新方式: 毎回かかる分"), counted with
// estimatePageTokens (the same counter as estimateTokens): the injected index block plus the owl-memory tool descriptions.
// Usage: node scripts/memory-token-report.mjs [vault-dir]   (default: a vault built from the fictional test fixtures)
// The vault is copied to /tmp first and never written. Exit 1 when a role is over its limit. Needs `pnpm build`.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const { IndexInjector } = await load("packages/core/dist/memory/index-injector.js");
const { MemoryIndex } = await load("packages/core/dist/memory/memory-index.js");
const { estimatePageTokens } = await load("packages/core/dist/memory/page-format.js");
const { PAGE_TOOLS } = await load("apps/server/dist/memory-mcp.js");

// Design §8 upper limits for "毎回かかる分" (index block + tool descriptions).
const LIMITS = { manager: 1550, designer: 1550, worker: 1550, reviewer: 1400, "advisor turn 1": 1950, "advisor turn 2+": 300 };

const tmp = mkdtempSync(join(tmpdir(), "memory-token-report-"));
const vault = join(tmp, "vault");
const src = process.argv[2];
if (src) cpSync(src, vault, { recursive: true });
else {
  const fixtures = join(root, "packages/core/test/memory/fixtures/pages");
  const put = (rel, name) => { mkdirSync(join(vault, rel, ".."), { recursive: true }); cpSync(join(fixtures, name), join(vault, rel)); };
  put("projects/p/_index.md", "project-index.md");
  put("projects/p/テスト.md", "theme.md");
  const common = readFileSync(join(fixtures, "project-index.md"), "utf8").replace(/^id: (.*)J$/mu, "id: $1C").replace("scope: project", "scope: common").replace(/^project_id: .*\n/mu, "").replace(/^title: .*$/mu, "title: 共通の目次");
  mkdirSync(join(vault, "common"), { recursive: true });
  writeFileSync(join(vault, "common/_index.md"), common);
}
mkdirSync(join(tmp, "data"), { recursive: true });
const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
const index = new MemoryIndex({ dataDir: join(tmp, "data"), storage, watch: false });
try {
  await index.start();
  await index.rebuild("manual");
  const injector = new IndexInjector({ index, isAvailable: () => true, logger: { warn() {} } });
  const toolTokens = estimatePageTokens(PAGE_TOOLS.map((t) => t.description).join("\n"));
  const projects = index.listPages({ types: ["project-index"], scope: "project" });
  const worst = {};
  // Tool descriptions are paid per session (§8 ※3), so they count in every role but not in a later Advisor turn's diff.
  const note = (role, text) => { worst[role] = Math.max(worst[role] ?? 0, estimatePageTokens(text ?? "") + (role === "advisor turn 2+" ? 0 : toolTokens)); };
  for (const project of projects.length ? projects : [{ project_id: null }]) {
    for (const role of ["manager", "designer", "worker", "reviewer"]) note(role, await injector.compose({ role, query: [], project_id: project.project_id ?? null }));
  }
  await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "report" }).then((text) => note("advisor turn 1", text));
  // Turn 2 with nothing changed injects nothing.
  note("advisor turn 2+", await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "report" }));
  // A change to the shared index in the vault copy shows up as a diff of at most 300 tokens.
  const target = join(vault, index.getProjectIndex(null)?.path ?? projects[0].path);
  writeFileSync(target, `${readFileSync(target, "utf8")}\n- 計測用に足した行 → [[テスト]]\n`);
  await index.rebuild("manual");
  const diff = await injector.compose({ role: "advisor", query: [], project_id: null, session_id: "report" });
  note("advisor turn 2+", diff);
  let failed = false;
  console.log(`tool descriptions: ${toolTokens} tokens (limit 350); projects measured: ${projects.length}`);
  for (const [role, limit] of Object.entries(LIMITS)) {
    const over = worst[role] > limit;
    failed ||= over;
    console.log(`${over ? "NG" : "ok"}  ${role.padEnd(16)} ${String(worst[role]).padStart(5)} / ${limit}`);
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  await index.stop();
  rmSync(tmp, { recursive: true, force: true });
}
