import { cliLanguage } from "./cli-language.js";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { OPENCODE_EXECUTABLE_ENV, builtinProviderHarness, DEFAULT_HARNESS_MODELS, type ModelHarness } from "@owl/shared";

import { AppSettingsStore } from "./app-settings-store.js";
import { providerMode } from "./config.js";
import { resolveDataDir } from "./contracts.js";
import { renderMessage } from "./errors.js";
import type { MessageRef } from "./messages/define.js";
import { ProviderSelectionMessages as M } from "./messages/provider-selection.js";

export type ProviderHarness = ModelHarness;

const HARNESS_LAUNCH = {
  claude: { adapter: "claude-cli/v1", executableEnv: "OWL_CLAUDE_EXECUTABLE" },
  codex: { adapter: "codex-cli/v1", executableEnv: "OWL_CODEX_EXECUTABLE" },
  opencode: { adapter: "opencode-serve/v1", executableEnv: OPENCODE_EXECUTABLE_ENV },
} as const satisfies Record<ProviderHarness, { adapter: string; executableEnv: string }>;

export interface ProviderSelection {
  readonly mode: "stub" | "real" | "invalid";
  readonly providerId: string;
  readonly harness: ProviderHarness | null;
  readonly adapter: typeof HARNESS_LAUNCH[ProviderHarness]["adapter"] | null;
  readonly executableEnv: typeof HARNESS_LAUNCH[ProviderHarness]["executableEnv"] | null;
  readonly binaryName: ProviderHarness | null;
  readonly model: string;
  readonly source: string;
}


function harnessForAdapter(value: string | undefined): ProviderHarness | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "claude" || normalized === "claude-cli/v1") return "claude";
  if (normalized === "codex" || normalized === "codex-cli/v1") return "codex";
  if (normalized === "opencode" || normalized === HARNESS_LAUNCH.opencode.adapter) return "opencode";
  return null;
}

function harnessForProviderId(providerId: string, customHarnessId?: string): ProviderHarness | null {
  const custom = harnessForAdapter(customHarnessId);
  if (custom) return custom;
  return builtinProviderHarness(providerId);
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
  // opencode has no default model: its model ids are provider/model pairs the user's opencode setup defines.
  const model = process.env.OWL_PROVIDER_MODEL?.trim()
    || (explicitHarness === "opencode" ? "" : DEFAULT_HARNESS_MODELS[explicitHarness]);
  const { adapter, executableEnv } = HARNESS_LAUNCH[explicitHarness];
  return {
    mode,
    providerId: configuredProviderId,
    harness: explicitHarness,
    adapter,
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

/** Why the selected Provider cannot start, as a message-table row; null when it can. */
export function providerConfigurationIssue(selection: ProviderSelection, executable?: string): MessageRef | null {
  if (selection.mode === "invalid") return M.modeInvalid();
  if (selection.mode === "stub") return null;
  if (!selection.harness || !selection.adapter || !selection.executableEnv || !selection.binaryName) {
    return process.env.OWL_PROVIDER_ADAPTER?.trim() ? M.adapterInvalid() : M.adapterUnresolved();
  }
  if (selection.harness === "opencode" && !selection.model) return M.opencodeModelMissing();
  const configured = providerExecutableFromEnvironment(selection);
  if (configured && !isAbsolute(configured)) return M.executableNotAbsolute({ env: selection.executableEnv });
  if (!executable) {
    return M.executableMissing({ harness: selection.harness, adapter: selection.adapter, env: selection.executableEnv, binary: selection.binaryName });
  }
  return null;
}

/** The same issue as text in the CLI language, for the CLI and setup. */
export function providerConfigurationError(selection: ProviderSelection, executable?: string): string | null {
  const issue = providerConfigurationIssue(selection, executable);
  return issue === null ? null : renderMessage(issue, cliLanguage());
}
