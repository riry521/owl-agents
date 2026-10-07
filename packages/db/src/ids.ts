import { randomBytes } from "node:crypto";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generate a Core-owned, sortable 26-character ULID without an external dependency. */
export function createUlid(nowMs: number = Date.now()): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) {
    throw new RangeError("ULID timestamp is outside the supported range.");
  }

  const randomness = randomBytes(10);
  let value = (BigInt(nowMs) << 80n) | BigInt(`0x${randomness.toString("hex")}`);
  let result = "";
  for (let index = 0; index < 26; index += 1) {
    result = ULID_ALPHABET[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

export function utcNow(): string {
  return new Date().toISOString();
}
