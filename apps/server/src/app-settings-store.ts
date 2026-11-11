import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { CLAUDE_FABLE_5_2_MODEL, CLAUDE_HAIKU_5_5_MODEL, CLAUDE_OPUS_5_5_MODEL, CLAUDE_SONNET_5_5_MODEL, parseDotEnv } from "@owl/shared";

import { AdvisorFolderError, normalizeAdvisorFolder } from "./advisor-folders.js";
import { legacyDataDir, prepareDataDir, resolveDataDir } from "./contracts.js";
import { isRecord } from "@owl/shared/small-helpers";

export interface CustomProviderConfig {
  displayName: string;
  harnessId: string;
  backendUrl?: string;
  apiKeySource?: string;
}

interface StoredAppSettings {
  hybrid_mode: boolean;
  custom_providers: Record<string, CustomProviderConfig>;
  provider_models: Record<string, string[]>;
  /** Empty, or an env:NAME reference; the key itself lives in the project .env. */
  typesafe_api_key: string;
  advisor_persona: string;
  advisor_shared_dir: string;
  advisor_screenshot_dir: string;
  /** Empty means the default <OWL_ROOT>/knowledge. */
  knowledge_dir: string;
  /** Optional and absent from DEFAULTS: a missing key (use Core's defaults) differs from an explicit []. */
  advisor_send_file_dirs?: string[];
  advisor_send_file_slack_max_bytes?: number;
  advisor_send_file_discord_max_bytes?: number;
  /** Optional and absent from DEFAULTS: a missing key means unset. */
  advisor_send_file_preferred_provider?: FileDestinationProvider;
  advisor_send_file_default_destination?: StoredFileDestination;
}

export type FileDestinationProvider = "slack" | "discord";
export interface StoredFileDestination { provider: FileDestinationProvider; channel_id: string; display_name: string }
export interface FileDestinationSettings {
  preferredProvider: FileDestinationProvider | null;
  defaultDestination: StoredFileDestination | null;
}

const FILE_DESTINATION_PROVIDERS: readonly string[] = ["slack", "discord"];

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

/** Shared by load() and the setter so a value the setter accepts always loads back. */
export function parseFileDestinationSettings(input: { preferredProvider?: unknown; defaultDestination?: unknown }): FileDestinationSettings {
  const { preferredProvider, defaultDestination } = input;
  if (preferredProvider != null && (typeof preferredProvider !== "string" || !FILE_DESTINATION_PROVIDERS.includes(preferredProvider))) {
    throw new Error("advisor_send_file_preferred_provider must be slack or discord");
  }
  if (defaultDestination != null) {
    const d = defaultDestination as Record<string, unknown>;
    const keys = typeof d === "object" && !Array.isArray(d) ? Object.keys(d).sort().join(",") : "";
    if (keys !== "channel_id,display_name,provider"
      || typeof d.provider !== "string" || !FILE_DESTINATION_PROVIDERS.includes(d.provider)
      || !isBoundedString(d.channel_id) || !isBoundedString(d.display_name)) {
      throw new Error("advisor_send_file_default_destination must be {provider, channel_id, display_name} with 1-200 character strings");
    }
  }
  return {
    preferredProvider: (preferredProvider ?? null) as FileDestinationProvider | null,
    defaultDestination: defaultDestination == null ? null : { ...(defaultDestination as StoredFileDestination) },
  };
}

/** The .env variable that holds the Typesafe API key saved from the settings UI. */
const TYPESAFE_API_KEY_ENV = "OWL_TYPESAFE_API_KEY";
const ENV_REFERENCE = /^env:([A-Za-z_][A-Za-z0-9_]*)$/u;

const DEFAULT_PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: [
    CLAUDE_FABLE_5_2_MODEL,
    CLAUDE_OPUS_5_5_MODEL,
    CLAUDE_SONNET_5_5_MODEL,
    CLAUDE_HAIKU_5_5_MODEL,
  ],
  openai: [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ],
};

const DEFAULTS: StoredAppSettings = {
  hybrid_mode: false,
  custom_providers: {},
  provider_models: { ...DEFAULT_PROVIDER_MODELS },
  typesafe_api_key: "",
  advisor_persona: "",
  advisor_shared_dir: "",
  advisor_screenshot_dir: "",
  knowledge_dir: "",
};

function legacyApiKeyEnvName(providerId: string): string {
  const normalized = providerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return `OWL_PROVIDER_${normalized || "CUSTOM"}_API_KEY`;
}

function updateEnvFile(envPath: string, updates: Record<string, string>): void {
  const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = original.length > 0 ? original.split(/\r?\n/u) : [];
  const keys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  const next: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    const key = match?.[2];
    if (!key || !keys.has(key)) {
      next.push(line);
      continue;
    }
    seen.add(key);
    next.push(`${match![1]}${key}=${JSON.stringify(updates[key])}`);
  }

  const additions = Object.entries(updates).filter(([key]) => !seen.has(key));
  if (additions.length > 0) {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    if (next.length > 0) next.push("");
    for (const [key, value] of additions) next.push(`${key}=${JSON.stringify(value)}`);
  }

  const temporaryPath = `${envPath}.tmp`;
  writeFileSync(temporaryPath, `${next.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, envPath);
    chmodSync(envPath, 0o600);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* preserve the original error */ }
    throw error;
  }
}

function persistRawSettings(filePath: string, value: Record<string, unknown>): void {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* preserve the original error */ }
    throw error;
  }
}

function envReferenceName(source: string): string | undefined {
  return ENV_REFERENCE.exec(source)?.[1];
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Replace secrets stored inline in raw settings (a custom-provider
 * apiKeySource or the Typesafe API key) with env:NAME references. Returns the
 * secrets by variable name, or null when the settings hold none.
 */
function extractInlineSecrets(value: Record<string, unknown>): Record<string, string> | null {
  const secrets: Record<string, string> = {};
  let changed = false;
  if (isRecord(value.custom_providers)) {
    const customProviders: Record<string, unknown> = { ...value.custom_providers };
    for (const [providerId, rawConfig] of Object.entries(customProviders)) {
      if (!isRecord(rawConfig) || typeof rawConfig.apiKeySource !== "string") continue;
      const source = rawConfig.apiKeySource.trim();
      if (source.length === 0 || source.startsWith("env:")) continue;
      const envName = legacyApiKeyEnvName(providerId);
      customProviders[providerId] = { ...rawConfig, apiKeySource: `env:${envName}` };
      secrets[envName] = source;
      changed = true;
    }
    if (changed) value.custom_providers = customProviders;
  }
  if (typeof value.typesafe_api_key === "string") {
    const key = value.typesafe_api_key.trim();
    if (key.length > 0 && !key.startsWith("env:")) {
      value.typesafe_api_key = `env:${TYPESAFE_API_KEY_ENV}`;
      secrets[TYPESAFE_API_KEY_ENV] = key;
      changed = true;
    }
  }
  return changed ? secrets : null;
}

function envFileKeys(envPath: string): Set<string> {
  if (!existsSync(envPath)) return new Set();
  return new Set(Object.keys(parseDotEnv(readFileSync(envPath, "utf8"))));
}

/**
 * Put secrets in the project .env and the process environment. A variable the
 * process environment or the .env file already defines keeps its value.
 * Returns the names that were written.
 */
function storeSecretsInEnv(envPath: string, secrets: Record<string, string>): string[] {
  const defined = envFileKeys(envPath);
  const updates = Object.fromEntries(
    Object.entries(secrets).filter(([name]) => !hasOwn(process.env, name) && !defined.has(name)),
  );
  const names = Object.keys(updates);
  if (names.length === 0) return [];
  updateEnvFile(envPath, updates);
  for (const [name, secret] of Object.entries(updates)) process.env[name] = secret;
  return names;
}

/**
 * Settings files keep only env:NAME references to credentials. An inline key
 * found on load moves to the project .env and the file is rewritten.
 */
function migrateInlineSecrets(value: Record<string, unknown>, filePath: string, envPath: string): void {
  const secrets = extractInlineSecrets(value);
  if (secrets === null) return;
  storeSecretsInEnv(envPath, secrets);
  persistRawSettings(filePath, value);
}

function parseSettingsJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's message quotes file content, which may be a credential.
    throw new Error("the file is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("root must be an object");
  return value;
}

export interface LegacySettingsCleanup {
  /** Where the legacy settings file now is. */
  readonly file: string;
  /** Variables written to the project .env (names only). */
  readonly env_names: readonly string[];
}

/**
 * Retire the pre-0.1.0 `.owl-data/app-settings.json`. The data directory gets its
 * copy first, inline credentials move to the project .env, the legacy file is
 * rewritten with env:NAME references (every other setting is kept) and renamed
 * to `app-settings.json.migrated` so it is not copied again. Running it again
 * does nothing. Returns null when there is no legacy file to handle.
 */
export function scrubLegacySettings(owlRoot: string, dataDir = resolveDataDir(owlRoot)): LegacySettingsCleanup | null {
  const legacyDir = legacyDataDir(owlRoot);
  const legacyFile = join(legacyDir, "app-settings.json");
  if (resolve(legacyDir) === resolve(dataDir) || !existsSync(legacyFile)) return null;
  prepareDataDir(owlRoot, dataDir);
  let value: Record<string, unknown>;
  try {
    value = parseSettingsJson(readFileSync(legacyFile, "utf8"));
  } catch (error) {
    throw new Error(`${legacyFile} could not be read (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  const secrets = extractInlineSecrets(value);
  const envNames = secrets === null ? [] : storeSecretsInEnv(join(owlRoot, ".env"), secrets);
  if (secrets !== null) persistRawSettings(legacyFile, value);
  const retired = `${legacyFile}.migrated`;
  if (existsSync(retired)) return { file: legacyFile, env_names: envNames };
  renameSync(legacyFile, retired);
  return { file: retired, env_names: envNames };
}

function parseCustomProviderConfig(id: string, value: unknown): CustomProviderConfig {
  if (!isRecord(value)) throw new Error(`custom_providers.${id} must be an object`);
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) {
    throw new Error(`custom_providers.${id}.displayName must be a non-empty string`);
  }
  if (value.harnessId !== "claude" && value.harnessId !== "codex" && value.harnessId !== "opencode") {
    throw new Error(`custom_providers.${id}.harnessId must be claude, codex or opencode`);
  }
  const config: CustomProviderConfig = {
    displayName: value.displayName,
    harnessId: value.harnessId,
  };
  if (value.backendUrl !== undefined) {
    if (typeof value.backendUrl !== "string") throw new Error(`custom_providers.${id}.backendUrl must be a string`);
    try {
      const parsed = new URL(value.backendUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      throw new Error(`custom_providers.${id}.backendUrl must be an http or https URL`);
    }
    config.backendUrl = value.backendUrl;
  }
  if (value.apiKeySource !== undefined) {
    if (typeof value.apiKeySource !== "string" || !/^env:[A-Za-z_][A-Za-z0-9_]*$/u.test(value.apiKeySource)) {
      throw new Error(`custom_providers.${id}.apiKeySource must use env:VARIABLE_NAME format`);
    }
    config.apiKeySource = value.apiKeySource;
  }
  return config;
}

function parseCustomProviders(value: unknown): Record<string, CustomProviderConfig> {
  if (!isRecord(value)) throw new Error("custom_providers must be an object");
  const result: Record<string, CustomProviderConfig> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    result[id] = parseCustomProviderConfig(id, entry);
  }
  return result;
}

function parseProviderModels(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) throw new Error("provider_models must be an object");
  const result: Record<string, string[]> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string" && item.trim().length > 0)) {
      throw new Error(`provider_models.${id} must be an array of non-empty strings`);
    }
    result[id] = [...entry] as string[];
  }
  return result;
}

const PROVIDER_ID_MIGRATION: Record<string, string> = {
  "openai-codex": "openai",
  "openai-api": "openai",
};

export class AppSettingsStore {
  private readonly filePath: string;
  private readonly envPath: string;
  private settings: StoredAppSettings;

  constructor(owlRoot: string, dataDir = resolveDataDir(owlRoot)) {
    prepareDataDir(owlRoot, dataDir);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filePath = join(dataDir, "app-settings.json");
    this.envPath = join(owlRoot, ".env");
    if (existsSync(this.filePath)) {
      try { chmodSync(this.filePath, 0o600); } catch { /* best effort */ }
    }
    this.settings = this.load();
  }

  private load(): StoredAppSettings {
    if (!existsSync(this.filePath)) {
      return { ...DEFAULTS, custom_providers: {}, provider_models: { ...DEFAULT_PROVIDER_MODELS } };
    }
    try {
      const parsed = parseSettingsJson(readFileSync(this.filePath, "utf8"));
      migrateInlineSecrets(parsed, this.filePath, this.envPath);
      const hybridMode = parsed.hybrid_mode === undefined
        ? DEFAULTS.hybrid_mode
        : typeof parsed.hybrid_mode === "boolean"
          ? parsed.hybrid_mode
          : (() => { throw new Error("hybrid_mode must be a boolean"); })();
      const typesafeApiKey = parsed.typesafe_api_key === undefined
        ? ""
        : parsed.typesafe_api_key === "" || (typeof parsed.typesafe_api_key === "string" && envReferenceName(parsed.typesafe_api_key))
          ? parsed.typesafe_api_key
          : (() => { throw new Error("typesafe_api_key must be empty or use env:VARIABLE_NAME format"); })();
      const advisorPersona = parsed.advisor_persona === undefined
        ? ""
        : typeof parsed.advisor_persona === "string"
          ? parsed.advisor_persona
          : (() => { throw new Error("advisor_persona must be a string"); })();
      const advisorSharedDir = parsed.advisor_shared_dir === undefined ? "" : typeof parsed.advisor_shared_dir === "string" ? parsed.advisor_shared_dir : (() => { throw new Error("advisor_shared_dir must be a string"); })();
      const advisorScreenshotDir = parsed.advisor_screenshot_dir === undefined ? "" : typeof parsed.advisor_screenshot_dir === "string" ? parsed.advisor_screenshot_dir : (() => { throw new Error("advisor_screenshot_dir must be a string"); })();
      const knowledgeDir = parsed.knowledge_dir === undefined ? "" : typeof parsed.knowledge_dir === "string" ? parsed.knowledge_dir : (() => { throw new Error("knowledge_dir must be a string"); })();
      const sendFileDirs = parsed.advisor_send_file_dirs;
      if (sendFileDirs !== undefined && (!Array.isArray(sendFileDirs) || !sendFileDirs.every((entry) => typeof entry === "string"))) {
        throw new Error("advisor_send_file_dirs must be an array of strings");
      }
      const sendFileLimit = (key: "advisor_send_file_slack_max_bytes" | "advisor_send_file_discord_max_bytes"): number | undefined => {
        const value = parsed[key];
        if (value === undefined) return undefined;
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
        throw new Error(`${key} must be an integer of at least 1`);
      };
      const fileDestination = parseFileDestinationSettings({
        preferredProvider: parsed.advisor_send_file_preferred_provider,
        defaultDestination: parsed.advisor_send_file_default_destination,
      });
      return {
        ...(fileDestination.preferredProvider === null ? {} : { advisor_send_file_preferred_provider: fileDestination.preferredProvider }),
        ...(fileDestination.defaultDestination === null ? {} : { advisor_send_file_default_destination: fileDestination.defaultDestination }),
        ...(sendFileDirs === undefined ? {} : { advisor_send_file_dirs: sendFileDirs as string[] }),
        ...(parsed.advisor_send_file_slack_max_bytes === undefined ? {} : { advisor_send_file_slack_max_bytes: sendFileLimit("advisor_send_file_slack_max_bytes") }),
        ...(parsed.advisor_send_file_discord_max_bytes === undefined ? {} : { advisor_send_file_discord_max_bytes: sendFileLimit("advisor_send_file_discord_max_bytes") }),
        hybrid_mode: hybridMode,
        custom_providers: parseCustomProviders(parsed.custom_providers === undefined ? {} : parsed.custom_providers),
        provider_models: this.mergeProviderModels(parseProviderModels(parsed.provider_models === undefined ? {} : parsed.provider_models)),
        typesafe_api_key: typesafeApiKey,
        advisor_persona: advisorPersona,
        advisor_shared_dir: advisorSharedDir,
        advisor_screenshot_dir: advisorScreenshotDir,
        knowledge_dir: knowledgeDir,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`app-settings.json is corrupt or contains invalid settings (${reason}): ${this.filePath}`, { cause: error });
    }
  }

  private save(): void {
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.settings, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  getHybridMode(): boolean {
    return this.settings.hybrid_mode;
  }

  setHybridMode(enabled: boolean): boolean {
    this.settings.hybrid_mode = enabled;
    this.save();
    return enabled;
  }

  /** The Typesafe API key, read from the environment variable the settings reference. */
  getTypesafeApiKey(): string {
    const name = envReferenceName(this.settings.typesafe_api_key);
    return name === undefined ? "" : process.env[name] ?? "";
  }

  /**
   * Save the Typesafe API key to the project .env and keep only a reference in
   * app-settings.json. An empty key clears it.
   */
  setTypesafeApiKey(key: string): string {
    const name = envReferenceName(this.settings.typesafe_api_key) ?? TYPESAFE_API_KEY_ENV;
    if (key.length === 0) {
      if (envFileKeys(this.envPath).has(name)) updateEnvFile(this.envPath, { [name]: "" });
      delete process.env[name];
      this.settings.typesafe_api_key = "";
    } else {
      updateEnvFile(this.envPath, { [name]: key });
      process.env[name] = key;
      this.settings.typesafe_api_key = `env:${name}`;
    }
    this.save();
    return key;
  }

  getAdvisorPersona(): string {
    return this.settings.advisor_persona;
  }

  setAdvisorPersona(persona: string): string {
    this.settings.advisor_persona = persona;
    this.save();
    return persona;
  }

  getAdvisorSharedDir(): string { return this.settings.advisor_shared_dir; }
  setAdvisorSharedDir(path: string): string { this.settings.advisor_shared_dir = path; this.save(); return path; }
  getAdvisorScreenshotDir(): string { return this.settings.advisor_screenshot_dir; }
  setAdvisorScreenshotDir(path: string): string { this.settings.advisor_screenshot_dir = path; this.save(); return path; }

  /** Absent keys stay undefined; dirs that cannot be used are dropped, so an all-invalid list yields [] (send nothing). */
  getAdvisorSendFileSettings(): { dirs?: string[]; slackMaxBytes?: number; discordMaxBytes?: number } {
    const dirs = this.settings.advisor_send_file_dirs?.flatMap((entry) => {
      try {
        const folder = normalizeAdvisorFolder(entry);
        if (folder) return [folder];
      } catch (error) {
        if (!(error instanceof AdvisorFolderError)) throw error;
      }
      console.warn("[owl] Ignoring advisor_send_file_dirs entry that is not an absolute path.");
      return [];
    });
    return { dirs, slackMaxBytes: this.settings.advisor_send_file_slack_max_bytes, discordMaxBytes: this.settings.advisor_send_file_discord_max_bytes };
  }

  getAdvisorFileDestinationSettings(): FileDestinationSettings {
    return parseFileDestinationSettings({
      preferredProvider: this.settings.advisor_send_file_preferred_provider,
      defaultDestination: this.settings.advisor_send_file_default_destination,
    });
  }

  /** null clears a key. Restores the previous values when save() fails. */
  setAdvisorFileDestinationSettings(input: FileDestinationSettings): FileDestinationSettings {
    const next = parseFileDestinationSettings(input);
    const previous = this.getAdvisorFileDestinationSettings();
    const apply = (value: FileDestinationSettings): void => {
      if (value.preferredProvider === null) delete this.settings.advisor_send_file_preferred_provider;
      else this.settings.advisor_send_file_preferred_provider = value.preferredProvider;
      if (value.defaultDestination === null) delete this.settings.advisor_send_file_default_destination;
      else this.settings.advisor_send_file_default_destination = value.defaultDestination;
    };
    apply(next);
    try {
      this.save();
    } catch (error) {
      apply(previous);
      throw error;
    }
    return next;
  }

  getKnowledgeDir(): string { return this.settings.knowledge_dir; }
  /** Core normalizes first; only "" (default) or an absolute path without NUL is stored. */
  setKnowledgeDir(path: string): string {
    if (path !== "" && (!isAbsolute(path) || path.includes("\0"))) throw new Error("knowledge_dir must be empty or an absolute path");
    const previous = this.settings.knowledge_dir;
    this.settings.knowledge_dir = path;
    try {
      this.save();
    } catch (error) {
      this.settings.knowledge_dir = previous;
      throw error;
    }
    return path;
  }

  setAdvisorFolders(sharedDir: string, screenshotDir: string): void {
    this.settings.advisor_shared_dir = sharedDir;
    this.settings.advisor_screenshot_dir = screenshotDir;
    this.save();
  }

  getCustomProviders(): Record<string, CustomProviderConfig> {
    return { ...this.settings.custom_providers };
  }

  saveCustomProvider(id: string, config: CustomProviderConfig): CustomProviderConfig {
    this.settings.custom_providers = { ...this.settings.custom_providers, [id]: { ...config } };
    this.save();
    return { ...config };
  }

  private mergeProviderModels(stored: Record<string, string[]>): Record<string, string[]> {
    const merged: Record<string, string[]> = { ...DEFAULT_PROVIDER_MODELS };
    for (const [id, models] of Object.entries(stored)) {
      const canonicalId = Object.hasOwn(PROVIDER_ID_MIGRATION, id) ? PROVIDER_ID_MIGRATION[id] : id;
      merged[canonicalId] = Object.hasOwn(DEFAULT_PROVIDER_MODELS, canonicalId)
        ? [...new Set([...DEFAULT_PROVIDER_MODELS[canonicalId], ...models])]
        : models;
    }
    return merged;
  }

  getProviderModels(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(this.settings.provider_models).map(([id, models]) => [id, [...models]]),
    );
  }

  setProviderModels(providerId: string, models: string[]): string[] {
    this.settings.provider_models = { ...this.settings.provider_models, [providerId]: [...models] };
    this.save();
    return [...models];
  }

  deleteCustomProvider(id: string): boolean {
    if (!(id in this.settings.custom_providers)) return false;
    const remaining = { ...this.settings.custom_providers };
    delete remaining[id];
    this.settings.custom_providers = remaining;
    this.save();
    return true;
  }
}
