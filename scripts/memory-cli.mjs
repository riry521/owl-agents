#!/usr/bin/env node
// Usage: node scripts/memory-cli.mjs search|expand|recall|health [text] [--limit N] [--types a,b] [--scope s] [--include-superseded] [--include-raw] [--explain]
//        node scripts/memory-cli.mjs index [project_id] | page <page> [--sections a,b] | pages-search <text> [--include-work-log] | mode
// Server: OWL_GUARD_API_BASE or OWL_API_BASE (default http://127.0.0.1:$OWL_PORT|3787); token: OWL_GUARD_TOKEN_FILE or OWL_API_TOKEN.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { positionals: [op, text], values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string" }, types: { type: "string" }, scope: { type: "string" }, "include-superseded": { type: "boolean" }, "include-raw": { type: "boolean" }, explain: { type: "boolean" },
    sections: { type: "string" }, "include-work-log": { type: "boolean" },
  },
});
const ROUTES = { search: "search", expand: "expand", recall: "recall", health: "health", index: "index", page: "page", "pages-search": "pages/search", mode: "mode" };
if (!Object.hasOwn(ROUTES, op ?? "")) {
  console.error("usage: memory-cli.mjs search|expand|recall|health|index|page|pages-search|mode [text] [options]");
  process.exit(2);
}
const isGet = op === "health" || op === "mode";
const base = (process.env.OWL_GUARD_API_BASE ?? process.env.OWL_API_BASE ?? `http://127.0.0.1:${process.env.OWL_PORT ?? 3787}`).replace(/\/$/u, "").replace(/\/api\/v1$/u, "");
const file = process.env.OWL_GUARD_TOKEN_FILE;
const token = file ? (await readFile(file, "utf8")).trim() : process.env.OWL_API_TOKEN;
const textKey = { expand: "note", recall: "topic", index: "project_id", page: "page" }[op] ?? "query";
const body = {
  ...(text === undefined ? {} : { [textKey]: text }),
  ...(values.limit ? { limit: Number(values.limit) } : {}),
  ...(values.types ? { types: values.types.split(",") } : {}),
  ...(values.scope ? { scope: values.scope } : {}),
  ...(values["include-superseded"] ? { include_superseded: true } : {}),
  ...(values["include-raw"] ? { include_raw: true } : {}),
  ...(values.explain ? { explain: true } : {}),
  ...(values.sections ? { sections: values.sections.split(",") } : {}),
  ...(values["include-work-log"] ? { include_work_log: true } : {}),
};
try {
  const response = await fetch(`${base}/api/v1/memory/${ROUTES[op]}`, {
    method: isGet ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(isGet ? {} : { body: JSON.stringify(body) }),
  });
  console.log(JSON.stringify(await response.json(), null, 2));
  process.exitCode = response.ok ? 0 : 1;
} catch {
  console.log(JSON.stringify({ error: "owl_unreachable" }));
  process.exitCode = 1;
}
