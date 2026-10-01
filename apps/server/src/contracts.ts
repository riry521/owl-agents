import { cliText } from "./cli-language.js";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "./config.js";
import { ContractValidationError } from "./errors.js";

export const CONTRACT_VERSION = "1.0.0" as const;
export const WS_PROTOCOL_VERSION = "owl-ws-1" as const;

export interface ContractArtifact {
  path: string;
  role: string;
  version: string;
  sha256: string;
  openapi_version?: string;
  schema_dialect?: string;
}

export interface ContractManifest {
  manifest_version: string;
  contract_version: string;
  artifacts: ContractArtifact[];
}

export function serverPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function defaultOwlRoot(): string {
  return resolve(serverPackageRoot(), "../..");
}

export function resolveOwlRoot(): string {
  const configured = process.env.OWL_ROOT;
  const root = configured ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured)) : defaultOwlRoot();
  if (!isAbsolute(root)) {
    throw new ContractValidationError(cliText('OWL_ROOT は絶対パスで指定してください。', 'Set OWL_ROOT to an absolute path.'));
  }
  return resolve(root);
}

export function resolveDataDir(owlRoot: string): string {
  const configured = process.env.OWL_DATA_DIR;
  if (!configured) {
    return join(owlRoot, "data");
  }
  return isAbsolute(configured) ? resolve(configured) : resolve(owlRoot, configured);
}

/** The pre-v1 connector/settings location used by older checkouts. */
export function legacyDataDir(owlRoot: string): string {
  return join(owlRoot, ".owl-data");
}

/**
 * Make the selected data directory the single canonical home for durable
 * runtime files. Only missing known files are copied from the legacy store;
 * existing canonical files and the legacy source are never overwritten or
 * deleted.
 */
export function prepareDataDir(owlRoot: string, dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch { /* best effort on filesystems without chmod */ }

  const legacy = legacyDataDir(owlRoot);
  if (resolve(legacy) === resolve(dataDir) || !existsSync(legacy)) return;
  try { chmodSync(legacy, 0o700); } catch { /* best effort */ }
  for (const name of ["secrets.json", "integrations-meta.json", "app-settings.json"]) {
    const source = join(legacy, name);
    const target = join(dataDir, name);
    if (existsSync(source)) {
      try { chmodSync(source, 0o600); } catch { /* best effort */ }
    }
    if (existsSync(target)) {
      try { chmodSync(target, 0o600); } catch { /* best effort */ }
      continue;
    }
    if (!existsSync(source)) continue;
    try {
      copyFileSync(source, target);
      try { chmodSync(target, 0o600); } catch { /* best effort */ }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
    }
  }
}

export function resolveWebOut(owlRoot: string): string {
  const configured = process.env.OWL_WEB_OUT;
  return configured
    ? (isAbsolute(configured) ? resolve(configured) : resolve(owlRoot, configured))
    : join(owlRoot, "apps/web/out");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new ContractValidationError(cliText(`契約JSONを読み込めませんでした: ${path}`, `Could not read contract JSON: ${path}`), { cause: error });
  }
  if (!isObject(value)) {
    throw new ContractValidationError(cliText(`契約JSONのルートがobjectではありません: ${path}`, `The contract JSON root is not an object: ${path}`));
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertWithinRoot(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (relativePath === ".." || relativePath.startsWith(".." + "/") || isAbsolute(relativePath)) {
    throw new ContractValidationError(cliText(`契約artifactのpathがOWL_ROOT外です: ${candidate}`, `The contract artifact path is outside OWL_ROOT: ${candidate}`));
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ContractValidationError(cliText(`契約artifactを読めませんでした: ${path}`, `Could not read contract artifact: ${path}`), { cause: error });
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractValidationError(cliText(`契約manifestの${label}が不正です。`, `The contract manifest ${label} is invalid.`));
  }
  return value;
}

export async function validateContractArtifacts(owlRoot: string): Promise<ContractManifest> {
  const manifestPath = join(owlRoot, "contracts/contract-manifest-v1.json");
  const manifestValue = parseJson(await readText(manifestPath), manifestPath);
  const manifestVersion = requireString(manifestValue.manifest_version, "manifest_version");
  const contractVersion = requireString(manifestValue.contract_version, "contract_version");
  if (manifestVersion !== CONTRACT_VERSION || contractVersion !== CONTRACT_VERSION) {
    throw new ContractValidationError(cliText('契約manifestのversionがサーバーの対応versionと一致しません。', 'The contract manifest version is not supported by the server.'));
  }
  if (!Array.isArray(manifestValue.artifacts) || manifestValue.artifacts.length === 0) {
    throw new ContractValidationError(cliText('契約manifestにartifactがありません。', 'The contract manifest contains no artifacts.'));
  }

  const seen = new Set<string>();
  const artifacts: ContractArtifact[] = [];
  for (const rawArtifact of manifestValue.artifacts) {
    if (!isObject(rawArtifact)) {
      throw new ContractValidationError(cliText('契約manifestのartifact行がobjectではありません。', 'A contract manifest artifact entry is not an object.'));
    }
    const artifactPath = requireString(rawArtifact.path, "artifact.path");
    const role = requireString(rawArtifact.role, "artifact.role");
    const version = requireString(rawArtifact.version, "artifact.version");
    if (version !== CONTRACT_VERSION) {
      throw new ContractValidationError(cliText(`契約artifactのversionが不正です: ${artifactPath}`, `The contract artifact version is invalid: ${artifactPath}`));
    }
    if (seen.has(artifactPath)) {
      throw new ContractValidationError(cliText(`契約artifactが重複しています: ${artifactPath}`, `Duplicate contract artifact: ${artifactPath}`));
    }
    seen.add(artifactPath);
    const absolutePath = resolve(owlRoot, artifactPath);
    assertWithinRoot(owlRoot, absolutePath);
    const text = await readText(absolutePath);
    if (role === "rest_ws") {
      if (!text.includes("openapi: 3.1.0") || !text.includes("x-contract-version: 1.0.0")) {
        throw new ContractValidationError(cliText('OpenAPI artifactのversionまたはdialectが不正です。', 'The OpenAPI artifact version or dialect is invalid.'));
      }
    } else {
      const schema = parseJson(text, absolutePath);
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new ContractValidationError(cliText(`JSON Schemaのdialectが不正です: ${artifactPath}`, `The JSON Schema dialect is invalid: ${artifactPath}`));
      }
    }
    artifacts.push({
      path: artifactPath,
      role,
      version,
      sha256: sha256(text),
      ...(typeof rawArtifact.openapi_version === "string" ? { openapi_version: rawArtifact.openapi_version } : {}),
      ...(typeof rawArtifact.schema_dialect === "string" ? { schema_dialect: rawArtifact.schema_dialect } : {}),
    });
  }

  const hasOpenApi = artifacts.some((artifact) => artifact.role === "rest_ws" && artifact.path === "contracts/openapi/owl-api-v1.yaml");
  if (!hasOpenApi) {
    throw new ContractValidationError(cliText('正本OpenAPI artifactがmanifestにありません。', 'The canonical OpenAPI artifact is missing from the manifest.'));
  }
  return { manifest_version: manifestVersion, contract_version: contractVersion, artifacts };
}

export async function assertStaticExport(webOut: string): Promise<void> {
  try {
    const stat = await import("node:fs/promises").then(({ stat }) => stat(webOut));
    if (!stat.isDirectory()) {
      throw new Error("not a directory");
    }
    const indexStat = await import("node:fs/promises").then(({ stat }) => stat(join(webOut, "index.html")));
    if (!indexStat.isFile()) {
      throw new Error("index.html is missing");
    }
  } catch (error) {
    throw new ContractValidationError(cliText('apps/web/out の静的exportが利用できません。ビルド成果物を用意してください。', 'The apps/web/out static export is unavailable. Build the web assets.'), { cause: error });
  }
}
