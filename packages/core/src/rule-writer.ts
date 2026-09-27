import { copyFile, open, readFile, readdir, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { generateUlid, isRuleRole } from "@owl/shared";
import { parseRuleYaml, renderRuleFile, type RuleFile, type RuleRole, type RuleStore } from "./rule-store";

export type RuleWriteErrorCode = "rules_currently_broken" | "duplicate_rule_id" | "managed_file_invalid" | "render_roundtrip_failed" | "rollback_failed";

export class RuleWriteError extends Error {
  public readonly code: RuleWriteErrorCode;
  public readonly details?: Record<string, unknown>;

  public constructor(code: RuleWriteErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RuleWriteError";
    this.code = code;
    this.details = details;
  }
}

export interface RuleWriteInput {
  level: "system" | "role";
  role?: RuleRole;
  id: string;
  text: string;
}

export interface RuleWriteResult {
  path: string;
  generation: number;
}

interface RuleWriterFileHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface RuleWriterFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  open(path: string, flags: string): Promise<RuleWriterFileHandle>;
  copyFile(source: string, destination: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
}

export interface RuleWriterOptions {
  fsImpl?: Partial<RuleWriterFileSystem>;
  logger?: { warn(msg: string, meta?: unknown): void };
}

const NODE_FS: RuleWriterFileSystem = { readFile, writeFile, open, copyFile, rename, unlink, readdir, mkdir };
const MANAGED_DIRECTORIES = ["system", "role"] as const;
const NOOP_LOGGER = { warn: (_msg: string, _meta?: unknown) => {} };

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorFailures(error: unknown): unknown[] {
  if (error !== null && typeof error === "object" && "failures" in error && Array.isArray(error.failures)) {
    return error.failures;
  }
  return [{ reason: errorMessage(error) }];
}

function roundTripDifference(expected: RuleFile, actual: RuleFile, fallbackId: string): { id: string; field: string } | null {
  if (expected.path !== actual.path) return { id: fallbackId, field: "path" };
  if (expected.level !== actual.level) return { id: fallbackId, field: "level" };
  if (!isDeepStrictEqual(expected.role, actual.role)) return { id: fallbackId, field: "role" };
  if (expected.rules.length !== actual.rules.length) return { id: fallbackId, field: "rules.length" };
  const fields = ["id", "kind", "text", "pattern", "mode", "message"] as const;
  for (let index = 0; index < expected.rules.length; index += 1) {
    const expectedRule = expected.rules[index];
    const actualRule = actual.rules[index];
    for (const field of fields) {
      if (!isDeepStrictEqual(expectedRule[field], actualRule[field])) {
        return { id: expectedRule.id || fallbackId, field };
      }
    }
  }
  return isDeepStrictEqual(expected, actual) ? null : { id: fallbackId, field: "rules" };
}

export class RuleWriter {
  private readonly fs: RuleWriterFileSystem;
  private readonly logger: NonNullable<RuleWriterOptions["logger"]>;
  private readonly ready: Promise<void>;
  private pending: Promise<void> = Promise.resolve();

  public constructor(private readonly ruleStore: RuleStore, private readonly rulesDir: string, options: RuleWriterOptions = {}) {
    this.fs = { ...NODE_FS, ...options.fsImpl };
    this.logger = options.logger ?? NOOP_LOGGER;
    this.ready = this.cleanManagedDirectories().catch((error: unknown) => {
      this.logger.warn(`[rule-writer] Could not clean managed rule files: ${errorMessage(error)}`);
    });
  }

  public apply(input: RuleWriteInput): Promise<RuleWriteResult> {
    const queuedInput = { ...input };
    const operation = this.pending.then(() => this.applyOne(queuedInput));
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async cleanManagedDirectories(): Promise<void> {
    for (const directory of MANAGED_DIRECTORIES) {
      const dirPath = join(this.rulesDir, directory);
      let names: string[];
      try {
        names = await this.fs.readdir(dirPath);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      for (const name of names) {
        const path = join(dirPath, name);
        if (name.endsWith(".tmp") || /\.yaml\.bak-.+$/.test(name)) {
          try {
            await this.fs.unlink(path);
          } catch (error) {
            if (!hasErrorCode(error, "ENOENT")) throw error;
          }
        }
      }
    }
  }

  private async applyOne(input: RuleWriteInput): Promise<RuleWriteResult> {
    await this.ready;
    if (input.level !== "system" && input.level !== "role") throw new TypeError("Rule write level must be system or role.");
    if (input.level === "role" && (input.role === undefined || !isRuleRole(input.role))) {
      throw new TypeError("Rule writes at role level require a valid role.");
    }
    if (input.level === "system" && input.role !== undefined) throw new TypeError("System rule writes cannot include a role.");

    const statusError = this.ruleStore.status.error;
    if (statusError !== null) {
      throw new RuleWriteError("rules_currently_broken", "Cannot approve a rule while rules/ has load errors.", {
        failures: statusError.failures,
      });
    }
    const duplicate = this.ruleStore.rules.promptRules.some((rule) => rule.id === input.id)
      || this.ruleStore.rules.blockRules.some((rule) => rule.id === input.id);
    if (duplicate) {
      throw new RuleWriteError("duplicate_rule_id", `Rule id '${input.id}' already exists.`, { id: input.id });
    }

    const directory = input.level === "system" ? "system" : "role";
    const filename = input.level === "system" ? "owl-approved.yaml" : `owl-approved-${input.role}.yaml`;
    const directoryPath = join(this.rulesDir, directory);
    const path = join(directoryPath, filename);
    await this.fs.mkdir(directoryPath, { recursive: true });

    let original: string | null = null;
    try {
      original = await this.fs.readFile(path, "utf8");
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw new RuleWriteError("managed_file_invalid", `Could not read managed rule file '${path}'.`, {
          path,
          reason: errorMessage(error),
        });
      }
    }

    let file: RuleFile;
    if (original === null) {
      file = {
        path,
        level: input.level,
        ...(input.role !== undefined ? { role: input.role } : {}),
        rules: [],
      };
    } else {
      try {
        file = parseRuleYaml(original, path);
      } catch (error) {
        throw new RuleWriteError("managed_file_invalid", `Managed rule file '${path}' is invalid.`, {
          path,
          reason: errorMessage(error),
        });
      }
      if (file.level !== input.level || (input.level === "role" && file.role !== input.role)) {
        throw new RuleWriteError("managed_file_invalid", `Managed rule file '${path}' has the wrong scope.`, {
          path,
          expected_level: input.level,
          expected_role: input.role,
          actual_level: file.level,
          actual_role: file.role,
        });
      }
    }

    const nextFile: RuleFile = {
      ...file,
      rules: [...file.rules, { id: input.id, kind: "instruction", text: input.text }],
    };
    let rendered: string;
    try {
      rendered = renderRuleFile(nextFile);
    } catch (error) {
      throw new RuleWriteError("render_roundtrip_failed", `Could not render rule '${input.id}' without loss.`, {
        id: error !== null && typeof error === "object" && "rule_id" in error ? error.rule_id : input.id,
        field: error !== null && typeof error === "object" && "field" in error ? error.field : "text",
        reason: errorMessage(error),
      });
    }
    try {
      const parsed = parseRuleYaml(rendered, path);
      const difference = roundTripDifference(nextFile, parsed, input.id);
      if (difference !== null) {
        throw new RuleWriteError("render_roundtrip_failed", `Rendered rule file differs at ${difference.field}.`, difference);
      }
    } catch (error) {
      if (error instanceof RuleWriteError) throw error;
      throw new RuleWriteError("render_roundtrip_failed", `Rendered rule file could not be parsed: ${errorMessage(error)}.`, {
        id: input.id,
        field: "rules",
      });
    }

    const extension = extname(filename);
    const basename = filename.slice(0, -extension.length);
    const token = generateUlid();
    const temporaryPath = join(directoryPath, `${basename}.${token}.tmp`);
    const backupPath = original === null ? null : `${path}.bak-${token}`;
    let backupCreated = false;
    try {
      await this.fs.writeFile(temporaryPath, rendered, "utf8");
      await this.syncFile(temporaryPath);
      if (backupPath !== null) {
        await this.fs.copyFile(path, backupPath);
        backupCreated = true;
        await this.syncFile(backupPath);
      }
      await this.fs.rename(temporaryPath, path);
    } catch (error) {
      await this.unlinkQuietly(temporaryPath);
      if (backupCreated && backupPath !== null) await this.unlinkQuietly(backupPath);
      throw error;
    }

    try {
      await this.ruleStore.load();
    } catch (loadError) {
      const failures = errorFailures(loadError);
      try {
        if (backupPath !== null) await this.fs.rename(backupPath, path);
        else await this.fs.unlink(path);
      } catch (rollbackError) {
        throw new RuleWriteError("rollback_failed", `Rule load failed and rollback failed: ${errorMessage(rollbackError)}.`, {
          failures,
          rollback_error: errorMessage(rollbackError),
          backup_path: backupPath,
        });
      }

      try {
        await this.ruleStore.load();
      } catch {
        throw new RuleWriteError("rules_currently_broken", "Rules remain invalid after restoring the managed file.", {
          failures,
          current_error: this.ruleStore.status.error,
        });
      }
      throw new RuleWriteError("rules_currently_broken", "The new rule failed to load and the previous file was restored.", {
        failures,
        restored: true,
      });
    }

    if (backupPath !== null) {
      try {
        await this.fs.unlink(backupPath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) this.logger.warn(`[rule-writer] Could not remove backup '${backupPath}': ${errorMessage(error)}`);
      }
    }
    return { path, generation: this.ruleStore.status.generation };
  }

  private async syncFile(path: string): Promise<void> {
    const handle = await this.fs.open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async unlinkQuietly(path: string): Promise<void> {
    try {
      await this.fs.unlink(path);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) this.logger.warn(`[rule-writer] Could not remove temporary file '${path}': ${errorMessage(error)}`);
    }
  }
}
