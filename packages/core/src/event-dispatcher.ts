import { utcNow } from "../../db/dist/index.js";
import { HumanReadableError } from "./errors";
import type {
  CanonicalEventFrame,
  CoreDatabase,
  CoreWriteLaneTransaction,
  EventHandler,
  JsonObject,
} from "./types";

interface EventRow {
  id: string;
  sequence: number;
  idempotency_key: string;
  type: string;
  work_id: string | null;
  task_id: string | null;
  agent_run_id: string | null;
  payload_json: string;
  status: "pending" | "processing" | "handled" | "failed";
  attempt_no: number;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  created_at: string;
}

interface OutboxRow {
  id: string;
  event_id: string;
  provider: string;
  provider_message_key: string;
  status: "pending" | "sending" | "delivered" | "failed" | "uncertain";
  attempt_no: number;
  lease_expires_at: string | null;
}

export type OutboxHandler = (delivery: {
  readonly delivery_id: string;
  readonly provider: string;
  readonly provider_message_key: string;
  readonly event: {
    readonly event_id: string;
    readonly sequence: number;
    readonly type: string;
    readonly payload: JsonObject;
  };
}) => void | Promise<void>;

export interface EventDispatcherOptions {
  readonly db: CoreDatabase;
  readonly onEvent?: EventHandler;
  readonly outboxHandlers?: Readonly<Record<string, OutboxHandler>>;
  readonly leaseMs?: number;
}

/**
 * Durable event replay/dispatch. Claim, handler completion, and failure state
 * are written through WriteLane. External handlers run only after the claim
 * transaction commits, so a crash leaves a pending/leased row to replay.
 */
export class EventDispatcher {
  private readonly db: CoreDatabase;
  private readonly writeLane;
  private readonly onEvent?: EventHandler;
  private readonly outboxHandlers: Readonly<Record<string, OutboxHandler>>;
  private readonly leaseMs: number;
  private started = false;
  private draining = false;

  public constructor(options: EventDispatcherOptions) {
    this.db = options.db;
    this.writeLane = options.db.createWriteLane();
    this.onEvent = options.onEvent;
    this.outboxHandlers = options.outboxHandlers ?? {};
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000) {
      throw new HumanReadableError({
        code: "invalid_event_lease",
        message: "The event dispatcher lease must be at least one second.",
        remediation: "Configure leaseMs with a positive duration of at least 1000 milliseconds.",
      });
    }
  }

  public async start(): Promise<void> {
    this.started = true;
    await this.replayPending();
  }

  public async stop(): Promise<void> {
    this.started = false;
    await this.writeLane.drain();
  }

  public isStarted(): boolean {
    return this.started;
  }

  /**
   * Read canonical event history without claiming, dispatching, or updating
   * any lifecycle/outbox row. The cursor is exclusive and accepts a sequence
   * number or an event id; frames are identical to subscriber frames.
   */
  public listEventsAfter(cursor: string | number | null = null, limit?: number): readonly CanonicalEventFrame[] {
    const afterSequence = resolveCursor(this.db, cursor);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new HumanReadableError({
        code: "invalid_event_limit",
        message: "The event limit must be a non-negative integer.",
        remediation: "Use a non-negative integer for the event history limit.",
        details: { limit },
      });
    }
    const select = `SELECT id, sequence, idempotency_key, type, work_id, task_id, agent_run_id,
                           payload_json, status, attempt_no, lease_expires_at, next_attempt_at, created_at
                      FROM events
                     WHERE sequence > ?
                       AND NOT COALESCE(type = 'system.alert' AND json_valid(payload_json) AND json_type(payload_json, '$.internal_dispatcher_marker') = 'true', 0)`;
    const rows = limit === undefined
      ? this.db.all<EventRow>(`${select} ORDER BY sequence ASC`, afterSequence)
      : this.db.all<EventRow>(
        `${select} ORDER BY sequence ASC LIMIT ?`,
        afterSequence,
        limit,
      );
    return rows.filter((row) => !isInternalLifecycleEvent(row)).map((row) => toCanonicalFrame(row, this.db));
  }

  public async replayPending(): Promise<number> {
    if (this.draining) {
      return 0;
    }
    this.draining = true;
    try {
      const rows = this.db.all<EventRow>(
        `SELECT id, sequence, idempotency_key, type, work_id, task_id, agent_run_id,
                payload_json, status, attempt_no, lease_expires_at, next_attempt_at, created_at
           FROM events
          WHERE status IN ('pending', 'processing', 'failed')
            AND dead_letter_at IS NULL
          ORDER BY sequence ASC`,
      );
      let handled = 0;
      for (const row of rows) {
        if (isInternalLifecycleEvent(row)) {
          continue;
        }
        if (!isEligible(row)) {
          continue;
        }
        try {
          await this.dispatchOne(row);
          handled += 1;
        } catch (error) {
          console.error(`[owl-core] Event ${row.id} dispatch failed; it was scheduled for durable retry`, error);
        }
      }
      return handled;
    } finally {
      this.draining = false;
    }
  }

  private async dispatchOne(row: EventRow): Promise<void> {
    const lease = new Date(Date.now() + this.leaseMs).toISOString();
    await this.updateLifecycle(row.id, "processing", lease, row.attempt_no + 1);
    let payload: JsonObject;
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HumanReadableError({
          code: "event_payload_invalid",
          message: "A stored event payload is not an object.",
          remediation: "Inspect the event record and repair the producer before replaying it.",
          details: { event_id: row.id },
        });
      }
      payload = withWorkTitle(this.db, row, parsed as JsonObject);
    } catch (error) {
      await this.updateLifecycle(row.id, "failed", null, row.attempt_no + 1, "event_payload_invalid");
      throw new HumanReadableError({
        code: "event_payload_invalid",
        message: "A stored event payload could not be decoded for dispatch.",
        remediation: "Inspect the event record and repair the producer before replaying it.",
        details: { event_id: row.id, cause: error instanceof Error ? error.message : String(error) },
      });
    }

    const frame = {
      kind: "event" as const,
      event_id: row.id,
      sequence: row.sequence,
      cursor: String(row.sequence),
      type: row.type,
      schema_version: "1.0.0" as const,
      work_id: row.work_id,
      task_id: row.task_id,
      agent_run_id: row.agent_run_id,
      created_at: row.created_at,
      payload,
    };
    try {
      if (this.onEvent) {
        await this.onEvent(frame);
      }
      await this.deliverOutbox(row, frame);
      await this.updateLifecycle(row.id, "handled", null, row.attempt_no + 1);
    } catch (error) {
      await this.updateLifecycle(row.id, "failed", null, row.attempt_no + 1, "handler_failed");
      throw new HumanReadableError({
        code: "event_handler_failed",
        message: "An event handler could not finish processing a stored event.",
        remediation: "Review the handler log and retry event replay after the cause is fixed.",
        details: { event_id: row.id, cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async deliverOutbox(row: EventRow, frame: {
    readonly event_id: string;
    readonly sequence: number;
    readonly type: string;
    readonly payload: JsonObject;
  }): Promise<void> {
    const deliveries = this.db.all<OutboxRow>(
      `SELECT id, event_id, provider, provider_message_key, status, attempt_no, lease_expires_at
         FROM outbox_deliveries
        WHERE event_id = ?
        ORDER BY id ASC`,
      row.id,
    );
    for (const delivery of deliveries) {
      if (delivery.status === "delivered" || delivery.status === "uncertain") {
        continue;
      }
      // A failed delivery is replayed as part of its parent event's retry
      // lease.  Treating its backoff timestamp as an independent lease here
      // could let the event become handled while this delivery is still
      // failed, permanently losing the notification.  Only an in-flight
      // `sending` claim suppresses another attempt.
      if (delivery.status === "sending" && delivery.lease_expires_at !== null && Date.parse(delivery.lease_expires_at) > Date.now()) {
        continue;
      }
      const handler = this.outboxHandlers[delivery.provider];
      // The in-process websocket bus is the Core subscriber callback itself.
      // Other providers must be explicitly supplied; no provider fallback is allowed.
      if (!handler && delivery.provider !== "websocket") {
        throw new HumanReadableError({
          code: "outbox_provider_unconfigured",
          message: `Outbox provider ${delivery.provider} is not configured.`,
          remediation: "Configure the provider adapter before replaying this event.",
          details: { event_id: row.id, delivery_id: delivery.id, provider: delivery.provider },
        });
      }
      const attemptNo = delivery.attempt_no + 1;
      await this.updateDelivery(delivery.id, "sending", attemptNo, null);
      try {
        if (handler) {
          await handler({
            delivery_id: delivery.id,
            provider: delivery.provider,
            provider_message_key: delivery.provider_message_key,
            event: { event_id: row.id, sequence: row.sequence, type: row.type, payload: frame.payload },
          });
        }
        await this.updateDelivery(delivery.id, "delivered", attemptNo, null);
      } catch (error) {
        await this.updateDelivery(delivery.id, attemptNo >= 5 ? "uncertain" : "failed", attemptNo, "handler_failed");
        throw error;
      }
    }
  }

  private async updateDelivery(
    deliveryId: string,
    status: OutboxRow["status"],
    attemptNo: number,
    errorCode: string | null,
  ): Promise<void> {
    const now = utcNow();
    await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
        const retryAt = status === "sending"
          ? new Date(Date.now() + this.leaseMs).toISOString()
          : status === "failed"
            ? new Date(Date.now() + Math.min(300_000, 1_000 * (2 ** Math.min(attemptNo, 8)))).toISOString()
            : null;
        const result = transaction.run(
          `UPDATE outbox_deliveries
              SET status = ?, attempt_no = ?, lease_expires_at = ?,
                  delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                  last_error_code = ?
            WHERE id = ?`,
          status,
          attemptNo,
          retryAt,
          status,
          now,
          errorCode,
          deliveryId,
        );
        if (result.changes !== 1) {
          throw new HumanReadableError({
            code: "outbox_delivery_not_found",
            message: `Outbox delivery ${deliveryId} was not found during dispatch.`,
            remediation: "Inspect the event and outbox records before retrying delivery.",
            details: { delivery_id: deliveryId },
          });
        }
        return { delivery_id: deliveryId, status };
    });
  }

  private async updateLifecycle(
    eventId: string,
    status: EventRow["status"],
    leaseExpiresAt: string | null,
    attemptNo: number,
    errorCode?: string,
  ): Promise<void> {
    const now = utcNow();
    await this.writeLane.transact((transaction: CoreWriteLaneTransaction) => {
        const nextAttemptAt = status === "failed"
          ? new Date(Date.now() + Math.min(300_000, 1_000 * (2 ** Math.min(attemptNo, 8)))).toISOString()
          : null;
        const deadLetterAt = status === "failed" && attemptNo >= 5 ? now : null;
        const persistedStatus = deadLetterAt === null ? status : "failed";
        const result = transaction.run(
          `UPDATE events
              SET status = ?, attempt_no = ?, lease_expires_at = ?,
                  next_attempt_at = ?, dead_letter_at = COALESCE(?, dead_letter_at),
                  handled_at = CASE WHEN ? = 'handled' THEN ? ELSE handled_at END,
                  failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END
            WHERE id = ?`,
          persistedStatus,
          attemptNo,
          leaseExpiresAt,
          nextAttemptAt,
          deadLetterAt,
          status,
          now,
          status,
          now,
          eventId,
        );
        if (result.changes !== 1) {
          throw new HumanReadableError({
            code: "event_not_found",
            message: `Stored event ${eventId} disappeared before lifecycle update.`,
            remediation: "Inspect the database integrity before retrying event dispatch.",
            details: { event_id: eventId },
          });
        }
        return { event_id: eventId, status: persistedStatus, error_code: errorCode ?? null };
    });
  }
}

function isEligible(row: EventRow): boolean {
  if (row.status === "pending" || row.status === "failed") {
    return row.next_attempt_at === null || Date.parse(row.next_attempt_at) <= Date.now();
  }
  return row.lease_expires_at === null || Date.parse(row.lease_expires_at) <= Date.now();
}

function resolveCursor(db: CoreDatabase, cursor: string | number | null): number {
  if (cursor === null) {
    return 0;
  }
  if (typeof cursor === "number") {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new HumanReadableError({
        code: "invalid_event_cursor",
        message: "The event cursor must be a non-negative sequence number.",
        remediation: "Use a previously returned event sequence or event id as the cursor.",
        details: { cursor },
      });
    }
    return cursor;
  }
  if (/^[0-9]+$/.test(cursor)) {
    const sequence = Number(cursor);
    if (!Number.isSafeInteger(sequence)) {
      throw new HumanReadableError({
        code: "invalid_event_cursor",
        message: "The event cursor sequence is outside the supported range.",
        remediation: "Use a previously returned event sequence or event id as the cursor.",
        details: { cursor },
      });
    }
    return sequence;
  }
  const row = db.get<{ sequence: number }>("SELECT sequence FROM events WHERE id = ?", cursor);
  if (!row) {
    throw new HumanReadableError({
      code: "event_cursor_not_found",
      message: "The requested event cursor was not found.",
      remediation: "Refresh the event stream and retry with a current sequence or event id.",
      details: { cursor },
    });
  }
  return row.sequence;
}

function toCanonicalFrame(row: EventRow, db: CoreDatabase): CanonicalEventFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch (error) {
    throw new HumanReadableError({
      code: "event_payload_invalid",
      message: "A stored event payload could not be decoded for history.",
      remediation: "Inspect the event record and repair the producer before reading history.",
      details: { event_id: row.id, cause: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HumanReadableError({
      code: "event_payload_invalid",
      message: "A stored event payload is not an object.",
      remediation: "Inspect the event record and repair the producer before reading history.",
      details: { event_id: row.id },
    });
  }
  return {
    kind: "event",
    event_id: row.id,
    sequence: row.sequence,
    cursor: String(row.sequence),
    type: row.type,
    schema_version: "1.0.0",
    work_id: row.work_id,
    task_id: row.task_id,
    agent_run_id: row.agent_run_id,
    created_at: row.created_at,
    payload: withWorkTitle(db, row, parsed as JsonObject),
  };
}

const WORK_TITLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "work.completed",
  "work.cancelled",
  "work.paused",
  "work.reopened",
  "decision.opened",
  "decision.resolved",
  "decision.cancelled",
  "system.alert",
]);

/** Delivery-time only: fills payload.work_title for notification events; stored rows are untouched. */
function withWorkTitle(db: CoreDatabase, row: EventRow, payload: JsonObject): JsonObject {
  if (!WORK_TITLE_EVENT_TYPES.has(row.type) || "work_title" in payload) {
    return payload;
  }
  const workId = typeof payload.work_id === "string" && payload.work_id !== "" ? payload.work_id : row.work_id;
  if (!workId) {
    return payload;
  }
  const work = db.get<{ title: string }>("SELECT title FROM works WHERE id = ?", workId);
  return work && work.title !== "" ? { ...payload, work_title: work.title } : payload;
}

function isInternalLifecycleEvent(row: EventRow): boolean {
  if (row.type !== "system.alert") {
    return false;
  }
  try {
    const payload: unknown = JSON.parse(row.payload_json);
    return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) && (payload as JsonObject).internal_dispatcher_marker === true);
  } catch (error) {
    throw new HumanReadableError({
      code: "event_payload_invalid",
      message: "A stored system alert payload could not be decoded.",
      remediation: "Inspect the event record and repair the producer before replaying it.",
      details: { event_id: row.id, cause: error instanceof Error ? error.message : String(error) },
    });
  }
}
