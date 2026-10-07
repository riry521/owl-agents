import { join } from "node:path";
import { FileConnectorStateStore } from "./shared/state-store";
import type { OwlPlugin, PluginConfig } from "./types";

export interface RunPluginOptions {
  signalTarget?: {
    on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  };
  exit?: (code: number) => void;
  stderr?: { write(message: string): unknown };
}

export async function runPluginFromEnv(
  factory: (config: PluginConfig) => OwlPlugin,
  env: NodeJS.ProcessEnv = process.env,
  opts?: RunPluginOptions,
): Promise<OwlPlugin> {
  const stderr = opts?.stderr ?? process.stderr;
  const exit = opts?.exit ?? ((code: number) => process.exit(code));
  const apiBase = env.OWL_API_BASE;
  if (!apiBase || !apiBase.trim()) {
    const error = new Error("OWL_API_BASE is required to start a plugin.");
    stderr.write(`[plugin-sdk] ${error.message}\n`);
    exit(1);
    throw error;
  }

  const stateDir = env.OWL_PLUGIN_STATE_DIR;
  const config: PluginConfig = {
    core_api_base: apiBase,
    core_ws_url: env.OWL_WS_URL || undefined,
    api_token: env.OWL_API_TOKEN || undefined,
    plugin_name: env.OWL_PLUGIN_NAME || "plugin",
    state_store: stateDir ? new FileConnectorStateStore(join(stateDir, "state.json")) : undefined,
  };
  const plugin = factory(config);
  await plugin.start();

  const signalTarget = opts?.signalTarget ?? process;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await plugin.stop();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      stderr.write(`[plugin-sdk] Plugin stop failed: ${detail}\n`);
    }
    exit(0);
  };
  const handleSignal = () => { void stop(); };
  signalTarget.on("SIGTERM", handleSignal);
  signalTarget.on("SIGINT", handleSignal);

  return plugin;
}
