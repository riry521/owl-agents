import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveDataDir, serverPackageRoot } from "./contracts.js";
import { providerMode } from "./config.js";
import { AppSettingsStore } from "./app-settings-store.js";
import { ApiError } from "./errors.js";
import { buildAgentEnv } from "./agent-env.js";
import { providerConfigurationError, providerSelection, resolveExecutableForSelection, type ProviderSelection } from "./provider-selection.js";
import type { AgentRunner } from "./types.js";
import type { GuardTokenIssuer } from "../../../packages/shared/dist/guard-token.js";
import type { PromptObserver } from "../../../packages/shared/dist/index.js";
import type { PlanUsageSnapshot } from "../../../packages/shared/dist/plan-usage.js";

interface AgentRuntimeModule {
  createAgentRunner?: (options: Record<string, unknown>) => unknown;
  createStubAgentRunner?: () => unknown;
}

type AgentProcessEvent =
  | { readonly type: "spawned"; readonly pid: number }
  | { readonly type: "exited"; readonly pid: number };

async function loadAgentRuntimeModule(): Promise<AgentRuntimeModule> {
  const runtimePath = join(serverPackageRoot(), "../../packages/agent-runtime/dist/index.js");
  try {
    await access(runtimePath);
  } catch (error) {
    throw new ApiError(
      503,
      "dependency_unavailable",
      "Agent実行基盤がまだ利用できません。必要なdistをビルドしてから再実行してください。",
      { dependency: "packages/agent-runtime/dist/index.js" },
      { cause: error },
    );
  }
  let loaded: AgentRuntimeModule;
  try {
    loaded = (await import(pathToFileURL(runtimePath).href)) as AgentRuntimeModule;
  } catch (error) {
    throw new ApiError(
      503,
      "dependency_unavailable",
      "Agent実行基盤を読み込めませんでした。ビルド成果物と実行環境を確認してください。",
      { dependency: "packages/agent-runtime/dist/index.js" },
      { cause: error },
    );
  }
  if (typeof loaded.createAgentRunner !== "function" || typeof loaded.createStubAgentRunner !== "function") {
    throw new ApiError(
      503,
      "dependency_unavailable",
      "Agent実行基盤の公開APIが契約と一致しません。createAgentRunner/createStubAgentRunnerを確認してください。",
      { dependency: "packages/agent-runtime/dist/index.js", export: "createAgentRunner,createStubAgentRunner" },
    );
  }
  return loaded;
}

/**
 * Standalone/dev-mode agent runner used only when OWL_CORE_MODE === "standalone"
 * (paired with MemoryCore, which has no real task-driving workflow of its own).
 * The production execution path is createExternalAgentRunner(), which the real
 * packages/core Core class calls directly via runManagerPlan/runWorker/runReviewer
 * (a structurally different interface with no start/stopAll/PID concept).
 *
 * packages/agent-runtime's ProviderClient.execute() spawns and fully owns its
 * child process inside the returned promise; it exposes no PID or AbortSignal
 * hook a caller could use to track or kill an in-flight invocation from outside.
 * Real PID-based cancellation for actually-spawned CLI processes is implemented
 * at the packages/core layer instead (Core.cancelAgent(), which reads the
 * agent_runs.pid column written by the real Core and sends SIGTERM/SIGKILL).
 * This class therefore only validates that the runtime dependency is loadable
 * and tracks which Work ids are considered active, rather than pretending to
 * manage real child processes it has no way to observe.
 */
class RealAgentRunner implements AgentRunner {
  readonly mode = "real" as const;
  private readonly activeWorkIds = new Set<string>();

  activeCount(): number {
    return this.activeWorkIds.size;
  }

  async start(workId: string, _mode: "normal" | "small"): Promise<void> {
    await loadAgentRuntimeModule();
    this.activeWorkIds.add(workId);
  }

  async stopAll(_force: boolean): Promise<void> {
    this.activeWorkIds.clear();
  }
}

class StubAgentRunner implements AgentRunner {
  readonly mode = "stub" as const;
  private active = 0;

  activeCount(): number {
    return this.active;
  }

  async start(_workId: string, _mode: "normal" | "small"): Promise<void> {
    this.active += 1;
  }

  async stopAll(_force: boolean): Promise<void> {
    this.active = 0;
  }
}

export function createAgentRunner(): AgentRunner {
  return new RealAgentRunner();
}

export function createStubAgentRunner(): AgentRunner {
  return new StubAgentRunner();
}

export function createConfiguredAgentRunner(): AgentRunner {
  return providerMode() === "stub" ? createStubAgentRunner() : createAgentRunner();
}

function agentRunnerInitializationError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const reason = error instanceof Error ? error.message : "";
  if (/app-settings\.json is corrupt or contains invalid settings/iu.test(reason)) {
    return new ApiError(
      503,
      "dependency_unavailable",
      `Provider設定を読み込めませんでした。${reason}`,
      { dependency: "data/app-settings.json" },
      { cause: error },
    );
  }
  if (/ENOENT|EACCES|EPERM|command not found|executable/iu.test(reason)) {
    return new ApiError(
      503,
      "dependency_unavailable",
      "Provider/Harnessの実行環境を初期化できませんでした。実行ファイルのパス、PATH、権限を確認してください。",
      { dependency: "Provider/Harness executable" },
      { cause: error },
    );
  }
  return new ApiError(
    503,
    "dependency_unavailable",
    "Provider/Harnessを初期化できませんでした。Provider設定、モデル、実行環境を確認してください。",
    { dependency: "packages/agent-runtime/dist/index.js" },
    { cause: error },
  );
}

async function resolveBinary(name: string, pathValue: string): Promise<string | undefined> {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = resolve(join(directory, name));
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR" || code === "EPERM") {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

/**
 * Absolute Claude / Codex executables for agent processes. The selected
 * provider's executable always wins for its harness; the other CLI is taken
 * from OWL_CLAUDE_EXECUTABLE / OWL_CODEX_EXECUTABLE or PATH when installed,
 * so role overrides can use it without making it a startup dependency.
 */
export async function resolveAgentExecutables(
  selection: ProviderSelection,
  selectedExecutable: string | undefined,
  pathValue: string,
): Promise<{ claude?: string; codex?: string }> {
  const configuredClaude = process.env.OWL_CLAUDE_EXECUTABLE?.trim()
    ?? (selection.harness === "claude" ? process.env.OWL_PROVIDER_EXECUTABLE?.trim() : undefined);
  const configuredCodex = process.env.OWL_CODEX_EXECUTABLE?.trim();
  const claude = selection.harness === "claude" && selectedExecutable
    ? selectedExecutable
    : configuredClaude && configuredClaude.startsWith("/") ? configuredClaude : await resolveBinary("claude", pathValue);
  const codex = selection.harness === "codex" && selectedExecutable
    ? selectedExecutable
    : configuredCodex && configuredCodex.startsWith("/") ? configuredCodex : await resolveBinary("codex", pathValue);
  return { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) };
}

/** Environment variable names that hold custom provider API keys. */
export function customProviderApiKeyEnvNames(owlRoot: string): string[] {
  return Object.values(new AppSettingsStore(owlRoot, resolveDataDir(owlRoot)).getCustomProviders())
    .map((config) => config.apiKeySource?.startsWith("env:") ? config.apiKeySource.slice("env:".length) : "")
    .filter((name) => name.length > 0);
}

function guardEnvironment(guard: AgentGuardConfiguration | undefined): Record<string, string> {
  return guard ? { OWL_GUARD_API_BASE: guard.apiBase } : {};
}

export interface HybridExecutorRuntime {
  readonly owlRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly executables: { readonly claude?: string; readonly codex?: string };
  readonly guardToken?: GuardTokenIssuer;
}

/**
 * Process settings for Hybrid Executor CLIs, resolved on every dispatch so a
 * running server picks up provider settings changes. They share the agent
 * environment rules of every other role.
 */
export function createHybridExecutorRuntime(
  owlRoot: string,
  guard?: AgentGuardConfiguration,
): () => Promise<HybridExecutorRuntime> {
  return async () => {
    const selection = providerSelection(owlRoot);
    const selectedExecutable = selection.mode === "real" ? await resolveExecutableForSelection(selection) : undefined;
    const executables = await resolveAgentExecutables(selection, selectedExecutable, process.env.PATH ?? "");
    const env = buildAgentEnv(process.env, {
      owlRoot,
      deny: customProviderApiKeyEnvNames(owlRoot),
      extra: guardEnvironment(guard),
    });
    return { owlRoot, env, executables, ...(guard ? { guardToken: guard.issueToken } : {}) };
  };
}

/**
 * How agent processes reach the guard: the endpoint address, which is passed
 * in their environment, and a per-process token, which is not.
 */
export interface AgentGuardConfiguration {
  readonly apiBase: string;
  readonly issueToken: GuardTokenIssuer;
}

export async function createExternalAgentRunner(owlRoot: string, useStub: boolean, guard?: AgentGuardConfiguration): Promise<unknown> {
  const runtimeModule = await loadAgentRuntimeModule();
  try {
    if (useStub) {
      return runtimeModule.createStubAgentRunner?.();
    }
    let delegate: {
      runManagerPlan(request: unknown): Promise<unknown>;
      runDesigner(request: unknown): Promise<unknown>;
      runWorker(request: unknown): Promise<unknown>;
      runReviewer(request: unknown): Promise<unknown>;
      runAdvisor(request: unknown): Promise<unknown>;
      runCurator?(request: unknown): Promise<unknown>;
      runKeywordExtraction?(request: unknown): Promise<unknown>;
      runLibrarianOperations?(request: unknown): Promise<unknown>;
      runClippingTags?(request: unknown): Promise<unknown>;
      runRuleJudgments?(request: unknown): Promise<unknown>;
      runProjectInvestigation?(request: unknown): Promise<unknown>;
      provider?: unknown;
      cancelAgent?: (invocationId: string, force?: boolean) => Promise<void>;
      setProcessObserver?: (observer: (invocationId: string, event: AgentProcessEvent) => void | Promise<void>) => void;
      setOutputObserver?: (observer: (invocationId: string) => void) => void;
      setOutputResubmitLimit?: (read: () => number) => void;
      setPromptObserver?: (observer: PromptObserver | undefined) => void;
      setPlanUsageObserver?: (observer: (observation: PlanUsageSnapshot) => void) => void;
    } | null = null;
    // The provider registry is mutable by design: settings are edited through
    // the running server, so a long-lived AgentRunner must see the next
    // request's custom-provider changes without being recreated.
    let refreshProviderSettings: () => void = () => undefined;
    let planUsageObserver: ((observation: PlanUsageSnapshot) => void) | undefined;
    let outputResubmitLimit: (() => number) | undefined;
    // Observers are registered fire-and-forget; a failed delegate must be logged, not left as an unhandled rejection.
    const logObserverError = (name: string) => (error: unknown): void => {
      console.error(`[agent-runner] ${name} registration failed`, error);
    };
    const getDelegate = async () => {
      try {
        if (delegate === null) {
          const selection = providerSelection(owlRoot);
        const pathValue = process.env.PATH;
        if (pathValue === undefined || pathValue.length === 0) {
          throw new ApiError(
            500,
            "server_error",
            "owl-coreプロセスの起動環境にPATHが設定されていません。owl startを実行するシェルの環境変数を確認してください。",
            { field: "PATH" },
          );
        }
        const homeValue = process.env.HOME;
        if (homeValue === undefined || homeValue.length === 0) {
          throw new ApiError(
            500,
            "server_error",
            "owl-coreプロセスの起動環境にHOMEが設定されていません。owl startを実行するシェルの環境変数を確認してください。",
            { field: "HOME" },
          );
        }
        const env = buildAgentEnv(process.env, {
          owlRoot,
          deny: customProviderApiKeyEnvNames(owlRoot),
          extra: guardEnvironment(guard),
        });

        const executablePath = await resolveExecutableForSelection(selection);
        const configurationError = providerConfigurationError(selection, executablePath);
        if (configurationError) {
          throw new ApiError(
            503,
            "dependency_unavailable",
            configurationError,
            { provider: selection.providerId, adapter: selection.adapter, executable: selection.executableEnv },
          );
        }

        const executables = await resolveAgentExecutables(selection, executablePath, pathValue);
        delete env.OWL_CLAUDE_EXECUTABLE;
        delete env.OWL_CODEX_EXECUTABLE;
        if (executables.claude) env.OWL_CLAUDE_EXECUTABLE = executables.claude;
        if (executables.codex) env.OWL_CODEX_EXECUTABLE = executables.codex;

        let model = selection.model;
        const appSettings = new AppSettingsStore(owlRoot, resolveDataDir(owlRoot));
        const providerConfigs: Record<string, { adapter: string; backend_url?: string; api_key_env?: string }> = {};
        // Custom provider keys are handed to the runtime separately so each
        // key reaches only the processes of the provider that uses it.
        const providerApiKeys: Record<string, string> = {};
        const refresh = (): void => {
          for (const providerId of Object.keys(providerConfigs)) delete providerConfigs[providerId];
          for (const envName of Object.keys(providerApiKeys)) delete providerApiKeys[envName];
          const customProviders = new AppSettingsStore(owlRoot, resolveDataDir(owlRoot)).getCustomProviders();
          for (const [providerId, config] of Object.entries(customProviders)) {
            const normalizedId = providerId.trim().toLowerCase();
            if (normalizedId.length === 0) {
              throw new ApiError(503, "dependency_unavailable", "カスタムProvider設定に空のProvider IDがあります。設定を修正してください。", { provider: providerId });
            }
            if (config.harnessId !== "claude" && config.harnessId !== "codex") {
              throw new ApiError(503, "dependency_unavailable", `カスタムProvider ${providerId} のHarness '${config.harnessId}'は未対応です。claudeまたはcodexを指定してください。`, { provider: providerId, harness: config.harnessId });
            }
            const apiKeyEnv = config.apiKeySource?.startsWith("env:")
              ? config.apiKeySource.slice("env:".length)
              : undefined;
            const validApiKeyEnv = apiKeyEnv !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv);
            if (config.apiKeySource !== undefined && !validApiKeyEnv) {
              throw new ApiError(503, "dependency_unavailable", `カスタムProvider ${providerId} のapiKeySourceが不正です。env:VARIABLE_NAME形式を指定してください。`, { provider: providerId });
            }
            if (validApiKeyEnv) {
              delete env[apiKeyEnv];
              if (typeof process.env[apiKeyEnv] === "string") providerApiKeys[apiKeyEnv] = process.env[apiKeyEnv];
            }
            providerConfigs[normalizedId] = {
              adapter: config.harnessId === "codex" ? "codex" : "claude-cli/v1",
              ...(config.backendUrl ? { backend_url: config.backendUrl } : {}),
              ...(validApiKeyEnv ? { api_key_env: apiKeyEnv } : {}),
            };
          }
        };
        refresh();
        refreshProviderSettings = refresh;
        console.log(
          `[agent-runner] selected provider: ${selection.providerId} adapter=${selection.adapter} executable=${executablePath} (model: ${model})`,
        );

        const format =
          process.env.OWL_PROVIDER_FORMAT !== undefined && process.env.OWL_PROVIDER_FORMAT.length > 0
            ? process.env.OWL_PROVIDER_FORMAT
            : "provider-json";
        const configured = runtimeModule.createAgentRunner?.({
          cwd: owlRoot,
          env,
          executablePath,
          model,
          format,
          providers: providerConfigs,
          providerApiKeys,
          adapter: selection.adapter,
          ...(guard ? { guardToken: guard.issueToken } : {}),
        });
        if (!configured || typeof configured !== "object") {
          throw new Error("createAgentRunner did not return a runner");
        }
          delegate = configured as typeof delegate & object;
          if (outputResubmitLimit) {
            (configured as { setOutputResubmitLimit?: (read: () => number) => void }).setOutputResubmitLimit?.(outputResubmitLimit);
          }
          if (planUsageObserver) {
            (configured as {
              setPlanUsageObserver?: (observer: (observation: PlanUsageSnapshot) => void) => void;
            }).setPlanUsageObserver?.(planUsageObserver);
          }
        }
        refreshProviderSettings();
        return delegate;
      } catch (error) {
        throw agentRunnerInitializationError(error);
      }
    };
    return {
      runManagerPlan: async (request: unknown) => (await getDelegate()).runManagerPlan(request),
      runDesigner: async (request: unknown) => (await getDelegate()).runDesigner(request),
      runWorker: async (request: unknown) => (await getDelegate()).runWorker(request),
      runReviewer: async (request: unknown) => (await getDelegate()).runReviewer(request),
      runAdvisor: async (request: unknown) => (await getDelegate()).runAdvisor(request),
      runCurator: async (request: unknown) => {
        const delegateValue = await getDelegate();
        if (typeof delegateValue.runCurator !== "function") return { ok: false, error: "curator_unavailable" };
        return delegateValue.runCurator(request);
      },
      runKeywordExtraction: async (request: unknown) => {
        const delegateValue = await getDelegate();
        if (typeof delegateValue.runKeywordExtraction !== "function") return { ok: false, error: "keyword_extraction_unavailable" };
        return delegateValue.runKeywordExtraction(request);
      },
      runLibrarianOperations: async (request: unknown) => {
        const delegateValue = await getDelegate();
        if (typeof delegateValue.runLibrarianOperations !== "function") return { ok: false, error: "librarian_operations_unavailable" };
        return delegateValue.runLibrarianOperations(request);
      },
      runClippingTags: async (request: unknown) => {
        const delegateValue = await getDelegate();
        if (typeof delegateValue.runClippingTags !== "function") return { ok: false, error: "clipping_tags_unavailable" };
        return delegateValue.runClippingTags(request);
      },
      runRuleJudgments: async (request: unknown) => {
        const delegateValue = await getDelegate();
        if (typeof delegateValue.runRuleJudgments !== "function") return { ok: false, error: "rule_judgments_unavailable" };
        return delegateValue.runRuleJudgments(request);
      },
      runProjectInvestigation: async (request: unknown) => {
        try {
          const delegateValue = await getDelegate();
          if (typeof delegateValue.runProjectInvestigation !== "function") return { ok: false, error: "project_investigation_unavailable" };
          return await delegateValue.runProjectInvestigation(request);
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
          return { ok: false, error: `provider_failed:${message}` };
        }
      },
      cancelAgent: async (invocationId: string, force?: boolean) => (await getDelegate()).cancelAgent?.(invocationId, force),
      setProcessObserver: (observer: (invocationId: string, event: AgentProcessEvent) => void | Promise<void>) => {
        void getDelegate().then((delegateValue) => delegateValue.setProcessObserver?.(observer)).catch(logObserverError("setProcessObserver"));
      },
      setOutputObserver: (observer: (invocationId: string) => void) => {
        void getDelegate().then((delegateValue) => delegateValue.setOutputObserver?.(observer)).catch(logObserverError("setOutputObserver"));
      },
      setOutputResubmitLimit: (read: () => number) => {
        outputResubmitLimit = read;
        void getDelegate().then((delegateValue) => delegateValue.setOutputResubmitLimit?.(read)).catch(logObserverError("setOutputResubmitLimit"));
      },
      setPromptObserver: (observer: PromptObserver | undefined) => {
        void getDelegate().then((delegateValue) => delegateValue.setPromptObserver?.(observer)).catch(logObserverError("setPromptObserver"));
      },
      setPlanUsageObserver: (observer: (observation: PlanUsageSnapshot) => void) => {
        planUsageObserver = observer;
        void getDelegate().then((delegateValue) => delegateValue.setPlanUsageObserver?.(observer)).catch(logObserverError("setPlanUsageObserver"));
      },
      // Lazily initialized like the run* methods above: only resolves once a
      // delegate has actually been constructed, so callers that just want to
      // know whether persistent Advisor sessions are available (Phase 4;
      // packages/core's AdvisorSessionRuntime) can await this without forcing
      // early binary resolution/ApiError surfacing before it is otherwise needed.
      getProvider: async () => (await getDelegate()).provider ?? null,
    };
  } catch (error) {
    throw agentRunnerInitializationError(error);
  }
}
