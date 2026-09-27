import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;

export interface SecretEntry {
  readonly key: string;
  readonly encrypted: string;
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export class SecretStore {
  private readonly vaultPath: string;
  private secrets: Map<string, SecretEntry> = new Map();

  constructor(dataDir: string) {
    this.vaultPath = join(dataDir, "secrets.json");
  }

  load(): void {
    if (!existsSync(this.vaultPath)) {
      this.secrets = new Map();
      return;
    }
    const raw = readFileSync(this.vaultPath, "utf8");
    const entries = JSON.parse(raw) as SecretEntry[];
    this.secrets = new Map(entries.map((e) => [e.key, e]));
  }

  private save(): void {
    const dir = join(this.vaultPath, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.vaultPath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify([...this.secrets.values()], null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.vaultPath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* preserve the original error */ }
      throw error;
    }
    try {
      chmodSync(this.vaultPath, 0o600);
    } catch (error) {
      console.warn(
        `[owl-core] Failed to set secret vault permissions on ${this.vaultPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  set(key: string, value: string, passphrase: string): void {
    const salt = randomBytes(SALT_LENGTH);
    const derivedKey = scryptSync(passphrase, salt, KEY_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const now = new Date().toISOString();

    const entry: SecretEntry = {
      key,
      encrypted: encrypted.toString("base64"),
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      created_at: this.secrets.get(key)?.created_at ?? now,
      updated_at: now,
    };

    this.secrets.set(key, entry);
    this.save();
  }

  get(key: string, passphrase: string): string | null {
    const entry = this.secrets.get(key);
    if (!entry) return null;

    const derivedKey = scryptSync(passphrase, Buffer.from(entry.salt, "base64"), KEY_LENGTH);
    const decipher = createDecipheriv(
      ALGORITHM,
      derivedKey,
      Buffer.from(entry.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    let decrypted: Buffer;
    try {
      decrypted = Buffer.concat([
        decipher.update(Buffer.from(entry.encrypted, "base64")),
        decipher.final(),
      ]);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === "ERR_OSSL_BAD_DECRYPT") {
        throw new Error("Failed to decrypt: incorrect passphrase or corrupted data");
      }
      throw error;
    }
    return decrypted.toString("utf8");
  }

  has(key: string): boolean {
    return this.secrets.has(key);
  }

  delete(key: string): boolean {
    const existed = this.secrets.delete(key);
    if (existed) this.save();
    return existed;
  }

  listKeys(): string[] {
    return [...this.secrets.keys()];
  }
}
