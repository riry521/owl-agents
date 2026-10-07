import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CoreDatabase } from "./types";

/** Resolve an Advisor's cwd from its conversation's Work project, then fall back to Owl itself. */
export function resolveAdvisorWorkingDirectory(db: Pick<CoreDatabase, "get">, owlRoot: string, conversationId: string): string {
  const project = db.get<{ canonical_path: string }>(
    `SELECT projects.canonical_path
       FROM conversations
       JOIN works ON works.id = conversations.work_id
       JOIN projects ON projects.id = works.project_id
      WHERE conversations.id = ?`,
    conversationId,
  );
  if (project && isAbsolute(project.canonical_path)) {
    try {
      const projectPath = realpathSync(resolve(project.canonical_path));
      if (statSync(projectPath).isDirectory()) return projectPath;
    } catch {
      // A removed or inaccessible project falls back to the Owl repository.
    }
  }
  return resolve(owlRoot);
}
