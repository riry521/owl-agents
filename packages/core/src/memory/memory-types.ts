export const MEMORY_TYPES = ["preference", "decision", "lesson", "procedure"] as const;
export const NON_MEMORY_TYPES = ["reference", "overview", "north-star", "reflection", "log", "raw"] as const;
export type MemoryNoteType = typeof MEMORY_TYPES[number] | typeof NON_MEMORY_TYPES[number];
import type { PageIssue, StoredKind } from "./page-format.js";

/** Page kinds of the theme-page layout (design §1.1). Stored in `notes.page_type`; the legacy `type` above is frozen. */
export const PAGE_TYPES = ["theme", "project-index", "work-log", "clipping", "conversation-log"] as const;
export type PageType = typeof PAGE_TYPES[number];
export interface PageRow {
  readonly rowid: number; readonly path: string; readonly filename: string; readonly title: string;
  readonly page_type: StoredKind; readonly page_scope: "project" | "common" | null;
  readonly project_id: string | null; readonly related_projects: readonly string[];
  readonly status: string; readonly summary: string; readonly merged_into: string | null;
  readonly body_sha256: string; readonly integrated_hash: string | null; readonly integrated_at: string | null;
  readonly source_hash: string | null; readonly generated_at: string | null;
  readonly token_estimate: number; readonly owl_new_count: number;
  readonly template_valid: boolean | null; readonly template_errors: readonly PageIssue[];
  readonly work_id: string | null; readonly work_number: number | null;
  readonly source_url: string | null; readonly retrieved_at: string | null;
  readonly updated: string | null; readonly mtime: number;
}
export interface PageQuery {
  readonly types: readonly StoredKind[];
  readonly scope?: "project" | "common";
  /** With `scope: "project"`. */
  readonly project_id?: string;
  /** Common themes whose `related_projects` contain it. */
  readonly related_to_project?: string;
  /** Default `["active"]`. */
  readonly status?: readonly string[];
  readonly work_id?: string;
}
export type MemoryNoteStatus = "active" | "dormant" | "superseded" | "archived" | "draft";
export type MemoryRole = "advisor" | "manager" | "designer" | "worker" | "reviewer" | "curator";
export type MemoryCaller = MemoryRole | "owner";

/** Caller of the memory API. Identity comes from the guard token; the other fields are hints. */
export interface MemoryRequestContext {
  readonly caller: MemoryCaller;
  readonly agent_run_id: string | null;
  readonly work_id: string | null;
  readonly task_id: string | null;
  readonly project_id: string | null;
}

/** One row of the `notes` table. */
export interface MemoryNoteRow {
  readonly id: string; readonly path: string; readonly filename: string; readonly title: string;
  readonly type: MemoryNoteType; readonly type_source: "frontmatter" | "inferred";
  readonly status: MemoryNoteStatus; readonly summary: string; readonly summary_source: "frontmatter" | "derived";
  readonly importance: number; readonly confidence: string | null; readonly scope: "global" | "project";
  readonly project_ids: readonly string[]; readonly tags: readonly string[];
  readonly origin_by: string | null; readonly origin_at: string | null; readonly origin_ref: string | null;
  readonly created: string | null; readonly updated: string | null;
  readonly mtime: number; readonly sha256: string; readonly size_bytes: number;
  readonly valid: boolean; readonly invalid_reasons: readonly string[]; readonly superseded_by: string | null;
}

/** Adapter over KnowledgeLocation, built by core.ts. */
export interface MemoryStoragePort {
  isAvailable(): boolean;
  /** Throws while the storage is unavailable (same as KnowledgeLocation). */
  activeDir(): string;
  withRead<T>(operation: () => Promise<T>): Promise<T>;
  /** Serialises vault writes; a page cannot be woken from dormancy without it. */
  withWrite?<T>(operation: () => Promise<T>): Promise<T>;
  status(): { readonly available: boolean; readonly dir: string | null; readonly since: string | null };
}

/** Paths under these prefixes are source material: type raw, and their unresolved links are not counted. `OWL_MEMORY_RAW_PREFIXES` (comma-separated) adds to the defaults. */
export function rawPathPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.OWL_MEMORY_RAW_PREFIXES ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return [...new Set(["raw/", "research/", ...extra])];
}

export interface MemoryLogger { warn(message: string, error?: unknown): void; info?(message: string): void }
