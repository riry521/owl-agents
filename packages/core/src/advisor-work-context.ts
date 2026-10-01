import type { CoreDatabase } from "./types";

export const ADVISOR_WORK_CATALOG_ACTIVE_LIMIT = 50;
export const ADVISOR_WORK_CATALOG_RECENT_FINISHED_LIMIT = 10;
const TITLE_MAX = 120;

interface AdvisorWorkCatalogRow {
  id: string;
  display_number: number | null;
  title: string;
  state: string;
  project_id: string | null;
  project_name: string | null;
  updated_at: string;
}

function catalogEntry(row: AdvisorWorkCatalogRow): AdvisorWorkCatalogRow {
  return {
    ...row,
    title: row.title.length > TITLE_MAX ? `${row.title.slice(0, TITLE_MAX)}…` : row.title,
  };
}

/** Build the up-to-date Work lookup block appended to every Advisor turn. */
export function buildAdvisorWorkCatalogInstruction(db: Pick<CoreDatabase, "all">): string {
  const activeRows = db.all<AdvisorWorkCatalogRow>(
    `SELECT works.id, works.display_number, works.title, works.state, works.project_id,
            projects.name AS project_name, works.updated_at
       FROM works LEFT JOIN projects ON projects.id = works.project_id
      WHERE works.archived_at IS NULL AND works.state IN ('running', 'paused', 'judgement_waiting')
      ORDER BY works.updated_at DESC, works.id DESC
      LIMIT ${ADVISOR_WORK_CATALOG_ACTIVE_LIMIT + 1}`,
  );
  const hasMoreActive = activeRows.length > ADVISOR_WORK_CATALOG_ACTIVE_LIMIT;
  const active = activeRows.slice(0, ADVISOR_WORK_CATALOG_ACTIVE_LIMIT).map(catalogEntry);
  const recentlyFinished = db.all<AdvisorWorkCatalogRow>(
    `SELECT works.id, works.display_number, works.title, works.state, works.project_id,
            projects.name AS project_name, works.updated_at
       FROM works LEFT JOIN projects ON projects.id = works.project_id
      WHERE works.archived_at IS NULL AND works.state IN ('completed', 'cancelled')
      ORDER BY COALESCE(works.completed_at, works.cancelled_at, works.updated_at) DESC, works.id DESC
      LIMIT ${ADVISOR_WORK_CATALOG_RECENT_FINISHED_LIMIT}`,
  ).map(catalogEntry);

  return [
    "<owl-work-search>",
    "Use this list to find the Work the operator means before any Work operation (send_work_instruction, update_work, pause_work, resume_work, cancel_work).",
    "Match the operator's words (title, \"Work #N\", Project, recent conversation) against it and use the exact id. display_number is the \"Work #N\" shown in the UI and is unique only within its Project. Never invent an id; if several Works match or none does, ask the operator which Work they mean.",
    `Active Works (running, paused or judgement_waiting; most recently updated first):\n${JSON.stringify(active, null, 2)}`,
    ...(hasMoreActive ? ["More active Works exist than are listed (showing the 50 most recently updated). Ask the operator for the Work ID if the target is not listed."] : []),
    `Recently finished Works (completed or cancelled; newest first, up to 10):\n${JSON.stringify(recentlyFinished, null, 2)}`,
    "</owl-work-search>",
  ].join("\n");
}

export function appendAdvisorWorkCatalog(text: string, db: Pick<CoreDatabase, "all">): string {
  return `${text}\n\n${buildAdvisorWorkCatalogInstruction(db)}`;
}
