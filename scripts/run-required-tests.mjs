import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** リストを読んで検査し、検査済みの path 配列を返す。違反は Error（メッセージにファイル名を含める）。 */
export function readRequiredTestList(listPath, repoRoot) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(listPath, "utf8"));
  } catch (error) {
    throw new Error(`${listPath}: cannot read required test list: ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`${listPath}: "files" must be a non-empty array`);
  }
  const seen = new Set();
  for (const entry of parsed.files) {
    const file = entry?.path;
    if (typeof file !== "string" || file === "") throw new Error(`${listPath}: every entry needs a "path" string`);
    if (!file.startsWith("tests/") || !file.endsWith(".test.mjs")) {
      throw new Error(`${file}: required test must be a tests/**/*.test.mjs file`);
    }
    if (seen.has(file)) throw new Error(`${file}: listed more than once`);
    seen.add(file);
    const full = path.join(repoRoot, file);
    if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`${file}: required test file does not exist`);
  }
  return [...seen];
}

function main() {
  const listPath = process.argv[2];
  if (!listPath) {
    console.error("usage: node scripts/run-required-tests.mjs <list.json>");
    process.exit(2);
  }
  let files;
  try {
    files = readRequiredTestList(listPath, process.cwd());
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
