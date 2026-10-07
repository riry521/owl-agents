import { lookup as dnsLookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

export interface OutboundPolicy {
  readonly allowed_hosts: readonly string[];
  readonly blocked_hosts: readonly string[];
  readonly log_all: boolean;
}

export interface OutboundAuditEntry {
  readonly timestamp: string;
  readonly agent_run_id: string | null;
  readonly url: string;
  readonly method: string;
  readonly allowed: boolean;
  readonly rule: string;
}

const DEFAULT_POLICY: OutboundPolicy = {
  allowed_hosts: [],
  blocked_hosts: [],
  log_all: true,
};

export class OutboundGuard {
  private policy: OutboundPolicy = DEFAULT_POLICY;
  private readonly auditLog: OutboundAuditEntry[] = [];
  private readonly configPath: string;

  constructor(owlRoot: string) {
    this.configPath = join(owlRoot, "rules", "system", "outbound.yaml");
  }

  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.configPath, "utf8");
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        this.policy = DEFAULT_POLICY;
        return;
      }
      throw error;
    }

    this.policy = parseOutboundPolicy(raw, this.configPath);
  }

  checkUrl(url: string, agentRunId: string | null = null, method = "GET"): { allowed: boolean; rule: string } {
    let hostname: string;
    try {
      hostname = normalizeHost(new URL(url).hostname);
    } catch {
      const entry: OutboundAuditEntry = {
        timestamp: new Date().toISOString(),
        agent_run_id: agentRunId,
        url,
        method,
        allowed: false,
        rule: "invalid_url",
      };
      this.auditLog.push(entry);
      return { allowed: false, rule: "invalid_url" };
    }

    if (this.policy.blocked_hosts.some((h) => matchesHost(hostname, h))) {
      this.record(url, method, agentRunId, false, "blocked_host");
      return { allowed: false, rule: "blocked_host" };
    }

    if (isInternalHostname(hostname)) {
      this.record(url, method, agentRunId, false, "internal_address");
      return { allowed: false, rule: "internal_address" };
    }

    if (this.policy.allowed_hosts.length > 0) {
      const onList = this.policy.allowed_hosts.some((h) => matchesHost(hostname, h));
      if (!onList) {
        this.record(url, method, agentRunId, false, "not_on_allowlist");
        return { allowed: false, rule: "not_on_allowlist" };
      }
    }

    this.record(url, method, agentRunId, true, "allowed");
    return { allowed: true, rule: "allowed" };
  }

  /** checkUrl, plus a DNS lookup so a name that resolves to an internal address is refused too. */
  async checkUrlResolved(
    url: string,
    agentRunId: string | null = null,
    method = "GET",
    resolve: (hostname: string) => Promise<readonly string[]> = resolveAddresses,
  ): Promise<{ allowed: boolean; rule: string }> {
    const result = this.checkUrl(url, agentRunId, method);
    if (!result.allowed) return result;
    const hostname = new URL(url).hostname;
    if (isIP(stripBrackets(hostname)) !== 0) return result;
    let addresses: readonly string[];
    try {
      addresses = await resolve(hostname);
    } catch {
      this.record(url, method, agentRunId, false, "dns_failed");
      return { allowed: false, rule: "dns_failed" };
    }
    if (addresses.some(isInternalAddress)) {
      this.record(url, method, agentRunId, false, "internal_address");
      return { allowed: false, rule: "internal_address" };
    }
    return result;
  }

  getAuditLog(limit = 100): readonly OutboundAuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  getPolicy(): OutboundPolicy {
    return this.policy;
  }

  private record(url: string, method: string, agentRunId: string | null, allowed: boolean, rule: string): void {
    if (!this.policy.log_all && allowed) return;
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      agent_run_id: agentRunId,
      url,
      method,
      allowed,
      rule,
    });
  }
}

async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  return (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);
}

/** Lower-cases a host and drops trailing dots so "Blocked.Example." compares equal to "blocked.example". */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/u, "");
}

function matchesHost(hostname: string, listed: string): boolean {
  const entry = normalizeHost(listed);
  return hostname === entry || hostname.endsWith(`.${entry}`);
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isInternalHostname(hostname: string): boolean {
  const host = stripBrackets(hostname).toLowerCase().replace(/\.$/u, "");
  return host === "localhost" || host.endsWith(".localhost") || isInternalAddress(host);
}

/** Loopback, private, link-local (metadata endpoints included), unspecified and unique-local addresses. */
export function isInternalAddress(address: string): boolean {
  const host = stripBrackets(address);
  const family = isIP(host);
  if (family === 4) return isInternalIpv4(host.split(".").map(Number));
  if (family !== 6) return false;
  const groups = expandIpv6(host);
  if (groups.every((g, i) => g === 0 || (i === 7 && g === 1))) return true; // :: and ::1
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return isInternalIpv4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255]);
  }
  return (groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80;
}

function isInternalIpv4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function expandIpv6(address: string): number[] {
  let text = address.split("%")[0];
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/u);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text = text.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((part) => parseInt(part, 16));
}

type HostSection= "allowed" | "blocked" | null;

function parseOutboundPolicy(raw: string, filePath: string): OutboundPolicy {
  const allowed: string[] = [];
  const blocked: string[] = [];
  let section: HostSection = null;
  let logAll = true;
  const seen = new Set<string>();

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = stripYamlComment(line).trim();
    if (!trimmed) continue;

    const hostListMatch = trimmed.match(/^(allowed_hosts|blocked_hosts):\s*(.*)$/);
    if (hostListMatch) {
      const key = hostListMatch[1];
      const value = hostListMatch[2].trim();
      if (seen.has(key)) throw invalidPolicy(filePath, index + 1, `duplicate key ${key}`);
      seen.add(key);
      if (value === "") {
        section = key === "allowed_hosts" ? "allowed" : "blocked";
      } else if (value === "[]") {
        section = null;
      } else {
        throw invalidPolicy(filePath, index + 1, `${key} must be a YAML list`);
      }
      continue;
    }

    const logMatch = trimmed.match(/^log_all:\s*(.*)$/);
    if (logMatch) {
      if (seen.has("log_all")) throw invalidPolicy(filePath, index + 1, "duplicate key log_all");
      seen.add("log_all");
      const value = logMatch[1].trim();
      if (value !== "true" && value !== "false") {
        throw invalidPolicy(filePath, index + 1, "log_all must be true or false");
      }
      logAll = value === "true";
      section = null;
      continue;
    }

    if (trimmed.startsWith("- ") && section) {
      const host = parseYamlScalar(trimmed.slice(2).trim(), filePath, index + 1);
      if (!host) throw invalidPolicy(filePath, index + 1, "host entries must not be empty");
      if (section === "allowed") allowed.push(host);
      else blocked.push(host);
      continue;
    }

    throw invalidPolicy(filePath, index + 1, "unsupported YAML construct");
  }

  return { allowed_hosts: allowed, blocked_hosts: blocked, log_all: logAll };
}

function parseYamlScalar(value: string, filePath: string, lineNumber: number): string {
  if (
    (value.startsWith("\"") && !value.endsWith("\"")) ||
    (value.startsWith("'") && !value.endsWith("'"))
  ) {
    throw invalidPolicy(filePath, lineNumber, "unterminated quoted scalar");
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function stripYamlComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "'" || character === '"') && (index === 0 || value[index - 1] !== "\\")) {
      quote = quote === character ? null : quote ?? character;
    } else if (character === "#" && quote === null && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function invalidPolicy(filePath: string, lineNumber: number, message: string): Error {
  return new Error(`Invalid outbound policy YAML at ${filePath}:${lineNumber}: ${message}`);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === code;
}
