import { parseClaudeUsageResponse } from "../../../shared/dist/plan-usage-claude.js";
import type { PlanUsageFetchResult, PlanUsageSource } from "../../../shared/dist/plan-usage.js";
import {
  defaultClaudeCredentialReaderDeps,
  readClaudeCredential,
} from "./claude-credentials.js";
import type { ClaudeCredentialRead } from "./claude-credentials.js";

export interface ClaudeUsageSourceOptions {
  readonly readCredential?: () => Promise<ClaudeCredentialRead>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export function assertAnthropicUsageUrl(url: URL): void {
  if (url.protocol !== "https:" || url.hostname !== "api.anthropic.com" || url.port !== "") {
    throw new Error("invalid Anthropic usage URL");
  }
}

function result(status: PlanUsageFetchResult["status"], detail: string | null = null): PlanUsageFetchResult {
  return { status, snapshot: null, detail };
}

function safeReadDetail(detail: unknown): string {
  const allowed = new Set(["keychain_timeout", "keychain_error", "file_unreadable", "invalid_json", "no_access_token"]);
  return typeof detail === "string" && allowed.has(detail) ? detail : "source_threw";
}

function isTimeout(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") return true;
  return error !== null && typeof error === "object" && (error as Record<string, unknown>).name === "TimeoutError";
}

function isRedirect(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const cause = (error as Record<string, unknown>).cause;
  return cause !== null && typeof cause === "object" &&
    (cause as Record<string, unknown>).code === "UND_ERR_REDIRECTION";
}

export function createClaudeUsageSource(options: ClaudeUsageSourceOptions = {}): PlanUsageSource {
  const readCredential = options.readCredential ?? (() => readClaudeCredential(defaultClaudeCredentialReaderDeps()));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  return {
    harness: "claude",
    origin: "claude_usage_api",
    async fetch(signal: AbortSignal): Promise<PlanUsageFetchResult> {
      let token: string;
      let expiresAt: number | null;
      let subscriptionType: string | null;
      try {
        const read: ClaudeCredentialRead = await readCredential();
        if (read.kind === "missing") return result("not_logged_in");
        if (read.kind === "unreadable") return result("error", safeReadDetail(read.detail));
        token = read.credential.accessToken;
        expiresAt = read.credential.expiresAt;
        subscriptionType = typeof read.credential.subscriptionType === "string" ? read.credential.subscriptionType : null;
        if (typeof token !== "string" || token.trim().length === 0) return result("not_logged_in");
      } catch {
        return result("error", "source_threw");
      }

      try {
        const checkedAt = now();
        if (!(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime())) return result("error", "source_threw");
        if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= checkedAt.getTime() + 60_000) {
          return result("expired");
        }

        const url = new URL(CLAUDE_USAGE_URL);
        assertAnthropicUsageUrl(url);
        const timeoutSignal = AbortSignal.timeout(10_000);
        const requestSignal = AbortSignal.any([signal, timeoutSignal]);
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "anthropic-beta": "oauth-2025-04-20",
              Accept: "application/json",
              "User-Agent": "owl-agents",
            },
            redirect: "error",
            signal: requestSignal,
          });
        } catch (error) {
          if (isTimeout(error, requestSignal)) return result("unavailable", "timeout");
          if (isRedirect(error)) return result("unavailable", "redirect");
          return result("unavailable", "network");
        }

        if (response.status === 401 || response.status === 403) return result("unauthorized", `http_${response.status}`);
        if (response.status === 429) return result("rate_limited", "http_429");
        if (response.status !== 200) return result("unavailable", `http_${response.status}`);

        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          if (isTimeout(error, requestSignal)) return result("unavailable", "timeout");
          return result("unrecognized", "unrecognized_response");
        }
        const planType = typeof subscriptionType === "string" && /^[a-z0-9_-]{1,32}$/i.test(subscriptionType)
          && !subscriptionType.includes(token)
          ? subscriptionType
          : null;
        const parsed = parseClaudeUsageResponse(body, checkedAt, planType);
        const windows = parsed?.windows.filter((window) => !window.id.includes(token) && !(window.label ?? "").includes(token)) ?? [];
        const snapshot = parsed && windows.length > 0 ? { ...parsed, windows } : null;
        return snapshot
          ? { status: "ok", snapshot, detail: null }
          : result("unrecognized", "unrecognized_response");
      } catch {
        return result("error", "source_threw");
      }
    },
  };
}
