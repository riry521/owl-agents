import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile as fsReadFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

export interface ClaudeOAuthCredential {
  readonly accessToken: string;
  readonly expiresAt: number | null;
  readonly subscriptionType: string | null;
}

export type ClaudeCredentialRead =
  | { readonly kind: "found"; readonly credential: ClaudeOAuthCredential }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly detail: "keychain_timeout" | "keychain_error" | "file_unreadable" | "invalid_json" | "no_access_token" };

export interface ClaudeCredentialReaderDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly runSecurity: (args: readonly string[]) => Promise<{ code: number; stdout: string }>;
  readonly readFile: (path: string) => Promise<string>;
}

const MISSING: ClaudeCredentialRead = { kind: "missing" };
const SUBSCRIPTION_TYPE = /^[a-z0-9_-]{1,32}$/i;

function runSecurity(args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", [...args], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    }, (error, stdout) => {
      if (error) {
        const code = typeof error.code === "number" ? error.code : -1;
        Object.assign(error, { exitCode: code });
        reject(error);
      } else {
        resolve({ code: 0, stdout });
      }
    });
  });
}

export function defaultClaudeCredentialReaderDeps(): ClaudeCredentialReaderDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: osHomedir(),
    runSecurity,
    readFile: (path) => fsReadFile(path, "utf8"),
  };
}

function parseCredential(text: string): ClaudeCredentialRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", detail: "invalid_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unreadable", detail: "no_access_token" };
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (oauth === null || typeof oauth !== "object" || Array.isArray(oauth)) return { kind: "unreadable", detail: "no_access_token" };
  const fields = oauth as Record<string, unknown>;
  if (typeof fields.accessToken !== "string" || fields.accessToken.trim().length === 0) return { kind: "unreadable", detail: "no_access_token" };
  return {
    kind: "found",
    credential: {
      accessToken: fields.accessToken,
      expiresAt: typeof fields.expiresAt === "number" && Number.isFinite(fields.expiresAt) ? fields.expiresAt : null,
      subscriptionType: typeof fields.subscriptionType === "string" && SUBSCRIPTION_TYPE.test(fields.subscriptionType)
        ? fields.subscriptionType
        : null,
    },
  };
}

function timedOut(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const fields = error as Record<string, unknown>;
  // execFile's `timeout` kills the child and reports `killed: true` with a null code, never ETIMEDOUT.
  return fields.code === "ETIMEDOUT" || fields.killed === true;
}

function outputFromSecurity(stdout: string): ClaudeCredentialRead {
  return parseCredential(stdout);
}

export async function readClaudeCredential(deps: ClaudeCredentialReaderDeps): Promise<ClaudeCredentialRead> {
  const configuredDir = deps.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = configuredDir || join(deps.homedir, ".claude");
  let sawKeychainTimeout = false;
  let lastUnreadable: ClaudeCredentialRead | null = null;

  if (deps.platform === "darwin") {
    const services: string[] = [];
    if (configuredDir) {
      const digest = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
      services.push(`Claude Code-credentials-${digest}`);
    }
    services.push("Claude Code-credentials");
    for (const service of services) {
      try {
        const result = await deps.runSecurity(["find-generic-password", "-s", service, "-w"]);
        if (result.code === 44) continue;
        if (result.code !== 0) continue;
        const parsed = outputFromSecurity(result.stdout);
        if (parsed.kind === "found") return parsed;
        lastUnreadable = parsed;
      } catch (error) {
        if (timedOut(error)) sawKeychainTimeout = true;
        // Why not log: the security command's error text can carry the stored secret or account details; any other failure just moves on to the next candidate.
      }
    }
  }

  try {
    const parsed = parseCredential(await deps.readFile(join(configDir, ".credentials.json")));
    if (parsed.kind === "found") return parsed;
    lastUnreadable = parsed;
  } catch (error) {
    if (error !== null && typeof error === "object" && (error as Record<string, unknown>).code === "ENOENT") {
      if (sawKeychainTimeout) return { kind: "unreadable", detail: "keychain_timeout" };
      return lastUnreadable ?? MISSING;
    }
    return { kind: "unreadable", detail: "file_unreadable" };
  }
  return lastUnreadable ?? (sawKeychainTimeout ? { kind: "unreadable", detail: "keychain_timeout" } : MISSING);
}
