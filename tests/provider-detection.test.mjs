import assert from "node:assert/strict";
import { test } from "node:test";

import { detectProviders } from "../apps/server/dist/provider-detection.js";

test("custom provider list includes saved URL and key source, but never the key", () => {
  const envName = "OWL_TEST_CUSTOM_PROVIDER_KEY";
  const previous = process.env[envName];
  process.env[envName] = "test-secret-value";
  try {
    const providers = detectProviders([], [], {
      example: {
        displayName: "Example",
        harnessId: "codex",
        backendUrl: "https://example.test/v1",
        apiKeySource: `env:${envName}`,
      },
    });
    assert.equal(providers[0].backendUrl, "https://example.test/v1");
    assert.equal(providers[0].apiKeySource, `env:${envName}`);
    assert.equal(providers[0].apiKeyConfigured, true);
    assert.equal(providers[0].apiKeyLast4, "alue");
    assert.equal(JSON.stringify(providers).includes("test-secret-value"), false);

    delete process.env[envName];
    const missingKeyProvider = detectProviders([], [], {
      example: { displayName: "Example", harnessId: "codex", apiKeySource: `env:${envName}` },
    })[0];
    assert.equal(missingKeyProvider.apiKeyConfigured, false);
    assert.equal(missingKeyProvider.apiKeyLast4, undefined);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});
