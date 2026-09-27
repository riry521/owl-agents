import { isAbsolute } from "node:path";
import { providerVersionMismatch } from "./errors.js";
import type { AdapterId, ResolvedProvider } from "./types.js";
import { buildAgentPermissionArgs, type AgentPermissionRole } from "@owl/shared";

export interface AdapterArgvTemplate {
  readonly healthSuffix: readonly ["--version"];
  readonly workSuffix: readonly string[];
}
export const ADAPTER_ARGV_TEMPLATES: Readonly<Record<AdapterId, AdapterArgvTemplate>> = {
  "claude-cli/v1": {
    healthSuffix: ["--version"],
    workSuffix: [
      "-p",
      "--output-format",
      "json",
      "--model",
      "<M>",
      "--",
      "<P>",
    ],
  },
  "codex-cli/v1": {
    healthSuffix: ["--version"],
    workSuffix: [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "<M>",
      "--",
      "<P>",
    ],
  },
};

function assertValidatedExecutable(provider: ResolvedProvider): void {
  if (!isAbsolute(provider.executablePath)) {
    throw providerVersionMismatch("argv_executable_not_absolute", provider.adapter);
  }
  if (provider.executablePath.length === 0) {
    throw providerVersionMismatch("argv_executable_empty", provider.adapter);
  }
}

export function buildHealthArgv(provider: ResolvedProvider): string[] {
  assertValidatedExecutable(provider);
  return [provider.executablePath, "--version"];
}

export function buildWorkArgv(
  provider: ResolvedProvider,
  model: string,
  prompt: string,
  guard: { readonly role?: AgentPermissionRole; readonly owlRoot?: string } = {},
): string[] {
  assertValidatedExecutable(provider);
  if (model.length === 0 || prompt.length === 0) {
    throw new TypeError("Provider model and prompt must be non-empty strings.");
  }
  if (provider.adapter === "claude-cli/v1") {
    return [
      provider.executablePath,
      "-p",
      "--output-format",
      "json",
      ...buildAgentPermissionArgs(guard.role ?? "worker", "claude", { owlRoot: guard.owlRoot ?? process.env.OWL_ROOT ?? process.cwd() }),
      "--model",
      model,
      "--",
      prompt,
    ];
  }
  if (provider.adapter === "codex-cli/v1") {
    return [
      provider.executablePath,
      "exec",
      "--json",
      ...buildAgentPermissionArgs(guard.role ?? "worker", "codex", { owlRoot: guard.owlRoot ?? process.env.OWL_ROOT ?? process.cwd() }),
      "--skip-git-repo-check",
      "--model",
      model,
      "--",
      prompt,
    ];
  }
  throw providerVersionMismatch("adapter_not_in_argv_allowlist", provider.adapter);
}
