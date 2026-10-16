import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { command, createTestCore } from "./core.mjs";
import { withNecessity } from "./necessity.mjs";

export const gitIn = (cwd, args, env = {}) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
}).trim();

/** Creates a repository with one commit; `templateDir` marks it the way a real Worker's `git init` does. */
export async function makeRepository(path, { templateDir, file = "created.txt" } = {}) {
  await mkdir(path, { recursive: true });
  gitIn(path, ["init", "--initial-branch=main"], templateDir ? { GIT_TEMPLATE_DIR: templateDir } : {});
  await writeFile(join(path, file), "created by a test Worker\n");
  gitIn(path, ["add", "."]);
  gitIn(path, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  return join(path, file);
}

/** `removeOnExit: false` leaves the removal to a caller that must stop other writers first. */
export async function tempFolder(t, prefix, { removeOnExit = true } = {}) {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  if (removeOnExit) t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export async function birthtimeIsAvailable(path) {
  const value = (await stat(path)).birthtimeMs;
  return Number.isFinite(value) && value > 0;
}

const REPORTED_ACTION = "created";

export const successReport =(invocationId, changes = []) => ({
  kind: "report",
  schema_version: "1.0.0",
  invocation_id: invocationId,
  result: "success",
  work_done: "Completed the test Task.",
  changes,
  delegation: { decomposition: "The test Task is not divided.", delegated: [], retained: [{ part: "the whole Task", reason: "A fake Worker does everything itself." }] },
  verification: { passed: true, method: "The fake Worker returned a valid success report." },
  remaining_issues: [],
  next_action: "none",
  needs_replanning: false,
  question_for_manager: null, pending_process: null, external_blocker: null,
});

export function plannedTask(id, title, dependsOn = [], type = "research") {
  return {
    id, title, type, acceptance: "Return a successful Worker report.", depends_on: dependsOn,
    required_sections: [], required_tests: [], wait_for: null, base_sync_only: null, replaces: [], review: false,
  };
}

/**
 * A Core whose fake agents run `workers[task title]` for each Worker request.
 * `finalizeCalls` records, per Final Manager call, whether the Work was already attached to a Project.
 */
export async function createAutoRegistrationCore(t, { tasks, workers = {}, coreOptions = {}, prefix = "owl-auto-registration-", start = true }) {
  const state = { db: null, requests: [], finalizeCalls: [] };
  const titleOf = (taskId) => state.db.get("SELECT title FROM tasks WHERE id = ?", taskId)?.title;
  const agentRunner = withNecessity({
    runManagerPlan: async (request) => {
      const mode = request.context?.mode ?? request.mode;
      if (mode === "plan") return { outcome: "success", report_valid: true, report: { tasks, event: "work.planned" } };
      if (mode === "finalize") {
        state.finalizeCalls.push({
          attached: Boolean(state.db.get("SELECT project_id FROM works WHERE id = ?", request.work_id)?.project_id),
        });
        return {
          outcome: "success",
          report_valid: true,
          report: { tasks: request.tasks ?? [], event: null, verdict: { verdict: "complete", summary: "Complete.", missing: [], lessons: [] } },
        };
      }
      return { outcome: "failed", message: `Unexpected Manager mode: ${String(mode)}` };
    },
    runWorker: async (request) => {
      const title = titleOf(request.task_id);
      state.requests.push({ ...request, title });
      const changes = (await workers[title]?.(request, state)) ?? [];
      return { outcome: "success", report_valid: true, report: successReport(request.invocation_id, changes.map((change) => (typeof change === "string" ? { file: change, action: REPORTED_ACTION } : change))) };
    },
    runReviewer: async () => ({
      outcome: "success",
      report_valid: true,
      report: { verdict: "pass", summary: "Reviewed.", findings: [], tests: { ran: false, command: "none", passed: 0, failed: 0 } },
    }),
    runAdvisor: async () => ({ reply: "" }),
    runCurator: async () => ({ ok: false, error: "curator_unavailable" }),
  });
  const created = await createTestCore(t, { agentRunner, dispatcher: { tick_interval_ms: 25 }, ...coreOptions }, { prefix, start });
  state.db = created.db;
  return { ...created, state };
}

export async function startProjectlessWork(core, key, mode = "normal") {
  const created = await core.createWork(command({ title: key, summary: "Auto registration", size: mode, project_id: null }, `${key}-create`));
  await core.startWork(created.data.work_id, command({ mode }, `${key}-start`, created.version));
  return created.data.work_id;
}

export const eventTypes = (db, workId, prefix = "work.") =>
  db.all("SELECT type FROM events WHERE work_id = ? AND type LIKE ? ORDER BY sequence", workId, `${prefix}%`).map((row) => row.type);
