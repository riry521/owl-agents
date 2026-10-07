import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BINDING = "build/Release/better_sqlite3.node";

/** checkout に無い better-sqlite3 のバインディングを source からコピーし、コピーしたパスを返す。 */
export function copyNativeBindings({ checkout, source }) {
  const copied = [];
  if (path.resolve(checkout) === path.resolve(source)) return copied;
  const pnpmDir = path.join(checkout, "node_modules/.pnpm");
  if (!existsSync(pnpmDir)) return copied;
  for (const dir of readdirSync(pnpmDir).filter((name) => name.startsWith("better-sqlite3@"))) {
    const rel = path.join("node_modules/.pnpm", dir, "node_modules/better-sqlite3", BINDING);
    if (existsSync(path.join(checkout, rel))) continue;
    const from = path.join(source, rel);
    if (!existsSync(from)) throw new Error(`better-sqlite3 binding for ${dir} not found in ${source}`);
    mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true });
    cpSync(from, path.join(checkout, rel));
    copied.push(path.join(checkout, rel));
  }
  return copied;
}

// stdout は TAP だけにするため、子プロセスの出力は stderr に流す。
function run(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", process.stderr, "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

function main() {
  run("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"]);
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (common.status !== 0) throw new Error("git rev-parse --git-common-dir failed");
  copyNativeBindings({ checkout: process.cwd(), source: path.dirname(common.stdout.trim()) });
  run("pnpm", ["build"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
