#!/usr/bin/env node
// List Serena registrations (projects in serena_config.yml) whose path no longer exists; remove them only with --apply.
// Usage: node scripts/serena-prune-missing.mjs [--apply]   (config: $SERENA_HOME or ~/.serena)
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { pruneMissingSerenaProjects, serenaConfigPath } from "../packages/core/dist/serena-registry.js";

const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
const configPath = serenaConfigPath(process.env, homedir());
try {
  const missing = await pruneMissingSerenaProjects(configPath, values.apply);
  for (const path of missing) console.log(path);
  console.log(`${configPath}: ${missing.length} missing ${values.apply ? "removed" : "found (not changed; use --apply to remove)"}`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
