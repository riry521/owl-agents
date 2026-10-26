import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

import { parseAdvisorSendFilePayload } from "../../shared/dist/index.js";
import type { AdvisorText } from "./advisor-text.js";
import { isSecretPath } from "./project-overview-note.js";

/** The one place the per-channel upload limits default; settings override them. */
export const DEFAULT_ADVISOR_SEND_FILE_MAX_BYTES = { slack: 100 * 1024 * 1024, discord: 20 * 1024 * 1024 } as const;

/** Channels whose connector implements uploads; not a setting. */
const SEND_FILE_CHANNELS: ReadonlySet<string> = new Set(["slack", "discord"]);

/** macOS <sys/fcntl.h> O_NOFOLLOW_ANY: refuses a symbolic link at any path component. Node does not export it. */
const O_NOFOLLOW_ANY = 0x20000000;

export interface AdvisorOutboundFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly comment?: string;
}

export type AdvisorSendFileRejection =
  | "outside" | "symlink_escape" | "secret" | "not_found"
  | "not_a_file" | "unreadable" | "too_large" | "no_folder" | "changed";

export interface AdvisorSendFileSettings {
  readonly dirs: readonly string[];
  readonly maxBytes: { readonly slack: number; readonly discord: number };
}

export type AdvisorSendFileResult =
  | { ok: true; file: AdvisorOutboundFile }
  | { ok: false; kind: "incomplete"; reason: string }
  | { ok: false; kind: "unsupported_channel"; name: string }
  | { ok: false; kind: "rejected"; name: string; rejection: AdvisorSendFileRejection; size?: number; limit?: number; channel?: string };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** Opens `real` so that the descriptor is the file at that exact symlink-free path. */
export async function openPinnedFile(real: string):
  Promise<{ ok: true; handle: FileHandle } | { ok: false; rejection: "changed" | "not_found" | "unreadable" }> {
  let flags: number;
  if (process.platform === "darwin") flags = constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY;
  else if (process.platform === "linux") flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  else return { ok: false, rejection: "unreadable" };
  let handle: FileHandle;
  try {
    handle = await open(real, flags);
  } catch (error) {
    const code = errorCode(error);
    return { ok: false, rejection: code === "ELOOP" ? "changed" : code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "unreadable" };
  }
  if (process.platform === "linux") {
    try {
      if (await readlink(`/proc/self/fd/${handle.fd}`) !== real) {
        await handle.close();
        return { ok: false, rejection: "changed" };
      }
    } catch {
      await handle.close().catch(() => undefined);
      return { ok: false, rejection: "unreadable" };
    }
  }
  return { ok: true, handle };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function realDirectories(dirs: readonly string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const dir of dirs) {
    try {
      const real = await realpath(dir);
      if ((await stat(real)).isDirectory()) roots.push(real);
    } catch { /* a missing folder is skipped */ }
  }
  return roots;
}

async function check(request: { path: string; comment?: string }, channel: string, settings: AdvisorSendFileSettings): Promise<AdvisorSendFileResult> {
  const name = basename(request.path);
  const reject = (rejection: AdvisorSendFileRejection, extra: { size?: number; limit?: number; channel?: string } = {}): AdvisorSendFileResult =>
    ({ ok: false, kind: "rejected", name, rejection, ...extra });
  if (!isAbsolute(request.path)) return { ok: false, kind: "incomplete", reason: "send_file path must be absolute" };
  const roots = await realDirectories(settings.dirs);
  if (roots.length === 0) return reject("no_folder");
  let real: string;
  try {
    real = await realpath(request.path);
  } catch (error) {
    const code = errorCode(error);
    return reject(code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "unreadable");
  }
  if (!roots.some((root) => isInside(root, real))) {
    if (roots.some((root) => root === real)) return reject("not_a_file");
    // Textually inside a folder but resolving outside means a link led out.
    const configured = [...settings.dirs, ...roots];
    return reject(configured.some((root) => isInside(root, request.path)) ? "symlink_escape" : "outside");
  }
  if (isSecretPath(real.split(sep).join("/"))) return reject("secret");
  const pinned = await openPinnedFile(real);
  if (!pinned.ok) return reject(pinned.rejection);
  const { handle } = pinned;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return reject("not_a_file");
    const channelKey = channel.trim().toLowerCase() as "slack" | "discord";
    const limit = settings.maxBytes[channelKey];
    if (info.size > limit) return reject("too_large", { size: info.size, limit, channel: channelKey });
    const hash = createHash("sha256");
    let read = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      hash.update(chunk as Buffer);
      read += (chunk as Buffer).length;
    }
    if (read !== info.size) return reject("changed");
    return { ok: true, file: { path: real, name: basename(real), size: info.size, sha256: hash.digest("hex"), ...(request.comment === undefined ? {} : { comment: request.comment }) } };
  } catch {
    return reject("unreadable");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function prepareAdvisorSendFile(payload: unknown, channel: string, settings: AdvisorSendFileSettings): Promise<AdvisorSendFileResult> {
  const parsed = parseAdvisorSendFilePayload(payload);
  if (!parsed.ok) return { ok: false, kind: "incomplete", reason: parsed.reason };
  const name = basename(parsed.value.path);
  if (!SEND_FILE_CHANNELS.has(channel.trim().toLowerCase())) return { ok: false, kind: "unsupported_channel", name };
  try {
    return await check(parsed.value, channel, settings);
  } catch {
    return { ok: false, kind: "rejected", name, rejection: "unreadable" };
  }
}

/** Same shape as the connectors' size display (3.0MB). */
export function formatSendFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Turns a refused result into the notice appended to the reply. */
export function sendFileNotice(result: Exclude<AdvisorSendFileResult, { ok: true }>, t: AdvisorText): string {
  if (result.kind === "incomplete") return t.sendFileIncomplete(result.reason);
  if (result.kind === "unsupported_channel") return t.sendFileUnsupportedChannel(result.name);
  const r = t.sendFileReason;
  switch (result.rejection) {
    case "outside": return t.sendFileRejected(result.name, r.outside);
    case "symlink_escape": return t.sendFileRejected(result.name, r.symlinkEscape);
    case "secret": return t.sendFileRejected(result.name, r.secret);
    case "not_found": return t.sendFileRejected(result.name, r.notFound);
    case "not_a_file": return t.sendFileRejected(result.name, r.notAFile);
    case "no_folder": return t.sendFileRejected(result.name, r.noFolder);
    case "changed": return t.sendFileRejected(result.name, r.changed);
    case "too_large": return t.sendFileRejected(result.name, r.tooLarge(
      formatSendFileSize(result.size ?? 0), formatSendFileSize(result.limit ?? 0), result.channel === "discord" ? "Discord" : "Slack"));
    default: return t.sendFileRejected(result.name, r.unreadable);
  }
}
