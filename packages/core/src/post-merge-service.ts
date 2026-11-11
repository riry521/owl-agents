import { createUlid } from "@owl/db";
import type { WriteLane } from "@owl/db";
import { parseStringArray, realPathOrResolve } from "./core-shared.js";
import { ownerLanguage } from "./owner-language";
import {
  DEFAULT_POST_MERGE_DEPENDENCY_FILES,
  DEFAULT_POST_MERGE_INSTALL_RULES,
  POST_MERGE_COMMAND_TIMEOUT_MS,
  PostMergeCommandQueue,
  postMergeResultEvent,
  redactArgv,
  type PostMergeInstallRule,
  type PostMergeRunOutcome,
  type ResolvedPostMergeCommand,
} from "./post-merge-command.js";
import type { CoreDatabase, CoreOptions, JsonObject } from "./types";
import type { CommandRunner } from "./workspace-tooling.js";

/** The Core members the post-merge service uses; Core passes its DB, write lane and started flag. */
export interface PostMergeServiceHost {
  readonly db: CoreDatabase;
  readonly writeLane: Pick<WriteLane, "write">;
  readonly owlRoot: string;
  readonly isStarted: () => boolean;
}

export class PostMergeService {
  private readonly queue: PostMergeCommandQueue;
  private readonly config: {
    readonly owlRootDefault: readonly string[];
    readonly installDefault: readonly string[];
    readonly installRules: readonly PostMergeInstallRule[];
    readonly dependencyFiles: readonly string[];
  };

  public constructor(private readonly host: PostMergeServiceHost, run: CommandRunner, options: CoreOptions["postMergeCommand"]) {
    this.config = {
      owlRootDefault: options?.owlRootDefault ?? ["pnpm", "build"],
      installDefault: options?.installDefault ?? ["pnpm", "install"],
      installRules: options?.installRules ?? DEFAULT_POST_MERGE_INSTALL_RULES,
      dependencyFiles: options?.dependencyFiles ?? DEFAULT_POST_MERGE_DEPENDENCY_FILES,
    };
    this.queue = new PostMergeCommandQueue({
      run,
      timeoutMs: options?.timeoutMs ?? POST_MERGE_COMMAND_TIMEOUT_MS,
      resolve: (projectId) => this.resolve(projectId),
      record: (outcome) => this.recordOutcome(outcome),
      log: (message, error) => console.warn(`[owl-core] ${message}`, error),
    });
  }

  public stop(): void {
    this.queue.stop();
  }

  /** Effective command from the DB at call time: stored value, else the owlRoot default (NULL only), else none. */
  public resolve(projectId: string): ResolvedPostMergeCommand | null {
    const row = this.host.db.get<{ canonical_path: string; post_merge_argv_json: string | null; post_merge_install_argv_json: string | null }>(
      "SELECT canonical_path, post_merge_argv_json, post_merge_install_argv_json FROM projects WHERE id = ?", projectId,
    );
    if (!row) return null;
    const stored = row.post_merge_argv_json === null ? null : parseStringArray(row.post_merge_argv_json, "post_merge_command", projectId, "Project");
    const isDefault = stored === null && realPathOrResolve(row.canonical_path) === realPathOrResolve(this.host.owlRoot);
    const argv = stored ?? (isDefault ? this.config.owlRootDefault : []);
    const installStored = row.post_merge_install_argv_json === null ? null : parseStringArray(row.post_merge_install_argv_json, "post_merge_install_command", projectId, "Project");
    return argv.length === 0 ? null : {
      argv, cwd: row.canonical_path, default_command: isDefault,
      install_override: installStored, install_default: this.config.installDefault, install_rules: this.config.installRules, dependency_files: this.config.dependencyFiles,
    };
  }

  public schedule(workId: string, projectId: string, mergeRecord: JsonObject): void {
    try {
      const base = mergeRecord.base_branch;
      const commit = mergeRecord.new_base_commit;
      if (!this.host.isStarted() || typeof base !== "string" || typeof commit !== "string") return;
      const command = this.resolve(projectId);
      if (command === null) return;
      const merge = { base_branch: base, old_base_commit: typeof mergeRecord.old_base_commit === "string" ? mergeRecord.old_base_commit : null, new_base_commit: commit, merge_commit: typeof mergeRecord.merge_commit === "string" ? mergeRecord.merge_commit : null };
      console.info(`[owl-core] Post-merge command for Work ${workId} queued: ${redactArgv(command.argv).join(" ")}`);
      void this.recordQueued(workId, projectId, command, merge)
        .finally(() => this.queue.enqueue({ project_id: projectId, work_id: workId, merge }));
    } catch (error) {
      console.warn(`[owl-core] Could not queue the post-merge command for Work ${workId}`, error);
    }
  }

  private async recordQueued(workId: string, projectId: string, command: ResolvedPostMergeCommand, merge: { base_branch: string; old_base_commit: string | null; new_base_commit: string; merge_commit: string | null }): Promise<void> {
    try {
      const idempotencyKey = `work-post-merge-queued:${projectId}:${merge.new_base_commit}`;
      if (this.host.db.get("SELECT id FROM events WHERE idempotency_key = ?", idempotencyKey)) return;
      await this.host.writeLane.write({
        mutateState: () => null,
        event: {
          id: createUlid(), idempotencyKey, type: "work.post_merge_command_queued", workId,
          payload: { work_id: workId, project_id: projectId, argv: redactArgv(command.argv), cwd: command.cwd, default_command: command.default_command, ...merge },
        },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      console.warn(`[owl-core] Could not record the queued post-merge command for Work ${workId}`, error);
    }
  }

  private async recordOutcome(outcome: PostMergeRunOutcome): Promise<void> {
    const workId = outcome.job.work_id;
    try {
      const { type, idempotencyKey, payload } = postMergeResultEvent(outcome, ownerLanguage(this.host.db));
      const stderrTail = String(payload.stderr_tail ?? "").trim();
      const stdoutTail = String(payload.stdout_tail ?? "").trim();
      const tail = [stderrTail && `stderr:\n${stderrTail}`, stdoutTail && `stdout:\n${stdoutTail}`].filter(Boolean).join("\n");
      console.info(type === "system.alert"
        ? `[owl-core] Post-merge command for Work ${workId} failed. stage=${String(payload.stage)} exit_code=${String(payload.exit_code)} timed_out=${String(payload.timed_out)}${tail ? `\n${tail}` : ""}`
        : `[owl-core] Post-merge command for Work ${workId} succeeded.`);
      if (!this.host.isStarted() || this.host.db.get("SELECT id FROM events WHERE idempotency_key = ?", idempotencyKey)) return;
      await this.host.writeLane.write({
        mutateState: () => null,
        event: { id: createUlid(), idempotencyKey, type, workId, payload: payload as JsonObject },
        outbox: [{ provider: "websocket" }],
      });
    } catch (error) {
      console.warn(`[owl-core] Could not record the post-merge command result for Work ${workId}`, error);
    }
  }

  /** Re-queues the newest queued merge per project that has no recorded result (stopped while waiting or running). */
  public recover(): void {
    const seen = new Set<string>();
    for (const row of this.host.db.all<{ work_id: string; payload_json: string }>(
      "SELECT work_id, payload_json FROM events WHERE type = 'work.post_merge_command_queued' ORDER BY sequence DESC LIMIT 500",
    )) {
      try {
        const p = JSON.parse(row.payload_json) as { project_id: string; base_branch: string; old_base_commit?: string | null; new_base_commit: string; merge_commit: string | null };
        if (seen.has(p.project_id)) continue;
        seen.add(p.project_id);
        const done = this.host.db.get(
          "SELECT id FROM events WHERE idempotency_key IN (?, ?)",
          `work-post-merge-succeeded:${p.project_id}:${p.new_base_commit}`, `work-post-merge-failed:${p.project_id}:${p.new_base_commit}`,
        );
        if (!done) this.queue.enqueue({ project_id: p.project_id, work_id: row.work_id, merge: { base_branch: p.base_branch, old_base_commit: p.old_base_commit ?? null, new_base_commit: p.new_base_commit, merge_commit: p.merge_commit } });
      } catch (error) {
        console.warn("[owl-core] Could not recover a queued post-merge command", error);
      }
    }
  }
}
