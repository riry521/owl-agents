import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const KEYS = new Set(["description", "include", "exclude_dirs", "allow_marker", "rules"]);
const RULE_KEYS = new Set(["id", "pattern", "flags", "message"]);

/** 設定ファイルを読んで形を検査し、正規表現を組んだ設定を返す。違反は Error。 */
export function readHardcodeConfig(configPath) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`${configPath}: cannot read hardcode config: ${error.message}`);
  }
  const fail = (message) => {
    throw new Error(`${configPath}: ${message}`);
  };
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("must be an object");
  for (const key of Object.keys(config)) if (!KEYS.has(key)) fail(`unknown key "${key}"`);
  const strings = (key) => {
    if (!Array.isArray(config[key]) || config[key].some((v) => typeof v !== "string" || v === "")) {
      fail(`"${key}" must be an array of non-empty strings`);
    }
  };
  strings("include");
  if (config.include.length === 0) fail('"include" must not be empty');
  strings("exclude_dirs");
  if (typeof config.allow_marker !== "string" || !/^[\w-]+$/.test(config.allow_marker)) fail('"allow_marker" must be a word');
  if (!Array.isArray(config.rules) || config.rules.length === 0) fail('"rules" must be a non-empty array');
  const ids = new Set();
  const rules = config.rules.map((rule, i) => {
    if (!rule || typeof rule !== "object") fail(`rules[${i}] must be an object`);
    for (const key of Object.keys(rule)) if (!RULE_KEYS.has(key)) fail(`rules[${i}]: unknown key "${key}"`);
    for (const key of ["id", "pattern", "message"]) {
      if (typeof rule[key] !== "string" || rule[key] === "") fail(`rules[${i}]: "${key}" must be a non-empty string`);
    }
    if (ids.has(rule.id)) fail(`rules[${i}]: duplicate id "${rule.id}"`);
    ids.add(rule.id);
    let regex;
    try {
      regex = new RegExp(rule.pattern, [...new Set(`${rule.flags ?? ""}g`)].join(""));
    } catch (error) {
      fail(`rules[${i}]: invalid pattern: ${error.message}`);
    }
    return { id: rule.id, message: rule.message, regex };
  });
  return { include: config.include, excludeDirs: new Set(config.exclude_dirs), marker: config.allow_marker, rules };
}

function walk(root, dir, excludeDirs, out) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) walk(root, rel, excludeDirs, out);
    } else out.push(rel);
  }
  return out;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** root 以下の include に合うファイルを規則で調べ、違反の行 `<path>:<line>: <rule-id>: <message>` の配列を返す。 */
export function checkHardcode(config, root) {
  const violations = [];
  const files = walk(root, "", config.excludeDirs, []).filter((f) => config.include.some((g) => path.matchesGlob(f, g)));
  for (const file of files.sort()) {
    const text = readFileSync(path.join(root, file), "utf8");
    const lines = text.split("\n");
    for (const rule of config.rules) {
      const allow = new RegExp(`${escapeRegex(config.marker)}\\s+${escapeRegex(rule.id)}\\s*:\\s*\\S`);
      for (const match of text.matchAll(rule.regex)) {
        const line = text.slice(0, match.index).split("\n").length;
        if (allow.test(lines[line - 1]) || (line > 1 && allow.test(lines[line - 2]))) continue;
        violations.push(`${file}:${line}: ${rule.id}: ${rule.message}`);
      }
    }
  }
  return violations;
}

function main() {
  const [configPath, root = process.cwd()] = process.argv.slice(2);
  if (!configPath) {
    console.error("usage: node scripts/check-test-hardcode.mjs <tests/hardcode-checks.json> [<root dir>]");
    process.exit(2);
  }
  let config;
  try {
    config = readHardcodeConfig(configPath);
    if (!statSync(root).isDirectory()) throw new Error(`${root}: not a directory`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const violations = checkHardcode(config, root);
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log(`test hardcode ok: ${config.rules.length} rules`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
