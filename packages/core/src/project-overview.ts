import { isValidUlid } from "@owl/shared";

export const PROJECT_OVERVIEW_FILE_PATTERN = /^project-overview-([0-9A-HJKMNP-TV-Z]{26})\.md$/u;

export function projectOverviewFilename(projectId: string): string {
  if (!isValidUlid(projectId)) throw new Error("invalid_project_id");
  return `project-overview-${projectId}.md`;
}

/** Accepts "notes/xxx.md" and "xxx.md". */
export function projectIdOfOverviewFile(fileOrNotesPath: string): string | null {
  return PROJECT_OVERVIEW_FILE_PATTERN.exec(fileOrNotesPath.replace(/^notes\//u, ""))?.[1] ?? null;
}

export function isProjectOverviewFile(fileOrNotesPath: string): boolean {
  return projectIdOfOverviewFile(fileOrNotesPath) !== null;
}
