import type { IncomingMessage, ServerResponse } from "node:http";

import type { OwnerFileEntry, OwnerFileOpened } from "@owl/core/dist/owner-files.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", log: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  pdf: "application/pdf",
};

/**
 * Pages open on Owl's own origin, where the session cookie and the API live. Scripts are therefore off
 * (a shared HTML file must not call the API as the Owner), and so is connect-src. Images, audio, video and
 * styles from the same folder stay allowed so a page can play ./sound.wav; SVG is also an HTML-like
 * document, so it gets the same policy. Why not `sandbox`: an opaque origin would drop the SameSite=Strict
 * cookie from those sub-resource requests and the audio would 401.
 */
const DOCUMENT_CSP = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const SAFE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": DOCUMENT_CSP,
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
} as const;

export function ownerFileContentType(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(CONTENT_TYPES, extension) ? CONTENT_TYPES[extension]! : "application/octet-stream";
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

/** Folder page in AlignUI's look (white, thin border, muted grey, rounded) with inline CSS only. */
export function renderOwnerFolder(title: string, entries: readonly OwnerFileEntry[]): string {
  const rows = entries.map((entry) => {
    const href = `${encodeURIComponent(entry.name)}${entry.isDirectory ? "/" : ""}`;
    return `<li><a href="${escapeHtml(href)}">${entry.isDirectory ? "📁" : "📄"} ${escapeHtml(entry.name)}${entry.isDirectory ? "/" : ""}</a></li>`;
  });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{margin:0;padding:16px;background:#f5f7fa;color:#0e121b;font:15px/1.5 system-ui,-apple-system,sans-serif}
h1{font-size:15px;font-weight:500;color:#525866;margin:0 0 12px;word-break:break-all}
ul{list-style:none;margin:0;padding:0;background:#fff;border:1px solid #e1e4ea;border-radius:12px;overflow:hidden}
li+li{border-top:1px solid #e1e4ea}
a{display:block;padding:12px 16px;min-height:24px;color:#0e121b;text-decoration:none;word-break:break-all}
a:hover{background:#f5f7fa}
p{padding:12px 16px;margin:0;color:#525866}
</style></head><body><h1>${escapeHtml(title)}</h1><ul>${rows.join("") || "<li><p>空のフォルダです</p></li>"}</ul></body></html>`;
}

/** Parses one `bytes=a-b` range; null when absent or not satisfiable as a single range. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? "invalid" : { start, end };
}

/** Streams a file (GET/HEAD, optional single Range) and closes the handle when the response ends. */
export function sendOwnerFile(request: IncomingMessage, response: ServerResponse, file: Extract<OwnerFileOpened, { kind: "file" }>): void {
  const range = parseRange(request.headers.range, file.size);
  const headers = {
    ...SAFE_HEADERS,
    "content-type": ownerFileContentType(file.name),
    "accept-ranges": "bytes",
    "last-modified": new Date(file.mtimeMs).toUTCString(),
  };
  if (range === "invalid") {
    void file.handle.close();
    response.writeHead(416, { ...headers, "content-range": `bytes */${file.size}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? file.size - 1;
  const length = file.size === 0 ? 0 : end - start + 1;
  response.writeHead(range ? 206 : 200, {
    ...headers,
    "content-length": length,
    ...(range ? { "content-range": `bytes ${start}-${end}/${file.size}` } : {}),
  });
  if (request.method === "HEAD" || length === 0) {
    void file.handle.close();
    response.end();
    return;
  }
  const stream = file.handle.createReadStream({ start, end, autoClose: true });
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

export function sendOwnerFolder(response: ServerResponse, html: string, head: boolean): void {
  response.writeHead(200, { ...SAFE_HEADERS, "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html, "utf8") });
  response.end(head ? undefined : html, "utf8");
}
