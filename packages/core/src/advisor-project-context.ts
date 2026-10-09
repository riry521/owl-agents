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

export function appendAdvisorProjectCatalog(text: string, db: Pick<CoreDatabase, "all">): string {
  return `${text}\n\n${buildAdvisorProjectCatalogInstruction(db)}`;
}
