import { cliText } from "./cli-language.js";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { DEFAULT_HARNESS_MODELS } from "../../../packages/shared/dist/index.js";

import { AppSettingsStore } from "./app-settings-store.js";
import { providerMode } from "./config.js";
import { resolveDataDir } from "./contracts.js";

export type ProviderHarness = "claude" | "codex";

export interface ProviderSelection {
  readonly mode: "stub" | "real" | "invalid";
  readonly providerId: string;
  readonly harness: ProviderHarness | null;
  readonly adapter: "claude-cli/v1" | "codex-cli/v1" | null;
  readonly executableEnv: "OWL_CLAUDE_EXECUTABLE" | "OWL_CODEX_EXECUTABLE" | null;
  readonly binaryName: "claude" | "codex" | null;
  readonly model: string;
  readonly source: string;
}


function harnessForAdapter(value: string | undefined): ProviderHarness | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "claude" || normalized === "claude-cli/v1") return "claude";
  if (normalized === "codex" || normalized === "codex-cli/v1") return "codex";
  return null;
}

function harnessForProviderId(providerId: string, customHarnessId?: string): ProviderHarness | null {
  const custom = harnessForAdapter(customHarnessId);
  if (custom) return custom;
  const normalized = providerId.trim().toLowerCase();
  if (normalized === "codex" || normalized === "openai" || normalized === "openai/codex") return "codex";
  if (normalized === "claude" || normalized === "anthropic") return "claude";
  return null;
}

export function providerSelection(owlRoot: string): ProviderSelection {
  const mode = providerMode();
  if (mode === "stub") {
    return {
      mode,
      providerId: "stub",
      harness: null,
      adapter: null,
      executableEnv: null,
      binaryName: null,
      model: "stub",
      source: "OWL_PROVIDER=stub",
    };
  }
  if (mode === "invalid") {
    return {
      mode,
      providerId: process.env.OWL_PROVIDER?.trim() || "",
      harness: null,
      adapter: null,
      executableEnv: null,
      binaryName: null,
      model: "",
      source: "OWL_PROVIDER",
    };
  }

  const dataDir = resolveDataDir(owlRoot);
  const settings = new AppSettingsStore(owlRoot, dataDir);
  const configuredProviderId = process.env.OWL_PROVIDER_ID?.trim()
    || "claude";
  const customProviders = settings.getCustomProviders();
  const custom = customProviders[configuredProviderId]
    ?? customProviders[configuredProviderId.toLowerCase()];
  const rawAdapter = process.env.OWL_PROVIDER_ADAPTER?.trim();
  const explicitProviderId = process.env.OWL_PROVIDER_ID?.trim();
  const explicitAdapter = harnessForAdapter(process.env.OWL_PROVIDER_ADAPTER);
  const explicitClaude = process.env.OWL_CLAUDE_EXECUTABLE?.trim();
  const explicitCodex = process.env.OWL_CODEX_EXECUTABLE?.trim();
  const legacyExecutable = process.env.OWL_PROVIDER_EXECUTABLE?.trim();
  const configuredHarness = custom
    ? harnessForAdapter(custom.harnessId)
    : harnessForProviderId(configuredProviderId);
  const explicitHarness = rawAdapter && !explicitAdapter
    ? null
    : explicitAdapter
    ?? (explicitClaude && !explicitCodex ? "claude" : explicitCodex && !explicitClaude ? "codex" : null)
    ?? configuredHarness
    // A legacy executable only selects Claude when the configured logical
    // provider is otherwise the built-in Claude provider. It must not mask a
    // misspelled/unsupported provider in app-settings.json.
    ?? (explicitProviderId ? null : legacyExecutable && (configuredProviderId === "claude" || configuredProviderId === "anthropic") ? "claude" : null);
  if (!explicitHarness) {
    return {
      mode,
      providerId: configuredProviderId,
      harness: null,
      adapter: null,
      executableEnv: null,
      binaryName: null,
      model: "",
      source: rawAdapter ? "OWL_PROVIDER_ADAPTER" : "OWL_PROVIDER_ID",
    };
  }
  const model = process.env.OWL_PROVIDER_MODEL?.trim()
    || DEFAULT_HARNESS_MODELS[explicitHarness];
  const executableEnv = explicitHarness === "claude" ? "OWL_CLAUDE_EXECUTABLE" : "OWL_CODEX_EXECUTABLE";
  return {
    mode,
    providerId: configuredProviderId,
    harness: explicitHarness,
    adapter: explicitHarness === "claude" ? "claude-cli/v1" : "codex-cli/v1",
    executableEnv,
    binaryName: explicitHarness,
    model,
    source: explicitAdapter
      ? "OWL_PROVIDER_ADAPTER"
      : process.env.OWL_PROVIDER_ID
        ? "OWL_PROVIDER_ID"
        : custom
          ? "custom provider settings"
          : "executor settings",
  };
}

export function providerExecutableFromEnvironment(selection: ProviderSelection): string | undefined {
  if (!selection.executableEnv) return undefined;
  const configured = process.env[selection.executableEnv]?.trim();
  if (configured) return configured;
  if (selection.harness === "claude") return process.env.OWL_PROVIDER_EXECUTABLE?.trim() || undefined;
  return undefined;
}

export async function resolveExecutableForSelection(selection: ProviderSelection): Promise<string | undefined> {
  if (!selection.binaryName) return undefined;
  const configured = providerExecutableFromEnvironment(selection);
  if (configured) return isAbsolute(configured) ? configured : undefined;
  const pathValue = process.env.PATH;
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    const candidate = resolve(join(directory, selection.binaryName));
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep checking the next PATH component.
    }
  }
  return undefined;
}

export function providerConfigurationError(selection: ProviderSelection, executable?: string): string | null {
  if (selection.mode === "invalid") {
    return cliText('OWL_PROVIDERはstubまたはrealのいずれかを指定してください。', 'Set OWL_PROVIDER to stub or real.');
  }
  if (selection.mode === "stub") return null;
  if (!selection.harness || !selection.adapter || !selection.executableEnv || !selection.binaryName) {
    return process.env.OWL_PROVIDER_ADAPTER?.trim()
      ? cliText('OWL_PROVIDER_ADAPTERはclaude-cli/v1またはcodex-cli/v1で指定してください。', 'Set OWL_PROVIDER_ADAPTER to claude-cli/v1 or codex-cli/v1.')
      : cliText('real providerのadapter設定を解決できません。OWL_PROVIDER_ADAPTER=claude-cli/v1またはcodex-cli/v1を指定してください。', 'Could not resolve the real Provider adapter. Set OWL_PROVIDER_ADAPTER to claude-cli/v1 or codex-cli/v1.');
  }
  const configured = providerExecutableFromEnvironment(selection);
  if (configured && !isAbsolute(configured)) {
    return cliText(`${selection.executableEnv}は絶対パスで指定してください。`, `Set ${selection.executableEnv} to an absolute path.`);
  }
  if (!executable) {
    return cliText(`${selection.harness} provider (${selection.adapter}) が必要です。${selection.executableEnv}へ絶対パスを指定するか、${selection.binaryName}をPATHへ追加してください。Owlはprovider CLIを自動インストールしません。`, `The ${selection.harness} Provider (${selection.adapter}) is required. Set ${selection.executableEnv} to an absolute path or add ${selection.binaryName} to PATH. Owl does not install Provider CLIs.`);
  }
  return null;
}
