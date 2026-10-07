import { BasePlugin, runPluginFromEnv, type OwlEvent, type PluginConfig } from "@owl/plugin-sdk";

class LogNotifyPlugin extends BasePlugin {
  readonly name = "log-notify";

  async onEvent(event: OwlEvent): Promise<void> {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  async onInbound(): Promise<void> {}
}

void runPluginFromEnv((config: PluginConfig) => new LogNotifyPlugin(config)).catch((error: unknown) => {
  console.error("[log-notify] Failed to start:", error);
  process.exitCode = 1;
});
