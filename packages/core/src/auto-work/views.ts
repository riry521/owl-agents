import {
  AUTO_WORK_GITHUB_LISTS, type AutoWorkSettingsValue, type AutoWorkSource, type AutoWorkVerdict, type EffectiveAutoWorkConfig,
} from "@owl/shared";
import { BACKLOG_LIST_LIMIT } from "../review-backlog.js";
import type { CoreDatabase } from "../types.js";
import type { AutoWorkConfigLoader } from "./config.js";
import { autoWorkDayKey } from "./stage-one.js";
import type { AutoWorkEventRecord, AutoWorkStore } from "./store.js";

/** Same bound as the Review Backlog list, so one screen can page both the same way. */
export const AUTO_WORK_LIST_LIMIT = BACKLOG_LIST_LIMIT;
/** Where the settings files live under the Owl root, as shown to people. */
export const AUTO_WORK_RULES_DIR = "rules/auto-work";

const COUNTED_VERDICTS = "('judging', 'created')";
const LEDGER_ITEM_TYPES = { issues: "issue", comments: "comment" } as const;

export interface AutoWorkEventFilter {
  project_id?: string;
  source?: AutoWorkSource;
  verdict?: AutoWorkVerdict;
  work_id?: string;
  limit?: number;
  offset?: number;
}

export interface AutoWorkViewDeps {
  readonly db: CoreDatabase;
  readonly store: AutoWorkStore;
  readonly loader: AutoWorkConfigLoader;
  readonly settings: AutoWorkSettingsValue | null;
  readonly now: Date;
}

/** One history row for people; the body and the model's answer are left to the single-row view. */
export function toAutoWorkEventView(db: CoreDatabase, event: AutoWorkEventRecord) {
  const { detail: _detail, judge: _judge, ...columns } = event;
  const work = event.work_id === null ? null : db.get<{ display_number: number | null; title: string; state: string }>(
    "SELECT display_number, title, state FROM works WHERE id = ?", event.work_id,
  );
  const duplicate = event.duplicate_of_work_id === null ? null : db.get<{ display_number: number | null }>(
    "SELECT display_number FROM works WHERE id = ?", event.duplicate_of_work_id,
  );
  return {
    ...columns,
    project_name: db.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", event.project_id)?.name ?? null,
    work_display_number: work?.display_number ?? null,
    work_title: work?.title ?? null,
    work_state: work?.state ?? null,
    duplicate_of_work_display_number: duplicate?.display_number ?? null,
  };
}

export function toAutoWorkEventDetailView(db: CoreDatabase, event: AutoWorkEventRecord) {
  return { ...toAutoWorkEventView(db, event), detail: event.detail, judge_json: event.judge };
}

function createdToday(db: CoreDatabase, dayKey: string, projectId?: string): number {
  const row = projectId === undefined
    ? db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM auto_work_events WHERE day_key = ? AND verdict IN ${COUNTED_VERDICTS}`, dayKey)
    : db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM auto_work_events WHERE project_id = ? AND day_key = ? AND verdict IN ${COUNTED_VERDICTS}`, projectId, dayKey);
  return Number(row?.total ?? 0);
}

function projectView(deps: AutoWorkViewDeps, project: { id: string; name: string }, config: EffectiveAutoWorkConfig, dayKey: string) {
  const lists = Object.fromEntries(AUTO_WORK_GITHUB_LISTS.map((list) => {
    const cursor = deps.store.getCursor(project.id, list);
    const counts = deps.store.countItems(project.id, LEDGER_ITEM_TYPES[list]);
    return [list, {
      since: cursor?.since ?? null,
      last_polled_at: cursor?.last_polled_at ?? null,
      last_completed_at: cursor?.last_completed_at ?? null,
      last_error: cursor?.last_error ?? null,
      pending_items: counts.pending,
      failed_items: counts.failed,
    }];
  }));
  const cursors = Object.values(lists);
  const github = config.github;
  return {
    project_id: project.id,
    project_name: project.name,
    enabled: config.enabled,
    config_file_present: deps.loader.hasProjectFile(project.id),
    // The scheduled check owns its own clock; until it reports one, the times are shown without a next or last run.
    scheduled_check: { times: config.scheduled_check.times, items: config.scheduled_check.items, next_run_at: null, last_run_at: null },
    watch: { logs: config.watch.logs.length, commands: config.watch.commands.length, last_error: null },
    github: {
      repo: github.repo,
      poll_minutes: github.poll_minutes,
      max_items_per_poll: github.max_items_per_poll,
      since_margin_seconds: github.since_margin_seconds,
      // `@me` stays as written: the login behind it is a person's name and does not leave Core.
      allowed_users: github.allowed_users,
      require_labels: github.require_labels,
      mention: github.mention,
      last_polled_at: cursors.map((cursor) => cursor.last_polled_at).filter((at) => at !== null).sort().at(-1) ?? null,
      last_error: cursors.find((cursor) => cursor.last_error !== null)?.last_error ?? null,
      lists,
    },
    rules: config.rules.map((rule) => ({
      id: rule.id, source: rule.source, kinds: rule.kinds, min_occurrences: rule.min_occurrences, window_minutes: rule.window_minutes,
      action: rule.action, size: rule.size, disabled: rule.disabled, origin: rule.origin, overridden_fields: rule.overridden_fields,
    })),
    today: { created: createdToday(deps.db, dayKey, project.id), cap: config.limits.max_works_per_day },
  };
}

/**
 * The settings screen's data (design 9.2). While defaults.json has never been read there is no config: the feature stays off
 * and the same shape comes back with null values and `config_error`, so the screen can show what is wrong (design 11).
 */
export function buildAutoWorkSettingsData(deps: AutoWorkViewDeps, globalConfig: EffectiveAutoWorkConfig | null, files: { defaults: string; local: string; projects_dir: string }) {
  if (!globalConfig) {
    return {
      enabled: { effective: false, from: "defaults" as const },
      judge_role: null,
      limits: { max_works_per_day: null, max_works_per_day_all: null, day_start_time: null, cooldown_hours: null },
      config_error: deps.loader.configError,
      files,
      today: { day_key: null, created_all: 0, cap_all: null },
      projects: [],
    };
  }
  const dayKey = autoWorkDayKey(deps.now, globalConfig.limits.day_start_time);
  const projects = deps.db.all<{ id: string; name: string }>("SELECT id, name FROM projects ORDER BY name, id");
  return {
    enabled: globalConfig.global_enabled,
    judge_role: globalConfig.judge_role,
    limits: {
      max_works_per_day: globalConfig.limits.max_works_per_day,
      max_works_per_day_all: globalConfig.limits.max_works_per_day_all,
      day_start_time: globalConfig.limits.day_start_time,
      cooldown_hours: globalConfig.limits.cooldown_hours,
    },
    config_error: globalConfig.config_error,
    files,
    today: { day_key: dayKey, created_all: createdToday(deps.db, dayKey), cap_all: globalConfig.limits.max_works_per_day_all },
    projects: projects.map((project) => {
      const config = deps.loader.effective(project.id, { global: deps.settings?.enabled ?? null, project: deps.settings?.projects?.[project.id]?.enabled ?? null });
      return projectView(deps, project, config ?? globalConfig, dayKey);
    }),
  };
}
