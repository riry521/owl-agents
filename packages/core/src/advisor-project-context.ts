import { externalJsonBlock } from "@owl/shared";
import type { CoreDatabase } from "./types";

/** Build the up-to-date project lookup block appended to every Advisor turn. */
export function buildAdvisorProjectCatalogInstruction(db: Pick<CoreDatabase, "all">): string {
  const projects = db.all<{ id: string; name: string; canonical_path: string; base_branch: string }>(
    "SELECT id, name, canonical_path, base_branch FROM projects ORDER BY name COLLATE NOCASE, id",
  );
  return [
    "<owl-project-search>",
    "Before creating a Work, always search this complete, current Project catalog against the full user request and conversation context.",
    "When a listed Project is the target, set project_id to its exact id. Use null only after checking every entry and finding no related Project. If multiple Projects are plausible and the target is unclear, ask which one to use before creating the Work.",
    "Catalog entries (id, name, repository path, and base branch):",
    JSON.stringify(projects, null, 2),
    "</owl-project-search>",
  ].join("\n");
}

/** What a Project window is limited to: its Project and how many open backlog items it is shown. */
export interface AdvisorProjectWindow {
  readonly projectId: string;
  readonly backlogLimit: number;
}

/**
 * The block a Project window gets in place of the catalog of every Project: its own Project and
 * open backlog (newest first; the same filter as GET /backlog?project_id).
 */
export function buildAdvisorProjectWindowInstruction(db: Pick<CoreDatabase, "all">, window: AdvisorProjectWindow): string {
  const project = db.all<{ id: string; name: string; canonical_path: string; base_branch: string }>(
    "SELECT id, name, canonical_path, base_branch FROM projects WHERE id = ?",
    window.projectId,
  );
  const backlog = db.all<{ id: string; title: string; status: string; updated_at: string }>(
    "SELECT id, problem AS title, status, updated_at FROM backlog_items WHERE project_id = ? AND status = 'open' ORDER BY updated_at DESC, id DESC LIMIT ?",
    window.projectId,
    window.backlogLimit,
  );
  return [
    "<owl-project-window>",
    "This window is dedicated to the Project below. Every Work you create goes into this Project, so leave project_id unset or set it to this id.",
    "Talk about other Projects only to hand them over: pass them to that Project's window with handoff_to_window. Matters that span Projects or belong to no Project go to the general window with project_id null.",
    "Project (id, name, repository path, and base branch):",
    externalJsonBlock("owl-project-window-project", project[0] ?? null),
    `Open backlog of this Project (newest first, up to ${window.backlogLimit}):`,
    externalJsonBlock("owl-project-window-backlog", backlog),
    "</owl-project-window>",
  ].join("\n");
}

export function appendAdvisorProjectCatalog(text: string, db: Pick<CoreDatabase, "all">, window: AdvisorProjectWindow | null = null): string {
  return `${text}\n\n${window ? buildAdvisorProjectWindowInstruction(db, window) : buildAdvisorProjectCatalogInstruction(db)}`;
}
