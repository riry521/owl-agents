import { spawn } from "node:child_process";

import { DECISION_TEXT_CHECK_OUTPUT_MAX_BYTES, type DecisionTextCheckInput } from "../../../packages/shared/dist/decision-explanation.js";
import type { FinalReportCheckInput } from "../../../packages/shared/dist/final-report.js";
import { getPluginsFilePath } from "./config.js";
import { loadDecisionTextCheckSpecs, loadFinalReportTextCheckSpecs, type PluginSpec } from "./plugin-manager.js";

/** Same shape as Core's DecisionTextCheck; the server loads Core at run time, so it does not import the type. */
export interface DecisionTextChecker {
  readonly name: string;
  run(input: DecisionTextCheckInput, signal: AbortSignal): Promise<unknown>;
}

/** Only these variables of the server's environment reach a checker; OWL_ values (API keys among them) never do. */
const INHERITED_ENV = ["PATH", "HOME", "LANG"] as const;

const KILL_GRACE_MS = 2000;

function runOnce(spec: PluginSpec, input: unknown, signal: AbortSignal, spawnFn: typeof spawn): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const key of INHERITED_ENV) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, spec.env);
    const child = spawnFn(spec.command, spec.args, { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        // A checker that handles SIGTERM without exiting is killed after a short grace.
        const killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killer.unref();
        child.once("exit", () => clearTimeout(killer));
      }
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = (): void => finish(new Error(`${spec.name} was aborted`));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(error));
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DECISION_TEXT_CHECK_OUTPUT_MAX_BYTES) finish(new Error(`${spec.name} wrote more than ${DECISION_TEXT_CHECK_OUTPUT_MAX_BYTES} bytes`));
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`${spec.name} exited with ${String(code)}`));
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        finish(new Error(`${spec.name} did not write JSON`));
      }
    });
    // A checker that exits without reading its input closes the pipe; the exit code decides then.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(input));
  });
}

/** One checker per enabled spec; each run starts the command once, writes the input JSON to its stdin and reads one JSON from its stdout. */
export function createDecisionTextChecks(specs: readonly PluginSpec[], options: { spawnFn?: typeof spawn } = {}): DecisionTextChecker[] {
  return createTextChecks<DecisionTextCheckInput>(specs, options);
}

/** The same command protocol for any check input: one JSON on stdin, one JSON on stdout. */
export function createTextChecks<Input>(specs: readonly PluginSpec[], options: { spawnFn?: typeof spawn } = {}): { readonly name: string; run(input: Input, signal: AbortSignal): Promise<unknown> }[] {
  const spawnFn = options.spawnFn ?? spawn;
  return specs.filter((spec) => spec.enabled).map((spec) => ({
    name: spec.name,
    run: (input, signal) => runOnce(spec, input, signal, spawnFn),
  }));
}

/** The checkers named in OWL_PLUGINS_FILE; a configuration error is logged and leaves none, so the server still starts. */
export function createDecisionTextChecksFromEnv(env: NodeJS.ProcessEnv): DecisionTextChecker[] {
  const filePath = getPluginsFilePath(env);
  if (!filePath) return [];
  try {
    return createDecisionTextChecks(loadDecisionTextCheckSpecs(filePath));
  } catch (error) {
    console.error(`[owl-server] decision_text_checks: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** The final report checkers named in OWL_PLUGINS_FILE; a configuration error is logged and leaves none, so the server still starts. */
export function createFinalReportTextChecksFromEnv(env: NodeJS.ProcessEnv): ReturnType<typeof createTextChecks<FinalReportCheckInput>> {
  const filePath = getPluginsFilePath(env);
  if (!filePath) return [];
  try {
    return createTextChecks<FinalReportCheckInput>(loadFinalReportTextCheckSpecs(filePath));
  } catch (error) {
    console.error(`[owl-server] final_report_text_checks: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
