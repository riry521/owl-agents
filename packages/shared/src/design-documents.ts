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
