import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FILE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*\.test\.mjs$/;

/** layout.json を読んで形を検査し、規則オブジェクトを返す。違反は Error。 */
export function readTestLayout(layoutPath) {
  let layout;
  try {
    layout = JSON.parse(readFileSync(layoutPath, "utf8"));
  } catch (error) {
    throw new Error(`${layoutPath}: cannot read test layout: ${error.message}`);
  }
  const dirs = layout?.directories;
  if (!dirs || typeof dirs !== "object" || Array.isArray(dirs) || Object.keys(dirs).length === 0) {
    throw new Error(`${layoutPath}: "directories" must be a non-empty object`);
  }
  for (const key of ["support_directories", "root_files", "forbidden_name_segments"]) {
    if (!Array.isArray(layout[key]) || layout[key].some((v) => typeof v !== "string")) {
      throw new Error(`${layoutPath}: "${key}" must be an array of strings`);
    }
  }
  for (const pattern of layout.forbidden_name_segments) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`${layoutPath}: invalid forbidden_name_segments pattern "${pattern}": ${error.message}`);
    }
  }
  return layout;
}

function listTests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listTests(full));
    else if (entry.name.endsWith(".test.mjs")) found.push(full);
  }
  return found;
}

/** testsDir を規則 R1〜R6 で調べ、違反の行 `<相対パス>: <理由>` の配列を返す。onlyDirs 指定時は R1 を調べず、R2〜R4・R6 を指定した機能ディレクトリだけに適用する。 */
export function checkTestLayout(testsDir, layout, onlyDirs) {
  const violations = [];
  const known = new Set(Object.keys(layout.directories));
  const support = new Set(layout.support_directories);
  const rootFiles = new Set(layout.root_files);
  const forbidden = layout.forbidden_name_segments.map((p) => new RegExp(p));
  const rel = (...parts) => ["tests", ...parts].join("/");
  const only = onlyDirs?.length ? onlyDirs : null;

  if (!only) {
    for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (!known.has(name) && !support.has(name)) violations.push(`${rel(name)}/: directory is not listed in tests/layout.json`);
      } else if (name.endsWith(".test.mjs")) {
        violations.push(`${rel(name)}: test files must be in a feature directory listed in tests/layout.json`);
      } else if (!rootFiles.has(name)) {
        violations.push(`${rel(name)}: only layout.json, required-tests.json and listed directories may be at the top of tests/`);
      }
    }
  }

  for (const dirName of only ?? known) {
    if (!known.has(dirName)) {
      violations.push(`${rel(dirName)}/: directory is not listed in tests/layout.json`);
      continue;
    }
    const dir = path.join(testsDir, dirName);
    const entries = existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir, { withFileTypes: true }) : [];
    if (!entries.some((e) => e.isFile() && e.name.endsWith(".test.mjs"))) {
      violations.push(`${rel(dirName)}/: listed in tests/layout.json but has no test files`);
    }
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        violations.push(`${rel(dirName, name)}/: feature directories must not have subdirectories`);
      } else if (!name.endsWith(".test.mjs")) {
        violations.push(`${rel(dirName, name)}: only *.test.mjs files may be in a feature directory (move helpers to tests/helpers/)`);
      } else if (!FILE_NAME.test(name)) {
        violations.push(`${rel(dirName, name)}: file name must be lowercase words joined by hyphens`);
      } else {
        if (name.startsWith(`${dirName}-`)) {
          violations.push(`${rel(dirName, name)}: drop the "${dirName}-" prefix; the directory already names the feature`);
        }
        for (const segment of name.slice(0, -".test.mjs".length).split("-")) {
          if (forbidden.some((re) => re.test(segment))) {
            violations.push(`${rel(dirName, name)}: name segment "${segment}" does not say what the test protects`);
          }
        }
      }
    }
  }

  for (const supportName of support) {
    const dir = path.join(testsDir, supportName);
    if (!existsSync(dir)) continue;
    for (const file of listTests(dir)) {
      const sub = path.relative(testsDir, file).split(path.sep).join("/");
      violations.push(`${rel(sub)}: test files must not be under tests/${supportName}/`);
    }
  }
  return violations;
}

function main() {
  const [target, ...onlyDirs] = process.argv.slice(2);
  if (!target) {
    console.error("usage: node scripts/check-test-layout.mjs <tests/layout.json | tests dir> [<feature dir> ...]");
    process.exit(2);
  }
  const layoutPath = existsSync(target) && statSync(target).isDirectory() ? path.join(target, "layout.json") : target;
  let layout;
  try {
    layout = readTestLayout(layoutPath);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const testsDir = path.dirname(layoutPath);
  const only = onlyDirs.map((d) => d.replace(/^tests\//, "").replace(/\/$/, ""));
  const violations = checkTestLayout(testsDir, layout, only);
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log(`test layout ok: ${listTests(testsDir).length} files in ${Object.keys(layout.directories).length} directories`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
