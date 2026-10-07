// Supervisor: watches owl-core process, restarts on crash.
// A lightweight process, separate from owl-core, that watches Core (and,
// once wired in, Web / Slack / Discord Connectors) and restarts them on
// crash with capped exponential backoff. If a service crashes too many
// times within a window, the Supervisor stops retrying and surfaces a
// human-readable alert instead of looping forever. The Supervisor itself is
// meant to be supervised by launchd/systemd (`install-service` registers the
// Supervisor, not owl-core directly).
//
// The MVP does not include an automatically-started Supervisor;
// `owl start|stop|restart|status` manages owl-core directly. This module is
// intended to be run manually (`node apps/supervisor/dist/supervisor.js`)
// until Supervisor auto-start is wired into `owl install-service`.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadOwlEnv } from "../../../packages/shared/dist/env.js";

// The supervisor is a direct executable as well as a child-spawner. Load the
// same project .env before its defaults read OWL_ROOT or other configuration.
loadOwlEnv();

interface SupervisorConfig {
  owlRoot: string;
  maxRestarts: number; // max restarts within window
  restartWindowMs: number; // window for counting restarts
  healthCheckIntervalMs: number;
  healthCheckUrl: string;
}

const DEFAULT_CONFIG: SupervisorConfig = {
  owlRoot: process.cwd(),
  maxRestarts: 5,
  restartWindowMs: 300_000, // 5 minutes
  healthCheckIntervalMs: 30_000, // 30 seconds
  healthCheckUrl: "http://127.0.0.1:3787/api/v1/health",
};

class Supervisor {
  private config: SupervisorConfig;
  private child: ChildProcess | null = null;
  private childExited = true;
  private restartTimestamps: number[] = [];
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthFailureCount = 0;
  private readonly healthFailureLimit = 3;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(config: Partial<SupervisorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    console.log("[supervisor] Starting owl-core supervision");
    this.stopping = false;
    this.spawnCore();
    this.startHealthCheck();

    process.on("SIGTERM", () => {
      void this.shutdown("SIGTERM");
    });
    process.on("SIGINT", () => {
      void this.shutdown("SIGINT");
    });
  }

  private spawnCore(): void {
    const cliPath = join(this.config.owlRoot, "apps/server/dist/cli.js");
    if (!existsSync(cliPath)) {
      console.error(`[supervisor] CLI not found: ${cliPath}`);
      process.exit(4);
    }

    console.log("[supervisor] Spawning owl-core");
    const child = spawn("node", [cliPath, "start", "--foreground"], {
      cwd: this.config.owlRoot,
      stdio: "inherit",
      env: { ...process.env },
    });

    this.child = child;
    this.childExited = false;
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.childExited = true;
      if (this.stopping) {
        console.log("[supervisor] owl-core stopped (supervised shutdown)");
        return;
      }
      console.error(`[supervisor] owl-core exited: code=${code} signal=${signal}`);
      this.handleCrash();
    });
  }

  private handleCrash(): void {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (t) => now - t < this.config.restartWindowMs,
    );

    if (this.restartTimestamps.length >= this.config.maxRestarts) {
      console.error(
        `[supervisor] Too many restarts (${this.config.maxRestarts} in ${
          this.config.restartWindowMs / 1000
        }s). Giving up.`,
      );
      process.exit(1);
    }

    this.restartTimestamps.push(now);
    const delay = Math.min(1000 * Math.pow(2, this.restartTimestamps.length - 1), 30_000);
    console.log(
      `[supervisor] Restarting in ${delay}ms (attempt ${this.restartTimestamps.length}/${this.config.maxRestarts})`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnCore();
    }, delay);
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(this.config.healthCheckUrl);
          if (!response.ok) {
            this.healthFailureCount += 1;
            console.warn(`[supervisor] Health check failed: ${response.status}`);
          } else {
            this.healthFailureCount = 0;
          }
        } catch (error) {
          this.healthFailureCount += 1;
          console.warn("[supervisor] Health check unreachable", error);
        }
        if (this.healthFailureCount >= this.healthFailureLimit && this.child && !this.childExited && !this.stopping) {
          console.error(`[supervisor] Health check failed ${this.healthFailureCount} times; restarting owl-core`);
          const childRef = this.child;
          childRef.kill("SIGTERM");
          setTimeout(() => {
            if (this.child === childRef && !this.childExited) {
              console.warn("[supervisor] Health restart grace period expired; force-killing owl-core");
              childRef.kill("SIGKILL");
            }
          }, 10_000).unref?.();
          this.healthFailureCount = 0;
        }
      })();
    }, this.config.healthCheckIntervalMs);
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.stopping) return;
    console.log(`[supervisor] Received ${signal}, shutting down`);
    this.stopping = true;
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (child && !this.childExited) {
      child.once("exit", () => {
        process.exit(0);
      });
      // Core owns termination of its Agent process groups and waits only for
      // its serialized database writes before exiting. Keep the supervisor
      // alive until that child has actually exited so it cannot orphan/restart it.
      child.kill("SIGTERM");
    } else {
      process.exit(0);
    }
  }
}

// CLI entry
const args = process.argv.slice(2);
const owlRoot = args.find((a) => a.startsWith("--root="))?.split("=")[1] ?? process.cwd();
const supervisor = new Supervisor({ owlRoot: resolve(owlRoot) });
supervisor.start().catch((err: unknown) => {
  console.error("[supervisor] Fatal:", err);
  process.exit(1);
});

export { Supervisor, type SupervisorConfig };
