#!/usr/bin/env node
// Copy archived pre-pages knowledge back into a vault. Stop the server first; the archive is kept.
// Usage: node scripts/memory-restore-archive.mjs --vault <dir> [--archive-dir <dir>] [--run <run folder>]
import { parseArgs } from "node:util";
import { ArchiveConflictError, restoreArchivedKnowledge } from "../packages/core/dist/memory/knowledge-archive.js";

const { values } = parseArgs({ options: { vault: { type: "string" }, "archive-dir": { type: "string", default: "" }, run: { type: "string" } } });
if (!values.vault) {
  console.error("Usage: memory-restore-archive.mjs --vault <dir> [--archive-dir <dir>] [--run <run folder>]");
  process.exit(2);
}
try {
  const result = await restoreArchivedKnowledge({ root: values.vault, archive: { dir: values["archive-dir"], exclude: [] }, run: values.run });
  console.log(`restored ${result.restored} files from ${result.run_dir}`);
} catch (error) {
  console.error(error instanceof ArchiveConflictError ? `${error.message}\n何も変更していません。` : error);
  process.exit(1);
}
