import { readFileSync } from "node:fs";
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
      hostname = new URL(url).hostname;
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

    if (this.policy.blocked_hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
      this.record(url, method, agentRunId, false, "blocked_host");
      return { allowed: false, rule: "blocked_host" };
    }

    if (this.policy.allowed_hosts.length > 0) {
      const onList = this.policy.allowed_hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
      if (!onList) {
        this.record(url, method, agentRunId, false, "not_on_allowlist");
        return { allowed: false, rule: "not_on_allowlist" };
      }
    }

    this.record(url, method, agentRunId, true, "allowed");
    return { allowed: true, rule: "allowed" };
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

type HostSection = "allowed" | "blocked" | null;

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
