import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CONNECTOR_STATE_SCHEMA_VERSION = 1 as const;

/** Where a Decision's notification was posted, so a later resolved/cancelled event can edit it instead of posting a new message. */
export interface ConnectorDecisionMessageRef {
  readonly channel_id: string;
  readonly message_ref: string;
  readonly posted_at: string;
}

/** A connector's durable state: how far it has read the Core event log, and which chat message announced which open Decision. */
export interface ConnectorState {
  readonly schema_version: 1;
  readonly cursor: number;
  readonly decisions: Readonly<Record<string, ConnectorDecisionMessageRef>>;
}

export interface ConnectorStateStore {
  /** null when there is no state yet (first run); throws for anything else it cannot make sense of. */
  load(): Promise<ConnectorState | null>;
  save(state: ConnectorState): Promise<void>;
}

export function emptyConnectorState(): ConnectorState {
  return { schema_version: CONNECTOR_STATE_SCHEMA_VERSION, cursor: 0, decisions: {} };
}

function invalid(path: string, detail: string): Error {
  return new Error(`Connector state file ${path} ${detail}`);
}

function parseDecisions(path: string, value: unknown): Record<string, ConnectorDecisionMessageRef> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(path, "has an invalid decisions map.");
  }
  const decisions: Record<string, ConnectorDecisionMessageRef> = {};
  for (const [decisionId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") throw invalid(path, `has an invalid entry for decision ${decisionId}.`);
    const { channel_id, message_ref, posted_at } = entry as Record<string, unknown>;
    if (typeof channel_id !== "string" || typeof message_ref !== "string" || typeof posted_at !== "string") {
      throw invalid(path, `has an invalid entry for decision ${decisionId}.`);
    }
    decisions[decisionId] = { channel_id, message_ref, posted_at };
  }
  return decisions;
}

/**
 * A connector's durable state (event cursor + Decision-to-notification-message
 * map), as one JSON file per connector account. `save` writes a temp file in
 * the same directory and renames it into place so a crash mid-write never
 * corrupts the previous state. `load` fails loudly on a corrupt or
 * unrecognized-schema file rather than silently discarding it.
 */
export class FileConnectorStateStore implements ConnectorStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<ConnectorState | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw invalid(this.path, `is not valid JSON: ${(error as Error).message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(this.path, "is not a JSON object.");
    const record = value as Record<string, unknown>;
    if (record.schema_version !== CONNECTOR_STATE_SCHEMA_VERSION) {
      throw invalid(this.path, `has schema_version ${JSON.stringify(record.schema_version)}; expected ${CONNECTOR_STATE_SCHEMA_VERSION}.`);
    }
    if (typeof record.cursor !== "number" || !Number.isFinite(record.cursor) || record.cursor < 0) {
      throw invalid(this.path, "has an invalid cursor.");
    }
    return {
      schema_version: CONNECTOR_STATE_SCHEMA_VERSION,
      cursor: record.cursor,
      decisions: parseDecisions(this.path, record.decisions),
    };
  }

  async save(state: ConnectorState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmpPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(tmpPath, 0o600);
    } catch { /* best effort on filesystems without chmod (e.g. some CI containers) */ }
    await rename(tmpPath, this.path);
  }
}
