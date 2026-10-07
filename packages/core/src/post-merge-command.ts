import type { CommandResult, CommandRunner } from "./workspace-tooling.js";
import { redactCredentials } from "./git-push.js";

const SECRET_NAME = "[\\w-]*(?:key|token|secret|password|passwd|credential)[\\w-]*";
const SECRET_VALUE = "(\"[^\"]*\"|'[^']*'|[^\\s\"']+)";
const SECRET_FLAG = new RegExp(`^--?${SECRET_NAME}$`, "iu");

/** Masks URL credentials, Authorization/Bearer/Basic values, NAME=value / NAME: value and `--flag value` secrets. */
export function redactSecrets(text: string): string {
  return redactCredentials(text)
    .replace(/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"']+/giu, "$1[REDACTED]")
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{6,}/giu, "$1 [REDACTED]")
    .replace(new RegExp(`(${SECRET_NAME}\\s*[=:]\\s*)${SECRET_VALUE}`, "giu"), "$1[REDACTED]")
    .replace(new RegExp(`(\\s--?${SECRET_NAME}\\s+)${SECRET_VALUE}`, "giu"), "$1[REDACTED]");
}

/** Like redactSecrets, but also masks the element after a secret-named flag such as `--token`. */
export function redactArgv(argv: readonly string[]): string[] {
  return argv.map((arg, i) => (i > 0 && SECRET_FLAG.test(argv[i - 1]!) ? "[REDACTED]" : redactSecrets(arg)));
}

/** Manifests and lockfiles whose change means dependencies changed; matched by base name so workspace packages count. */
export const DEFAULT_POST_MERGE_DEPENDENCY_FILES: readonly string[] = [
  "package.json", "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb",
];

export const POST_MERGE_COMMAND_TIMEOUT_MS = 15 * 60_000;
const STDOUT_TAIL_BYTES = 2_048;
const STDERR_TAIL_BYTES = 4_096;

export interface PostMergeMerge {
  readonly base_branch: string;
  /** Base before the merge (the earliest one when merges are coalesced); null when unknown, which counts as "dependencies changed". */
  readonly old_base_commit: string | null;
  readonly new_base_commit: string;
  readonly merge_commit: string | null;
}

/** One merge waiting for (or running) its project's post-merge command. */
export interface PostMergeJob {
  readonly project_id: string;
  readonly work_id: string;
  readonly merge: PostMergeMerge;
  readonly covered_work_ids: readonly string[];
}

/** Resolved at run time from the DB; null means skip (project deleted or command empty). */
export interface ResolvedPostMergeCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly default_command: boolean;
  /** Runs before argv when a dependency file changed; empty means no install step. */
  readonly install_argv: readonly string[];
  /** Base names (package.json, pnpm-lock.yaml, ...) whose change triggers install_argv. */
  readonly dependency_files: readonly string[];
}

export type PostMergeStage = "install" | "build";

export interface PostMergeRunOutcome {
  readonly job: PostMergeJob;
  readonly command: ResolvedPostMergeCommand;
  /** "install" when the install step failed (the build did not run), otherwise "build". */
  readonly stage: PostMergeStage;
  readonly result: CommandResult;
  readonly duration_ms: number;
  readonly timeout_ms: number;
}

export interface PostMergeCommandQueueDeps {
  readonly run: CommandRunner;
  readonly timeoutMs: number;
  readonly resolve: (projectId: string) => ResolvedPostMergeCommand | null;
  readonly record: (outcome: PostMergeRunOutcome) => Promise<void>;
  readonly log: (message: string, error?: unknown) => void;
}

/**
 * One command at a time for the whole Core. Each project keeps at most one
 * waiting job: a newer merge replaces it (keeping its place) and inherits the
 * covered Work ids, so a burst of merges costs one extra run.
 */
export class PostMergeCommandQueue {
  private readonly waiting = new Map<string, PostMergeJob>();
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: PostMergeCommandQueueDeps) {}

  enqueue(job: Omit<PostMergeJob, "covered_work_ids">): void {
    if (this.stopped) return;
    const previous = this.waiting.get(job.project_id);
    const merge = previous ? { ...job.merge, old_base_commit: previous.merge.old_base_commit } : job.merge;
    this.waiting.set(job.project_id, { ...job, merge, covered_work_ids: [...(previous?.covered_work_ids ?? []), job.work_id] });
    this.draining ??= this.drain().finally(() => { this.draining = null; });
  }

  idle(): Promise<void> {
    return this.draining ?? Promise.resolve();
  }

  /** Drops waiting jobs and discards the running job's result; the running process is not awaited. */
  stop(): void {
    this.stopped = true;
    this.waiting.clear();
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const next = this.waiting.entries().next();
      if (next.done) return;
      const [projectId, job] = next.value;
      this.waiting.delete(projectId);
      try {
        const command = this.deps.resolve(projectId);
        if (command === null) continue;
        const started = Date.now();
        const run = (argv: readonly string[]) => this.deps.run(argv[0]!, argv.slice(1), {
          cwd: command.cwd, env: postMergeCommandEnv(process.env), timeout_ms: this.deps.timeoutMs,
        });
        let stage: PostMergeStage = "build";
        let result: CommandResult | null = null;
        if (command.install_argv.length > 0 && await this.dependenciesChanged(command, job.merge)) {
          const installed = await run(command.install_argv);
          if (!isSuccess(installed)) { stage = "install"; result = installed; }
        }
        if (this.stopped) return;
        result ??= await run(command.argv);
        if (this.stopped) return;
        await this.deps.record({ job, command, stage, result, duration_ms: Date.now() - started, timeout_ms: this.deps.timeoutMs });
      } catch (error) {
        this.deps.log(`Post-merge command for Work ${job.work_id} could not be run`, error);
      }
    }
  }

  /** A diff that cannot be read counts as changed: a needless install is cheaper than a build on stale dependencies. */
  private async dependenciesChanged(command: ResolvedPostMergeCommand, merge: PostMergeMerge): Promise<boolean> {
    if (merge.old_base_commit === null) return true;
    const diff = await this.deps.run("git", ["diff", "--name-only", "-z", merge.old_base_commit, merge.new_base_commit], {
      cwd: command.cwd, env: postMergeCommandEnv(process.env), timeout_ms: this.deps.timeoutMs,
    });
    if (!isSuccess(diff)) return true;
    const names = new Set(command.dependency_files);
    return diff.stdout.split("\0").some((file) => names.has(file.split("/").pop() ?? ""));
  }
}

function isSuccess(result: CommandResult): boolean {
  return result.exit_code === 0 && !result.timed_out;
}

const ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TZ", "LANG",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "PNPM_HOME", "COREPACK_HOME", "NVM_DIR", "NVM_BIN", "VOLTA_HOME",
]);

/** Allowlisted environment only: Owl's own tokens and provider keys never reach the command. */
export function postMergeCommandEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_KEYS.has(key.toUpperCase()) || key.startsWith("LC_")) env[key] = value;
  }
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0" };
}

/** Last `cap` bytes of `text`, without splitting a UTF-8 code point. */
export function tailBytes(text: string, cap: number): string {
  const buffer = Buffer.from(text);
  if (buffer.byteLength <= cap) return text;
  let start = buffer.byteLength - cap;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

function postMergeAlertText(language: "ja" | "en", stage: PostMergeStage, argv: readonly string[], cwd: string, result: CommandResult, timeoutMs: number): { message: string; remediation: string } {
  const cmd = `${stage}: ${redactArgv(argv).join(" ")}`;
  const ja = language === "ja";
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  const spawnError = result.error !== undefined && result.exit_code === null && !result.timed_out;
  const error = redactSecrets(result.error ?? "");
  const message = result.timed_out
    ? (ja ? `マージ後コマンド（${cmd}）が ${minutes} 分以内に終わらなかったため停止しました。` : `The post-merge command (${cmd}) was stopped after ${minutes} minutes.`)
    : result.exit_code === null
      ? (spawnError
        ? (ja ? `マージ後コマンド（${cmd}）を起動できませんでした: ${error}` : `The post-merge command (${cmd}) could not be started: ${error}`)
        : (ja ? `マージ後コマンド（${cmd}）が途中で終了しました。` : `The post-merge command (${cmd}) was terminated.`))
      : (ja ? `マージ後コマンド（${cmd}）が終了コード ${result.exit_code} で失敗しました。` : `The post-merge command (${cmd}) failed with exit code ${result.exit_code}.`);
  const hint = spawnError ? (ja ? "コマンド名と PATH を確認するか、絶対パスで指定してください。" : "Check the command name and PATH, or use an absolute path. ") : "";
  const remediation = hint + (ja
    ? `${cwd} で同じコマンドを手動で実行して原因を確認してください。Work は完了済みです。次のマージで自動的に再実行されます。`
    : `Run the same command manually in ${cwd} to find the cause. The Work is already complete; the command runs again after the next merge.`);
  return { message, remediation };
}

/** The event to record for a finished run: succeeded, or a system.alert. Redacts, then trims. */
export function postMergeResultEvent(outcome: PostMergeRunOutcome, language: "ja" | "en"):
  { readonly type: "work.post_merge_command_succeeded" | "system.alert"; readonly idempotencyKey: string; readonly payload: Record<string, unknown> } {
  const { job, command, result, stage } = outcome;
  const argv = stage === "install" ? command.install_argv : command.argv;
  const stdoutTail = tailBytes(redactSecrets(result.stdout), STDOUT_TAIL_BYTES);
  const stderrTail = tailBytes(redactSecrets(result.stderr), STDERR_TAIL_BYTES);
  const detail = {
    project_id: job.project_id, stage, argv: redactArgv(argv), cwd: command.cwd,
    default_command: command.default_command, exit_code: result.exit_code, duration_ms: outcome.duration_ms,
    stdout_tail: stdoutTail, stderr_tail: stderrTail,
    base_branch: job.merge.base_branch, old_base_commit: job.merge.old_base_commit, new_base_commit: job.merge.new_base_commit, merge_commit: job.merge.merge_commit,
    covered_work_ids: [...job.covered_work_ids],
  };
  const suffix = `${job.project_id}:${job.merge.new_base_commit}`;
  if (isSuccess(result)) {
    return { type: "work.post_merge_command_succeeded", idempotencyKey: `work-post-merge-succeeded:${suffix}`, payload: { work_id: job.work_id, ...detail } };
  }
  const text = postMergeAlertText(language, stage, argv, command.cwd, result, outcome.timeout_ms);
  const body = (stderrTail || stdoutTail).slice(-500);
  return {
    type: "system.alert",
    idempotencyKey: `work-post-merge-failed:${suffix}`,
    payload: {
      kind: "work_post_merge_command_failed", message: body ? `${text.message}\n\n${body}` : text.message, remediation: text.remediation,
      ...detail, timed_out: result.timed_out, spawn_error: result.error === undefined ? null : redactSecrets(result.error),
    },
  };
}
