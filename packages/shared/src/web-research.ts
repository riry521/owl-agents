export type WebResearchTool = "WebFetch" | "WebSearch";

export interface WebResearchLink {
  readonly title: string;
  readonly url: string;
}

/** One WebFetch / WebSearch result, independent of the provider's event shape. */
export interface WebResearchCapture {
  readonly tool: WebResearchTool;
  readonly url: string | null;
  readonly query: string | null;
  readonly prompt: string | null;
  readonly title: string | null;
  readonly content: string;
  readonly links: readonly WebResearchLink[];
  readonly http_status: number | null;
  readonly is_error: boolean;
  /** Set when the original tool input included credential-bearing headers or cookies. */
  readonly has_auth_headers?: boolean;
  /** Set when the full WebFetch body contains a password input form. */
  readonly auth_form_detected?: true;
}

export const WEB_RESEARCH_TOOLS: readonly WebResearchTool[] = ["WebFetch", "WebSearch"];
export const WEB_RESEARCH_MAX_CONTENT_CHARS = 65_536;
export const WEB_RESEARCH_MAX_LINKS = 20;
export const MAX_CONTENT_CHARS = WEB_RESEARCH_MAX_CONTENT_CHARS;
export const MAX_LINKS = WEB_RESEARCH_MAX_LINKS;

const TRUNCATION_SUFFIX = "\n…[truncated]";

/** Parse either Claude Code's PostToolUse payload or stream-json tool results. */
export function extractWebResearchCapture(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  options?: { readonly isError?: boolean; readonly contentText?: string; readonly onError?: (error: unknown) => void },
): WebResearchCapture | null {
  try {
    if (!(WEB_RESEARCH_TOOLS as readonly string[]).includes(toolName) || !isRecord(toolInput)) return null;
    const isError = options?.isError === true || (isRecord(toolResponse) && toolResponse.is_error === true);
    const hasAuthHeaders = hasCredentialHeaders(toolInput);

    if (toolName === "WebFetch") {
      const url = nonEmptyString(toolInput.url);
      if (url === null) return null;
      const prompt = trimmedString(toolInput.prompt);
      const responseObject = isRecord(toolResponse) ? toolResponse : null;
      const responseText = typeof toolResponse === "string"
        ? toolResponse
        : responseObject && typeof responseObject.result === "string" ? responseObject.result : "";
      const content = responseText || (typeof options?.contentText === "string" ? options.contentText : "");
      const authFormDetected = hasAuthPasswordForm(content);
      const status = responseObject?.code;
      return {
        tool: "WebFetch",
        url,
        query: null,
        prompt,
        title: extractTitle(content),
        content: capContent(content),
        links: [],
        http_status: typeof status === "number" && Number.isFinite(status) ? status : null,
        is_error: isError,
        ...(hasAuthHeaders ? { has_auth_headers: true } : {}),
        ...(authFormDetected ? { auth_form_detected: true as const } : {}),
      };
    }

    const query = nonEmptyString(toolInput.query);
    if (query === null) return null;
    const responseObject = isRecord(toolResponse) ? toolResponse : null;
    const rawLinks: WebResearchLink[] = [];
    const content: string[] = [];
    if (Array.isArray(responseObject?.results)) {
      for (const result of responseObject.results) {
        if (typeof result === "string") {
          content.push(result);
        } else if (isRecord(result) && Array.isArray(result.content)) {
          for (const item of result.content) {
            if (!isRecord(item) || typeof item.title !== "string" || typeof item.url !== "string") continue;
            const title = item.title.trim();
            const url = item.url.trim();
            if (title && url) rawLinks.push({ title, url });
          }
        }
      }
    }

    let contentText = content.join("\n");
    let links = uniqueLinks(rawLinks);
    if (links.length === 0 && contentText.length === 0 && typeof options?.contentText === "string") {
      const parsed = parseLinksText(options.contentText);
      contentText = parsed.content;
      links = uniqueLinks(parsed.links);
    }

    return {
      tool: "WebSearch",
      url: null,
      query,
      prompt: null,
      title: extractTitle(contentText),
      content: capContent(contentText),
      links,
      http_status: null,
      is_error: isError,
      ...(hasAuthHeaders ? { has_auth_headers: true } : {}),
    };
  } catch (error) {
    // Returning null stays the contract for "not a capture"; onError lets callers tell a real failure apart.
    // console.error is the fallback so a failure is logged exactly once, never twice.
    if (options?.onError) options.onError(error);
    else console.error("[web-research] Could not build web research capture", error);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function nonEmptyString(value: unknown): string | null {
  return trimmedString(value);
}

function extractTitle(content: string): string | null {
  const match = /^#{1,3}\s+(.+)$/mu.exec(content);
  return match ? Array.from(match[1].trim()).slice(0, 200).join("") || null : null;
}

function capContent(content: string): string {
  const chars = Array.from(content);
  return chars.length <= WEB_RESEARCH_MAX_CONTENT_CHARS
    ? content
    : `${chars.slice(0, WEB_RESEARCH_MAX_CONTENT_CHARS).join("")}${TRUNCATION_SUFFIX}`;
}

export function hasAuthPasswordForm(content: string): boolean {
  return /<input\b[^>]*\b(?:type\s*=\s*["']?password\b|autocomplete\s*=\s*["']?current-password\b)/iu.test(content);
}

function uniqueLinks(links: readonly WebResearchLink[]): WebResearchLink[] {
  const seen = new Set<string>();
  const unique: WebResearchLink[] = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    unique.push(link);
    if (unique.length >= WEB_RESEARCH_MAX_LINKS) break;
  }
  return unique;
}

function parseLinksText(text: string): { content: string; links: WebResearchLink[] } {
  const match = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/u.exec(text);
  if (!match) return { content: text, links: [] };
  let links: WebResearchLink[] = [];
  try {
    const value: unknown = JSON.parse(match[1]);
    if (Array.isArray(value)) {
      links = value.flatMap((item) => {
        if (!isRecord(item) || typeof item.title !== "string" || typeof item.url !== "string") return [];
        const title = item.title.trim();
        const url = item.url.trim();
        return title && url ? [{ title, url }] : [];
      });
    }
  } catch {
    // A malformed link block does not make the rest of the result unusable.
  }
  return { content: `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim(), links };
}

function hasCredentialHeaders(input: Record<string, unknown>): boolean {
  const credentialNames = new Set(["cookie", "authorization", "proxy-authorization"]);
  for (const field of ["headers", "cookies"]) {
    const value = input[field];
    if (!isRecord(value)) continue;
    for (const key of Object.keys(value)) {
      if (credentialNames.has(key.toLowerCase())) return true;
      if (field === "cookies") return true;
    }
  }
  return false;
}
