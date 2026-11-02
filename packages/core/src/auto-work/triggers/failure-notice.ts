import { statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { AutoWorkSignal, EffectiveAutoWorkConfig } from "@owl/shared";
import { validationError } from "../../errors.js";
import type { LibrarianSchedulerClock } from "../../librarian-scheduler.js";
import { spawnTestCommand } from "../../nightly-tests.js";
import { PeriodicRunner } from "../periodic-runner.js";
import type { AutoWorkTriggerSource } from "../service.js";

export const FAILURE_NOTICE_KINDS = ["process_failed", "process_stopped", "log_error", "other"] as const;
const TITLE_MAX_CHARS = 500;
/** A matching line's title is its head; the whole line is in `dedupe` and the context in `detail`. */
const LOG_TITLE_MAX_CHARS = 200;
/** A burst larger than this is read from its end: the newest lines matter and memory stays bounded. */
const LOG_READ_MAX_BYTES = 1_048_576;
const COMMAND_OUTPUT_LIMIT_BYTES = 1_048_576;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export type AutoWorkCommandRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => Promise<{ exit_code: number | null; stdout: string; stderr: string; timed_out: boolean }>;

/** Runs a command the way the nightly tests do (no shell, only PATH and HOME). A command that cannot start throws. */
export const spawnAutoWorkCommand: AutoWorkCommandRunner = async (argv, cwd, timeoutMs) => {
  const result = await spawnTestCommand(argv, cwd, { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, timeoutMs, COMMAND_OUTPUT_LIMIT_BYTES);
  if (result.error !== undefined) throw new Error(result.error);
  return result;
};

function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw validationError(`${field} must be a string.`, { field });
  return value;
}

/** Checks a failure notice from the HTTP API (design 3.2.1) and turns it into the common signal. */
export function readFailureNotice(body: unknown, now: Date): AutoWorkSignal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw validationError("The notice must be an object.", { field: "payload" });
  const input = body as Record<string, unknown>;
  const projectId = input.project_id;
  if (typeof projectId !== "string" || !ULID.test(projectId)) throw validationError("project_id must be a Project ULID.", { field: "project_id" });
  const kind = input.kind;
  if (typeof kind !== "string" || !(FAILURE_NOTICE_KINDS as readonly string[]).includes(kind)) {
    throw validationError(`kind must be one of ${FAILURE_NOTICE_KINDS.join(", ")}.`, { field: "kind" });
  }
  const title = input.title;
  if (typeof title !== "string" || title.length < 1 || title.length > TITLE_MAX_CHARS) {
    throw validationError(`title must be 1 to ${TITLE_MAX_CHARS} characters.`, { field: "title" });
  }
  const detail = optionalString(input, "detail") ?? "";
  const hint = optionalString(input, "dedupe_hint");
  if (hint === "") throw validationError("dedupe_hint must not be empty.", { field: "dedupe_hint" });
  const occurredAt = optionalString(input, "occurred_at");
  if (occurredAt !== null && !Number.isFinite(Date.parse(occurredAt))) throw validationError("occurred_at must be an ISO 8601 time.", { field: "occurred_at" });
  const exitCode = input.exit_code ?? null;
  if (exitCode !== null && !Number.isInteger(exitCode)) throw validationError("exit_code must be an integer.", { field: "exit_code" });
  return {
    source: "failure_notice",
    project_id: projectId,
    kind,
    title,
    detail,
    dedupe: hint === null ? { kind: "text", value: `${kind}\0${title}` } : { kind: "id", value: hint },
    occurred_at: occurredAt === null ? now.toISOString() : new Date(occurredAt).toISOString(),
    backlog_item_ids: [],
    github: null,
    failure: { exit_code: exitCode as number | null, command: optionalString(input, "command"), log_path: optionalString(input, "log_path") },
  };
}

export interface FailureWatchDeps {
  readonly clock?: LibrarianSchedulerClock;
  readonly commandRunner: AutoWorkCommandRunner;
  /** The Project's directory, where commands run; null when the Project is gone. */
  readonly projectPath: (projectId: string) => string | null;
  /** A file that cannot be read or a command that cannot start; told once until it works again. */
  readonly onAlert: (kind: "auto_work_watch_failed", detail: string) => void;
  readonly logger?: Pick<Console, "warn">;
}

const commandKey = (command: { argv: readonly string[]; cwd?: string }) => `${command.argv.join("\0")}\0${command.cwd ?? ""}`;
const isEnabled = (config: EffectiveAutoWorkConfig) => config.enabled.effective && config.global_enabled.effective;

type Sink = (signal: AutoWorkSignal) => Promise<unknown>;

interface ProjectWatch {
  sink: Sink;
  config: EffectiveAutoWorkConfig;
  logs: PeriodicRunner;
  commands: Map<string, PeriodicRunner>;
  /** Read position per log file, in bytes. */
  offsets: Map<string, number>;
  alerted: Set<string>;
}

/** Watches the log files and the commands a Project lists in `watch` (design 3.2.2, 3.2.3). */
export class FailureWatchTrigger implements AutoWorkTriggerSource {
  public readonly source = "failure_notice" as const;
  private readonly projects = new Map<string, ProjectWatch>();

  public constructor(private readonly deps: FailureWatchDeps) {}

  public start(sink: Sink, config: EffectiveAutoWorkConfig, projectId: string): void {
    const watch: ProjectWatch = {
      sink, config, offsets: new Map(), alerted: new Set(), commands: new Map(),
      logs: new PeriodicRunner({ run: () => this.pollLogs(projectId), intervalMs: config.watch.poll_seconds * 1000, clock: this.deps.clock, logger: this.deps.logger }),
    };
    this.projects.set(projectId, watch);
    this.apply(projectId, watch);
    watch.logs.start();
  }

  public reconfigure(config: EffectiveAutoWorkConfig, projectId: string): void {
    const watch = this.projects.get(projectId);
    if (!watch) return;
    watch.config = config;
    watch.logs.reschedule(config.watch.poll_seconds * 1000);
    this.apply(projectId, watch);
  }

  public async stop(): Promise<void> {
    const watches = [...this.projects.values()];
    this.projects.clear();
    await Promise.all(watches.flatMap((watch) => [watch.logs, ...watch.commands.values()].map((runner) => runner.stop())));
  }

  /** Brings the per-file offsets and the command runners in line with the current configuration. */
  private apply(projectId: string, watch: ProjectWatch): void {
    const { logs, commands } = watch.config.watch;
    const paths = new Set(logs.map((log) => log.path));
    for (const path of [...watch.offsets.keys()]) if (!paths.has(path)) watch.offsets.delete(path);
    // Lines already in a file when watching begins are history, not news.
    for (const path of paths) if (!watch.offsets.has(path)) watch.offsets.set(path, currentSize(path));

    const wanted = new Map(commands.map((command) => [commandKey(command), command]));
    for (const [key, runner] of [...watch.commands]) {
      if (wanted.has(key)) continue;
      watch.commands.delete(key);
      void runner.stop();
    }
    for (const [key, command] of wanted) {
      const intervalMs = command.interval_minutes * 60_000;
      const existing = watch.commands.get(key);
      if (existing) { existing.reschedule(intervalMs); continue; }
      const runner = new PeriodicRunner({ run: () => this.runCommand(projectId, key), intervalMs, clock: this.deps.clock, logger: this.deps.logger });
      watch.commands.set(key, runner);
      runner.start();
    }
  }

  private alert(watch: ProjectWatch, key: string, detail: string): void {
    if (watch.alerted.has(key)) return;
    watch.alerted.add(key);
    this.deps.onAlert("auto_work_watch_failed", detail);
  }

  private async deliver(watch: ProjectWatch, signal: AutoWorkSignal): Promise<void> {
    await watch.sink(signal).catch((error: unknown) => { this.deps.logger?.warn("[owl-core] Could not hand a watched failure to automatic Work creation", error); });
  }

  private async runCommand(projectId: string, key: string): Promise<void> {
    const watch = this.projects.get(projectId);
    const command = watch?.config.watch.commands.find((entry) => commandKey(entry) === key);
    if (!watch || !command || !isEnabled(watch.config)) return;
    const cwd = command.cwd ?? this.deps.projectPath(projectId);
    if (cwd === null) return;
    let result;
    try {
      result = await this.deps.commandRunner(command.argv, cwd, watch.config.watch.command_timeout_seconds * 1000);
    } catch (error) {
      this.alert(watch, key, `${command.argv.join(" ")}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    watch.alerted.delete(key);
    if (result.exit_code === 0 && !result.timed_out) return;
    const text = command.argv.join(" ");
    const output = `${result.stdout}\n${result.stderr}`.trim();
    await this.deliver(watch, {
      source: "failure_notice",
      project_id: projectId,
      kind: command.kind,
      title: result.timed_out ? `${text} timed out` : `${text} exited with code ${result.exit_code}`,
      detail: output.slice(-watch.config.max_detail_chars),
      dedupe: { kind: "id", value: command.argv.join("\0") },
      occurred_at: this.now().toISOString(),
      backlog_item_ids: [],
      github: null,
      failure: { exit_code: result.exit_code, command: text, log_path: null },
    });
  }

  private async pollLogs(projectId: string): Promise<void> {
    const watch = this.projects.get(projectId);
    if (!watch || !isEnabled(watch.config)) return;
    // A file is read once per poll and every setting for it sees the same lines; reading per setting would give the later ones nothing.
    const logs = watch.config.watch.logs;
    const around = watch.config.watch.context_lines;
    for (const path of new Set(logs.map((log) => log.path))) {
      let lines: string[];
      try {
        lines = await this.readNewLines(watch, path);
      } catch (error) {
        this.alert(watch, path, `${path}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      watch.alerted.delete(path);
      for (const log of logs.filter((entry) => entry.path === path)) {
        let pattern: RegExp;
        try { pattern = new RegExp(log.pattern, "u"); } catch (error) {
          this.alert(watch, `${path}\0${log.pattern}`, `${path}: invalid pattern (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
        for (const [index, line] of lines.entries()) {
          if (!pattern.test(line)) continue;
          await this.deliver(watch, {
            source: "failure_notice",
            project_id: projectId,
            kind: log.kind,
            title: line.slice(0, LOG_TITLE_MAX_CHARS),
            detail: lines.slice(Math.max(0, index - around), index + around + 1).join("\n"),
            dedupe: { kind: "text", value: line },
            occurred_at: this.now().toISOString(),
            backlog_item_ids: [],
            github: null,
            failure: { exit_code: null, command: null, log_path: path },
          });
        }
      }
    }
  }

  /** Complete lines added since the last read; a file that got shorter was rotated and is read again from its start. */
  private async readNewLines(watch: ProjectWatch, path: string): Promise<string[]> {
    const size = (await stat(path)).size;
    let offset = watch.offsets.get(path) ?? 0;
    if (size < offset) offset = 0;
    if (size === offset) { watch.offsets.set(path, offset); return []; }
    const start = Math.max(offset, size - LOG_READ_MAX_BYTES);
    const handle = await open(path, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
      chunk = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    // A last line without its newline may still be written; it is read with the next batch.
    const end = chunk.lastIndexOf(0x0a);
    watch.offsets.set(path, start + end + 1);
    return end < 0 ? [] : chunk.subarray(0, end).toString("utf8").split("\n").map((line) => line.replace(/\r$/u, ""));
  }

  private now(): Date {
    return this.deps.clock?.now() ?? new Date();
  }
}

function currentSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
