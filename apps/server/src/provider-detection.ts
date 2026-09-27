// Provider detection: determines which configured providers are currently available on this system.
import { execFileSync } from "node:child_process";

export interface DetectedProviderInfo {
  id: string;
  displayName: string;
  harnessId: string;
  available: boolean;
  detail: string | null;
  isBuiltin: boolean;
  backendUrl?: string;
  apiKeySource?: string;
  apiKeyConfigured?: boolean;
  apiKeyLast4?: string;
}

export interface BuiltinProviderInfo {
  id: string;
  displayName: string;
  harnessId: string;
  apiKeySource?: string;
}

export interface BuiltinHarnessInfo {
  id: string;
  binaryName?: string;
}

export interface CustomProviderInfo {
  displayName: string;
  harnessId: string;
  backendUrl?: string;
  apiKeySource?: string;
}

function resolveEnvApiKeySource(apiKeySource: string | undefined): { available: boolean; detail: string | null } {
  if (!apiKeySource || !apiKeySource.startsWith("env:")) {
    return { available: false, detail: null };
  }
  const varName = apiKeySource.slice(4);
  const available = Boolean(process.env[varName]);
  return { available, detail: available ? "API key configured" : null };
}

function detectCliAvailability(binaryName: string): { available: boolean; detail: string | null } {
  try {
    const path = execFileSync("which", [binaryName], { encoding: "utf8" }).trim();
    return path.length > 0 ? { available: true, detail: path } : { available: false, detail: null };
  } catch {
    return { available: false, detail: null };
  }
}

export function detectProviders(
  builtinProviders: readonly BuiltinProviderInfo[],
  builtinHarnesses: readonly BuiltinHarnessInfo[],
  customProviders: Record<string, CustomProviderInfo>,
): DetectedProviderInfo[] {
  const results: DetectedProviderInfo[] = [];

  for (const provider of builtinProviders) {
    const harness = builtinHarnesses.find((candidate) => candidate.id === provider.harnessId);
    let available = false;
    let detail: string | null = null;

    if (harness?.binaryName) {
      ({ available, detail } = detectCliAvailability(harness.binaryName));
    } else if (provider.apiKeySource) {
      ({ available, detail } = resolveEnvApiKeySource(provider.apiKeySource));
    } else {
      available = true;
    }

    results.push({
      id: provider.id,
      displayName: provider.displayName,
      harnessId: provider.harnessId,
      available,
      detail,
      isBuiltin: true,
    });
  }

  for (const [id, config] of Object.entries(customProviders)) {
    const harness = builtinHarnesses.find((candidate) => candidate.id === config.harnessId);
    let available = false;
    let detail: string | null = null;

    if (harness?.binaryName) {
      ({ available, detail } = detectCliAvailability(harness.binaryName));
    } else {
      ({ available, detail } = resolveEnvApiKeySource(config.apiKeySource));
    }
    const keyEnvName = config.apiKeySource?.startsWith("env:") ? config.apiKeySource.slice(4) : undefined;
    const apiKey = keyEnvName ? process.env[keyEnvName] : undefined;

    results.push({
      id,
      displayName: config.displayName,
      harnessId: config.harnessId,
      available,
      detail,
      isBuiltin: false,
      backendUrl: config.backendUrl,
      apiKeySource: config.apiKeySource,
      apiKeyConfigured: Boolean(apiKey),
      ...(apiKey && apiKey.length >= 4 ? { apiKeyLast4: apiKey.slice(-4) } : {}),
    });
  }

  return results;
}
