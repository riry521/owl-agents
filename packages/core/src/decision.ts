import { createHash } from "node:crypto";
import { createUlid } from "../../db/dist/index.js";
import { idempotencyConflict, validationError } from "./errors";
import { ownerLanguage } from "./owner-language";
import { openDecisionInTransaction, resolveDecisionInTransaction } from "./state-reducer";
import type {
  CommandRequest,
  CommandResponse,
  CoreDatabase,
  CoreWriteLaneTransaction,
  Decision,
  JsonObject,
} from "./types";
import type { OpenDecisionInput, ResolveDecisionInput } from "./state-reducer";

export interface OpenDecisionPayload extends JsonObject {
  readonly work_id: string;
  readonly scope: "task" | "work";
  readonly blocked_task_ids: readonly string[];
  readonly reason: string;
  readonly question: string;
  readonly tried: string;
  readonly current_state: string;
  readonly options: readonly JsonObject[];
  readonly recommended: string | null;
  readonly allow_free_text: boolean;
  readonly issuer_role: "core" | "advisor" | "manager";
  /** Work scope only: false opens a Decision that does not block the Work. */
  readonly blocks_work?: boolean;
}

interface StoredIdempotencyRow {
  request_hash: string;
  response_json: string;
}

export class DecisionService {
  private readonly db: CoreDatabase;
  private readonly writeLane;

  public constructor(db: CoreDatabase) {
    this.db = db;
    this.writeLane = db.createWriteLane();
  }

  public async open(
    request: CommandRequest<OpenDecisionPayload>,
  ): Promise<CommandResponse<{ decision_id: string; status: "open"; blocked_task_ids: readonly string[] }>> {
    const scopedKey = "decision.open:" + request.payload.work_id + ":" + request.idempotency_key;
    const requestHash = hashRequest({ expected_version: request.expected_version, payload: request.payload });
    const cached = this.readCached(scopedKey, requestHash);
    if (cached) {
      return JSON.parse(cached.response_json) as CommandResponse<{ decision_id: string; status: "open"; blocked_task_ids: readonly string[] }>;
    }
    // Allocate the Decision identifier before the write-lane request. The
    // write lane appends the canonical event before invoking mutateState, so
    // the event payload must receive the same identifier that the transaction
    // inserts rather than discovering a second identifier afterward.
    const decisionId = createUlid();
    try {
      const result = await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const existing = transaction.get<StoredIdempotencyRow>(
            "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
            scopedKey,
          );
          if (existing) {
            if (existing.request_hash !== requestHash) {
              throw idempotencyConflict(scopedKey);
            }
            throw new ReplayCommand(JSON.parse(existing.response_json) as CommandResponse);
          }
          const input: OpenDecisionInput = { ...request.payload, id: decisionId };
          const decision = openDecisionInTransaction(transaction, input);
          const response: CommandResponse<{ decision_id: string; status: "open"; blocked_task_ids: readonly string[] }> = {
            request_id: request.request_id,
            data: { decision_id: decision.id, status: "open", blocked_task_ids: request.payload.blocked_task_ids },
            version: decision.state_version,
          };
          transaction.run(
            `INSERT INTO idempotency_keys
               (key, request_hash, response_json, status_code, created_at, expires_at)
             VALUES (?, ?, ?, 200, ?, ?)`,
            scopedKey,
            requestHash,
            JSON.stringify(response),
            decision.created_at,
            new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          );
          return response;
        },
        event: {
          id: createUlid(),
          idempotencyKey: "decision-opened:" + scopedKey,
          type: "decision.opened",
          workId: request.payload.work_id,
          // Connectors word the notification in the Owner language.
          payload: { ...request.payload, decision_id: decisionId, language: ownerLanguage(this.db) },
        },
        outbox: [{ provider: "websocket" }],
      });
      return result.state;
    } catch (error) {
      if (error instanceof ReplayCommand) {
        return error.response as CommandResponse<{ decision_id: string; status: "open"; blocked_task_ids: readonly string[] }>;
      }
      throw error;
    }
  }

  public async resolve(
    request: CommandRequest<{
      decision_id: string;
      answer: string;
      option_key: string | null;
      source_message_id: string | null;
      answerer_id?: string;
      source?: "web" | "slack" | "discord" | "advisor";
      to_manager?: boolean;
      rerun_review?: boolean;
      option_note?: boolean;
    }>,
  ): Promise<CommandResponse<{ decision_id: string; status: "resolved"; winner: boolean; resumed_task_ids: readonly string[] }>> {
    const scopedKey = "decision.resolve:" + request.payload.decision_id + ":" + request.idempotency_key;
    const requestHash = hashRequest({ expected_version: request.expected_version, payload: request.payload });
    const cached = this.readCached(scopedKey, requestHash);
    if (cached) {
      return JSON.parse(cached.response_json) as CommandResponse<{ decision_id: string; status: "resolved"; winner: boolean; resumed_task_ids: readonly string[] }>;
    }
    // Resolve the routing metadata before entering the write lane so the
    // canonical event can carry work_id even though the state callback owns
    // the actual CAS/resolution transaction. The decision row is immutable in
    // its work association, so this read cannot redirect the event.
    const decisionMetadata = this.db.get<{ work_id: string }>(
      "SELECT work_id FROM decisions WHERE id = ?",
      request.payload.decision_id,
    );
    try {
      const result = await this.writeLane.write({
        mutateState: (transaction: CoreWriteLaneTransaction) => {
          const existing = transaction.get<StoredIdempotencyRow>(
            "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
            scopedKey,
          );
          if (existing) {
            if (existing.request_hash !== requestHash) {
              throw idempotencyConflict(scopedKey);
            }
            throw new ReplayCommand(JSON.parse(existing.response_json) as CommandResponse);
          }
          const resolved = resolveDecisionInTransaction(transaction, {
            decision_id: request.payload.decision_id,
            expected_version: request.expected_version,
            answerer_id: request.payload.answerer_id ?? "owner:default",
            answer: request.payload.answer,
            option_key: request.payload.option_key,
            source: request.payload.source ?? "web",
            source_message_id: request.payload.source_message_id,
            to_manager: request.payload.to_manager,
            rerun_review: request.payload.rerun_review,
            option_note: request.payload.option_note,
          } satisfies ResolveDecisionInput);
          const response: CommandResponse<{ decision_id: string; status: "resolved"; winner: boolean; resumed_task_ids: readonly string[] }> = {
            request_id: request.request_id,
            data: {
              decision_id: resolved.decision.id,
              status: "resolved",
              winner: true,
              resumed_task_ids: resolved.resumed_task_ids,
            },
            version: resolved.decision.state_version,
          };
          transaction.run(
            `INSERT INTO idempotency_keys
               (key, request_hash, response_json, status_code, created_at, expires_at)
             VALUES (?, ?, ?, 200, ?, ?)`,
            scopedKey,
            requestHash,
            JSON.stringify(response),
            resolved.decision.resolved_at,
            new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          );
          return response;
        },
        event: {
          id: createUlid(),
          idempotencyKey: "decision-resolved:" + scopedKey,
          type: "decision.resolved",
          workId: decisionMetadata?.work_id ?? null,
          payload: { decision_id: request.payload.decision_id, answer: request.payload.answer },
        },
        outbox: [{ provider: "websocket" }],
      });
      return result.state;
    } catch (error) {
      if (error instanceof ReplayCommand) {
        return error.response as CommandResponse<{ decision_id: string; status: "resolved"; winner: boolean; resumed_task_ids: readonly string[] }>;
      }
      throw error;
    }
  }

  public list(status?: "open" | "resolved" | "cancelled", limit = 50, cursor: string | null = null): readonly Decision[] {
    const boundedLimit = boundLimit(limit);
    const rows = this.db.all<DecisionDbRow>(
      `SELECT id, work_id, scope, status, blocked_task_ids_json, reason, question, current_state, tried,
              options_json, recommended, allow_free_text, state_version, design_block_json
         FROM decisions
        WHERE (? IS NULL OR status = ?)
          AND (? IS NULL OR id > ?)
        ORDER BY id ASC LIMIT ?`,
      status ?? null,
      status ?? null,
      cursor,
      cursor,
      boundedLimit + 1,
    );
    return rows.slice(0, boundedLimit).map(toDecision);
  }

  private readCached(key: string, requestHash: string): StoredIdempotencyRow | null {
    const cached = this.db.get<StoredIdempotencyRow>(
      "SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?",
      key,
    );
    if (!cached) {
      return null;
    }
    if (cached.request_hash !== requestHash) {
      throw idempotencyConflict(key);
    }
    return cached;
  }
}

interface DecisionDbRow {
  id: string;
  work_id: string;
  scope: "task" | "work";
  status: "open" | "resolved" | "cancelled";
  blocked_task_ids_json: string;
  reason: string;
  question: string;
  current_state: string;
  tried: string;
  options_json: string;
  recommended: string | null;
  allow_free_text: number;
  state_version: number;
  design_block_json: string | null;
}

function toDecision(row: DecisionDbRow): Decision {
  const blocked = JSON.parse(row.blocked_task_ids_json) as unknown;
  const options = JSON.parse(row.options_json) as unknown;
  if (!Array.isArray(blocked) || !blocked.every((id) => typeof id === "string") || !Array.isArray(options)) {
    throw validationError("A stored Decision contains invalid JSON fields.", { decision_id: row.id });
  }
  return {
    id: row.id,
    work_id: row.work_id,
    scope: row.scope,
    status: row.status,
    reason: row.reason,
    question: row.question,
    current_state: row.current_state,
    tried: row.tried,
    options: options as Decision["options"],
    recommended: row.recommended,
    allow_free_text: row.allow_free_text === 1,
    blocked_task_ids: blocked,
    state_version: row.state_version,
    design_block: row.design_block_json ? (JSON.parse(row.design_block_json) as Decision["design_block"]) : null,
  };
}

function boundLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw validationError("List limit must be an integer between 1 and 200.", { limit });
  }
  return limit;
}

function hashRequest(payload: JsonObject): string {
  return createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

class ReplayCommand extends Error {
  public constructor(public readonly response: CommandResponse) {
    super("idempotent command replay");
    this.name = "ReplayCommand";
  }
}
