import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class AdvisorFolderError extends Error {
  constructor(readonly reason: "absolute" | "tracked") { super(reason); }
}

function expandHome(value: string): string {
  return value === "~" ? homedir() : value.startsWith(`~${sep}`) ? join(homedir(), value.slice(2)) : value;
}

let cachedScreenshotDir: string | undefined;

export function defaultScreenshotDir(): string {
  if (cachedScreenshotDir) return cachedScreenshotDir;
  if (process.platform === "darwin") {
    try {
      const location = execFileSync("defaults", ["read", "com.apple.screencapture", "location"], { encoding: "utf8", timeout: 1000 }).trim();
      if (location) return cachedScreenshotDir = resolve(expandHome(location));
    } catch { /* use Desktop */ }
    return cachedScreenshotDir = join(homedir(), "Desktop");
  }
  const pictures = join(homedir(), "Pictures");
  const screenshots = join(pictures, "Screenshots");
  return cachedScreenshotDir = existsSync(screenshots) ? screenshots : existsSync(pictures) ? pictures : homedir();
}

export function advisorFolderDefaults(dataDir: string): { sharedDir: string; screenshotDir: string } {
  return { sharedDir: join(resolve(dataDir), "shared"), screenshotDir: defaultScreenshotDir() };
}

export function normalizeAdvisorFolder(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const expanded = expandHome(trimmed);
  if (value.length > 1024 || expanded.includes("\0") || !isAbsolute(expanded)) throw new AdvisorFolderError("absolute");
  return resolve(expanded);
}

export function isGitIgnoredDirectory(path: string): boolean {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) return true;
    ancestor = parent;
  }
  if (!statSync(ancestor).isDirectory()) ancestor = resolve(ancestor, "..");
  let toplevel: string;
  try {
    toplevel = execFileSync("git", ["-C", ancestor, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return true; }
  const probe = join(realpathSync(ancestor), relative(ancestor, path), ".owl-probe");
  const relativeProbe = relative(toplevel, probe);
  if (relativeProbe.startsWith(`..${sep}`) || relativeProbe === "..") return true;
  try {
    execFileSync("git", ["-C", toplevel, "check-ignore", "-q", "--", relativeProbe], { timeout: 1000, stdio: "ignore" });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function ensureAdvisorSharedDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
