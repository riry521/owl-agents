import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { prepareDataDir } from "./contracts.js";
import { IntegrationStore } from "./integration-store.js";

function hasLegacyEncryptedEntries(dataDir: string): boolean {
  const path = join(dataDir, "secrets.json");
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * Connector credentials are loaded from the mode-0600 project .env file.
 * Keep this compatibility hook because the server still calls it before
 * startup; it deliberately never prompts for the legacy vault passphrase.
 * When an old passphrase is explicitly present, IntegrationStore migrates
 * any recoverable legacy entries to .env once.
 */
export async function prepareConnectorConfig(owlRoot: string, dataDir: string): Promise<void> {
  prepareDataDir(owlRoot, dataDir);
  if (process.env.OWL_SECRET_PASSPHRASE?.trim()) {
    new IntegrationStore(owlRoot, dataDir);
  }
}

/** Used by doctor without prompting or returning secret material. */
export function connectorConfigStatus(owlRoot: string, dataDir: string): { configured: boolean; accessible: boolean; legacy: boolean } {
  prepareDataDir(owlRoot, dataDir);
  try {
    const store = new IntegrationStore(owlRoot, dataDir);
    const configured = store.list().some((integration) => integration.configured);
    const accessible = store.list()
      .filter((integration) => integration.configured)
      .every((integration) => store.getConfig(integration.provider) !== null);
    return { configured, accessible, legacy: hasLegacyEncryptedEntries(dataDir) };
  } catch {
    // A malformed metadata file means the user had connector state, so keep
    // it visible to doctor. A missing metadata file is still the ordinary
    // unconfigured state even if a legacy vault happens to be present.
    return {
      configured: existsSync(join(dataDir, "integrations-meta.json")),
      accessible: false,
      legacy: hasLegacyEncryptedEntries(dataDir),
    };
  }
}
