import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface PluginSpec {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  enabled: boolean;
  env: Record<string, string>;
}

export class PluginConfigError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "PluginConfigError";
  }
}

const topLevelFields = new Set(["plugins"]);
const pluginFields = new Set(["name", "command", "args", "cwd", "enabled", "env"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PluginConfigError(`Unknown field: ${field}.${key}`, `${field}.${key}`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PluginConfigError(`${field} must be a non-empty string.`, field);
  }
  return value;
}

export function loadPluginSpecs(filePath: string): PluginSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof SyntaxError ? `Invalid JSON: ${error.message}` : "Could not read plugin configuration.";
    throw new PluginConfigError(message, "file");
  }

  if (!isRecord(parsed)) throw new PluginConfigError("Plugin configuration must be an object.", "file");
  checkKeys(parsed, topLevelFields, "file");
  if (!Array.isArray(parsed.plugins)) throw new PluginConfigError("plugins must be an array.", "plugins");

  const configDirectory = dirname(resolve(filePath));
  const names = new Set<string>();
  return parsed.plugins.map((value, index) => {
    const field = `plugins[${index}]`;
    if (!isRecord(value)) throw new PluginConfigError(`${field} must be an object.`, field);
    checkKeys(value, pluginFields, field);

    const name = requireString(value.name, `${field}.name`);
    if (/^[a-z0-9][a-z0-9-]{0,39}$/u.exec(name)?.[0] !== name) {
      throw new PluginConfigError(`${field}.name is invalid.`, `${field}.name`);
    }
    if (names.has(name)) throw new PluginConfigError(`${field}.name is duplicated.`, `${field}.name`);
    names.add(name);

    const command = requireString(value.command, `${field}.command`);
    const args = value.args === undefined ? [] : value.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new PluginConfigError(`${field}.args must be an array of strings.`, `${field}.args`);
    }
    const cwdValue = requireString(value.cwd, `${field}.cwd`);
    const cwd = isAbsolute(cwdValue) ? resolve(cwdValue) : resolve(configDirectory, cwdValue);
    try {
      if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new PluginConfigError(`${field}.cwd must be an existing directory.`, `${field}.cwd`);
    }

    const enabled = value.enabled === undefined ? true : value.enabled;
    if (typeof enabled !== "boolean") throw new PluginConfigError(`${field}.enabled must be a boolean.`, `${field}.enabled`);

    const rawEnv = value.env === undefined ? {} : value.env;
    if (!isRecord(rawEnv)) throw new PluginConfigError(`${field}.env must be an object.`, `${field}.env`);
    const env: Record<string, string> = {};
    for (const [key, entry] of Object.entries(rawEnv)) {
      if (/^[A-Z_][A-Z0-9_]*$/u.exec(key)?.[0] !== key || key.startsWith("OWL_")) {
        throw new PluginConfigError(`${field}.env contains an invalid or reserved key.`, `${field}.env.${key}`);
      }
      if (typeof entry !== "string") {
        throw new PluginConfigError(`${field}.env values must be strings.`, `${field}.env.${key}`);
      }
      env[key] = entry;
    }

    return { name, command, args: [...args] as string[], cwd, enabled, env };
  });
}

interface PluginRuntime {
  spec: PluginSpec;
  child: ChildProcess | null;
  startedAt: number;
  restartCount: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

export interface PluginManagerOptions {
  specs: PluginSpec[];
  serverPort: number;
  apiToken?: string;
  dataDir: string;
  spawnFn?: typeof spawn;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

const restartDelays = [1000, 2000, 4000, 8000, 16000];
const stableRunMs = 10 * 60 * 1000;

export class PluginManager {
  private readonly runtimes: PluginRuntime[];
  private readonly spawnFn: typeof spawn;
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private started = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: PluginManagerOptions) {
    this.spawnFn = options.spawnFn ?? spawn;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.runtimes = options.specs.map((spec) => ({
      spec,
      child: null,
      startedAt: 0,
      restartCount: 0,
      restartTimer: null,
    }));
  }

  async startAll(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true;
    for (const runtime of this.runtimes) {
      if (runtime.spec.enabled) await this.startPlugin(runtime);
    }
  }

  stopAll(timeoutMs = 5000): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.stopProcesses(timeoutMs);
    return this.stopPromise;
  }

  private async startPlugin(runtime: PluginRuntime): Promise<void> {
    if (this.stopping) return;
    const { spec } = runtime;
    try {
      const stateDir = join(this.options.dataDir, "plugins", spec.name);
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      if (this.stopping) return;
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "HOME", "LANG"] as const) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, spec.env, {
        OWL_API_BASE: `http://127.0.0.1:${this.options.serverPort}/api/v1`,
        OWL_PLUGIN_NAME: spec.name,
        OWL_PLUGIN_STATE_DIR: stateDir,
      });
      if (this.options.apiToken !== undefined) env.OWL_API_TOKEN = this.options.apiToken;
      runtime.startedAt = this.now();
      const child = this.spawnFn(spec.command, spec.args, { cwd: spec.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      runtime.child = child;
      this.pipeOutput(child.stdout, spec.name, false);
      this.pipeOutput(child.stderr, spec.name, true);
      child.on("error", (error) => {
        console.error(`[owl-server] Could not start plugin ${spec.name}.`, error);
      });
      const handleTermination = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (runtime.child !== child) return;
        runtime.child = null;
        if (this.stopping) return;
        if (this.now() - runtime.startedAt >= stableRunMs) runtime.restartCount = 0;
        if (code === 0 && signal === null) return;
        this.scheduleRestart(runtime);
      };
      child.once("exit", handleTermination);
      child.once("close", handleTermination);
    } catch (error) {
      console.error(`[owl-server] Could not start plugin ${spec.name}.`, error);
      if (!this.stopping) this.scheduleRestart(runtime);
    }
  }

  private pipeOutput(stream: Readable | null, name: string, isError: boolean): void {
    if (!stream) return;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = `[plugin:${name}] ${line}`;
      if (isError) console.error(message);
      else console.log(message);
    });
  }

  private scheduleRestart(runtime: PluginRuntime): void {
    if (this.stopping) return;
    if (runtime.restartCount >= restartDelays.length) {
      console.error(`[owl-server] Plugin ${runtime.spec.name} reached the restart limit; restarting has stopped.`);
      return;
    }
    const delay = restartDelays[runtime.restartCount];
    runtime.restartCount += 1;
    runtime.restartTimer = this.setTimeoutFn(() => {
      runtime.restartTimer = null;
      if (!this.stopping) void this.startPlugin(runtime);
    }, delay);
    runtime.restartTimer.unref?.();
  }

  private async stopProcesses(timeoutMs: number): Promise<void> {
    for (const runtime of this.runtimes) {
      if (runtime.restartTimer) {
        this.clearTimeoutFn(runtime.restartTimer);
        runtime.restartTimer = null;
      }
    }
    const active = this.runtimes.flatMap((runtime) => runtime.child ? [{ runtime, child: runtime.child }] : []);
    if (active.length === 0) return;
    const exits = active.map(({ runtime, child }) => this.waitForExit(runtime, child));
    for (const { child } of active) child.kill("SIGTERM");

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = await Promise.race([
      Promise.all(exits).then(() => false),
      new Promise<boolean>((resolveTimeout) => {
        timeout = this.setTimeoutFn(() => resolveTimeout(true), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) this.clearTimeoutFn(timeout);
    if (!timedOut) return;

    for (const { runtime, child } of active) {
      if (runtime.child === child) child.kill("SIGKILL");
    }
    await Promise.all(exits);
  }

  private waitForExit(runtime: PluginRuntime, child: ChildProcess): Promise<void> {
    if (runtime.child !== child) return Promise.resolve();
    return new Promise((resolveExit) => {
      const done = (): void => {
        child.off("exit", done);
        child.off("close", done);
        resolveExit();
      };
      child.once("exit", done);
      child.once("close", done);
    });
  }
}

export function createPluginManagerFromEnv(
  env: NodeJS.ProcessEnv,
  options: Omit<PluginManagerOptions, "specs">,
): PluginManager | null {
  const filePath = env.OWL_PLUGINS_FILE?.trim();
  if (!filePath) return null;
  if (!isAbsolute(filePath)) throw new PluginConfigError("OWL_PLUGINS_FILE must be an absolute path.", "OWL_PLUGINS_FILE");
  return new PluginManager({ ...options, specs: loadPluginSpecs(filePath) });
}
