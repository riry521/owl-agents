/**
 * Environment names that carry a custom provider's endpoint and key into a
 * Codex launch. Codex ignores OPENAI_BASE_URL and OPENAI_API_KEY while it is
 * signed in with a ChatGPT account, so a custom provider is selected through
 * a dedicated Codex model provider instead, and the key stays in the child's
 * environment under the name that provider reads.
 */
export const CODEX_PROVIDER_BASE_URL_ENV = "OWL_PROVIDER_CODEX_BASE_URL";
export const CODEX_PROVIDER_API_KEY_ENV = "OWL_PROVIDER_CODEX_API_KEY";

/** Id of the Codex model provider table Owl defines for a custom provider. */
const CODEX_CUSTOM_PROVIDER_ID = "owl_custom";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex `--config` arguments that route a run to the custom provider named by
 * the environment, or none when the environment carries no custom endpoint,
 * in which case Codex keeps using the user's own login.
 */
export function buildCodexCustomProviderArgs(env: Readonly<Record<string, string | undefined>> | undefined): string[] {
  const baseUrl = env?.[CODEX_PROVIDER_BASE_URL_ENV];
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return [];
  const apiKey = env?.[CODEX_PROVIDER_API_KEY_ENV];
  // A provider without a key (a local endpoint) must not name an env_key:
  // Codex fails the run when the named variable is unset.
  const table = [
    `name=${tomlString("owl-custom")}`,
    `base_url=${tomlString(baseUrl)}`,
    ...(typeof apiKey === "string" && apiKey.length > 0 ? [`env_key=${tomlString(CODEX_PROVIDER_API_KEY_ENV)}`] : []),
    `wire_api=${tomlString("responses")}`,
  ].join(",");
  return [
    "--config",
    `model_provider=${tomlString(CODEX_CUSTOM_PROVIDER_ID)}`,
    "--config",
    `model_providers.${CODEX_CUSTOM_PROVIDER_ID}={${table}}`,
  ];
}
