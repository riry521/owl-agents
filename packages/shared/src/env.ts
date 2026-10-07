import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DotEnvLoadOptions {
  /** Environment object to populate. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Project root containing .env. When omitted, OWL_ROOT/cwd/monorepo root are used. */
  readonly projectRoot?: string;
  /** Explicit .env path, primarily useful for tests. */
  readonly envPath?: string;
  readonly cwd?: string;
  readonly moduleUrl?: string;
}

export interface DotEnvLoadResult {
  readonly root: string;
  readonly envPath: string | null;
  readonly loadedKeys: readonly string[];
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Parse the small, deliberately dependency-free .env dialect Owl supports.
 * Values are not expanded: this keeps the precedence rule predictable and
 * avoids accidentally interpolating secrets from another environment.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const sourceLine of text.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const assignment = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!ENV_KEY.test(key)) continue;
    const rawValue = assignment.slice(separator + 1).trimStart();
    result[key] = parseDotEnvValue(rawValue);
  }
  return result;
}

function parseDotEnvValue(value: string): string {
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end >= 0 ? value.slice(1, end) : value.slice(1);
  }
  if (value.startsWith('"')) {
    let escaped = false;
    let result = "";
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) {
        result += character === "n" ? "\n" : character === "r" ? "\r" : character === "t" ? "\t" : character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        break;
      } else {
        result += character;
      }
    }
    return result;
  }
  const comment = value.search(/\s+#/u);
  return (comment >= 0 ? value.slice(0, comment) : value).trimEnd();
}

function monorepoRoot(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../../..");
}

function candidateRoot(value: string | undefined, cwd: string): string | null {
  if (!value || value.trim().length === 0) return null;
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function resolveProjectRoot(options: DotEnvLoadOptions, env: NodeJS.ProcessEnv): string {
  const cwd = options.cwd ?? process.cwd();
  if (options.projectRoot) {
    return isAbsolute(options.projectRoot) ? resolve(options.projectRoot) : resolve(cwd, options.projectRoot);
  }
  const configured = candidateRoot(env.OWL_ROOT, cwd);
  if (configured) return configured;
  const repositoryRoot = monorepoRoot(options.moduleUrl ?? import.meta.url);
  if (existsSync(join(cwd, ".env"))) return resolve(cwd);
  return repositoryRoot;
}

/**
 * Load the project .env without ever overwriting a value already present in
 * the process environment. Callers may invoke this from more than one entry
 * point; the explicit environment remains authoritative on every call.
 */
export function loadOwlEnv(options: DotEnvLoadOptions = {}): DotEnvLoadResult {
  const env = options.env ?? process.env;
  const root = resolveProjectRoot(options, env);
  const envPath = resolve(options.envPath ?? join(root, ".env"));
  if (!existsSync(envPath)) return { root, envPath: null, loadedKeys: [] };

  const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
  const explicitKeys = new Set(Object.keys(env));
  const loadedKeys: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (explicitKeys.has(key)) continue;
    env[key] = value;
    loadedKeys.push(key);
  }
  return { root, envPath, loadedKeys };
}
