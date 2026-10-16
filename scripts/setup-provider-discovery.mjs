// setup.sh から呼ぶ。claude・codex を探して .env の provider 設定を埋める。
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseDotEnv } from "../packages/shared/dist/env.js";

const defaultConfigPath = join(dirname(fileURLToPath(import.meta.url)), "provider-search.json");

export function loadConfig(env = process.env) {
  return JSON.parse(readFileSync(env.OWL_PROVIDER_SEARCH_CONFIG || defaultConfigPath, "utf8"));
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function expandDir(dir, home) {
  const parts = (dir.startsWith("~") ? join(home, dir.slice(1)) : dir).split("/");
  let paths = [parts[0] === "" ? "/" : parts[0]];
  for (const part of parts.slice(1)) {
    paths = paths.flatMap((base) => {
      if (!part.includes("*")) return [join(base, part)];
      const re = new RegExp(`^${part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      try {
        return readdirSync(base).filter((n) => re.test(n)).sort().map((n) => join(base, n));
      } catch {
        return [];
      }
    });
  }
  return paths;
}

function loginShellPath(name, env) {
  if (!env.SHELL) return null;
  try {
    const out = execFileSync(env.SHELL, ["-lc", `command -v ${name}`], { encoding: "utf8", env, timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
    const last = out.trim().split("\n").pop() ?? "";
    return isAbsolute(last) && isExecutable(last) ? last : null;
  } catch {
    return null;
  }
}

/** 見つかった CLI を config の providers 順に返す。 */
export function discover(config, env = process.env, home = env.HOME || homedir()) {
  const dirs = [
    ...(env.PATH || "").split(delimiter).filter(Boolean),
    ...config.dirs.flatMap((d) => expandDir(d, home)),
  ];
  const found = [];
  for (const p of config.providers) {
    let path = dirs.map((d) => join(d, p.name)).find(isExecutable);
    if (!path && config.loginShell) path = loginShellPath(p.name, env);
    if (path) found.push({ ...p, path: resolve(path) });
  }
  return found;
}

/**
 * .env のテキストに検出結果を入れる。空・未設定・既定の stub は埋め、値のある項目は approve が true のときだけ書き換える。
 */
export function mergeEnv(text, found, approve = false) {
  if (!found.length) return { text, changed: [], skipped: [] };
  const wanted = {
    OWL_PROVIDER: "real",
    OWL_PROVIDER_ADAPTER: found[0].adapter,
    ...Object.fromEntries(found.map((f) => [f.executableEnv, f.path])),
  };
  const lines = text.split("\n");
  const changed = [];
  const skipped = [];
  for (const [key, value] of Object.entries(wanted)) {
    // Owl の読み込み（parseDotEnv）は同じキーの最後の行を採用するので、最後の行を見る。
    const i = lines.findLastIndex((l) => key in parseDotEnv(l));
    const current = i < 0 ? "" : parseDotEnv(lines[i])[key];
    if (current === value) continue;
    const isDefault = current === "" || (key === "OWL_PROVIDER" && current === "stub");
    if (!isDefault && !approve) {
      skipped.push(key);
      continue;
    }
    if (i < 0) {
      if (lines.at(-1) === "") lines.pop();
      lines.push(`${key}=${value}`, "");
    } else {
      lines[i] = `${key}=${value}`;
    }
    changed.push(key);
  }
  return { text: lines.join("\n"), changed, skipped };
}

function writeAtomic(file, text) {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

/** approveOverwrite は真偽値か、書き換え対象のキー一覧を受け取って承認を返す関数。 */
export async function run({ envFile, env = process.env, approveOverwrite = false, out = console.log }) {
  const config = loadConfig(env);
  const found = discover(config, env);
  if (!found.length) {
    out(config.installGuide);
    return { found, changed: [], skipped: [] };
  }
  const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  let result = mergeEnv(text, found, false);
  if (result.skipped.length) {
    const ok = typeof approveOverwrite === "function" ? await approveOverwrite(result.skipped) : approveOverwrite;
    if (ok) result = mergeEnv(text, found, true);
  }
  if (result.changed.length) writeAtomic(envFile, result.text);
  for (const f of found) out(`${f.name}: ${f.path}`);
  out(`updated: ${result.changed.join(", ") || "-"}`);
  if (result.skipped.length && !result.changed.includes(result.skipped[0])) out(`kept existing: ${result.skipped.join(", ")}`);
  return { found, ...result };
}

async function main(argv) {
  const envFile = resolve(argv.find((a) => !a.startsWith("--")) ?? ".env");
  let approveOverwrite = argv.includes("--approve-overwrite");
  if (!approveOverwrite && process.stdin.isTTY && process.stdout.isTTY) {
    approveOverwrite = async (keys) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`${keys.join(", ")} は設定済みです。書き換えますか？ / Overwrite? [y/N] `);
      rl.close();
      return /^y(es)?$/i.test(answer.trim());
    };
  }
  await run({ envFile, approveOverwrite });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
