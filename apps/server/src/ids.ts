import { randomBytes } from "node:crypto";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encodeBase32(value: bigint, length: number): string {
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = `${ULID_ALPHABET[Number(value & 31n)]}${encoded}`;
    value >>= 5n;
  }
  return encoded;
}

export function createUlid(timestamp = Date.now()): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new Error("ULID timestamp is outside the supported range");
  }
  let randomPart = 0n;
  for (const byte of randomBytes(10)) {
    randomPart = (randomPart << 8n) | BigInt(byte);
  }
  const value = `${encodeBase32(BigInt(timestamp), 10)}${encodeBase32(randomPart, 16)}`;
  if (!ULID_PATTERN.test(value)) {
    throw new Error("Generated ULID did not match the contract");
  }
  return value;
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_PATTERN.test(value);
}

export function utcNow(): string {
  return new Date().toISOString();
}
