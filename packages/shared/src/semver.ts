export interface Semver {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly prerelease: readonly (string | bigint)[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((identifier) => /^\d+$/u.test(identifier) ? BigInt(identifier) : identifier)
    : [];
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

export function compareSemver(left: Semver, right: Semver): number {
  for (const [a, b] of [[left.major, right.major], [left.minor, right.minor], [left.patch, right.patch]] as const) {
    if (a !== b) return a > b ? 1 : -1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    if (typeof a === "bigint" && typeof b === "bigint") return a > b ? 1 : -1;
    if (typeof a === "bigint") return -1;
    if (typeof b === "bigint") return 1;
    return a > b ? 1 : -1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length > right.prerelease.length ? 1 : -1;
}

export interface ClaudePluginEntry {
  readonly scope: string;
  readonly installPath: string;
  readonly version: string;
}

export function compareClaudeEntries(left: ClaudePluginEntry, right: ClaudePluginEntry): number {
  const leftUser = left.scope === "user" ? 1 : 0;
  const rightUser = right.scope === "user" ? 1 : 0;
  if (leftUser !== rightUser) return leftUser - rightUser;
  const leftVersion = parseSemver(left.version);
  const rightVersion = parseSemver(right.version);
  if (leftVersion && rightVersion) return compareSemver(leftVersion, rightVersion);
  if (leftVersion || rightVersion) return leftVersion ? 1 : -1;
  return 0;
}
