import type { GitPushFailure } from "./types";

export const PUSH_HOOK_BLOCK_MARKER = "owl-pre-push: blocked";
export const PUSH_HOOK_WARNING_MARKER = "owl-pre-push: warning";

export interface PushRefLine {
  readonly flag: string;
  readonly from: string;
  readonly to: string;
  readonly summary: string;
}

export function safeRemoteName(name: string): boolean {
  return name.length > 0 && !name.startsWith("-") && !/[\s\u0000-\u001f\u007f]/u.test(name);
}

export function basePushArgs(remote: string, baseBranch: string, remoteRef: string): string[] {
  if (!safeRemoteName(remote)) throw new Error("Unsafe Git remote name.");
  if (baseBranch.length === 0) throw new Error("Base branch must not be empty.");
  if (!remoteRef.startsWith("refs/heads/")) throw new Error("Remote ref must name a branch.");
  return ["push", "--porcelain", remote, `refs/heads/${baseBranch}:${remoteRef}`];
}

export function parsePushPorcelain(stdout: string): PushRefLine[] {
  const lines: PushRefLine[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^([ *=!])\t([^:\t]+):([^\t]+)\t(.*)$/u);
    if (match) lines.push({ flag: match[1], from: match[2], to: match[3], summary: match[4] });
  }
  return lines;
}

export function classifyPushFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly exitCode: number;
}): { readonly failure: GitPushFailure; readonly hook_side: "local" | "remote" | null } {
  const stderr = input.stderr.toLowerCase();
  const refs = parsePushPorcelain(input.stdout);
  if (input.timedOut) return { failure: "network", hook_side: null };
  if (stderr.includes(PUSH_HOOK_BLOCK_MARKER.toLowerCase())) return { failure: "hook_rejected", hook_side: "local" };
  if (refs.some((line) => line.flag === "!" && line.summary.toLowerCase().includes("remote rejected"))) {
    return { failure: "hook_rejected", hook_side: "remote" };
  }
  if (refs.some((line) => line.flag === "!" && /rejected|non-fast-forward|fetch first/u.test(line.summary.toLowerCase()))) {
    return { failure: "non_fast_forward", hook_side: null };
  }
  if ([
    "permission denied (publickey", "authentication failed", "terminal prompts disabled", "could not read username",
    "could not read password", "invalid username or password", "repository not found", "returned error: 403",
  ].some((message) => stderr.includes(message))) return { failure: "auth", hook_side: null };
  if ([
    "could not resolve host", "unable to access", "could not read from remote repository", "connection timed out",
    "connection refused", "connection reset", "operation timed out", "network is unreachable", "no route to host",
    "the remote end hung up", "early eof", "failed to connect", "ssh: connect to host", "does not appear to be a git repository",
  ].some((message) => stderr.includes(message))) return { failure: "network", hook_side: null };
  if (refs.length === 0 && stderr.includes("failed to push some refs")) return { failure: "hook_rejected", hook_side: "local" };
  return { failure: "unknown", hook_side: null };
}

export function redactCredentials(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1***@")
    .replace(/\b(x-access-token|oauth2|gitlab-ci-token):[^@\s/]+@/giu, "$1:***@");
}
