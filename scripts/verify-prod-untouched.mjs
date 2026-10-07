#!/usr/bin/env node
// Read-only check that files did not change. Lines are "path mtime sha256".
//   node verify-prod-untouched.mjs snap <out> <vault> [root...] | OWL_VAULT=<vault>
//   node verify-prod-untouched.mjs diff <before> <after>  compare; live-updated paths are reported separately
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Written by the running production server on its own (SQLite, WAL/SHM, run artifacts, tokens, connectors).
const LIVE = /\/data\/(owl\.sqlite[^/]*|server\.log|artifacts\/.*|guard-tokens\/.*|connectors\/.*)$/;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}
const read = (f) =>
  new Map(
    readFileSync(f, "utf8")
      .split("\n")
      .map((l) => l.match(/^(\/.+) (\d+) ([0-9a-f]{64})$/))
      .filter(Boolean)
      .map((m) => [m[1], `${m[2]} ${m[3]}`]),
  );

const [cmd, a, b, ...rest] = process.argv.slice(2);
if (cmd === "snap") {
  const vault = b || process.env.OWL_VAULT;
  if (!vault) {
    console.error("Usage: node scripts/verify-prod-untouched.mjs snap <out> <vault> [root...] | OWL_VAULT=<vault>");
    process.exit(2);
  }
  const roots = [vault, ...rest];
  if (process.env.OWL_PROD_ROOT) roots.push(join(process.env.OWL_PROD_ROOT, "data"));
  const lines = [];
  for (const r of roots)
    for (const f of walk(r)) {
      try {
        lines.push(`${f} ${Math.floor(statSync(f).mtimeMs / 1000)} ${createHash("sha256").update(readFileSync(f)).digest("hex")}`);
      } catch {}
    }
  writeFileSync(a, lines.sort().join("\n") + "\n");
} else if (cmd === "diff") {
  const x = read(a), y = read(b);
  const bad = [], live = [];
  for (const p of new Set([...x.keys(), ...y.keys()])) {
    if (x.get(p) === y.get(p)) continue;
    (LIVE.test(p) ? live : bad).push(`${x.has(p) ? (y.has(p) ? "~" : "-") : "+"} ${p}`);
  }
  console.log(`before=${x.size} after=${y.size} live-updated(excluded)=${live.length} unexpected=${bad.length}`);
  for (const l of bad) console.log(l);
  process.exit(bad.length ? 1 : 0);
} else {
  console.error("usage: snap <out> <vault> [root...] | diff <before> <after>");
  process.exit(2);
}
