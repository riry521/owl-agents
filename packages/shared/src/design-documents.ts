import { resolve } from "node:path";

function safePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return segment.length > 0 ? segment : "_";
}

/** Resolve a Work's external design directory or one Task's Markdown document. */
export function designDocumentPath(dataDir: string, workId: string, taskId?: string): string {
  const workDirectory = resolve(dataDir, "designs", safePathSegment(workId));
  return taskId === undefined
    ? workDirectory
    : resolve(workDirectory, `${safePathSegment(taskId)}.md`);
}

/** Resolve the full report of one Task, kept for an agent that needs more than a dependency summary. */
export function taskReportPath(dataDir: string, workId: string, taskId?: string): string {
  const workDirectory = resolve(dataDir, "task-reports", safePathSegment(workId));
  return taskId === undefined
    ? workDirectory
    : resolve(workDirectory, `${safePathSegment(taskId)}.json`);
}

export const DESIGN_MOCK_FILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.html$/u;
export const DESIGN_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/u;

/** Resolve the directory that holds one screen design Task's HTML mocks. */
export function designMockDirectory(dataDir: string, workId: string, taskId: string): string {
  return resolve(designDocumentPath(dataDir, workId), `${safePathSegment(taskId)}.mocks`);
}

/** Every design Task may save mocks, whichever Designer is assigned: Owl has no separate marker for screen design. */
export function isScreenDesignTask(task: { type: string }): boolean {
  return task.type === "design";
}
