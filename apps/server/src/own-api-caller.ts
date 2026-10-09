// Mirrors OwnApiRequest/OwnApiResult in packages/core/src/types.ts; apps/server cannot import Core sources (rootDir).
export interface OwnApiRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

export type OwnApiResult =
  | { readonly kind: "response"; readonly status: number; readonly body: unknown }
  | { readonly kind: "not_sent"; readonly error: string }
  | { readonly kind: "unknown"; readonly error: string };

export interface OwnApiCallerOptions {
  /** Base URL of Owl's own server, e.g. the guard API base. */
  readonly apiBase: string;
  /** Owner credential, read on every call so a rotated token applies at once. */
  readonly token: () => string | undefined;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function causeCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

// Only ECONNREFUSED and a URL that cannot be built prove nothing was sent; any other failure may have reached the server, so it is unknown and never retried.
export function createOwnApiCaller(options: OwnApiCallerOptions): (request: OwnApiRequest) => Promise<OwnApiResult> {
  const doFetch = options.fetchImpl ?? fetch;
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.path, options.apiBase);
      // An absolute or protocol-relative path would carry the Owner token to another host.
      if (url.origin !== new URL(options.apiBase).origin) {
        return { kind: "not_sent", error: "path resolves outside the Owl API origin" };
      }
    } catch (error) {
      return { kind: "not_sent", error: error instanceof Error ? error.message : String(error) };
    }
    const headers: Record<string, string> = {};
    const token = options.token();
    if (token) headers.authorization = `Bearer ${token}`;
    if (request.body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await doFetch(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const text = await response.text();
      let body: unknown = text;
      try { body = text === "" ? null : JSON.parse(text); } catch { /* keep the raw text */ }
      return { kind: "response", status: response.status, body };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return causeCode(error) === "ECONNREFUSED"
        ? { kind: "not_sent", error: message }
        : { kind: "unknown", error: message };
    }
  };
}
