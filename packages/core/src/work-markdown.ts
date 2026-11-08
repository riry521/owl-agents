import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, posix, relative, sep } from "node:path";

import { isInside, openPinnedFile } from "./advisor-send-file.js";
import { HumanReadableError, notFound, validationError } from "./errors.js";
import { isSecretPath, type GitProjectSourceReader } from "./project-overview-note.js";
import type { CoreDatabase } from "./types.js";

export const DEFAULT_WORK_MARKDOWN_LIMITS = { maxBytes: 2 * 1024 * 1024, maxPathLength: 4096 } as const;

export type WorkMarkdownDenial = "outside" | "symlink_escape" | "traversal" | "secret" | "not_markdown";
export type WorkMarkdownSource = "project" | "work_branch" | "materials";

export interface WorkMarkdownDocument {
  readonly path: string;
  readonly name: string;
  readonly source: WorkMarkdownSource;
  readonly markdown: string;
  readonly size_bytes: number;
}

export interface WorkMarkdownReaderOptions {
  readonly db: CoreDatabase;
  readonly materials: {
    root(): string;
    withRead<T>(read: () => Promise<T>): Promise<T>;
  };
  readonly blobs: Pick<GitProjectSourceReader, "resolveCommit" | "readRegularBlob">;
  readonly limits: { readonly maxBytes: number; readonly maxPathLength: number };
}

interface WorkRow {
  readonly state: string;
  readonly canonical_path: string | null;
  readonly base_branch: string | null;
}

/** A place to read: a base folder and the path below it. */
interface Target {
  readonly kind: "project" | "materials";
  readonly root: string;
  readonly rel: string;
}

const MATERIALS_PREFIX = "materials/";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MARKDOWN_NAME = /\.md$/iu;

const denied = (reason: WorkMarkdownDenial): HumanReadableError => new HumanReadableError({
  code: "markdown_path_denied",
  message: "This file is outside what the viewer may read.",
  remediation: "Open a Markdown file inside the Project or the materials folder.",
  details: { reason },
});

const failure = (code: string, message: string, details: Record<string, unknown> = {}): HumanReadableError =>
  new HumanReadableError({ code, message, remediation: "Check the path and try again.", details });

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;

/** Absolute, symlink-free form of a folder, or null when it cannot be resolved (missing or unmounted). */
const realOrNull = (dir: string): Promise<string | null> => realpath(dir).catch(() => null);

export class WorkMarkdownReader {
  public constructor(private readonly options: WorkMarkdownReaderOptions) {}

  public async read(workId: string, path: string): Promise<WorkMarkdownDocument> {
    const { limits } = this.options;
    if (typeof path !== "string" || path === "" || path.length > limits.maxPathLength || CONTROL_CHARACTERS.test(path)) {
      throw validationError("path must be 1 to 4096 characters without control characters.", { field: "path" });
    }
    const work = this.options.db.get<WorkRow>(
      `SELECT w.state AS state, p.canonical_path AS canonical_path, p.base_branch AS base_branch
       FROM works w LEFT JOIN projects p ON p.id = w.project_id WHERE w.id = ?`,
      workId,
    );
    if (!work) throw notFound("work", workId);
    if (path.split("/").includes("..")) throw denied("traversal");

    const targets = await this.resolveTargets(work, posix.normalize(path));
    if (targets.length === 0) throw denied("outside");
    for (const target of targets) {
      if (isSecretPath(target.rel)) throw denied("secret");
      if (!MARKDOWN_NAME.test(target.rel)) throw denied("not_markdown");
    }

    for (const target of targets) {
      const found = target.kind === "project" ? await this.readProject(workId, work, target) : await this.readMaterials(target);
      if (found) return found;
    }
    const finished = work.state === "completed" || work.state === "cancelled";
    if (!finished && targets.some((target) => target.kind === "project")) {
      throw failure("markdown_not_integrated", "The file is not in the Work branch or the base branch yet.");
    }
    throw failure("markdown_not_found", "The Markdown file was not found.");
  }

  private async resolveTargets(work: WorkRow, path: string): Promise<Target[]> {
    const projectRoot = work.canonical_path;
    const materialsRoot = this.options.materials.root();
    if (!isAbsolute(path)) {
      const targets: Target[] = [];
      if (projectRoot) targets.push({ kind: "project", root: projectRoot, rel: path });
      if (path.startsWith(MATERIALS_PREFIX)) targets.push({ kind: "materials", root: materialsRoot, rel: path.slice(MATERIALS_PREFIX.length) });
      return targets;
    }
    const targets: Target[] = [];
    for (const [kind, root] of [["project", projectRoot], ["materials", materialsRoot]] as const) {
      if (!root) continue;
      // Reports spell a folder either way (macOS /tmp and /private/tmp), so accept the configured and the real form.
      const forms = [root, await realOrNull(root)];
      const base = forms.find((form): form is string => form !== null && isInside(form, path));
      if (base) targets.push({ kind, root, rel: relative(base, path).split(sep).join("/") });
    }
    return targets;
  }

  private async readProject(workId: string, work: WorkRow, target: Target): Promise<WorkMarkdownDocument | null> {
    const repo = target.root;
    const refs: Array<{ ref: string; source: WorkMarkdownSource }> = work.state === "completed" ? [] : [{ ref: `refs/heads/owl/work/${workId}/work`, source: "work_branch" }];
    if (work.base_branch) refs.push({ ref: `refs/heads/${work.base_branch}`, source: "project" });
    for (const { ref, source } of refs) {
      const commit = await this.options.blobs.resolveCommit(repo, ref);
      if (!commit) continue;
      const blob = await this.options.blobs.readRegularBlob(repo, commit, target.rel, this.options.limits.maxBytes);
      if (blob.kind === "too_large") throw this.tooLarge(blob.size);
      if (blob.kind === "ok") return this.document(target.rel, source, blob.bytes);
    }
    const bytes = await this.readFromDisk(target);
    return bytes && this.document(target.rel, "project", bytes);
  }

  private readMaterials(target: Target): Promise<WorkMarkdownDocument | null> {
    return this.options.materials.withRead(async () => {
      const bytes = await this.readFromDisk(target);
      return bytes && this.document(`${MATERIALS_PREFIX}${target.rel}`, "materials", bytes);
    });
  }

  /** Reads the working-tree file; null when it does not exist. */
  private async readFromDisk(target: Target): Promise<Buffer | null> {
    const unreadable = (): HumanReadableError => failure("markdown_unreadable", "The Markdown file could not be read.");
    let rootReal: string;
    let real: string;
    try {
      rootReal = await realpath(target.root);
      real = await realpath(join(rootReal, target.rel));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) return null;
      throw unreadable();
    }
    if (!isInside(rootReal, real)) throw denied("symlink_escape");
    const realRel = relative(rootReal, real).split(sep).join("/");
    if (isSecretPath(realRel)) throw denied("secret");
    if (!MARKDOWN_NAME.test(realRel)) throw denied("not_markdown");

    const pinned = await openPinnedFile(real);
    if (!pinned.ok) {
      if (pinned.rejection === "not_found") return null;
      throw pinned.rejection === "changed" ? denied("symlink_escape") : unreadable();
    }
    const { handle } = pinned;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      if (stat.size > this.options.limits.maxBytes) throw this.tooLarge(stat.size);
      return await handle.readFile();
    } catch (error) {
      throw error instanceof HumanReadableError ? error : unreadable();
    } finally {
      await handle.close();
    }
  }

  private tooLarge(size: number): HumanReadableError {
    return failure("markdown_too_large", "The Markdown file is too large to show.", { size_bytes: size, limit_bytes: this.options.limits.maxBytes });
  }

  private document(path: string, source: WorkMarkdownSource, bytes: Buffer): WorkMarkdownDocument {
    if (bytes.length > this.options.limits.maxBytes) throw this.tooLarge(bytes.length);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw failure("markdown_unreadable", "The Markdown file is not valid UTF-8.");
    }
    return { path, name: basename(path), source, markdown: text.replace(/^﻿/u, ""), size_bytes: bytes.length };
  }
}
